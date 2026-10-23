"use client";

/** Reachability Analyzer: 저장된 경로를 만들고 가상 패킷 경로를 단계별로 분석한다. */
import { withHint } from "../error-codes";
import { ArrowRight, CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { useCallback, useState } from "react";
import {
  DEFAULT_INTERNET_CLIENT_IP,
  DEFAULT_INTERNET_HOST_IP,
  simulateWithTopology,
  type EndpointSpec,
  type SimulationRequest,
  type SimulationResult,
} from "@/lib/engine/connectivity-engine";
import type { NetworkPath } from "@/lib/engine/resource-models";
import type { SimStep } from "@/lib/engine/simulation-log";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import { createNetworkPath, deleteNetworkPaths, recordPathAnalysis } from "@/lib/project/console-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { formatDateTime } from "@/lib/ui/format";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject, useRunAction } from "../console-context";
import { useConsoleUi } from "../console-store";
import { notify } from "../notify";
import { href, navigate } from "../router";
import { Alert, ErrorAlert } from "../ui/alert";
import { PageGuide } from "../ui/page-guide";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { FormActions, FormField, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { StatusIndicator } from "../ui/status";
import { useSelection, useTopology } from "./common";

// ---------------------------------------------------------------- 분석 실행

export function useAnalyzePath() {
  const projectId = useConsoleProjectId();
  const { topology } = useAnalysis();
  const recordRun = useConsoleUi((s) => s.recordRun);
  return useCallback(
    (path: NetworkPath): SimulationResult => {
      const result = simulateWithTopology(topology, path.request);
      recordRun(path.id, { pathId: path.id, result, at: new Date().toISOString() });
      const store = useProjectStore.getState();
      store.updateWithoutHistory(projectId, (p) => recordPathAnalysis(p, path.id, result));
      store.log({ projectId, kind: "simulation", message: `StartNetworkInsightsAnalysis ${path.id}: ${outcomeLabel(result.outcome)} — ${result.summary}` });
      return result;
    },
    [projectId, topology, recordRun],
  );
}

export function outcomeLabel(outcome: SimulationResult["outcome"]): string {
  return { success: "도달 가능", failure: "도달 불가", "invalid-request": "잘못된 요청", "engine-error": "분석 오류" }[outcome];
}

export function OutcomeStatus({ outcome }: { outcome: SimulationResult["outcome"] }) {
  const type = outcome === "success" ? "success" : outcome === "failure" ? "error" : "warning";
  return <StatusIndicator type={type}>{outcomeLabel(outcome)}</StatusIndicator>;
}

function endpointText(topo: Topology, e: EndpointSpec): string {
  if (e.kind === "internet") return `인터넷 (${e.ip})`;
  const r = topo.get(e.resourceId);
  const addressing = e.addressing && e.addressing !== "auto" ? ` · ${e.addressing === "public" ? "퍼블릭 IP" : "프라이빗 IP"}` : "";
  return r ? `${displayName(r)} (${r.id})${addressing}` : `${e.resourceId} (삭제됨)`;
}

function protocolText(r: SimulationRequest) {
  const base = r.protocol === "icmp" ? "ICMP" : `${r.protocol.toUpperCase()} ${r.port}`;
  return r.httpPath && r.httpPath !== "/" ? `${base} · 경로 ${r.httpPath}` : base;
}

// ---------------------------------------------------------------- 목록

export function PathListPage() {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  const analyze = useAnalyzePath();
  const paths = project.networkPaths;
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = paths.filter((p) => selected.includes(p.id));
  return (
    <SpaceBetween>
      <PageGuide topic="reachability" />
      <ResourceTable<NetworkPath>
        ariaLabel="분석 경로 목록"
        items={paths}
        trackBy={(p) => p.id}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(p) => p.name || p.id}
        header={
          <PageHeader
            title="분석 경로"
            counter={`(${paths.length})`}
            info={<InfoLink topic="reachability" />}
            description="Reachability Analyzer는 두 지점 사이의 가상 네트워크 경로를 분석해 도달 가능 여부와 막힌 지점을 알려 줍니다."
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "analyze", text: "경로 분석", disabled: !current.length },
                    { id: "delete", text: "경로 삭제", disabled: !current.length, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (a === "analyze") current.forEach((p) => analyze(p));
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/reachability/create")}>
                  경로 생성 및 분석
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="분석 경로 없음" description="소스와 대상을 지정해 통신이 가능한지 확인해 보세요." action={<ButtonLink href={href("/vpc/reachability/create")}>경로 생성 및 분석</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (p) => <a className="text-aws-link hover:underline" href={href(`/vpc/reachability/${p.id}`)}>{p.name || p.id}</a>, sortValue: (p) => p.name || p.id },
          { id: "source", header: "소스", cell: (p) => endpointText(topo, p.request.source) },
          { id: "dest", header: "대상", cell: (p) => endpointText(topo, p.request.destination) },
          { id: "proto", header: "프로토콜", cell: (p) => protocolText(p.request) },
          {
            id: "last",
            header: "마지막 분석",
            cell: (p) =>
              p.lastAnalysis ? (
                <span className="space-y-0.5">
                  <OutcomeStatus outcome={p.lastAnalysis.outcome} />
                  <span className="block text-xs text-aws-text-2">{formatDateTime(p.lastAnalysis.at)}</span>
                </span>
              ) : (
                <span className="text-aws-text-2">분석 안 함</span>
              ),
          },
        ]}
      />
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title="경로 삭제"
          onConfirm={() => {
            const ids = current.map((p) => p.id);
            const r = run("DeleteNetworkInsightsPath", (p) => deleteNetworkPaths(p, ids), { success: () => `경로 ${ids.length}개를 삭제했습니다.` });
            setSelected([]);
            return r.ok ? null : withHint(r);
          }}
        >
          <p>선택한 경로 {current.length}개와 분석 결과를 삭제하시겠습니까?</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 생성

type EndpointKind = "internet" | "ec2" | "alb" | "rds" | "nat-gateway";

function endpointOptions(topo: Topology, kind: EndpointKind) {
  if (kind === "internet") return [];
  return topo
    .ofType(kind)
    .filter((r) => !(r.type === "ec2" && r.config.state === "terminated"))
    .map((r) => ({ value: r.id, label: `${r.id} (${displayName(r)})` }));
}

export function CreatePathPage() {
  const topo = useTopology();
  const run = useRunAction();
  const analyze = useAnalyzePath();
  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<EndpointKind>("internet");
  const [sourceId, setSourceId] = useState("");
  const [sourceIp, setSourceIp] = useState(DEFAULT_INTERNET_CLIENT_IP);
  const [destKind, setDestKind] = useState<EndpointKind>("ec2");
  const [destId, setDestId] = useState("");
  const [destIp, setDestIp] = useState(DEFAULT_INTERNET_HOST_IP);
  const [addressing, setAddressing] = useState<"auto" | "private" | "public">("auto");
  const [protocol, setProtocol] = useState<"tcp" | "udp" | "icmp">("tcp");
  const [port, setPort] = useState("80");
  const [requestCount, setRequestCount] = useState("4");
  const [httpPath, setHttpPath] = useState("/");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (sourceKind !== "internet" && !sourceId) return setError("[MissingParameter] 소스를 선택하세요.");
    if (destKind !== "internet" && !destId) return setError("[MissingParameter] 대상을 선택하세요.");
    if (protocol !== "icmp" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return setError("[InvalidParameterValue] 대상 포트는 1~65535 사이여야 합니다.");
    const request = {
      source: sourceKind === "internet" ? { kind: "internet", ip: sourceIp.trim() } : { kind: "resource", resourceId: sourceId },
      destination: destKind === "internet" ? { kind: "internet", ip: destIp.trim() } : { kind: "resource", resourceId: destId, addressing },
      protocol,
      port: protocol === "icmp" ? 0 : Number(port),
      requestCount: destKind === "alb" ? Math.min(100, Math.max(1, Number(requestCount) || 1)) : undefined,
      httpPath: destKind === "alb" ? httpPath.trim() || "/" : undefined,
    };
    const r = run("CreateNetworkInsightsPath", (p) => createNetworkPath(p, { name, request }), {});
    if (!r.ok) return setError(withHint(r));
    const path = r.project.networkPaths.find((p) => p.id === r.createdId);
    if (path) {
      const result = analyze(path);
      notify({
        type: result.outcome === "success" ? "success" : result.outcome === "failure" ? "warning" : "error",
        title: `경로 분석 완료: ${outcomeLabel(result.outcome)}`,
        description: result.summary,
      });
      navigate(`/vpc/reachability/${path.id}`);
    }
  };

  const kindOptions = (includeTargets: boolean) => [
    { value: "internet", label: "인터넷 (가상 외부 주소)" },
    { value: "ec2", label: "인스턴스" },
    ...(includeTargets
      ? [
          { value: "alb", label: "로드 밸런서" },
          { value: "rds", label: "RDS DB 인스턴스" },
        ]
      : [{ value: "nat-gateway", label: "NAT 게이트웨이" }]),
  ];

  return (
    <form onSubmit={submit} className="space-y-6" noValidate data-tour="path-form">
      <PageHeader title="경로 생성 및 분석" info={<InfoLink topic="reachability" />} description="소스에서 대상까지 가상 패킷이 라우팅 테이블, 네트워크 ACL, 보안 그룹, 게이트웨이를 통과하는지 분석합니다. 실제 패킷은 보내지 않습니다." />
      <PageGuide topic="reachability" />
      <Container header={<ContainerHeader title="경로 구성" />}>
        <SpaceBetween size="m">
          <FormField label="이름 태그" optional>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: internet-to-web" maxLength={128} />
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <fieldset className="space-y-3 rounded-xl border border-aws-border p-4">
              <legend className="px-1 text-sm font-bold">소스</legend>
              <FormField label="소스 유형">
                <SelectInput value={sourceKind} onChange={(v) => { setSourceKind(v as EndpointKind); setSourceId(""); }} options={kindOptions(false)} />
              </FormField>
              {sourceKind === "internet" ? (
                <FormField label="소스 IP 주소" constraint="VPC 밖의 퍼블릭 IPv4 주소 (기본: 문서용 예약 대역 203.0.113.10)">
                  <TextInput value={sourceIp} onChange={(e) => setSourceIp(e.target.value)} />
                </FormField>
              ) : (
                <FormField label="소스">
                  <SelectInput value={sourceId} onChange={setSourceId} placeholder="소스 선택" options={endpointOptions(topo, sourceKind)} />
                </FormField>
              )}
            </fieldset>
            <fieldset className="space-y-3 rounded-xl border border-aws-border p-4">
              <legend className="px-1 text-sm font-bold">대상</legend>
              <FormField label="대상 유형">
                <SelectInput value={destKind} onChange={(v) => { setDestKind(v as EndpointKind); setDestId(""); }} options={kindOptions(true)} />
              </FormField>
              {destKind === "internet" ? (
                <FormField label="대상 IP 주소" constraint="인터넷의 가상 외부 호스트 (기본: 203.0.113.200)">
                  <TextInput value={destIp} onChange={(e) => setDestIp(e.target.value)} />
                </FormField>
              ) : (
                <>
                  <FormField label="대상">
                    <SelectInput value={destId} onChange={setDestId} placeholder="대상 선택" options={endpointOptions(topo, destKind)} />
                  </FormField>
                  {destKind !== "alb" && (
                    <FormField label="대상 주소" description="자동: 같은 VPC 안이면 프라이빗 IP, 밖이면 퍼블릭 IP">
                      <SelectInput value={addressing} onChange={(v) => setAddressing(v as typeof addressing)} options={[{ value: "auto", label: "자동" }, { value: "private", label: "프라이빗 IP" }, { value: "public", label: "퍼블릭 IP" }]} />
                    </FormField>
                  )}
                </>
              )}
            </fieldset>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="프로토콜">
              <SelectInput value={protocol} onChange={(v) => setProtocol(v as typeof protocol)} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }, { value: "icmp", label: "ICMP" }]} />
            </FormField>
            {protocol !== "icmp" && (
              <FormField label="대상 포트">
                <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </FormField>
            )}
            {destKind === "alb" && (
              <FormField label="요청 수" description="대상 분산 확인용 (1~100)">
                <TextInput value={requestCount} onChange={(e) => setRequestCount(e.target.value)} inputMode="numeric" />
              </FormField>
            )}
            {destKind === "alb" && (
              <FormField label="HTTP 경로" info={<InfoLink topic="listener-rules" />} description="리스너 규칙(경로 기반 라우팅)을 평가할 요청 경로">
                <TextInput value={httpPath} onChange={(e) => setHttpPath(e.target.value)} placeholder="/api/users" maxLength={256} />
              </FormField>
            )}
          </div>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href("/vpc/reachability")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          경로 생성 및 분석
        </Button>
      </FormActions>
    </form>
  );
}

