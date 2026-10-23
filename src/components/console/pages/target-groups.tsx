"use client";

import { useState } from "react";
import type { TargetHealth } from "@/lib/engine/alb-engine";
import type { HealthCheck, ResourceOfType } from "@/lib/engine/resource-models";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import { createTargetGroup, deleteTargetGroup, deregisterTargets, editTargetGroupHealthCheck, registerTargets } from "@/lib/project/console-actions";
import { DEFAULT_HEALTH_CHECK } from "@/lib/project/factory";
import { useAnalysis } from "../analysis-context";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { Checkbox, FormActions, FormField, SelectInput, TextInput, Tiles } from "../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { CopyText, StatusIndicator } from "../ui/status";
import { InstanceState, ResourceNotFound, useQueryTab, useResource, useSelection, useTopology } from "./common";

type Tg = ResourceOfType<"target-group">;

export function HealthStatus({ h }: { h: TargetHealth | undefined }) {
  if (!h) return <StatusIndicator type="pending">확인 전</StatusIndicator>;
  const type = h.state === "healthy" ? "success" : h.state === "unhealthy" ? "error" : h.state === "unused" ? "stopped" : "info";
  return (
    <span className="space-y-0.5">
      <StatusIndicator type={type}>{h.state}</StatusIndicator>
      {h.reasonCode && <span className="block text-xs text-aws-text-2">{h.reasonCode}</span>}
    </span>
  );
}

function healthSummary(health: TargetHealth[] | undefined) {
  if (!health?.length) return "대상 없음";
  const healthy = health.filter((h) => h.state === "healthy").length;
  return `정상 ${healthy} / 전체 ${health.length}`;
}

function DeleteTgModal({ tg, onClose }: { tg: Tg | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!tg) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="대상 그룹 삭제"
      onConfirm={() => {
        const r = run("DeleteTargetGroup", (p) => deleteTargetGroup(p, tg.id), { success: () => `대상 그룹 ${tg.name}을(를) 삭제했습니다.` });
        if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
        navigate("/ec2/target-groups");
        return null;
      }}
    >
      <p>
        대상 그룹 <strong>{tg.name}</strong>을(를) 삭제하시겠습니까? 등록된 대상은 등록 해제됩니다.
      </p>
    </DeleteModal>
  );
}

