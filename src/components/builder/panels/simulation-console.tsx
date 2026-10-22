"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleX,
  Crosshair,
  Globe,
  Info,
  Lightbulb,
  Loader2,
  Play,
  RotateCcw,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResourceIcon } from "@/components/resource-visuals";
import { isPublicRoutableIp, parseIpv4 } from "@/lib/engine/cidr-utils";
import {
  DEFAULT_EPHEMERAL_PORT,
  DEFAULT_INTERNET_CLIENT_IP,
  DEFAULT_INTERNET_HOST_IP,
  MAX_REQUEST_COUNT,
  simulateWithTopology,
  type SimulationRequest,
  type SimulationResult,
} from "@/lib/engine/connectivity-engine";
import type { Project } from "@/lib/engine/resource-models";
import type { SimStep } from "@/lib/engine/simulation-log";
import { buildTopology, type Topology } from "@/lib/engine/topology-engine";
import { createId } from "@/lib/engine/ids";
import { useEditorStore, type PathHighlight } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { formatTime } from "@/lib/ui/format";
import { useAnalysis } from "../analysis-context";
import { NativeSelect, type SelectOption } from "../inspector/fields";

const STEP_PAGE = 80;
const PLAY_INTERVAL_MS = 450;

export function buildHighlight(result: SimulationResult, project: Project): PathHighlight | null {
  if (result.outcome === "invalid-request" || result.outcome === "engine-error") return null;
  const ids = result.path.filter((h) => h.resourceId).map((h) => h.resourceId!);
  const connectionIds = new Set(result.steps.flatMap((s) => s.connectionIds));
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    for (const c of project.connections) {
      if ((c.sourceResourceId === a && c.targetResourceId === b) || (c.sourceResourceId === b && c.targetResourceId === a)) {
        connectionIds.add(c.id);
      }
    }
  }
  return {
    resourceIds: ids,
    connectionIds: [...connectionIds],
    failedResourceIds: result.failure?.resourceIds ?? [],
    outcome: result.outcome,
    playhead: 0,
  };
}

interface FormState {
  source: string;
  sourceIp: string;
  destination: string;
  destinationIp: string;
  addressing: "auto" | "private" | "public";
  protocol: "tcp" | "udp" | "icmp";
  port: string;
  ephemeralPort: string;
  requestCount: string;
}

function suggestedPort(topo: Topology, destination: string): number {
  if (destination === "internet") return 443;
  const r = topo.get(destination);
  if (r?.type === "alb") return r.config.listeners[0]?.port ?? 80;
  if (r?.type === "rds") return r.config.port;
  if (r?.type === "ec2") return r.config.listenPorts.includes(80) ? 80 : (r.config.listenPorts[0] ?? 80);
  return 80;
}

function presetsFor(topo: Topology): { label: string; request: SimulationRequest }[] {
  const presets: { label: string; request: SimulationRequest }[] = [];
  for (const alb of topo.ofType("alb").filter((a) => a.config.scheme === "internet-facing").slice(0, 2)) {
    const port = alb.config.listeners[0]?.port ?? 80;
    presets.push({
      label: `인터넷 → ${alb.name}:${port} (요청 6회)`,
      request: { source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP }, destination: { kind: "resource", resourceId: alb.id }, protocol: "tcp", port, requestCount: 6 },
    });
  }
  const ec2s = topo.ofType("ec2").filter((e) => e.config.state !== "terminated");
  for (const e of ec2s.filter((x) => topo.ec2PublicIpEnabled(x)).slice(0, 1)) {
    presets.push({
      label: `인터넷 → ${e.name}:80`,
      request: { source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP }, destination: { kind: "resource", resourceId: e.id, addressing: "public" }, protocol: "tcp", port: 80 },
    });
  }
  for (const e of ec2s.slice(0, 2)) {
    presets.push({
      label: `${e.name} → 인터넷:443`,
      request: { source: { kind: "resource", resourceId: e.id }, destination: { kind: "internet", ip: DEFAULT_INTERNET_HOST_IP }, protocol: "tcp", port: 443 },
    });
  }
  for (const rds of topo.ofType("rds").slice(0, 1)) {
    const app = ec2s.find((e) => topo.vpcOf(e.id) === topo.vpcOf(rds.id));
    if (app) {
      presets.push({
        label: `${app.name} → ${rds.name}:${rds.config.port}`,
        request: { source: { kind: "resource", resourceId: app.id }, destination: { kind: "resource", resourceId: rds.id }, protocol: "tcp", port: rds.config.port },
      });
    }
  }
  return presets.slice(0, 6);
}

