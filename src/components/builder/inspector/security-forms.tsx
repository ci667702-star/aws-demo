"use client";

import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { SG } from "@/lib/project/factory";
import { setSingleRelation } from "@/lib/project/mutations";
import { Callout, CheckList, Section, SelectField, TextField } from "./fields";
import { ResourceList, type FormContext } from "./form-shared";
import { NaclRulesEditor, SgRulesEditor, type SgPreset } from "./rule-editors";

function vpcSelect(ctx: FormContext) {
  return [
    { value: "", label: "VPC 선택 안 함" },
    ...ctx.analysis.topology.ofType("vpc").map((v) => ({ value: v.id, label: `${displayName(v)} (${v.config.cidr})` })),
  ];
}

export function SecurityGroupForm({ sg, ctx }: { sg: ResourceOfType<"security-group">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const vpcId = t.vpcOf(sg.id);
  const vpcCidr = t.getOfType(vpcId, "vpc")?.config.cidr ?? "10.0.0.0/16";
  const groups = t
    .ofType("security-group")
    .filter((g) => g.id !== sg.id)
    .map((g) => ({ id: g.id, name: displayName(g), sameVpc: !vpcId || !t.vpcOf(g.id) || t.vpcOf(g.id) === vpcId }));
  const sameVpcGroups = groups.filter((g) => g.sameVpc).slice(0, 4);
  const inboundPresets: SgPreset[] = [
    { label: "HTTP 80 ← 0.0.0.0/0", rule: () => SG.tcp(80, "0.0.0.0/0", "HTTP") },
    { label: "HTTPS 443 ← 0.0.0.0/0", rule: () => SG.tcp(443, "0.0.0.0/0", "HTTPS") },
    { label: "SSH 22 ← 관리자 대역 203.0.113.0/24", rule: () => SG.tcp(22, "203.0.113.0/24", "SSH from admin") },
    { label: `MySQL 3306 ← VPC ${vpcCidr}`, rule: () => SG.tcp(3306, vpcCidr, "MySQL from VPC") },
    { label: `PostgreSQL 5432 ← VPC ${vpcCidr}`, rule: () => SG.tcp(5432, vpcCidr, "PostgreSQL from VPC") },
    { label: `ICMP ← VPC ${vpcCidr}`, rule: () => SG.icmp(vpcCidr, "Ping from VPC") },
    ...sameVpcGroups.flatMap((g) => [
      { label: `TCP 80 ← SG ${displayName(g)}`, rule: () => SG.tcp(80, { sg: g.id }, `HTTP from ${displayName(g)}`) },
      { label: `TCP 3306 ← SG ${displayName(g)}`, rule: () => SG.tcp(3306, { sg: g.id }, `MySQL from ${displayName(g)}`) },
    ]),
  ];
  const outboundPresets: SgPreset[] = [
    { label: "모든 트래픽 → 0.0.0.0/0", rule: () => SG.all("0.0.0.0/0", "All outbound") },
    { label: "HTTPS 443 → 0.0.0.0/0", rule: () => SG.tcp(443, "0.0.0.0/0", "HTTPS outbound") },
    { label: `모든 트래픽 → VPC ${vpcCidr}`, rule: () => SG.all(vpcCidr, "VPC internal") },
  ];
  return (
    <>
      <Section title="기본 설정">
        <SelectField
          label="VPC"
          value={vpcId ?? ""}
          options={vpcSelect(ctx)}
          onChange={(v) => ctx.actions.setRelation(sg.id, "vpc-security-group", v || null, "보안 그룹 VPC 변경")}
        />
        <TextField
          label="설명"
          value={sg.config.description}
          maxLength={255}
          onCommit={(v) => ctx.actions.updateConfig(sg, { description: v }, "보안 그룹 설명 변경")}
        />
        <Callout>
          보안 그룹은 <b>상태 저장형</b>입니다. 허용 규칙만 있고, 일치하는 규칙이 없으면 거부됩니다. 허용된 연결의 응답은 규칙과 관계없이 자동으로
          허용됩니다.
        </Callout>
      </Section>
      <Section title="인바운드 규칙">
        <SgRulesEditor
          title="인바운드"
          direction="inbound"
          rules={sg.config.inboundRules}
          securityGroups={groups}
          presets={inboundPresets}
          onChange={(rules) => ctx.actions.updateConfig(sg, { inboundRules: rules }, `${displayName(sg)} 인바운드 규칙 변경`)}
        />
      </Section>
      <Section title="아웃바운드 규칙">
        <SgRulesEditor
          title="아웃바운드"
          direction="outbound"
          rules={sg.config.outboundRules}
          securityGroups={groups}
          presets={outboundPresets}
          onChange={(rules) => ctx.actions.updateConfig(sg, { outboundRules: rules }, `${displayName(sg)} 아웃바운드 규칙 변경`)}
        />
      </Section>
      <Section title="연결된 리소스">
        <ResourceList ctx={ctx} resources={t.resourcesUsingSecurityGroup(sg.id)} empty="연결된 EC2/ALB/RDS가 없습니다." />
      </Section>
    </>
  );
}

export function NetworkAclForm({ nacl, ctx }: { nacl: ResourceOfType<"network-acl">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const vpcId = t.vpcOf(nacl.id);
  const vpcCidr = t.getOfType(vpcId, "vpc")?.config.cidr ?? null;
  const associated = new Set(t.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId));
  const items = t.ofType("subnet").map((s) => {
    const sVpc = t.vpcOfSubnet(s.id);
    const current = t.naclOf(s.id);
    const sameVpc = !vpcId || !sVpc || sVpc === vpcId;
    return {
      id: s.id,
      label: `${displayName(s)} (${s.config.cidr})`,
      description: current && current.id !== nacl.id ? `현재 ${current.name}와(과) 연결됨 — 선택하면 옮깁니다.` : undefined,
      checked: associated.has(s.id),
      disabled: !sameVpc,
      disabledReason: sameVpc ? undefined : "다른 VPC의 서브넷",
    };
  });
  return (
    <>
      <Section title="기본 설정">
        <SelectField
          label="VPC"
          value={vpcId ?? ""}
          options={vpcSelect(ctx)}
          onChange={(v) => ctx.actions.setRelation(nacl.id, "vpc-network-acl", v || null, "NACL VPC 변경")}
        />
        <Callout tone="warn">
          Network ACL은 <b>상태 비저장형</b>입니다. 규칙 번호가 낮은 것부터 평가해 처음 일치한 규칙을 적용하고, 요청과 응답을 각각 평가합니다. 응답은
          보통 임시 포트(1024-65535)를 사용하므로 반대 방향 규칙도 필요합니다. 새로 만든 NACL은 규칙이 없어 모든 트래픽을 거부합니다.
        </Callout>
      </Section>
      <Section title={`연결된 서브넷 (${associated.size})`}>
        <CheckList
          label="서브넷 연결(Association)"
          items={items}
          empty="서브넷이 없습니다."
          onToggle={(subnetId, checked) =>
            ctx.actions.run(checked ? "NACL 서브넷 연결" : "NACL 서브넷 연결 해제", (p) =>
              setSingleRelation(p, subnetId, "network-acl-subnet", checked ? nacl.id : null),
            )
          }
        />
      </Section>
      <Section title="인바운드 규칙">
        <NaclRulesEditor
          title="인바운드"
          direction="inbound"
          rules={nacl.config.inboundRules}
          vpcCidr={vpcCidr}
          onChange={(rules) => ctx.actions.updateConfig(nacl, { inboundRules: rules }, `${nacl.name} 인바운드 규칙 변경`)}
        />
      </Section>
      <Section title="아웃바운드 규칙">
        <NaclRulesEditor
          title="아웃바운드"
          direction="outbound"
          rules={nacl.config.outboundRules}
          vpcCidr={vpcCidr}
          onChange={(rules) => ctx.actions.updateConfig(nacl, { outboundRules: rules }, `${nacl.name} 아웃바운드 규칙 변경`)}
        />
      </Section>
    </>
  );
}
