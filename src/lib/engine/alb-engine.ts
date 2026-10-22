/**
 * ALB 및 Target Group 시뮬레이션.
 * - 가상 헬스 체크: 대상 상태, 가용 영역, 네트워크 경로(보안 그룹/NACL/라우팅), 가상 서비스 포트,
 *   가상 애플리케이션 응답 코드와 matcher를 이용해 결정적으로 계산한다. 실제 HTTP 요청은 보내지 않는다.
 * - 대상 선택: 라운드 로빈 (요청 번호 기반, 결정적).
 *
 * 네트워크 경로 검사는 connectivity-engine이 probe 함수로 주입한다 (순환 의존 방지).
 */
import type { HealthCheck, ResourceOfType } from "./resource-models";
import type { FailureInfo, SimStep } from "./simulation-log";
import type { Eni, Topology } from "./topology-engine";

export type TargetHealthState = "healthy" | "unhealthy" | "unused" | "initial";

export interface TargetHealth {
  targetId: string;
  targetName: string;
  connectionId: string;
  availabilityZone: string | null;
  state: TargetHealthState;
  reasonCode: string;
  reason: string;
  /** 헬스 체크 경로 검사 로그 (헬스 체크를 수행하지 않은 경우 null) */
  probe: ProbeResult | null;
}

export interface ProbeArgs {
  alb: ResourceOfType<"alb">;
  targetGroup: ResourceOfType<"target-group">;
  target: ResourceOfType<"ec2">;
  nodeEni: Eni;
  port: number;
}

export interface ProbeResult {
  /** 네트워크 경로와 포트 연결이 성공했는지 */
  connected: boolean;
  steps: SimStep[];
  failure: FailureInfo | null;
}

export type HealthProbe = (args: ProbeArgs) => ProbeResult;

export const TARGET_STATE_LABEL: Record<TargetHealthState, string> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  unused: "Unused",
  initial: "Initial",
};

// ---------------------------------------------------------------- matcher

export type MatcherParse = { ok: true; ranges: [number, number][] } | { ok: false; error: string };

/** ALB HTTP matcher 파싱: "200", "200,302", "200-299". 허용 코드 범위는 200~499. */
export function parseMatcher(matcher: string): MatcherParse {
  const text = matcher.trim();
  if (!text) return { ok: false, error: "성공 코드(matcher)를 입력하세요. 예: 200 또는 200-299" };
  const ranges: [number, number][] = [];
  for (const part of text.split(",")) {
    const m = /^\s*(\d{3})(?:\s*-\s*(\d{3}))?\s*$/.exec(part);
    if (!m) return { ok: false, error: `성공 코드 형식이 올바르지 않습니다: "${part.trim()}"` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 200 || to > 499 || from > to) {
      return { ok: false, error: `ALB HTTP 성공 코드는 200~499 범위여야 합니다: "${part.trim()}"` };
    }
    ranges.push([from, to]);
  }
  return { ok: true, ranges };
}

export function matcherIncludes(matcher: string, code: number): boolean {
  const parsed = parseMatcher(matcher);
  return parsed.ok && parsed.ranges.some(([a, b]) => code >= a && code <= b);
}

/** AWS 헬스 체크 설정 제약을 검사하고 문제 목록을 반환한다. */
export function validateHealthCheck(hc: HealthCheck): string[] {
  const problems: string[] = [];
  if (!hc.path.startsWith("/")) problems.push(`헬스 체크 경로는 "/"로 시작해야 합니다. (현재: "${hc.path}")`);
  if (hc.healthyThreshold < 2 || hc.healthyThreshold > 10) problems.push("정상 임계값(healthy threshold)은 2~10 사이여야 합니다.");
  if (hc.unhealthyThreshold < 2 || hc.unhealthyThreshold > 10) problems.push("비정상 임계값(unhealthy threshold)은 2~10 사이여야 합니다.");
  if (hc.intervalSeconds < 5 || hc.intervalSeconds > 300) problems.push("헬스 체크 간격은 5~300초 사이여야 합니다.");
  if (hc.timeoutSeconds < 2 || hc.timeoutSeconds > 120) problems.push("헬스 체크 제한 시간은 2~120초 사이여야 합니다.");
  if (hc.timeoutSeconds >= hc.intervalSeconds) problems.push("헬스 체크 제한 시간은 간격보다 짧아야 합니다.");
  const matcher = parseMatcher(hc.matcher);
  if (!matcher.ok) problems.push(matcher.error);
  return problems;
}

/** 임계값과 간격으로 계산한 가상 상태 전환 시간 (초). */
export function healthTiming(hc: HealthCheck): { secondsToHealthy: number; secondsToUnhealthy: number } {
  return {
    secondsToHealthy: hc.healthyThreshold * hc.intervalSeconds,
    secondsToUnhealthy: hc.unhealthyThreshold * hc.intervalSeconds,
  };
}

export function healthCheckPort(tg: ResourceOfType<"target-group">): number {
  return tg.config.healthCheck.port === "traffic-port" ? tg.config.port : tg.config.healthCheck.port;
}

// ---------------------------------------------------------------- health