export function TargetGroupListPage() {
  const topo = useTopology();
  const { health } = useAnalysis();
  const tgs = topo.ofType("target-group");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = tgs.find((t) => t.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Tg>
        ariaLabel="대상 그룹 목록"
        items={tgs}
        trackBy={(t) => t.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(t) => t.name}
        header={
          <PageHeader
            title="대상 그룹"
            counter={`(${tgs.length})`}
            info={<InfoLink topic="target-group" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "targets", text: "대상 등록 및 등록 취소", disabled: !current },
                    { id: "health", text: "상태 검사 설정 편집", disabled: !current },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (!current) return;
                    if (id === "targets") navigate(resourcePath("target-group", current.id), { query: { tab: "targets" } });
                    if (id === "health") navigate(`${resourcePath("target-group", current.id)}/edit-health-check`);
                    if (id === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/ec2/target-groups/create")}>
                  대상 그룹 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="대상 그룹 없음" description="로드 밸런서가 요청을 보낼 인스턴스 묶음을 만드세요." action={<ButtonLink href={href("/ec2/target-groups/create")}>대상 그룹 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (t) => <TypedResourceLink type="target-group" id={t.id}>{t.name}</TypedResourceLink>, sortValue: (t) => t.name },
          { id: "id", header: "ID", cell: (t) => <span className="font-mono text-[13px] text-aws-text-2">{t.id}</span>, sortValue: (t) => t.id },
          { id: "port", header: "포트", cell: (t) => t.config.port, sortValue: (t) => t.config.port },
          { id: "protocol", header: "프로토콜", cell: (t) => t.config.protocol },
          { id: "type", header: "대상 유형", cell: () => "Instance" },
          { id: "lb", header: "로드 밸런서", cell: (t) => topo.targetGroupAlbs(t.id).map((a) => <ResourceLink key={a.id} id={a.id} showName />) },
          { id: "vpc", header: "VPC ID", cell: (t) => <ResourceLink id={topo.vpcOf(t.id)} /> },
          { id: "health", header: "상태", cell: (t) => healthSummary(health.get(t.id)) },
        ]}
      />
      <DeleteTgModal tg={deleting ? current : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 상태 검사 필드

interface HcDraft {
  protocol: "HTTP" | "HTTPS";
  path: string;
  portMode: "traffic-port" | "override";
  port: string;
  healthy: string;
  unhealthy: string;
  timeout: string;
  interval: string;
  matcher: string;
}

function hcDraftFrom(hc: HealthCheck): HcDraft {
  return {
    protocol: hc.protocol,
    path: hc.path,
    portMode: hc.port === "traffic-port" ? "traffic-port" : "override",
    port: hc.port === "traffic-port" ? "" : String(hc.port),
    healthy: String(hc.healthyThreshold),
    unhealthy: String(hc.unhealthyThreshold),
    timeout: String(hc.timeoutSeconds),
    interval: String(hc.intervalSeconds),
    matcher: hc.matcher,
  };
}

function hcFromDraft(d: HcDraft): { ok: true; value: HealthCheck } | { ok: false; error: string } {
  const num = (v: string, label: string) => {
    if (!/^\d+$/.test(v.trim())) throw new Error(`${label}은(는) 숫자여야 합니다.`);
    return Number(v);
  };
  try {
    return {
      ok: true,
      value: {
        protocol: d.protocol,
        path: d.path,
        port: d.portMode === "traffic-port" ? "traffic-port" : num(d.port, "상태 검사 포트"),
        healthyThreshold: num(d.healthy, "정상 임계값"),
        unhealthyThreshold: num(d.unhealthy, "비정상 임계값"),
        timeoutSeconds: num(d.timeout, "제한 시간"),
        intervalSeconds: num(d.interval, "간격"),
        matcher: d.matcher.trim(),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function HealthCheckFields({ draft, onChange }: { draft: HcDraft; onChange: (d: HcDraft) => void }) {
  const set = (patch: Partial<HcDraft>) => onChange({ ...draft, ...patch });
  return (
    <SpaceBetween size="m">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="상태 검사 프로토콜">
          <SelectInput value={draft.protocol} onChange={(v) => set({ protocol: v as "HTTP" | "HTTPS" })} options={[{ value: "HTTP", label: "HTTP" }, { value: "HTTPS", label: "HTTPS" }]} />
        </FormField>
        <FormField label="상태 검사 경로" constraint="/로 시작, 최대 1024자">
          <TextInput value={draft.path} onChange={(e) => set({ path: e.target.value })} placeholder="/" />
        </FormField>
      </div>
      <ExpandableSection header="고급 상태 검사 설정">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="상태 검사 포트">
            <SelectInput value={draft.portMode} onChange={(v) => set({ portMode: v as HcDraft["portMode"] })} options={[{ value: "traffic-port", label: "트래픽 포트" }, { value: "override", label: "재정의" }]} />
          </FormField>
          {draft.portMode === "override" && (
            <FormField label="포트">
              <TextInput value={draft.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" />
            </FormField>
          )}
          <FormField label="정상 임계값" constraint="2~10">
            <TextInput value={draft.healthy} onChange={(e) => set({ healthy: e.target.value })} inputMode="numeric" />
          </FormField>
          <FormField label="비정상 임계값" constraint="2~10">
            <TextInput value={draft.unhealthy} onChange={(e) => set({ unhealthy: e.target.value })} inputMode="numeric" />
          </FormField>
          <FormField label="제한 시간 (초)" constraint="2~120">
            <TextInput value={draft.timeout} onChange={(e) => set({ timeout: e.target.value })} inputMode="numeric" />
          </FormField>
          <FormField label="간격 (초)" constraint="5~300, 제한 시간보다 커야 함">
            <TextInput value={draft.interval} onChange={(e) => set({ interval: e.target.value })} inputMode="numeric" />
          </FormField>
          <FormField label="성공 코드" constraint='예: 200, 200-299, 200,302'>
            <TextInput value={draft.matcher} onChange={(e) => set({ matcher: e.target.value })} />
          </FormField>
        </div>
      </ExpandableSection>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 생성

export function CreateTargetGroupPage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"HTTP" | "HTTPS">("HTTP");
  const [port, setPort] = useState("80");
  const [vpcId, setVpcId] = useState(vpcs.length === 1 ? vpcs[0].id : "");
  const [hc, setHc] = useState<HcDraft>(() => hcDraftFrom(DEFAULT_HEALTH_CHECK));
  const [checked, setChecked] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const instances = topo.ofType("ec2").filter((i) => i.config.state !== "terminated" && topo.vpcOf(i.id) === vpcId);

  const next = () => {
    setError(null);
    if (!/^(?!-)[A-Za-z0-9-]{1,32}(?<!-)$/.test(name.trim())) return setError("[ValidationError] 대상 그룹 이름은 1~32자의 영문자, 숫자, 하이픈만 사용할 수 있고 하이픈으로 시작하거나 끝날 수 없습니다.");
    if (!vpcId) return setError("[ValidationError] VPC를 선택하세요.");
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return setError("[ValidationError] 포트는 1~65535 사이여야 합니다.");
    const h = hcFromDraft(hc);
    if (!h.ok) return setError(h.error);
    setStep(2);
  };
  const create = () => {
    const h = hcFromDraft(hc);
    if (!h.ok) return setError(h.error);
    const r = run("CreateTargetGroup", (p) => createTargetGroup(p, { name, protocol, port: Number(port), vpcId, healthCheck: h.value, targetIds: pending }), {
      success: () => `대상 그룹 ${name.trim()}을(를) 생성했습니다.`,
    });
    if (r.ok && r.createdId) navigate(resourcePath("target-group", r.createdId));
    else if (!r.ok) setError(r.error);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="대상 그룹 생성" info={<InfoLink topic="target-group" />} description={step === 1 ? "1단계: 그룹 세부 정보 지정" : "2단계: 대상 등록"} />
      <ol className="flex flex-wrap gap-4 text-sm" aria-label="단계">
        {["그룹 세부 정보 지정", "대상 등록"].map((label, i) => (
          <li key={label} className={i + 1 === step ? "font-bold text-aws-link" : "text-aws-text-2"} aria-current={i + 1 === step ? "step" : undefined}>
            {i + 1}단계 · {label}
          </li>
        ))}
      </ol>
      {step === 1 ? (
        <SpaceBetween>
          <Container header={<ContainerHeader title="기본 구성" />}>
            <SpaceBetween size="m">
              <FormField label="대상 유형 선택">
                <Tiles aria-label="대상 유형" value="instance" onChange={() => undefined} columns={2} items={[{ value: "instance", label: "인스턴스", description: "특정 VPC 안의 인스턴스로 로드 밸런싱" }]} />
              </FormField>
              <FormField label="대상 그룹 이름" constraint="1~32자의 영문자, 숫자, 하이픈. 하이픈으로 시작하거나 끝날 수 없습니다. 만든 뒤에는 바꿀 수 없습니다.">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-target-group" maxLength={32} />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="프로토콜">
                  <SelectInput value={protocol} onChange={(v) => setProtocol(v as "HTTP" | "HTTPS")} options={[{ value: "HTTP", label: "HTTP" }, { value: "HTTPS", label: "HTTPS" }]} />
                </FormField>
                <FormField label="포트" constraint="대상이 트래픽을 받는 포트">
                  <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
                </FormField>
              </div>
              <FormField label="VPC" description="대상으로 등록할 인스턴스가 있는 VPC">
                <SelectInput value={vpcId} onChange={(v) => { setVpcId(v); setPending([]); setChecked([]); }} placeholder="VPC 선택" options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))} />
              </FormField>
            </SpaceBetween>
          </Container>
          <Container header={<ContainerHeader title="상태 검사" info={<InfoLink topic="health-check" />} description="로드 밸런서는 이 설정으로 대상에 주기적으로 요청을 보내 정상 여부를 확인합니다." />}>
            <HealthCheckFields draft={hc} onChange={setHc} />
          </Container>
          <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
            <ButtonLink variant="link" href={href("/ec2/target-groups")}>
              취소
            </ButtonLink>
            <Button variant="primary" onClick={next}>
              다음
            </Button>
          </FormActions>
        </SpaceBetween>
      ) : (
        <SpaceBetween>
          <Container header={<ContainerHeader title={`사용 가능한 인스턴스 (${instances.length})`} description={`VPC ${vpcId}의 종료되지 않은 인스턴스`} />}>
            {instances.length ? (
              <SpaceBetween size="m">
                <ul className="divide-y divide-aws-divider">
                  {instances.map((i) => (
                    <li key={i.id} className="py-2">
                      <Checkbox checked={checked.includes(i.id)} onChange={(v) => setChecked(v ? [...checked, i.id] : checked.filter((x) => x !== i.id))} description={`${i.config.privateIp} · ${topo.getOfType(topo.subnetOf(i.id), "subnet")?.config.availabilityZone ?? ""}`}>
                        {i.id} ({displayName(i)}) <InstanceState state={i.config.state} />
                      </Checkbox>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-end gap-3">
                  <FormField label="선택한 인스턴스용 포트">
                    <TextInput value={port} disabled readOnly className="max-w-28" />
                  </FormField>
                  <Button onClick={() => { setPending([...new Set([...pending, ...checked])]); setChecked([]); }} disabled={!checked.length}>
                    아래에 보류 중인 것으로 포함
                  </Button>
                </div>
              </SpaceBetween>
            ) : (
              <p className="text-sm text-aws-text-2">이 VPC에 등록할 인스턴스가 없습니다. 대상 없이 만든 뒤 나중에 등록할 수 있습니다.</p>
            )}
          </Container>
          <Container header={<ContainerHeader title={`대상 검토 (${pending.length})`} />}>
            {pending.length ? (
              <ul className="space-y-1 text-sm">
                {pending.map((id) => (
                  <li key={id} className="flex items-center justify-between gap-2">
                    <span>
                      {id}:{port} <span className="text-aws-text-2">보류 중</span>
                    </span>
                    <Button variant="link" onClick={() => setPending(pending.filter((x) => x !== id))}>
                      제거
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-aws-text-2">보류 중인 대상이 없습니다.</p>
            )}
          </Container>
          <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
            <Button variant="link" onClick={() => setStep(1)}>
              이전
            </Button>
            <Button variant="primary" onClick={create}>
              대상 그룹 생성
            </Button>
          </FormActions>
        </SpaceBetween>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 상세

function TargetsTab({ tg, topo }: { tg: Tg; topo: Topology }) {
  const { health } = useAnalysis();
  const run = useRunAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const [toRegister, setToRegister] = useState<string[]>([]);
  const targets = topo.targetGroupTargets(tg.id).map((t) => t.ec2);
  const hs = health.get(tg.id) ?? [];
  const vpcId = topo.vpcOf(tg.id);
  const candidates = topo.ofType("ec2").filter((i) => i.config.state !== "terminated" && topo.vpcOf(i.id) === vpcId && !targets.some((t) => t.id === i.id));
  return (
    <SpaceBetween>
      <ResourceTable
        ariaLabel="등록된 대상"
        variant="container"
        items={targets}
        trackBy={(i) => i.id}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={setSelected}
        filtering={false}
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">
              등록된 대상 <span className="font-normal text-aws-text-2">({targets.length})</span> <InfoLink topic="health-check" />
            </h2>
            <div className="flex gap-2">
              <Button
                disabled={!selected.length}
                onClick={() => {
                  run("DeregisterTargets", (p) => deregisterTargets(p, tg.id, selected), { success: () => `대상 ${selected.length}개를 등록 취소했습니다.`, flashError: true });
                  setSelected([]);
                }}
              >
                등록 취소
              </Button>
              <Button variant="primary" onClick={() => setRegistering(!registering)}>
                대상 등록
              </Button>
            </div>
          </div>
        }
        empty={<p className="py-6 text-center text-sm text-aws-text-2">등록된 대상이 없습니다. 대상 등록을 선택하세요.</p>}
        columns={[
          { id: "id", header: "인스턴스 ID", cell: (i) => <ResourceLink id={i.id} /> },
          { id: "name", header: "이름", cell: (i) => i.name || "–" },
          { id: "port", header: "포트", cell: () => tg.config.port },
          { id: "az", header: "영역", cell: (i) => topo.getOfType(topo.subnetOf(i.id), "subnet")?.config.availabilityZone ?? "–" },
          { id: "state", header: "상태 확인 상태", cell: (i) => <HealthStatus h={hs.find((h) => h.targetId === i.id)} /> },
          { id: "detail", header: "상태 세부 정보", cell: (i) => <span className="text-[13px] text-aws-text-2">{hs.find((h) => h.targetId === i.id)?.reason ?? "–"}</span> },
        ]}
      />
      {registering && (
        <Container header={<ContainerHeader title="대상 등록" description={`VPC ${vpcId}의 인스턴스 중 아직 등록하지 않은 것`} />}>
          {candidates.length ? (
            <SpaceBetween size="m">
              <ul className="space-y-2">
                {candidates.map((i) => (
                  <li key={i.id}>
                    <Checkbox checked={toRegister.includes(i.id)} onChange={(v) => setToRegister(v ? [...toRegister, i.id] : toRegister.filter((x) => x !== i.id))} description={i.config.privateIp}>
                      {i.id} ({displayName(i)})
                    </Checkbox>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2">
                <Button variant="link" onClick={() => setRegistering(false)}>
                  취소
                </Button>
                <Button
                  variant="primary"
                  disabled={!toRegister.length}
                  onClick={() => {
                    const r = run("RegisterTargets", (p) => registerTargets(p, tg.id, toRegister), { success: () => `대상 ${toRegister.length}개를 등록했습니다.`, flashError: true });
                    if (r.ok) {
                      setToRegister([]);
                      setRegistering(false);
                    }
                  }}
                >
                  보류 중인 대상 등록
                </Button>
              </div>
            </SpaceBetween>
          ) : (
            <p className="text-sm text-aws-text-2">등록할 수 있는 인스턴스가 없습니다.</p>
          )}
        </Container>
      )}
    </SpaceBetween>
  );
}

export function TargetGroupDetailPage({ id }: { id: string }) {
  const tg = useResource(id, "target-group");
  const topo = useTopology();
  const { health } = useAnalysis();
  const [tab, setTab] = useQueryTab("targets");
  const [deleting, setDeleting] = useState(false);
  if (!tg) return <ResourceNotFound type="target-group" id={id} />;
  const hs = health.get(tg.id) ?? [];
  const hc = tg.config.healthCheck;
  return (
    <SpaceBetween>
      <PageHeader
        title={tg.name}
        description={tg.id}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "health", text: "상태 검사 설정 편집" },
              { id: "delete", text: "삭제", danger: true },
            ]}
            onItemClick={(a) => (a === "delete" ? setDeleting(true) : navigate(`${resourcePath("target-group", tg.id)}/edit-health-check`))}
          />
        }
      />
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "대상 유형", value: "Instance" },
            { label: "프로토콜 : 포트", value: `${tg.config.protocol}: ${tg.config.port}` },
            { label: "VPC", value: <ResourceLink id={topo.vpcOf(tg.id)} /> },
            { label: "로드 밸런서", value: topo.targetGroupAlbs(tg.id).map((a) => <div key={a.id}><ResourceLink id={a.id} showName /></div>) || "–" },
            { label: "총 대상", value: hs.length },
            { label: "정상", value: <StatusIndicator type="success">{hs.filter((h) => h.state === "healthy").length}</StatusIndicator> },
            { label: "비정상", value: <StatusIndicator type="error">{hs.filter((h) => h.state === "unhealthy").length}</StatusIndicator> },
            { label: "대상 그룹 ID", value: <CopyText text={tg.id} /> },
          ]}
        />
        {!topo.targetGroupAlbs(tg.id).length && hs.length > 0 && (
          <p className="mt-3 text-[13px] text-aws-text-2">로드 밸런서에 연결되지 않은 대상 그룹의 대상은 unused 상태입니다. 로드 밸런서 리스너의 기본 작업에서 이 대상 그룹을 선택하세요.</p>
        )}
      </Container>
      <Tabs
        ariaLabel="대상 그룹 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "targets", label: "대상", content: <TargetsTab tg={tg} topo={topo} /> },
          {
            id: "health",
            label: "상태 검사",
            content: (
              <Container header={<ContainerHeader title="상태 검사 설정" info={<InfoLink topic="health-check" />} actions={<ButtonLink href={href(`${resourcePath("target-group", tg.id)}/edit-health-check`)}>편집</ButtonLink>} />}>
                <KeyValueGrid
                  columns={4}
                  items={[
                    { label: "프로토콜", value: hc.protocol },
                    { label: "경로", value: hc.path },
                    { label: "포트", value: hc.port === "traffic-port" ? "트래픽 포트" : hc.port },
                    { label: "정상 임계값", value: `${hc.healthyThreshold}회 연속 성공` },
                    { label: "비정상 임계값", value: `${hc.unhealthyThreshold}회 연속 실패` },
                    { label: "제한 시간", value: `${hc.timeoutSeconds}초` },
                    { label: "간격", value: `${hc.intervalSeconds}초` },
                    { label: "성공 코드", value: hc.matcher },
                  ]}
                />
              </Container>
            ),
          },
        ]}
      />
      <DeleteTgModal tg={deleting ? tg : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function EditHealthCheckPage({ id }: { id: string }) {
  const tg = useResource(id, "target-group");
  const run = useRunAction();
  const [draft, setDraft] = useState<HcDraft>(() => hcDraftFrom(tg?.config.healthCheck ?? DEFAULT_HEALTH_CHECK));
  const [error, setError] = useState<string | null>(null);
  if (!tg) return <ResourceNotFound type="target-group" id={id} />;
  const save = () => {
    const h = hcFromDraft(draft);
    if (!h.ok) return setError(h.error);
    const r = run("ModifyTargetGroup", (p) => editTargetGroupHealthCheck(p, tg.id, h.value), { success: () => `대상 그룹 ${tg.name}의 상태 검사 설정을 저장했습니다.` });
    if (r.ok) navigate(resourcePath("target-group", tg.id), { query: { tab: "health" } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="상태 검사 설정 편집" info={<InfoLink topic="health-check" />} description={tg.name} />
      <Container header={<ContainerHeader title="상태 검사" />}>
        <HealthCheckFields draft={draft} onChange={setDraft} />
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("target-group", tg.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
