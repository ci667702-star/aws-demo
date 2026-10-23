"use client";

import { useState } from "react";
import { displayName } from "@/lib/engine/topology-engine";
import { CirclePlay, CircleStop, Power } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ToneBadge, type Tone } from "@/components/resource-visuals";
import { healthCheckPort, healthTiming, parseMatcher, TARGET_STATE_LABEL } from "@/lib/engine/alb-engine";
import { awsReservedReason, cidrContainsIp, formatIpv4, parseIpv4, tryParseCidr } from "@/lib/engine/cidr-utils";
import { EC2_AMIS, EC2_INSTANCE_TYPES, type HealthCheck, type ResourceOfType } from "@/lib/engine/resource-models";
import { setListenerTargetGroup, toggleRelation, updateResourceConfig } from "@/lib/project/mutations";
import { useProjectStore } from "@/lib/store/project-store";
import { Callout, CheckList, InfoRow, NumberField, Section, SelectField, TextField } from "./fields";
import { ResourceLink, vpcCompatibility, type FormContext } from "./form-shared";
import { ListenersEditor } from "./rule-editors";

const STATE_TONE: Record<string, Tone> = { running: "ok", pending: "info", stopped: "muted", terminated: "error" };
const AMI_LABEL: Record<(typeof EC2_AMIS)[number], string> = {
  "amazon-linux-2023": "Amazon Linux 2023 (가상)",
  "ubuntu-24.04": "Ubuntu 24.04 (가상)",
  "windows-server-2022": "Windows Server 2022 (가상)",
};

const PENDING_DELAY_MS = 1200;