/** 대상 그룹을 사용하는(리스너가 실제로 전달하는) ALB를 찾는다. */
export function activeAlbFor(topo: Topology, tgId: string): ResourceOfType<"alb"> | null {
  for (const alb of topo.targetGroupAlbs(tgId)) {
    if (topo.listenersOf(alb.id).some((b) => b.targetGroupId === tgId)) return alb;
  }
  return null;
}

export function computeTargetHealth(topo: Topology, tgId: string, probe: HealthProbe): TargetHealth[] {
  const tg = topo.getOfType(tgId, "target-group");
  if (!tg) return [];
  const alb = activeAlbFor(topo, tgId);
  const albVpc = alb ? topo.vpcOf(alb.id) : null;
  const albAzs = alb ? new Set(topo.albSubnets(alb.id).map((s) => s.config.availabilityZone)) : new Set<string>();
  const nodes = alb ? topo.enisOf(alb.id) : [];

  return topo.targetGroupTargets(tgId).map(({ connectionId, ec2 }): TargetHealth => {
    const subnet = topo.getOfType(topo.subnetOf(ec2.id), "subnet");
    const az = subnet?.config.availabilityZone ?? null;
    const base = {
      targetId: ec2.id,
      targetName: ec2.name,
      connectionId,
      availabilityZone: az,
    };
    const state = ec2.config.state;
    if (state === "terminated") {
      return { ...base, state: "unused", reasonCode: "Target.InvalidState", reason: "인스턴스가 종료(Terminated)되었습니다.", probe: null };
    }
    if (state === "stopped") {
      return { ...base, state: "unused", reasonCode: "Target.InvalidState", reason: "인스턴스가 중지(Stopped) 상태입니다.", probe: null };
    }
    if (state === "pending") {
      return { ...base, state: "initial", reasonCode: "Elb.InitialHealthChecking", reason: "인스턴스가 시작 중(Pending)이어서 초기 헬스 체크 대기 중입니다.", probe: null };
    }
    if (!alb) {
      return { ...base, state: "unused", reasonCode: "Target.NotInUse", reason: "대상 그룹이 어떤 ALB 리스너에도 연결되어 있지 않습니다.", probe: null };
    }
    if (!subnet) {
      return { ...base, state: "unused", reasonCode: "Target.InvalidState", reason: "인스턴스가 서브넷에 배치되지 않았습니다.", probe: null };
    }
    if (albVpc && topo.vpcOf(ec2.id) !== albVpc) {
      return { ...base, state: "unused", reasonCode: "Target.NotInUse", reason: "대상이 ALB와 다른 VPC에 있습니다.", probe: null };
    }
    if (az && !albAzs.has(az)) {
      return { ...base, state: "unused", reasonCode: "Target.NotInUse", reason: `대상의 가용 영역(${az})이 ALB에서 활성화되지 않았습니다.`, probe: null };
    }
    const nodeEni = nodes.find((n) => topo.getOfType(n.subnetId, "subnet")?.config.availabilityZone === az) ?? nodes[0];
    if (!nodeEni) {
      return { ...base, state: "unused", reasonCode: "Target.NotInUse", reason: "ALB가 서브넷에 배치되지 않아 헬스 체크를 보낼 노드가 없습니다.", probe: null };
    }
    const port = healthCheckPort(tg);
    const result = probe({ alb, targetGroup: tg, target: ec2, nodeEni, port });
    if (!result.connected) {
      const refused = result.failure?.category === "service";
      return {
        ...base,
        state: "unhealthy",
        reasonCode: refused ? "Target.FailedHealthChecks" : "Target.Timeout",
        reason: refused
          ? `헬스 체크 연결 거부: ${result.failure?.reason ?? "포트에서 응답하는 서비스 없음"}`
          : `헬스 체크 요청 시간 초과: ${result.failure?.reason ?? "네트워크 경로 차단"}`,
        probe: result,
      };
    }
    const code = ec2.config.httpResponseCode;
    if (!matcherIncludes(tg.config.healthCheck.matcher, code)) {
      return {
        ...base,
        state: "unhealthy",
        reasonCode: "Target.ResponseCodeMismatch",
        reason: `가상 앱이 ${tg.config.healthCheck.path}에 HTTP ${code}을(를) 반환했으며 성공 코드 "${tg.config.healthCheck.matcher}"와 일치하지 않습니다.`,
        probe: result,
      };
    }
    return {
      ...base,
      state: "healthy",
      reasonCode: "",
      reason: `헬스 체크 성공: ${tg.config.healthCheck.protocol} ${port}${tg.config.healthCheck.path} → HTTP ${code} (가상)`,
      probe: result,
    };
  });
}

/**
 * 요청을 받을 수 있는 대상.
 * 정상 대상이 없고 비정상 대상만 있으면 AWS ALB처럼 fail-open으로 모든 비정상 대상에 전달한다.
 */
export function routableTargets(health: TargetHealth[]): { targets: TargetHealth[]; failOpen: boolean } {
  const healthy = health.filter((h) => h.state === "healthy");
  if (healthy.length) return { targets: healthy, failOpen: false };
  const unhealthy = health.filter((h) => h.state === "unhealthy");
  if (unhealthy.length) return { targets: unhealthy, failOpen: true };
  return { targets: [], failOpen: false };
}

export function pickRoundRobin<T>(items: T[], requestIndex: number): T | undefined {
  if (!items.length) return undefined;
  const i = ((requestIndex % items.length) + items.length) % items.length;
  return items[i];
}
