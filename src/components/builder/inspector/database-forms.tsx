"use client";

import { formatIpv4 } from "@/lib/engine/cidr-utils";
import { displayName } from "@/lib/engine/topology-engine";
import { RDS_DEFAULT_PORT, RDS_INSTANCE_CLASSES, type ResourceOfType } from "@/lib/engine/resource-models";
import { toggleRelation } from "@/lib/project/mutations";
import { Callout, CheckList, InfoRow, NumberField, Section, SelectField, SwitchField, TextField } from "./fields";
import { ResourceLink, ResourceList, SubnetKindBadge, vpcCompatibility, type FormContext } from "./form-shared";

export function DbSubnetGroupForm({ group, ctx }: { group: ResourceOfType<"db-subnet-group">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const subnets = t.dbSubnetGroupSubnets(group.id);
  const ids = new Set(subnets.map((s) => s.id));
  const azs = new Set(subnets.map((s) => s.config.availabilityZone));
  const users = t.ofType("rds").filter((r) => t.dbSubnetGroupOf(r.id)?.id === group.id);
  return (
    <>
      <Section title="기본 설정">
        <TextField
          label="설명"
          value={group.config.description}
          maxLength={255}
          onCommit={(v) => ctx.actions.updateConfig(group, { description: v }, "DB 서브넷 그룹 설명 변경")}
        />
        <Callout tone={subnets.length >= 2 && azs.size >= 2 ? "info" : "warn"}>
          서브넷 {subnets.length}개 · 가용 영역 {azs.size}개 — DB 서브넷 그룹은 서로 다른 가용 영역의 서브넷이 최소 2개 필요합니다.
        </Callout>
      </Section>
      <Section title="서브넷">
        <CheckList
          label="포함할 서브넷 (프라이빗 서브넷 권장)"
          empty="서브넷이 없습니다."
          items={t.ofType("subnet").map((s) => {
            const compat = vpcCompatibility(ctx, group.id, s.id);
            return {
              id: s.id,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {displayName(s)} <span className="text-xs text-muted-foreground">({s.config.availabilityZone})</span>
                  <SubnetKindBadge ctx={ctx} subnetId={s.id} />
                </span>
              ),
              checked: ids.has(s.id),
              disabled: !ids.has(s.id) && !compat.ok,
              disabledReason: compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "DB 서브넷 추가" : "DB 서브넷 제거", (p) => toggleRelation(p, group.id, id, checked))}
        />
      </Section>
      <Section title="사용 중인 RDS">
        <ResourceList ctx={ctx} resources={users} empty="이 그룹을 사용하는 RDS가 없습니다." />
      </Section>
    </>
  );
}

export function RdsForm({ rds, ctx }: { rds: ResourceOfType<"rds">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const group = t.dbSubnetGroupOf(rds.id);
  const placement = t.rdsPlacement(rds.id);
  const eni = t.enisOf(rds.id)[0];
  const sgIds = new Set(t.securityGroupsOf(rds.id).map((g) => g.id));
  return (
    <>
      <Section title="데이터베이스 (가상)">
        <SelectField
          label="엔진"
          value={rds.config.engine}
          options={[
            { value: "mysql", label: "MySQL" },
            { value: "postgres", label: "PostgreSQL" },
          ]}
          onChange={(v) => {
            const engine = v as typeof rds.config.engine;
            const port = rds.config.port === RDS_DEFAULT_PORT[rds.config.engine] ? RDS_DEFAULT_PORT[engine] : rds.config.port;
            ctx.actions.updateConfig(rds, { engine, port }, "DB 엔진 변경");
          }}
        />
        <SelectField
          label="인스턴스 클래스"
          value={rds.config.instanceClass}
          options={RDS_INSTANCE_CLASSES.map((c) => ({ value: c, label: c }))}
          onChange={(v) => ctx.actions.updateConfig(rds, { instanceClass: v as typeof rds.config.instanceClass }, "인스턴스 클래스 변경")}
        />
        <NumberField
          label="포트"
          value={rds.config.port}
          min={1150}
          max={65535}
          onCommit={(v) => ctx.actions.updateConfig(rds, { port: v }, "DB 포트 변경")}
          hint={`기본값: MySQL 3306, PostgreSQL 5432 (RDS 허용 범위 1150~65535)`}
        />
        <NumberField
          label="스토리지 (GB)"
          value={rds.config.allocatedStorageGb}
          min={20}
          max={65536}
          onCommit={(v) => ctx.actions.updateConfig(rds, { allocatedStorageGb: v }, "스토리지 변경")}
        />
        <SelectField
          label="가상 상태"
          value={rds.config.state}
          options={[
            { value: "available", label: "Available" },
            { value: "stopped", label: "Stopped" },
          ]}
          onChange={(v) => ctx.actions.updateConfig(rds, { state: v as typeof rds.config.state }, "RDS 상태 변경")}
        />
        <Callout>실제 데이터베이스는 실행되지 않습니다. 시뮬레이션은 네트워크 경로와 포트 접근 가능 여부만 검사하며 SQL을 실행하지 않습니다.</Callout>
      </Section>
      <Section title="네트워크">
        <SelectField
          label="DB 서브넷 그룹"
          value={group?.id ?? ""}
          options={[{ value: "", label: "선택 안 함" }, ...t.ofType("db-subnet-group").map((g) => ({ value: g.id, label: g.name }))]}
          onChange={(v) => ctx.actions.setRelation(rds.id, "rds-db-subnet-group", v || null, "DB 서브넷 그룹 변경")}
        />
        <SwitchField
          label="Publicly Accessible"
          description="켜면 외부에서 엔드포인트가 퍼블릭 IP로 해석됩니다. 실제 접근은 퍼블릭 서브넷 경로와 보안 그룹에 따라 결정됩니다."
          checked={rds.config.publiclyAccessible}
          onChange={(v) => ctx.actions.updateConfig(rds, { publiclyAccessible: v }, "Publicly Accessible 변경")}
        />
        <SwitchField
          label="Multi-AZ"
          description="다른 가용 영역에 대기 인스턴스를 둡니다 (연결 시뮬레이션에는 영향 없음)."
          checked={rds.config.multiAz}
          onChange={(v) => ctx.actions.updateConfig(rds, { multiAz: v }, "Multi-AZ 변경")}
        />
        <InfoRow label="가상 엔드포인트" mono>
          {t.dnsName(rds.id)}
        </InfoRow>
        <InfoRow label="기본 인스턴스 서브넷">
          <ResourceLink ctx={ctx} id={placement.primary?.id} />
        </InfoRow>
        {rds.config.multiAz && (
          <InfoRow label="대기 인스턴스 서브넷">
            <ResourceLink ctx={ctx} id={placement.standby?.id} />
          </InfoRow>
        )}
        <InfoRow label="사설 IP" mono>
          {eni?.privateIp != null ? formatIpv4(eni.privateIp) : "-"}
        </InfoRow>
        <InfoRow label="가상 퍼블릭 IP" mono>
          {eni?.publicIp != null ? formatIpv4(eni.publicIp) : "없음"}
        </InfoRow>
      </Section>
      <Section title={`보안 그룹 (${sgIds.size})`}>
        <CheckList
          label="DB 보안 그룹"
          empty="보안 그룹이 없습니다."
          items={t.ofType("security-group").map((g) => {
            const compat = vpcCompatibility(ctx, rds.id, g.id);
            return {
              id: g.id,
              label: displayName(g),
              checked: sgIds.has(g.id),
              disabled: !sgIds.has(g.id) && !compat.ok,
              disabledReason: compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "보안 그룹 연결" : "보안 그룹 연결 해제", (p) => toggleRelation(p, rds.id, id, checked))}
        />
      </Section>
    </>
  );
}
