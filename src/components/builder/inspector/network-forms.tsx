"use client";

import { ToneBadge } from "@/components/resource-visuals";
import { displayName } from "@/lib/engine/topology-engine";
import {
  awsUsableHostCount,
  cidrContainsCidr,
  cidrSize,
  formatIpv4,
  parseCidr,
  tryParseCidr,
  validateSubnetCidr,
  validateVpcCidr,
} from "@/lib/engine/cidr-utils";
import { AVAILABILITY_ZONES, type ResourceOfType } from "@/lib/engine/resource-models";
import {
  addRoute,
  disconnect,
  setMainRouteTable,
  setSingleRelation,
  updateRouteDestination,
  updateRouteTarget,
} from "@/lib/project/mutations";
import { Callout, CheckList, InfoRow, Section, SelectField, SwitchField, TextField, type SelectOption } from "./fields";
import { ResourceLink, ResourceList, SubnetKindBadge, type FormContext } from "./form-shared";
import { RoutesEditor } from "./rule-editors";

function vpcOptions(ctx: FormContext, emptyLabel: string): SelectOption[] {
  return [
    { value: "", label: emptyLabel },
    ...ctx.analysis.topology.ofType("vpc").map((v) => ({ value: v.id, label: `${displayName(v)} (${v.config.cidr})` })),
  ];
}

// ---------------------------------------------------------------- VPC