export function parsePortList(text: string): { ok: true; ports: number[] } | { ok: false; error: string } {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const ports: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,5}$/.test(p)) return { ok: false, error: `"${p}"은(는) 올바른 포트가 아닙니다.` };
    const n = Number(p);
    if (n < 1 || n > 65535) return { ok: false, error: "포트는 1~65535 범위여야 합니다." };
    if (!ports.includes(n)) ports.push(n);
  }
  if (ports.length > 20) return { ok: false, error: "가상 서비스 포트는 최대 20개입니다." };
  return { ok: true, ports: ports.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------- EC2

export function Ec2Form({ ec2, ctx }: { ec2: ResourceOfType<"ec2">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const subnetId = t.subnetOf(ec2.id);
  const eni = t.enisOf(ec2.id)[0];
  const state = ec2.config.state;
  const terminated = state === "terminated";
  const sgIds = new Set(t.securityGroupsOf(ec2.id).map((g) => g.id));
  const publicEnabled = t.ec2PublicIpEnabled(ec2);

  const setState = (next: typeof state, label: string) => ctx.actions.updateConfig(ec2, { state: next }, label);

  const start = () => {
    if (setState("pending", `${displayName(ec2)} 시작 (Stopped → Pending)`)) return;
    setTimeout(() => {
      const current = useProjectStore.getState().projects[ctx.projectId]?.resources.find((r) => r.id === ec2.id);
      if (current?.type === "ec2" && current.config.state === "pending") {
        const r = useProjectStore
          .getState()
          .apply(ctx.projectId, `${displayName(ec2)} 시작 완료 (Pending → Running)`, (p) => updateResourceConfig(p, ec2.id, { state: "running" }));
        if (r.ok) toast.success(`${displayName(ec2)}이(가) Running 상태가 되었습니다. (가상)`);
      }
    }, PENDING_DELAY_MS);
  };

  const validatePrivateIp = (value: string): string | null => {
    const ip = parseIpv4(value.trim());
    if (ip === null) return "올바른 IPv4 주소가 아닙니다. 예: 10.0.1.10";
    if (!subnetId) return null;
    const subnet = t.getOfType(subnetId, "subnet");
    const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
    if (cidr && !cidrContainsIp(cidr, ip)) return `서브넷 ${subnet ? displayName(subnet) : ""}(${cidr.text}) 범위 밖의 주소입니다.`;
    if (cidr) {
      const reserved = awsReservedReason(cidr, ip);
      if (reserved) return `AWS가 예약한 주소입니다 (${reserved}).`;
    }
    const dup = t.enis().find((e) => e.ownerId !== ec2.id && e.vpcId === t.vpcOfSubnet(subnetId) && e.privateIp === ip);
    if (dup) return `${dup.label}이(가) 이미 사용 중인 주소입니다.`;
    return null;
  };

  return (
    <>
      <Section title="가상 인스턴스 상태">
        <div className="flex items-center justify-between gap-2">
          <ToneBadge tone={STATE_TONE[state]} className="h-6 px-2 text-xs">
            {state}
          </ToneBadge>
          <div className="flex flex-wrap justify-end gap-1">
            {state === "stopped" && (
              <Button size="xs" variant="outline" onClick={start}>
                <CirclePlay /> 시작
              </Button>
            )}
            {state === "pending" && (
              <Button size="xs" variant="outline" onClick={() => setState("running", `${displayName(ec2)} Running으로 전환`)}>
                <CirclePlay /> Running으로 전환
              </Button>
            )}
            {(state === "running" || state === "pending") && (
              <Button size="xs" variant="outline" onClick={() => setState("stopped", `${displayName(ec2)} 중지`)}>
                <CircleStop /> 중지
              </Button>
            )}
            {!terminated && (
              <Button size="xs" variant="destructive" onClick={() => setConfirmTerminate(true)}>
                <Power /> 종료
              </Button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          가상 상태만 바뀌며 실제 운영체제는 실행되지 않습니다. Stopped 상태에서는 퍼블릭 IP가 해제되고, Terminated 인스턴스는 다시 시작할 수 없습니다.
        </p>
      </Section>
      <Section title="인스턴스">
        <SelectField
          label="AMI (가상)"
          value={ec2.config.ami}
          options={EC2_AMIS.map((a) => ({ value: a, label: AMI_LABEL[a] }))}
          onChange={(v) => ctx.actions.updateConfig(ec2, { ami: v as typeof ec2.config.ami }, "AMI 변경")}
          disabled={terminated}
        />
        <SelectField
          label="인스턴스 유형"
          value={ec2.config.instanceType}
          options={EC2_INSTANCE_TYPES.map((x) => ({ value: x, label: x }))}
          onChange={(v) => ctx.actions.updateConfig(ec2, { instanceType: v as typeof ec2.config.instanceType }, "인스턴스 유형 변경")}
          disabled={terminated}
          hint="가상 설정이며 비용 추정에만 사용됩니다."
        />
      </Section>
      <Section title="네트워크">
        <SelectField
          label="서브넷"
          value={subnetId ?? ""}
          options={[
            { value: "", label: "배치 안 함" },
            ...t.ofType("subnet").map((s) => ({ value: s.id, label: `${displayName(s)} (${s.config.cidr}, ${s.config.availabilityZone})` })),
          ]}
          onChange={(v) => ctx.actions.setRelation(ec2.id, "ec2-subnet", v || null, "EC2 서브넷 변경")}
          testId="ec2-subnet"
          hint="서브넷을 바꾸면 범위 밖의 사설 IP는 자동으로 다시 할당됩니다."
        />
        <TextField
          label="사설 IPv4"
          value={ec2.config.privateIp}
          mono
          testId="ec2-private-ip"
          validate={validatePrivateIp}
          onCommit={(v) => ctx.actions.updateConfig(ec2, { privateIp: v.trim() }, "사설 IP 변경")}
          hint={subnetId ? `제안: ${t.suggestPrivateIp(subnetId, ec2.id) ?? "-"}` : "서브넷에 배치하면 자동 할당됩니다."}
        />
        <SelectField
          label="퍼블릭 IPv4 할당"
          value={ec2.config.publicIpMode}
          options={[
            { value: "subnet-default", label: "서브넷 설정 따름" },
            { value: "enabled", label: "활성화" },
            { value: "disabled", label: "비활성화" },
          ]}
          onChange={(v) => ctx.actions.updateConfig(ec2, { publicIpMode: v as typeof ec2.config.publicIpMode }, "퍼블릭 IP 설정 변경")}
          testId="ec2-public-ip"
          hint={publicEnabled ? "퍼블릭 IP가 할당됩니다 (가상)." : "퍼블릭 IP가 할당되지 않습니다."}
        />
        <InfoRow label="가상 퍼블릭 IP" mono>
          {eni?.publicIp != null ? formatIpv4(eni.publicIp) : state === "stopped" ? "없음 (중지됨)" : "없음"}
        </InfoRow>
        <InfoRow label="VPC">
          <ResourceLink ctx={ctx} id={t.vpcOf(ec2.id)} />
        </InfoRow>
        <InfoRow label="사설 DNS (가상)" mono>
          {t.dnsName(ec2.id) ?? "-"}
        </InfoRow>
      </Section>
      <Section title={`보안 그룹 (${sgIds.size})`}>
        <CheckList
          label="연결할 보안 그룹 (최대 5개)"
          empty="보안 그룹이 없습니다. 팔레트에서 Security Group을 추가하세요."
          items={t.ofType("security-group").map((g) => {
            const compat = vpcCompatibility(ctx, ec2.id, g.id);
            return {
              id: g.id,
              label: displayName(g),
              description: g.config.description || `인바운드 ${g.config.inboundRules.length} · 아웃바운드 ${g.config.outboundRules.length}`,
              checked: sgIds.has(g.id),
              disabled: !sgIds.has(g.id) && (!compat.ok || sgIds.size >= 5),
              disabledReason: !compat.ok ? compat.reason : sgIds.size >= 5 ? "최대 5개까지 연결할 수 있습니다." : undefined,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "보안 그룹 연결" : "보안 그룹 연결 해제", (p) => toggleRelation(p, ec2.id, id, checked))}
        />
      </Section>
      <Section title="가상 애플리케이션 (시뮬레이션 가정)">
        <TextField
          label="가상 서비스 포트"
          value={ec2.config.listenPorts.join(", ")}
          mono
          validate={(v) => {
            const r = parsePortList(v);
            return r.ok ? null : r.error;
          }}
          onCommit={(v) => {
            const r = parsePortList(v);
            return r.ok ? ctx.actions.updateConfig(ec2, { listenPorts: r.ports }, "가상 서비스 포트 변경") : r.error;
          }}
          hint="이 포트로 온 요청에만 응답한다고 가정합니다. 예: 22, 80"
        />
        <NumberField
          label="가상 HTTP 응답 코드"
          value={ec2.config.httpResponseCode}
          min={100}
          max={599}
          onCommit={(v) => ctx.actions.updateConfig(ec2, { httpResponseCode: v }, "가상 응답 코드 변경")}
          hint="헬스 체크 성공 코드(matcher)와 비교됩니다. 예: 200, 500"
        />
      </Section>
      <Section title="대상 그룹 등록">
        <CheckList
          label="이 인스턴스를 대상으로 등록할 대상 그룹"
          empty="대상 그룹이 없습니다."
          items={t.ofType("target-group").map((tg) => {
            const registered = t.targetGroupTargets(tg.id).some((x) => x.ec2.id === ec2.id);
            const compat = vpcCompatibility(ctx, ec2.id, tg.id);
            return {
              id: tg.id,
              label: `${displayName(tg)} (${tg.config.protocol}:${tg.config.port})`,
              checked: registered,
              disabled: !registered && (terminated || !compat.ok),
              disabledReason: terminated ? "종료된 인스턴스는 등록할 수 없습니다." : compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "대상 등록" : "대상 등록 해제", (p) => toggleRelation(p, ec2.id, id, checked))}
        />
      </Section>
      <AlertDialog open={confirmTerminate} onOpenChange={setConfirmTerminate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ec2.name}을(를) 종료할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              Terminated 상태의 인스턴스는 다시 Running으로 전환할 수 없습니다. (가상 상태 전환이며 실행 취소로 되돌릴 수는 있습니다.)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => setState("terminated", `${displayName(ec2)} 종료`)}>
              종료
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------- ALB

export function AlbForm({ alb, ctx }: { alb: ResourceOfType<"alb">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const subnets = t.albSubnets(alb.id);
  const subnetIds = new Set(subnets.map((s) => s.id));
  const usedAzs = new Map(subnets.map((s) => [s.config.availabilityZone, displayName(s)]));
  const sgIds = new Set(t.securityGroupsOf(alb.id).map((g) => g.id));
  const bindings = Object.fromEntries(t.listenersOf(alb.id).map((b) => [b.listener.id, b.targetGroupId]));
  const nodes = t.enisOf(alb.id);
  return (
    <>
      <Section title="기본 설정">
        <SelectField
          label="Scheme"
          value={alb.config.scheme}
          options={[
            { value: "internet-facing", label: "Internet-facing (인터넷에서 접근)" },
            { value: "internal", label: "Internal (VPC 내부 전용)" },
          ]}
          onChange={(v) => ctx.actions.updateConfig(alb, { scheme: v as typeof alb.config.scheme }, "ALB Scheme 변경")}
          hint="internet-facing ALB는 퍼블릭 서브넷에 배치해야 합니다."
        />
        <InfoRow label="가상 DNS 이름" mono>
          {t.dnsName(alb.id)}
        </InfoRow>
      </Section>
      <Section title={`서브넷 / 가용 영역 (${subnets.length})`}>
        <CheckList
          label="ALB 노드를 둘 서브넷 (가용 영역당 1개, 최소 2개 AZ)"
          empty="서브넷이 없습니다."
          items={t.ofType("subnet").map((s) => {
            const checked = subnetIds.has(s.id);
            const compat = vpcCompatibility(ctx, alb.id, s.id);
            const azTaken = !checked && usedAzs.has(s.config.availabilityZone);
            return {
              id: s.id,
              label: `${displayName(s)} (${s.config.availabilityZone})`,
              description: t.classifySubnet(s.id).kind === "public" ? "퍼블릭 서브넷" : "프라이빗 서브넷",
              checked,
              disabled: !checked && (!compat.ok || azTaken),
              disabledReason: !compat.ok ? compat.reason : azTaken ? `이 가용 영역에는 이미 ${usedAzs.get(s.config.availabilityZone)}이(가) 있습니다.` : undefined,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "ALB 서브넷 추가" : "ALB 서브넷 제거", (p) => toggleRelation(p, alb.id, id, checked))}
        />
        {nodes.length > 0 && (
          <div className="overflow-hidden rounded-md border text-xs">
            <div className="grid grid-cols-3 bg-muted/50 px-2 py-1 font-medium text-muted-foreground">
              <span>가용 영역</span>
              <span>사설 IP</span>
              <span>퍼블릭 IP (가상)</span>
            </div>
            {nodes.map((n) => (
              <div key={n.id} className="grid grid-cols-3 border-t px-2 py-1 font-mono">
                <span className="font-sans">{t.getOfType(n.subnetId, "subnet")?.config.availabilityZone.replace("ap-northeast-", "") ?? "-"}</span>
                <span>{n.privateIp != null ? formatIpv4(n.privateIp) : "-"}</span>
                <span>{n.publicIp != null ? formatIpv4(n.publicIp) : "-"}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title={`보안 그룹 (${sgIds.size})`}>
        <CheckList
          label="ALB 보안 그룹"
          empty="보안 그룹이 없습니다."
          items={t.ofType("security-group").map((g) => {
            const compat = vpcCompatibility(ctx, alb.id, g.id);
            return {
              id: g.id,
              label: displayName(g),
              checked: sgIds.has(g.id),
              disabled: !sgIds.has(g.id) && !compat.ok,
              disabledReason: compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "보안 그룹 연결" : "보안 그룹 연결 해제", (p) => toggleRelation(p, alb.id, id, checked))}
        />
      </Section>
      <Section title={`리스너 (${alb.config.listeners.length})`}>
        <ListenersEditor
          listeners={alb.config.listeners}
          bindings={bindings}
          targetGroups={t.ofType("target-group").map((tg) => {
            const otherAlb = t.targetGroupAlbs(tg.id).find((a) => a.id !== alb.id);
            return {
              value: tg.id,
              label: `${displayName(tg)} (${tg.config.protocol}:${tg.config.port})${otherAlb ? ` — ${displayName(otherAlb)}에서 사용 중` : ""}`,
              disabled: !!otherAlb,
            };
          })}
          onListenersChange={(listeners) => ctx.actions.updateConfig(alb, { listeners }, "리스너 변경")}
          onTargetGroupChange={(listenerId, tgId) =>
            ctx.actions.run("리스너 대상 그룹 변경", (p) => setListenerTargetGroup(p, alb.id, listenerId, tgId))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          쉬운 모드에서는 리스너의 기본 작업(전달)만 편집합니다. 경로 기반 규칙(예: /api/* → 다른 대상 그룹, 고정 응답)은 심화 모드의 로드 밸런서 화면에서 설정할 수
          있습니다.
          {alb.config.listeners.some((l) => (l.rules ?? []).length > 0) && " 이 로드 밸런서에는 경로 규칙이 설정되어 있습니다."}
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Target Group

export function TargetGroupForm({ tg, ctx }: { tg: ResourceOfType<"target-group">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const hc = tg.config.healthCheck;
  const health = ctx.analysis.health.get(tg.id) ?? [];
  const registered = new Set(t.targetGroupTargets(tg.id).map((x) => x.ec2.id));
  const timing = healthTiming(hc);
  const setHc = (patch: Partial<HealthCheck>, label: string) =>
    ctx.actions.updateConfig(tg, { healthCheck: { ...hc, ...patch } }, label);
  return (
    <>
      <Section title="기본 설정">
        <SelectField
          label="프로토콜"
          value={tg.config.protocol}
          options={[
            { value: "HTTP", label: "HTTP" },
            { value: "HTTPS", label: "HTTPS" },
          ]}
          onChange={(v) => ctx.actions.updateConfig(tg, { protocol: v as typeof tg.config.protocol }, "대상 그룹 프로토콜 변경")}
        />
        <NumberField
          label="대상 포트"
          value={tg.config.port}
          min={1}
          max={65535}
          onCommit={(v) => ctx.actions.updateConfig(tg, { port: v }, "대상 포트 변경")}
          hint="ALB가 대상 EC2로 요청을 보낼 포트입니다."
        />
        <div className="text-sm">
          <span className="text-xs text-muted-foreground">사용 중인 ALB: </span>
          {t.targetGroupAlbs(tg.id).length ? (
            t.targetGroupAlbs(tg.id).map((a) => <ResourceLink key={a.id} ctx={ctx} id={a.id} />)
          ) : (
            <span className="text-xs text-muted-foreground">없음</span>
          )}
        </div>
      </Section>
      <Section title={`대상 (${registered.size})`}>
        <CheckList
          label="등록할 EC2"
          empty="EC2가 없습니다."
          items={t.ofType("ec2").map((e) => {
            const compat = vpcCompatibility(ctx, tg.id, e.id);
            const isReg = registered.has(e.id);
            return {
              id: e.id,
              label: `${displayName(e)} (${e.config.privateIp || "IP 없음"})`,
              description: e.config.state,
              checked: isReg,
              disabled: !isReg && (e.config.state === "terminated" || !compat.ok),
              disabledReason: e.config.state === "terminated" ? "종료된 인스턴스" : compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "대상 등록" : "대상 등록 해제", (p) => toggleRelation(p, tg.id, id, checked))}
        />
        {health.length > 0 && (
          <div className="overflow-hidden rounded-md border text-xs" data-testid="target-health">
            <div className="bg-muted/50 px-2 py-1 font-medium text-muted-foreground">가상 대상 상태</div>
            {health.map((h) => (
              <div key={h.targetId} className="space-y-0.5 border-t px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <ResourceLink ctx={ctx} id={h.targetId} />
                  <ToneBadge tone={h.state === "healthy" ? "ok" : h.state === "unhealthy" ? "error" : "muted"}>{TARGET_STATE_LABEL[h.state]}</ToneBadge>
                </div>
                {h.reasonCode && <p className="font-mono text-[10px] text-muted-foreground">{h.reasonCode}</p>}
                <p className="text-muted-foreground">{h.reason}</p>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="가상 헬스 체크">
        <SelectField
          label="프로토콜"
          value={hc.protocol}
          options={[
            { value: "HTTP", label: "HTTP" },
            { value: "HTTPS", label: "HTTPS" },
          ]}
          onChange={(v) => setHc({ protocol: v as HealthCheck["protocol"] }, "헬스 체크 프로토콜 변경")}
        />
        <TextField
          label="경로"
          value={hc.path}
          mono
          maxLength={1024}
          validate={(v) => (v.startsWith("/") ? null : '경로는 "/"로 시작해야 합니다.')}
          onCommit={(v) => setHc({ path: v }, "헬스 체크 경로 변경")}
        />
        <SelectField
          label="포트"
          value={hc.port === "traffic-port" ? "traffic-port" : "override"}
          options={[
            { value: "traffic-port", label: `traffic-port (대상 포트 ${tg.config.port})` },
            { value: "override", label: "직접 지정" },
          ]}
          onChange={(v) => setHc({ port: v === "traffic-port" ? "traffic-port" : tg.config.port }, "헬스 체크 포트 변경")}
        />
        {hc.port !== "traffic-port" && (
          <NumberField label="헬스 체크 포트" value={hc.port} min={1} max={65535} onCommit={(v) => setHc({ port: v }, "헬스 체크 포트 변경")} />
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="정상 임계값" value={hc.healthyThreshold} min={2} max={10} onCommit={(v) => setHc({ healthyThreshold: v }, "정상 임계값 변경")} />
          <NumberField label="비정상 임계값" value={hc.unhealthyThreshold} min={2} max={10} onCommit={(v) => setHc({ unhealthyThreshold: v }, "비정상 임계값 변경")} />
          <TextField
            label="제한 시간(초)"
            value={String(hc.timeoutSeconds)}
            validate={(v) => {
              if (!/^\d+$/.test(v)) return "정수를 입력하세요.";
              const n = Number(v);
              if (n < 2 || n > 120) return "2~120초 사이여야 합니다.";
              if (n >= hc.intervalSeconds) return `간격(${hc.intervalSeconds}초)보다 짧아야 합니다.`;
              return null;
            }}
            onCommit={(v) => setHc({ timeoutSeconds: Number(v) }, "헬스 체크 제한 시간 변경")}
          />
          <TextField
            label="간격(초)"
            value={String(hc.intervalSeconds)}
            validate={(v) => {
              if (!/^\d+$/.test(v)) return "정수를 입력하세요.";
              const n = Number(v);
              if (n < 5 || n > 300) return "5~300초 사이여야 합니다.";
              if (n <= hc.timeoutSeconds) return `제한 시간(${hc.timeoutSeconds}초)보다 길어야 합니다.`;
              return null;
            }}
            onCommit={(v) => setHc({ intervalSeconds: Number(v) }, "헬스 체크 간격 변경")}
          />
        </div>
        <TextField
          label="성공 코드 (matcher)"
          value={hc.matcher}
          mono
          maxLength={64}
          validate={(v) => {
            const r = parseMatcher(v);
            return r.ok ? null : r.error;
          }}
          onCommit={(v) => setHc({ matcher: v.trim() }, "성공 코드 변경")}
          hint="예: 200, 200-299, 200,302"
        />
        <Callout>
          가상 헬스 체크: ALB 노드 → 대상 {hc.protocol}:{healthCheckPort(tg)}
          {hc.path} 경로를 보안 그룹·NACL·라우팅·가상 서비스 포트·응답 코드로 계산합니다. 실제 HTTP 요청은 보내지 않습니다. 설정상 정상 판정까지 약{" "}
          {timing.secondsToHealthy}초, 비정상 판정까지 약 {timing.secondsToUnhealthy}초가 걸립니다(임계값 × 간격).
        </Callout>
      </Section>
    </>
  );
}