// ---------------------------------------------------------------- 상세

export function PathDetailPage({ id }: { id: string }) {
  const project = useProject();
  const topo = useTopology();
  const analyze = useAnalyzePath();
  const runInfo = useConsoleUi((s) => s.runs[id]);
  const path = project.networkPaths.find((p) => p.id === id);
  if (!path) {
    return (
      <Container>
        <EmptyState title="경로를 찾을 수 없습니다" description={`${id}은(는) 존재하지 않거나 삭제되었습니다.`} action={<ButtonLink href={href("/vpc/reachability")}>분석 경로 목록</ButtonLink>} />
      </Container>
    );
  }
  const stale = path.lastAnalysis && project.updatedAt > path.lastAnalysis.at;
  return (
    <SpaceBetween>
      <PageHeader
        title={path.name || path.id}
        description={path.id}
        actions={
          <>
            <ButtonLink href={href("/map", { path: path.id })}>리소스 맵에서 보기</ButtonLink>
            <Button variant="primary" onClick={() => analyze(path)}>
              경로 분석
            </Button>
          </>
        }
      />
      <Container header={<ContainerHeader title="경로 세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "소스", value: endpointText(topo, path.request.source) },
            { label: "대상", value: endpointText(topo, path.request.destination) },
            { label: "프로토콜", value: protocolText(path.request) },
            { label: "마지막 분석", value: path.lastAnalysis ? <span><OutcomeStatus outcome={path.lastAnalysis.outcome} /> <span className="text-xs text-aws-text-2">{formatDateTime(path.lastAnalysis.at)}</span></span> : "분석 안 함" },
          ]}
        />
      </Container>
      {stale && !runInfo && <Alert type="info">마지막 분석 이후 구성이 변경되었습니다. 경로 분석을 다시 실행해 최신 결과를 확인하세요.</Alert>}
      {runInfo ? (
        <AnalysisResultView result={runInfo.result} at={runInfo.at} topo={topo} />
      ) : (
        <Container header={<ContainerHeader title="분석 결과" />}>
          <EmptyState title="이 세션에서 실행한 분석이 없습니다" description={path.lastAnalysis ? `저장된 마지막 결과: ${path.lastAnalysis.summary}` : "경로 분석을 실행하세요."} action={<Button variant="primary" onClick={() => analyze(path)}>경로 분석</Button>} />
        </Container>
      )}
    </SpaceBetween>
  );
}