function formFromRequest(req: SimulationRequest): FormState {
  return {
    source: req.source.kind === "internet" ? "internet" : req.source.resourceId,
    sourceIp: req.source.kind === "internet" ? req.source.ip : DEFAULT_INTERNET_CLIENT_IP,
    destination: req.destination.kind === "internet" ? "internet" : req.destination.resourceId,
    destinationIp: req.destination.kind === "internet" ? req.destination.ip : DEFAULT_INTERNET_HOST_IP,
    addressing: req.destination.kind === "resource" ? (req.destination.addressing ?? "auto") : "auto",
    protocol: req.protocol,
    port: String(req.port),
    ephemeralPort: String(req.ephemeralPort ?? DEFAULT_EPHEMERAL_PORT),
    requestCount: String(req.requestCount ?? 1),
  };
}

export function SimulationConsole({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId])!;
  const log = useProjectStore((s) => s.log);
  const analysis = useAnalysis();
  const topo = analysis.topology;
  const runs = useEditorStore((s) => s.runs);
  const activeRunId = useEditorStore((s) => s.activeRunId);
  const addRun = useEditorStore((s) => s.addRun);
  const setHighlight = useEditorStore((s) => s.setHighlight);
  const pending = useEditorStore((s) => s.pendingRequest);
  const clearPending = useEditorStore((s) => s.clearPendingRequest);
  const activeRun = runs.find((r) => r.id === activeRunId) ?? null;

  const [form, setForm] = useState<FormState>(() => ({
    source: "internet",
    sourceIp: DEFAULT_INTERNET_CLIENT_IP,
    destination: "",
    destinationIp: DEFAULT_INTERNET_HOST_IP,
    addressing: "auto",
    protocol: "tcp",
    port: "80",
    ephemeralPort: String(DEFAULT_EPHEMERAL_PORT),
    requestCount: "1",
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const ec2s = topo.ofType("ec2");
  const sourceOptions: SelectOption[] = [
    { value: "internet", label: "인터넷 클라이언트 (가상)" },
    ...ec2s.map((e) => ({ value: e.id, label: `EC2 ${e.name} (${e.config.state})` })),
  ];
  const destinationOptions: SelectOption[] = [
    { value: "", label: "목적지 선택…", disabled: true },
    { value: "internet", label: "인터넷 호스트 (가상)" },
    ...ec2s.map((e) => ({ value: e.id, label: `EC2 ${e.name}` })),
    ...topo.ofType("alb").map((a) => ({ value: a.id, label: `ALB ${a.name} (${a.config.scheme})` })),
    ...topo.ofType("rds").map((r) => ({ value: r.id, label: `RDS ${r.name}` })),
  ];
  const destinationResource = topo.get(form.destination);
  const presets = useMemo(() => presetsFor(topo), [topo]);

  const execute = (request: SimulationRequest) => {
    setRunning(true);
    setTimeout(() => {
      const current = useProjectStore.getState().projects[projectId];
      const result = current ? simulateWithTopology(topo.project === current ? topo : buildTopology(current), request) : null;
      setRunning(false);
      if (!result) return;
      const run = { id: createId("run"), at: new Date().toISOString(), result };
      addRun(run);
      const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const highlight = current ? buildHighlight(result, current) : null;
      setHighlight(highlight && reduced ? { ...highlight, playhead: highlight.resourceIds.length } : highlight);
      log({
        projectId,
        kind: "simulation",
        message: `${result.sourceLabel} → ${result.destinationLabel}: ${result.outcome === "success" ? "성공" : result.outcome === "failure" ? "실패" : result.outcome}`,
      });
    }, 10);
  };

  const buildRequest = (f: FormState): SimulationRequest | string => {
    if (!f.destination) return "목적지를 선택하세요.";
    if (f.source === "internet") {
      const ipValue = parseIpv4(f.sourceIp.trim());
      if (ipValue === null) return "인터넷 클라이언트 IP 형식이 올바르지 않습니다.";
      if (!isPublicRoutableIp(ipValue)) return "인터넷 클라이언트 IP는 공인 주소여야 합니다. 예: 203.0.113.10";
    }
    if (f.destination === "internet" && parseIpv4(f.destinationIp.trim()) === null) return "인터넷 호스트 IP 형식이 올바르지 않습니다.";
    const port = Number(f.port);
    if (f.protocol !== "icmp" && (!Number.isInteger(port) || port < 1 || port > 65535)) return "포트는 1~65535 사이의 정수여야 합니다.";
    const eph = Number(f.ephemeralPort);
    if (!Number.isInteger(eph) || eph < 1024 || eph > 65535) return "임시 포트는 1024~65535 사이의 정수여야 합니다.";
    const count = Number(f.requestCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_REQUEST_COUNT) return `요청 수는 1~${MAX_REQUEST_COUNT} 사이여야 합니다.`;
    return {
      source: f.source === "internet" ? { kind: "internet", ip: f.sourceIp.trim() } : { kind: "resource", resourceId: f.source },
      destination:
        f.destination === "internet"
          ? { kind: "internet", ip: f.destinationIp.trim() }
          : { kind: "resource", resourceId: f.destination, addressing: f.addressing },
      protocol: f.protocol,
      port: f.protocol === "icmp" ? 0 : port,
      ephemeralPort: eph,
      requestCount: destinationResource?.type === "alb" ? count : 1,
    };
  };

  const run = () => {
    const req = buildRequest(form);
    if (typeof req === "string") return setFormError(req);
    setFormError(null);
    execute(req);
  };

  // 외부(실습 단계, 프리셋)에서 요청을 전달받으면 폼을 채우고 실행한다
  useEffect(() => {
    if (!pending) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 외부에서 전달된 요청으로 폼을 동기화
    setForm(formFromRequest(pending.request));
    if (pending.autoRun) execute(pending.request);
    clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.nonce]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      if (patch.destination !== undefined && patch.destination !== f.destination) next.port = String(suggestedPort(topo, patch.destination));
      return next;
    });
    setFormError(null);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(260px,320px)_1fr]" data-testid="simulation-console">
      <form
        className="space-y-3 overflow-auto border-b p-3 md:border-r md:border-b-0"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        aria-label="통신 시뮬레이션 요청"
      >
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="sim-source">
            출발지
          </Label>
          <NativeSelect id="sim-source" value={form.source} options={sourceOptions} onChange={(v) => update({ source: v })} testId="sim-source" />
          {form.source === "internet" && (
            <Input value={form.sourceIp} onChange={(e) => update({ sourceIp: e.target.value })} aria-label="인터넷 클라이언트 IP" className="h-7 font-mono text-xs" />
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="sim-destination">
            목적지
          </Label>
          <NativeSelect id="sim-destination" value={form.destination} options={destinationOptions} onChange={(v) => update({ destination: v })} testId="sim-destination" />
          {form.destination === "internet" && (
            <Input value={form.destinationIp} onChange={(e) => update({ destinationIp: e.target.value })} aria-label="인터넷 호스트 IP" className="h-7 font-mono text-xs" />
          )}
          {destinationResource?.type === "ec2" && (
            <NativeSelect
              value={form.addressing}
              options={[
                { value: "auto", label: "주소 자동 (같은 VPC면 사설 IP)" },
                { value: "private", label: "사설 IP로 요청" },
                { value: "public", label: "퍼블릭 IP로 요청" },
              ]}
              onChange={(v) => update({ addressing: v as FormState["addressing"] })}
              ariaLabel="목적지 주소 지정 방식"
            />
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="sim-protocol">
              프로토콜
            </Label>
            <NativeSelect
              id="sim-protocol"
              value={form.protocol}
              options={[
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
                { value: "icmp", label: "ICMP (ping)" },
              ]}
              onChange={(v) => update({ protocol: v as FormState["protocol"] })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="sim-port">
              목적지 포트
            </Label>
            <Input id="sim-port" value={form.protocol === "icmp" ? "" : form.port} disabled={form.protocol === "icmp"} onChange={(e) => update({ port: e.target.value })} className="h-8 font-mono" data-testid="sim-port" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="sim-eph">
              응답 임시 포트
            </Label>
            <Input id="sim-eph" value={form.ephemeralPort} onChange={(e) => update({ ephemeralPort: e.target.value })} className="h-8 font-mono" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="sim-count">
              요청 수 (ALB)
            </Label>
            <Input
              id="sim-count"
              value={form.requestCount}
              disabled={destinationResource?.type !== "alb"}
              onChange={(e) => update({ requestCount: e.target.value })}
              className="h-8 font-mono"
            />
          </div>
        </div>
        {formError && (
          <p role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={running} data-testid="sim-run">
          {running ? <Loader2 className="animate-spin" /> : <Play />} 시뮬레이션 실행
        </Button>
        {presets.length > 0 && (
          <div className="space-y-1">
            <p className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Zap className="size-3" aria-hidden /> 빠른 시나리오
            </p>
            <div className="flex flex-wrap gap-1">
              {presets.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-auto py-1 text-left whitespace-normal"
                  onClick={() => {
                    setForm(formFromRequest(p.request));
                    execute(p.request);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        {runs.length > 1 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">최근 실행</p>
            <ul className="space-y-0.5">
              {runs.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      useEditorStore.getState().setActiveRun(r.id);
                      setHighlight(buildHighlight(r.result, project));
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted",
                      r.id === activeRunId && "bg-muted",
                    )}
                  >
                    <OutcomeIcon outcome={r.result.outcome} className="size-3" />
                    <span className="truncate">
                      {r.result.sourceLabel} → {r.result.destinationLabel}
                    </span>
                    <span className="ml-auto text-muted-foreground">{formatTime(r.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
      <div className="min-h-0 overflow-auto">
        {activeRun ? (
          <SimulationResultView result={activeRun.result} project={project} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <Globe className="size-6" aria-hidden />
            <p>출발지와 목적지를 선택하고 시뮬레이션을 실행하세요.</p>
            <p className="max-w-md text-xs">
              라우팅 테이블, 보안 그룹, NACL, 게이트웨이, 대상 상태를 순서대로 평가해 각 단계의 판단 근거를 보여줍니다. 실제 패킷이나 HTTP 요청은
              보내지 않습니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function OutcomeIcon({ outcome, className }: { outcome: SimulationResult["outcome"]; className?: string }) {
  if (outcome === "success") return <CircleCheck className={cn("text-emerald-600", className)} aria-label="성공" />;
  if (outcome === "failure") return <CircleX className={cn("text-red-600", className)} aria-label="실패" />;
  return <TriangleAlert className={cn("text-amber-600", className)} aria-label="실행 불가" />;
}

const PHASE_LABEL: Record<SimStep["phase"], string> = {
  setup: "준비",
  request: "요청",
  service: "처리",
  response: "응답",
};

function SimulationResultView({ result, project }: { result: SimulationResult; project: Project }) {
  const highlight = useEditorStore((s) => s.highlight);
  const setHighlight = useEditorStore((s) => s.setHighlight);
  const advance = useEditorStore((s) => s.advancePlayhead);
  const focusResources = useEditorStore((s) => s.focusResources);
  const analysis = useAnalysis();
  const [limit, setLimit] = useState(STEP_PAGE);
  const [openStep, setOpenStep] = useState<number | null>(result.failure?.stepIndex ?? null);

  const playing = !!highlight && highlight.playhead < highlight.resourceIds.length;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(advance, PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, advance]);

  const banner = {
    success: { className: "border-emerald-500/40 bg-emerald-500/10", title: "요청 성공 (가상)" },
    failure: { className: "border-red-500/40 bg-red-500/10", title: "요청 실패" },
    "invalid-request": { className: "border-amber-500/40 bg-amber-500/10", title: "요청을 실행할 수 없음" },
    "engine-error": { className: "border-violet-500/40 bg-violet-500/10", title: "시뮬레이션 엔진 오류 (통신 실패 아님)" },
  }[result.outcome];

  const steps = result.steps.slice(0, limit);
  const name = (id: string) => analysis.topology.get(id)?.name ?? id;

  return (
    <div className="space-y-3 p-3" data-testid="simulation-result" data-outcome={result.outcome}>
      <div className={cn("rounded-lg border p-3", banner.className)} role="status">
        <p className="flex items-center gap-2 font-semibold">
          <OutcomeIcon outcome={result.outcome} className="size-4" /> {banner.title}
        </p>
        <p className="mt-1 text-sm">{result.summary}</p>
      </div>

      {result.failure && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">차단 원인</p>
          <p className="text-muted-foreground">{result.failure.reason}</p>
          {result.failure.resourceIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.failure.resourceIds.map((id) => {
                const r = analysis.topology.get(id);
                return r ? (
                  <Button key={id} variant="outline" size="xs" onClick={() => focusResources([id])}>
                    <ResourceIcon type={r.type} size="sm" className="size-4 [&_svg]:size-2.5" /> {r.name}
                  </Button>
                ) : null;
              })}
            </div>
          )}
          {result.failure.fixes.length > 0 && (
            <div>
              <p className="flex items-center gap-1 font-medium">
                <Lightbulb className="size-3.5 text-amber-500" aria-hidden /> 해결 방법
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {result.failure.fixes.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {result.failure.concept && <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{result.failure.concept}</p>}
        </div>
      )}

      {result.path.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">가상 이동 경로</p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const h = buildHighlight(result, project);
                if (h) setHighlight(h);
              }}
            >
              <RotateCcw /> 경로 다시 재생
            </Button>
          </div>
          <ol className="flex flex-wrap items-center gap-1" aria-label="이동 경로">
            {result.path.map((hop, i) => {
              const reached = highlight ? i < highlight.playhead || highlight.playhead >= highlight.resourceIds.length : true;
              const failed = hop.resourceId && result.failure?.resourceIds.includes(hop.resourceId) && i === result.path.length - 1;
              return (
                <li key={`${hop.label}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <ArrowRight className="size-3 text-muted-foreground" aria-hidden />}
                  <button
                    type="button"
                    disabled={!hop.resourceId}
                    onClick={() => hop.resourceId && focusResources([hop.resourceId])}
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[11px] transition-opacity",
                      hop.kind === "internet" && "border-dashed",
                      !reached && "opacity-40",
                      failed && "border-red-500 text-red-700 dark:text-red-300",
                    )}
                  >
                    {hop.label}
                  </button>
                </li>
              );
            })}
            {result.outcome === "failure" && (
              <li className="flex items-center gap-1 text-[11px] text-red-600">
                <ArrowRight className="size-3" aria-hidden /> <CircleX className="size-3" aria-hidden /> 차단
              </li>
            )}
          </ol>
        </div>
      )}

      {result.distribution && (
        <div className="space-y-1 rounded-lg border p-3" data-testid="distribution">
          <p className="text-xs font-medium">요청 분산 (라운드 로빈, {result.request.requestCount}회)</p>
          {result.distribution.map((d) => {
            const pct = Math.round((d.requests / (result.request.requestCount ?? 1)) * 100);
            return (
              <div key={d.targetId} className="grid grid-cols-[minmax(80px,140px)_1fr_auto] items-center gap-2 text-xs">
                <span className="truncate">{d.targetName}</span>
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                </span>
                <span className="font-mono">
                  {d.requests}회 · 성공 {d.successes}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {result.steps.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            단계별 로그 ({result.steps.length}단계{result.truncated ? ", 일부 생략" : ""})
          </p>
          <ol className="divide-y rounded-lg border" data-testid="simulation-steps">
            {steps.map((step, i) => {
              const prev = steps[i - 1];
              const newSegment = !prev || prev.segment !== step.segment;
              return (
                <li key={step.index}>
                  {newSegment && step.segment && (
                    <p className="bg-muted/50 px-3 py-1 text-[11px] font-semibold text-muted-foreground">{step.segment}</p>
                  )}
                  <StepRow step={step} open={openStep === step.index} onToggle={() => setOpenStep((x) => (x === step.index ? null : step.index))} name={name} onFocus={focusResources} />
                </li>
              );
            })}
          </ol>
          {result.steps.length > limit && (
            <Button variant="outline" size="xs" onClick={() => setLimit((l) => l + STEP_PAGE)}>
              더 보기 (+{Math.min(STEP_PAGE, result.steps.length - limit)})
            </Button>
          )}
        </div>
      )}

      <details className="rounded-lg border p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          <Info className="mr-1 inline size-3.5" aria-hidden />
          지원 범위와 단순화한 가정
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {result.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function StepRow({
  step,
  open,
  onToggle,
  name,
  onFocus,
}: {
  step: SimStep;
  open: boolean;
  onToggle: () => void;
  name: (id: string) => string;
  onFocus: (ids: string[]) => void;
}) {
  const icon =
    step.status === "pass" ? (
      <CircleCheck className="size-3.5 text-emerald-600" aria-label="통과" />
    ) : step.status === "fail" ? (
      <CircleX className="size-3.5 text-red-600" aria-label="실패" />
    ) : step.status === "warn" ? (
      <TriangleAlert className="size-3.5 text-amber-600" aria-label="주의" />
    ) : (
      <Info className="size-3.5 text-sky-600" aria-label="정보" />
    );
  const expandable = !!(step.detail || step.rules?.length || step.concept || step.resourceIds.length);
  return (
    <div className={cn("px-3 py-1.5", step.status === "fail" && "bg-red-500/5")} data-testid="sim-step" data-status={step.status}>
      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={onToggle} aria-expanded={open} disabled={!expandable}>
        <span className="mt-0.5">{icon}</span>
        <span className="w-9 shrink-0 text-[10px] text-muted-foreground uppercase">{PHASE_LABEL[step.phase]}</span>
        <span className="min-w-0 flex-1 text-xs">
          <span className="font-medium">{step.title}</span>
          {!open && step.detail && <span className="block truncate text-muted-foreground">{step.detail}</span>}
        </span>
        {expandable && <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 pl-14 text-xs">
          {step.detail && <p className="text-muted-foreground">{step.detail}</p>}
          {step.rules && step.rules.length > 0 && (
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-0.5 text-left font-medium">평가한 규칙/경로</th>
                  <th className="py-0.5 text-left font-medium">판단</th>
                </tr>
              </thead>
              <tbody>
                {step.rules.map((r, i) => (
                  <tr key={i} className={cn("border-t", r.decisive && "font-semibold")}>
                    <td className="py-0.5 pr-2 font-mono">{r.label}</td>
                    <td className={cn("py-0.5", r.matched ? "text-foreground" : "text-muted-foreground")}>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {step.concept && <p className="rounded-md bg-muted/50 p-2 text-muted-foreground">{step.concept}</p>}
          {step.resourceIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {step.resourceIds.map((id) => (
                <Button key={id} variant="outline" size="xs" onClick={() => onFocus([id])}>
                  <Crosshair /> {name(id)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