export function VpcForm({ vpc, ctx }: { vpc: ResourceOfType<"vpc">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const cidr = tryParseCidr(vpc.config.cidr);
  const igw = t.igwOfVpc(vpc.id);
  const tables = t.routeTablesOfVpc(vpc.id);
  const main = t.mainRouteTableOf(vpc.id);
  const subnets = t.subnetsOfVpc(vpc.id);
  return (
    <>
      <Section title="기본 설정">
        <TextField
          label="IPv4 CIDR 블록"
          value={vpc.config.cidr}
          mono
          testId="vpc-cidr"
          validate={(v) => {
            const r = validateVpcCidr(v);
            return r.ok ? null : r.error;
          }}
          onCommit={(v) => {
            const r = parseCidr(v);
            return ctx.actions.updateConfig(vpc, { cidr: r.ok ? r.value.text : v.trim() }, "VPC CIDR 변경");
          }}
          hint={cidr ? `주소 ${cidrSize(cidr).toLocaleString()}개 · /16 ~ /28 허용` : "/16 ~ /28 범위의 CIDR"}
        />
        <SwitchField
          label="DNS 확인 (enableDnsSupport)"
          description="VPC 안에서 Amazon 제공 DNS로 ALB/RDS 엔드포인트 이름을 해석합니다. 끄면 이름 기반 연결이 실패합니다."
          checked={vpc.config.enableDnsSupport}
          onChange={(v) => ctx.actions.updateConfig(vpc, { enableDnsSupport: v }, "DNS 확인 설정 변경")}
        />
        <SwitchField
          label="DNS 호스트 이름 (enableDnsHostnames)"
          description="퍼블릭 IP가 있는 인스턴스에 DNS 이름을 부여합니다. Publicly Accessible RDS에 필요합니다."
          checked={vpc.config.enableDnsHostnames}
          onChange={(v) => ctx.actions.updateConfig(vpc, { enableDnsHostnames: v }, "DNS 호스트 이름 설정 변경")}
        />
      </Section>
      <Section title="연결">
        <SelectField
          label="Internet Gateway"
          value={igw?.id ?? ""}
          options={[
            { value: "", label: "연결 안 함" },
            ...t.ofType("internet-gateway").map((g) => {
              const other = t.vpcOfIgw(g.id);
              return { value: g.id, label: `${displayName(g)}${other && other !== vpc.id ? ` (VPC ${t.name(other)}에 연결됨)` : ""}` };
            }),
          ]}
          onChange={(v) => ctx.actions.setRelation(vpc.id, "vpc-internet-gateway", v || null, "Internet Gateway 연결 변경")}
          hint="VPC당 하나의 IGW만 연결할 수 있습니다."
        />
        <SelectField
          label="기본(main) 라우팅 테이블"
          value={main?.id ?? ""}
          options={[
            { value: "", label: "지정 안 함 (local 경로만 있는 기본 테이블로 가정)" },
            ...tables.map((rt) => ({ value: rt.id, label: rt.name })),
          ]}
          onChange={(v) => ctx.actions.run("기본 라우팅 테이블 변경", (p) => setMainRouteTable(p, vpc.id, v || null))}
          hint="명시적으로 연결되지 않은 서브넷이 이 테이블을 사용합니다."
        />
      </Section>
      <Section title={`서브넷 (${subnets.length})`}>
        <ResourceList
          ctx={ctx}
          resources={subnets}
          empty="이 VPC에 속한 서브넷이 없습니다."
          extra={(s) => (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {(s as ResourceOfType<"subnet">).config.cidr}
              <SubnetKindBadge ctx={ctx} subnetId={s.id} />
            </span>
          )}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Subnet

export function SubnetForm({ subnet, ctx }: { subnet: ResourceOfType<"subnet">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const vpcId = t.vpcOfSubnet(subnet.id);
  const vpcCidr = t.vpcCidr(vpcId);
  const cidr = tryParseCidr(subnet.config.cidr);
  const routing = t.subnetRouting(subnet.id);
  const explicitRt = routing.table.kind === "explicit" ? routing.table.routeTableId : "";
  const nacl = t.naclOf(subnet.id);
  const cls = t.classifySubnet(subnet.id);
  const members = t.project.resources.filter(
    (r) => (r.type === "ec2" || r.type === "nat-gateway") && t.subnetOf(r.id) === subnet.id,
  );
  const azOptions: SelectOption[] = AVAILABILITY_ZONES.map((az) => ({ value: az, label: az }));
  if (!AVAILABILITY_ZONES.includes(subnet.config.availabilityZone as (typeof AVAILABILITY_ZONES)[number])) {
    azOptions.push({ value: subnet.config.availabilityZone, label: `${subnet.config.availabilityZone} (지원하지 않음)` });
  }
  return (
    <>
      <Section title="기본 설정">
        <SelectField
          label="VPC"
          value={vpcId ?? ""}
          options={vpcOptions(ctx, "VPC 선택 안 함")}
          onChange={(v) => ctx.actions.setRelation(subnet.id, "vpc-subnet", v || null, "서브넷 VPC 변경")}
          testId="subnet-vpc"
        />
        <TextField
          label="IPv4 CIDR 블록"
          value={subnet.config.cidr}
          mono
          testId="subnet-cidr"
          validate={(v) => {
            const r = validateSubnetCidr(v);
            return r.ok ? null : r.error;
          }}
          onCommit={(v) => {
            const r = parseCidr(v);
            return ctx.actions.updateConfig(subnet, { cidr: r.ok ? r.value.text : v.trim() }, "서브넷 CIDR 변경");
          }}
          hint={
            cidr
              ? `AWS 사용 가능 주소 ${awsUsableHostCount(cidr)}개 (예약 5개 제외)${vpcCidr && !cidrContainsCidr(vpcCidr, cidr) ? " · ⚠ VPC 범위 밖" : ""}`
              : undefined
          }
        />
        <SelectField
          label="가용 영역"
          value={subnet.config.availabilityZone}
          options={azOptions}
          onChange={(v) => ctx.actions.updateConfig(subnet, { availabilityZone: v }, "가용 영역 변경")}
        />
        <SwitchField
          label="퍼블릭 IPv4 자동 할당"
          description="이 서브넷에서 '서브넷 기본값'으로 시작한 EC2에 가상 퍼블릭 IP를 할당합니다. 퍼블릭 IP가 있어도 IGW 경로가 없으면 인터넷과 통신할 수 없습니다."
          checked={subnet.config.mapPublicIpOnLaunch}
          onChange={(v) => ctx.actions.updateConfig(subnet, { mapPublicIpOnLaunch: v }, "퍼블릭 IP 자동 할당 변경")}
        />
      </Section>
      <Section title="라우팅 / 네트워크 ACL">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">서브넷 유형 (라우팅으로 판정)</span>
          <SubnetKindBadge ctx={ctx} subnetId={subnet.id} />
        </div>
        <Callout>{cls.reason}</Callout>
        <SelectField
          label="라우팅 테이블 연결"
          value={explicitRt}
          options={[
            { value: "", label: "명시적 연결 없음 (기본 라우팅 테이블 사용)" },
            ...t.ofType("route-table").map((rt) => {
              const rtVpc = t.vpcOf(rt.id);
              return { value: rt.id, label: `${displayName(rt)}${rtVpc && vpcId && rtVpc !== vpcId ? " (다른 VPC)" : ""}`, disabled: !!rtVpc && !!vpcId && rtVpc !== vpcId };
            }),
          ]}
          onChange={(v) => ctx.actions.setRelation(subnet.id, "route-table-subnet", v || null, "라우팅 테이블 연결 변경")}
          testId="subnet-route-table"
        />
        <div className="overflow-hidden rounded-md border text-xs">
          <div className="bg-muted/50 px-2 py-1 font-medium text-muted-foreground">적용 중인 경로 — {t.routeTableLabel(routing.table)}</div>
          {routing.routes.map((r) => (
            <div key={r.key} className="flex justify-between border-t px-2 py-1">
              <span className="font-mono">{r.destinationCidr}</span>
              <span>{t.routeTargetLabel(r)}</span>
            </div>
          ))}
          {routing.routes.length === 0 && <p className="border-t px-2 py-1 text-muted-foreground">경로 없음</p>}
        </div>
        <SelectField
          label="네트워크 ACL"
          value={nacl?.id ?? ""}
          options={[
            { value: "", label: "기본 NACL (모든 트래픽 허용, 가정)" },
            ...t.ofType("network-acl").map((n) => {
              const nVpc = t.vpcOf(n.id);
              return { value: n.id, label: `${displayName(n)}${nVpc && vpcId && nVpc !== vpcId ? " (다른 VPC)" : ""}`, disabled: !!nVpc && !!vpcId && nVpc !== vpcId };
            }),
          ]}
          onChange={(v) => ctx.actions.setRelation(subnet.id, "network-acl-subnet", v || null, "NACL 연결 변경")}
        />
      </Section>
      <Section title={`배치된 리소스 (${members.length})`}>
        <ResourceList ctx={ctx} resources={members} empty="이 서브넷에 배치된 EC2/NAT가 없습니다." />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Internet Gateway

export function IgwForm({ igw, ctx }: { igw: ResourceOfType<"internet-gateway">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const vpcId = t.vpcOfIgw(igw.id);
  const routes = t.incoming(igw.id, "route-table-internet-gateway");
  return (
    <>
      <Section title="연결">
        <SelectField
          label="연결된 VPC"
          value={vpcId ?? ""}
          options={vpcOptions(ctx, "연결 안 함 (Detached)").map((o) => {
            if (!o.value) return o;
            const other = t.igwOfVpc(o.value);
            return other && other.id !== igw.id ? { ...o, label: `${o.label} — 이미 ${displayName(other)} 연결됨`, disabled: true } : o;
          })}
          onChange={(v) => ctx.actions.setRelation(igw.id, "vpc-internet-gateway", v || null, "IGW 연결 변경")}
          testId="igw-vpc"
        />
        <Callout>
          IGW는 VPC에 연결되어야 하며, 퍼블릭 IP가 있는 인터페이스에 대해 사설 IP ↔ 퍼블릭 IP 1:1 주소 변환을 수행합니다. 서브넷이 퍼블릭이 되려면 라우팅
          테이블에 이 IGW로 향하는 경로가 필요합니다.
        </Callout>
      </Section>
      <Section title={`이 IGW를 사용하는 경로 (${routes.length})`}>
        {routes.length === 0 ? (
          <p className="text-xs text-muted-foreground">이 IGW를 대상으로 하는 경로가 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {routes.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <ResourceLink ctx={ctx} id={c.sourceResourceId} />
                <span className="font-mono text-xs">{c.relationType === "route-table-internet-gateway" ? c.metadata.destinationCidr : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Route Table

export function RouteTableForm({ rt, ctx }: { rt: ResourceOfType<"route-table">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const vpcId = t.vpcOf(rt.id);
  const vpc = t.getOfType(vpcId, "vpc");
  const routes = t.routesOf(rt.id, vpcId).filter((r) => r.connectionId);
  const targets: SelectOption[] = [
    ...t.ofType("internet-gateway").map((g) => {
      const attached = t.vpcOfIgw(g.id);
      return {
        value: g.id,
        label: `${displayName(g)} (IGW${attached ? `, ${t.name(attached)}` : ", 미연결"})`,
        disabled: !!attached && !!vpcId && attached !== vpcId,
      };
    }),
    ...t.ofType("nat-gateway").map((n) => {
      const natVpc = t.vpcOf(n.id);
      return {
        value: n.id,
        label: `${displayName(n)} (NAT${t.subnetOf(n.id) ? `, ${t.name(t.subnetOf(n.id))}` : ", 미배치"})`,
        disabled: !!natVpc && !!vpcId && natVpc !== vpcId,
      };
    }),
  ];
  const associated = new Set(t.outgoing(rt.id, "route-table-subnet").map((c) => c.targetResourceId));
  const subnetItems = t.ofType("subnet").map((s) => {
    const sVpc = t.vpcOfSubnet(s.id);
    const ref = t.routeTableRefFor(s.id);
    const other = ref.kind === "explicit" && ref.routeTableId !== rt.id ? t.name(ref.routeTableId) : null;
    const sameVpc = !vpcId || !sVpc || sVpc === vpcId;
    return {
      id: s.id,
      label: `${displayName(s)} (${s.config.cidr})`,
      description: other ? `현재 ${other}와(과) 연결됨 — 선택하면 이 테이블로 옮깁니다.` : undefined,
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
          options={vpcOptions(ctx, "VPC 선택 안 함")}
          onChange={(v) => ctx.actions.setRelation(rt.id, "vpc-route-table", v || null, "라우팅 테이블 VPC 변경")}
        />
        <SwitchField
          label="VPC 기본(main) 라우팅 테이블"
          description="명시적으로 연결되지 않은 서브넷이 이 테이블을 사용합니다."
          checked={rt.config.main}
          disabled={!vpcId}
          onChange={(v) => vpcId && ctx.actions.run("기본 라우팅 테이블 변경", (p) => setMainRouteTable(p, vpcId, v ? rt.id : null))}
        />
      </Section>
      <Section title={`경로 (${routes.length + (vpc ? 1 : 0)})`}>
        <RoutesEditor
          localCidr={vpc?.config.cidr ?? null}
          routes={routes.map((r) => ({ connectionId: r.connectionId!, destination: r.destinationCidr, targetId: r.targetId ?? "" }))}
          targets={targets}
          onAdd={(dest, targetId) => ctx.actions.run(`경로 추가 ${dest}`, (p) => addRoute(p, rt.id, targetId, dest))}
          onDestinationChange={(id, dest) => ctx.actions.run("경로 Destination 변경", (p) => updateRouteDestination(p, id, dest))}
          onTargetChange={(id, target) => {
            ctx.actions.run("경로 대상 변경", (p) => updateRouteTarget(p, id, target));
          }}
          onRemove={(id) => {
            ctx.actions.run("경로 삭제", (p) => disconnect(p, [id]));
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          가장 구체적인 경로(접두사가 긴 경로)가 우선합니다. 인터넷 기본 경로는 0.0.0.0/0입니다.
        </p>
      </Section>
      <Section title={`연결된 서브넷 (${associated.size})`}>
        <CheckList
          label="서브넷 연결(Association)"
          items={subnetItems}
          empty="서브넷이 없습니다."
          onToggle={(subnetId, checked) =>
            ctx.actions.run(checked ? "서브넷 연결" : "서브넷 연결 해제", (p) =>
              setSingleRelation(p, subnetId, "route-table-subnet", checked ? rt.id : null),
            )
          }
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- NAT Gateway

export function EipForm({ eip, ctx }: { eip: ResourceOfType<"elastic-ip">; ctx: FormContext }) {
  const target = ctx.analysis.topology.elasticIpTarget(eip.id);
  return (
    <Section title="탄력적 IP">
      <InfoRow label="퍼블릭 IPv4 (가상)" mono>
        {eip.config.publicIp}
      </InfoRow>
      <InfoRow label="연결 대상">{target ? <ResourceLink ctx={ctx} id={target.id} /> : "연결 안 됨"}</InfoRow>
      <Callout>
        탄력적 IP는 바뀌지 않는 고정 퍼블릭 주소입니다. 캔버스에서 EC2 또는 NAT Gateway와 선으로 이으면 연결됩니다. 실제 공인 IP가 아니라 문서용 대역(198.51.100.0/24)의
        가상 주소입니다.
      </Callout>
    </Section>
  );
}

export function NatForm({ nat, ctx }: { nat: ResourceOfType<"nat-gateway">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const subnetId = t.subnetOf(nat.id);
  const eni = t.enisOf(nat.id)[0];
  const cls = subnetId ? t.classifySubnet(subnetId) : null;
  return (
    <>
      <Section title="배치 및 상태">
        <SelectField
          label="서브넷 (퍼블릭 서브넷 권장)"
          value={subnetId ?? ""}
          options={[
            { value: "", label: "배치 안 함" },
            ...t.ofType("subnet").map((s) => ({ value: s.id, label: `${displayName(s)} (${s.config.cidr})` })),
          ]}
          onChange={(v) => ctx.actions.setRelation(nat.id, "nat-gateway-subnet", v || null, "NAT 서브넷 변경")}
        />
        {cls && cls.kind !== "public" && (
          <Callout tone="warn">NAT Gateway가 퍼블릭 서브넷에 있지 않습니다. {cls.reason} NAT를 경유하는 인터넷 통신이 실패합니다.</Callout>
        )}
        <SelectField
          label="가상 상태"
          value={nat.config.state}
          options={[
            { value: "available", label: "Available" },
            { value: "pending", label: "Pending" },
            { value: "failed", label: "Failed" },
          ]}
          onChange={(v) => ctx.actions.updateConfig(nat, { state: v as typeof nat.config.state }, "NAT 상태 변경")}
          hint="Available 상태에서만 트래픽을 처리합니다."
        />
      </Section>
      <Section title="주소 (가상)">
        <InfoRow label="가상 Elastic IP" mono>
          {eni?.publicIp != null ? formatIpv4(eni.publicIp) : "-"}
        </InfoRow>
        <InfoRow label="사설 IP" mono>
          {eni?.privateIp != null ? formatIpv4(eni.privateIp) : "서브넷에 배치하면 배정"}
        </InfoRow>
        <p className="text-[11px] text-muted-foreground">실제 공인 IP가 아니라 문서화용 대역(198.51.100.0/24)의 가상 주소입니다.</p>
      </Section>
      <Section title="사용 중인 경로">
        {t.incoming(nat.id, "route-table-nat-gateway").length === 0 ? (
          <p className="text-xs text-muted-foreground">이 NAT를 대상으로 하는 경로가 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {t.incoming(nat.id, "route-table-nat-gateway").map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <ResourceLink ctx={ctx} id={c.sourceResourceId} />
                <ToneBadge tone="muted">{c.relationType === "route-table-nat-gateway" ? c.metadata.destinationCidr : ""}</ToneBadge>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