const PHASE_LABEL: Record<SimStep["phase"], string> = { setup: "준비", request: "요청", service: "서비스", response: "응답" };

function StepIcon({ status }: { status: SimStep["status"] }) {
  if (status === "pass") return <CircleCheck className="size-4 shrink-0 text-aws-success" aria-label="통과" />;
  if (status === "fail") return <CircleX className="size-4 shrink-0 text-aws-error" aria-label="실패" />;
  if (status === "warn") return <TriangleAlert className="size-4 shrink-0 text-aws-warning" aria-label="주의" />;
  return <Info className="size-4 shrink-0 text-aws-info" aria-label="정보" />;
}

export function AnalysisResultView({ result, at, topo }: { result: SimulationResult; at: string; topo: Topology }) {
  const [onlyImportant, setOnlyImportant] = useState(false);
  const steps = onlyImportant ? result.steps.filter((s) => s.status !== "info") : result.steps;
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="분석 결과" description={`분석 시각 ${formatDateTime(at)} · 현재 구성 기준의 결정적인 가상 결과`} />}>
        <SpaceBetween size="m">
          <div className="flex flex-wrap items-center gap-3" data-testid="analysis-outcome" data-outcome={result.outcome}>
            <span className="text-xl font-bold">
              <OutcomeStatus outcome={result.outcome} />
            </span>
            <span className="text-sm text-aws-text">{result.summary}</span>
          </div>
          {result.failure && (
            <Alert type="error" header={`막힌 지점: ${result.failure.reason}`}>
              <div className="space-y-2">
                {result.failure.resourceIds.length > 0 && (
                  <p>
                    관련 리소스:{" "}
                    {result.failure.resourceIds.map((rid) => (
                      <span key={rid} className="mr-2">
                        <ResourceLink id={rid} showName />
                      </span>
                    ))}
                  </p>
                )}
                {result.failure.fixes.length > 0 && (
                  <div>
                    <p className="font-bold">해결 방법</p>
                    <ul className="list-disc pl-5">
                      {result.failure.fixes.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.failure.concept && <p className="text-[13px] text-aws-text-2">개념: {result.failure.concept}</p>}
              </div>
            </Alert>
          )}
          {result.errorMessage && <Alert type="warning">{result.errorMessage}</Alert>}
          {result.path.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-bold text-aws-text-2">경로</p>
              <ol className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="패킷 경로">
                {result.path.map((hop, i) => {
                  const failed = !!hop.resourceId && !!result.failure?.resourceIds.includes(hop.resourceId);
                  return (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className={cn("rounded-lg border px-2 py-1", failed ? "border-aws-error bg-aws-error-bg" : "border-aws-border bg-aws-surface-2")}>
                        {hop.resourceId ? <ResourceLink id={hop.resourceId} /> : hop.label}
                        {hop.resourceId && <span className="ml-1 text-xs text-aws-text-2">{topo.get(hop.resourceId) ? displayName(topo.get(hop.resourceId)!) : ""}</span>}
                      </span>
                      {i < result.path.length - 1 && <ArrowRight className="size-3.5 text-aws-text-3" aria-hidden />}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {result.distribution && (
            <div>
              <p className="mb-2 text-sm font-bold text-aws-text-2">대상 분산 (요청 {result.request.requestCount ?? 1}개, 라운드 로빈)</p>
              <ul className="space-y-1 text-sm">
                {result.distribution.map((d) => (
                  <li key={d.targetId}>
                    <ResourceLink id={d.targetId} showName /> — 요청 {d.requests}개 · 성공 {d.successes}개
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SpaceBetween>
      </Container>
      <Container
        header={
          <ContainerHeader
            title={`분석 단계 (${result.steps.length})`}
            description="각 단계에서 적용된 규칙과 판단 근거입니다."
            actions={
              <Button variant="link" onClick={() => setOnlyImportant(!onlyImportant)}>
                {onlyImportant ? "모든 단계 보기" : "판정 단계만 보기"}
              </Button>
            }
          />
        }
      >
        <ol className="space-y-2" data-testid="analysis-steps">
          {steps.map((s) => (
            <li key={s.index} className={cn("rounded-xl border p-3", s.status === "fail" ? "border-aws-error bg-aws-error-bg" : "border-aws-border")}>
              <div className="flex items-start gap-2">
                <StepIcon status={s.status} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm">
                    <span className="mr-2 text-xs text-aws-text-2">
                      #{s.index + 1} · {PHASE_LABEL[s.phase]}
                      {s.segment ? ` · ${s.segment}` : ""}
                    </span>
                    <span className="font-bold">{s.title}</span>
                  </p>
                  {s.detail && <p className="text-[13px] break-words whitespace-pre-line text-aws-text-2">{s.detail}</p>}
                  {s.rules && s.rules.length > 0 && (
                    <ExpandableSection header={<span className="text-[13px]">평가한 규칙 ({s.rules.length})</span>} defaultExpanded={s.status === "fail"}>
                      <ul className="space-y-0.5 font-mono text-[12px]">
                        {s.rules.map((r, i) => (
                          <li key={i} className={cn(r.decisive ? "font-bold text-aws-text" : r.matched ? "text-aws-text" : "text-aws-text-3")}>
                            {r.decisive ? "▶ " : r.matched ? "✓ " : "· "}
                            {r.label} {r.note && <span className="font-sans text-aws-text-2">— {r.note}</span>}
                          </li>
                        ))}
                      </ul>
                    </ExpandableSection>
                  )}
                  {s.concept && <p className="text-[12px] text-aws-info">💡 {s.concept}</p>}
                </div>
              </div>
            </li>
          ))}
        </ol>
        {result.truncated && <p className="mt-3 text-xs text-aws-text-2">단계가 너무 많아 일부만 표시했습니다.</p>}
      </Container>
      <ExpandableSection variant="container" header="분석 가정">
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-aws-text-2">
          {result.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </ExpandableSection>
    </SpaceBetween>
  );
}
