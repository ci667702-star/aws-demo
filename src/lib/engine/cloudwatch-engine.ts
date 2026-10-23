/**
 * 가상 CloudWatch 엔진.
 * 실제 서버가 없으므로 지표는 "리소스 상태 + 가상 부하 + 대상 헬스"로부터 분 단위로 계산한 값이다.
 * 같은 입력(프로젝트, 시각)이면 항상 같은 값이 나오도록 난수 대신 해시 기반 잡음을 쓴다.
 */
import type { TargetHealth } from "./alb-engine";
import { computeAllTargetHealth, simulateWithTopology } from "./connectivity-engine";
import type { Alarm, ConfigOf, LoadTest, MetricRef, Project, Resource } from "./resource-models";
import { buildTopology, displayName, type Topology } from "./topology-engine";

export const MINUTE = 60_000;

export type MetricResourceType = "ec2" | "alb" | "rds" | "nat-gateway";

export interface MetricDefinition {
  namespace: MetricRef["namespace"];
  metricName: string;
  label: string;
  unit: "Percent" | "Count" | "Bytes" | "Seconds";
  description: string;
  resourceType: MetricResourceType;
  defaultStat: MetricRef["stat"];
}

export const METRIC_CATALOG: MetricDefinition[] = [
  { namespace: "AWS/EC2", metricName: "CPUUtilization", label: "CPU 사용률", unit: "Percent", description: "인스턴스가 CPU를 얼마나 쓰는지 (%)", resourceType: "ec2", defaultStat: "Average" },
  { namespace: "AWS/EC2", metricName: "NetworkIn", label: "네트워크 입력", unit: "Bytes", description: "인스턴스가 받은 데이터 양", resourceType: "ec2", defaultStat: "Sum" },
  { namespace: "AWS/EC2", metricName: "NetworkOut", label: "네트워크 출력", unit: "Bytes", description: "인스턴스가 보낸 데이터 양", resourceType: "ec2", defaultStat: "Sum" },
  { namespace: "AWS/EC2", metricName: "StatusCheckFailed", label: "상태 검사 실패", unit: "Count", description: "인스턴스가 정상 동작하지 않으면 1", resourceType: "ec2", defaultStat: "Maximum" },
  { namespace: "AWS/ApplicationELB", metricName: "RequestCount", label: "요청 수", unit: "Count", description: "로드 밸런서가 받은 요청 수", resourceType: "alb", defaultStat: "Sum" },
  { namespace: "AWS/ApplicationELB", metricName: "TargetResponseTime", label: "대상 응답 시간", unit: "Seconds", description: "대상(EC2)이 응답하기까지 걸린 시간", resourceType: "alb", defaultStat: "Average" },
  { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_2XX_Count", label: "대상 2XX 응답", unit: "Count", description: "대상이 성공(2XX)으로 응답한 수", resourceType: "alb", defaultStat: "Sum" },
  { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_5XX_Count", label: "대상 5XX 응답", unit: "Count", description: "대상이 서버 오류(5XX)로 응답한 수", resourceType: "alb", defaultStat: "Sum" },
  { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_ELB_5XX_Count", label: "로드 밸런서 5XX 응답", unit: "Count", description: "정상 대상이 없어 로드 밸런서가 직접 503 등을 돌려준 수", resourceType: "alb", defaultStat: "Sum" },
  { namespace: "AWS/ApplicationELB", metricName: "HealthyHostCount", label: "정상 대상 수", unit: "Count", description: "상태 검사를 통과한 대상 수", resourceType: "alb", defaultStat: "Minimum" },
  { namespace: "AWS/ApplicationELB", metricName: "UnHealthyHostCount", label: "비정상 대상 수", unit: "Count", description: "상태 검사에 실패한 대상 수", resourceType: "alb", defaultStat: "Maximum" },
  { namespace: "AWS/RDS", metricName: "CPUUtilization", label: "CPU 사용률", unit: "Percent", description: "DB 인스턴스 CPU 사용률", resourceType: "rds", defaultStat: "Average" },
  { namespace: "AWS/RDS", metricName: "DatabaseConnections", label: "DB 연결 수", unit: "Count", description: "DB에 연결된 클라이언트 수", resourceType: "rds", defaultStat: "Average" },
  { namespace: "AWS/RDS", metricName: "FreeStorageSpace", label: "남은 저장 공간", unit: "Bytes", description: "사용할 수 있는 저장 공간", resourceType: "rds", defaultStat: "Minimum" },
  { namespace: "AWS/NATGateway", metricName: "BytesOutToDestination", label: "인터넷으로 보낸 데이터", unit: "Bytes", description: "NAT 게이트웨이를 거쳐 나간 데이터 양", resourceType: "nat-gateway", defaultStat: "Sum" },
  { namespace: "AWS/NATGateway", metricName: "ActiveConnectionCount", label: "활성 연결 수", unit: "Count", description: "NAT 게이트웨이를 통한 동시 연결 수", resourceType: "nat-gateway", defaultStat: "Maximum" },
];

export const NAMESPACE_RESOURCE: Record<MetricRef["namespace"], MetricResourceType> = {
  "AWS/EC2": "ec2",
  "AWS/ApplicationELB": "alb",
  "AWS/RDS": "rds",
  "AWS/NATGateway": "nat-gateway",
};

export function metricDefinition(ref: Pick<MetricRef, "namespace" | "metricName">): MetricDefinition | undefined {
  return METRIC_CATALOG.find((m) => m.namespace === ref.namespace && m.metricName === ref.metricName);
}

/** 인스턴스 유형별 가상 처리 용량 (분당 요청 수). 실제 성능 수치가 아니다. */
export const INSTANCE_CAPACITY_RPM: Record<ConfigOf<"ec2">["instanceType"], number> = {
  "t3.micro": 3000,
  "t3.small": 6000,
  "t3.medium": 12000,
  "t3.large": 24000,
  "m5.large": 30000,
  "c5.large": 40000,
};

// ---------------------------------------------------------------- 잡음

function hash01(seed: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 분 단위로 부드럽게 변하는 0~1 잡음 */
function smoothNoise(seed: string, minute: number): number {
  const slow = Math.floor(minute / 5);
  const t = (minute % 5) / 5;
  const a = hash01(seed, slow);
  const b = hash01(seed, slow + 1);
  return a + (b - a) * t;
}

// ---------------------------------------------------------------- 모델

export interface LoadReach {
  load: LoadTest;
  /** 요청이 대상까지 도달하는지 */
  reaches: boolean;
  /** ALB까지는 왔지만 정상 대상이 없어 ALB가 5XX로 응답 */
  albOnly: boolean;
  reason: string;
}

export interface MetricModel {
  project: Project;
  topology: Topology;
  health: Map<string, TargetHealth[]>;
  loads: LoadReach[];
  /** ALB → 정상 대상 인스턴스 */
  albHealthy: Map<string, ResourceOfEc2[]>;
  albUnhealthy: Map<string, number>;
}

type ResourceOfEc2 = Extract<Resource, { type: "ec2" }>;

function checkLoad(topo: Topology, load: LoadTest): LoadReach {
  const target = topo.get(load.targetId);
  if (!target) return { load, reaches: false, albOnly: false, reason: "대상 리소스가 삭제되었습니다." };
  const result = simulateWithTopology(topo, { source: { kind: "internet", ip: "203.0.113.10" }, destination: { kind: "resource", resourceId: target.id }, protocol: "tcp", port: load.port });
  if (result.outcome === "success") return { load, reaches: true, albOnly: false, reason: "요청이 대상까지 도달합니다." };
  if (target.type === "alb" && result.failure && (result.failure.category === "target" || result.failure.category === "service")) {
    return { load, reaches: true, albOnly: true, reason: `로드 밸런서까지는 도달하지만 대상으로 전달되지 않습니다: ${result.failure.reason}` };
  }
  return { load, reaches: false, albOnly: false, reason: result.failure?.reason ?? result.summary };
}

export function buildMetricModel(project: Project, topology: Topology = buildTopology(project), health: Map<string, TargetHealth[]> = computeAllTargetHealth(topology)): MetricModel {
  const albHealthy = new Map<string, ResourceOfEc2[]>();
  const albUnhealthy = new Map<string, number>();
  for (const alb of topology.ofType("alb")) {
    const healthy = new Map<string, ResourceOfEc2>();
    let unhealthy = 0;
    for (const binding of topology.listenersOf(alb.id)) {
      if (!binding.targetGroupId) continue;
      for (const th of health.get(binding.targetGroupId) ?? []) {
        const ec2 = topology.getOfType(th.targetId, "ec2");
        if (!ec2) continue;
        if (th.state === "healthy") healthy.set(ec2.id, ec2);
        else if (th.state === "unhealthy") unhealthy += 1;
      }
    }
    albHealthy.set(alb.id, [...healthy.values()]);
    albUnhealthy.set(alb.id, unhealthy);
  }
  const loads = project.services.cloudwatch.loads.map((l) => checkLoad(topology, l));
  return { project, topology, health, loads, albHealthy, albUnhealthy };
}

export function loadWindow(load: LoadTest): { start: number; end: number } {
  const start = Math.floor(Date.parse(load.startAt) / MINUTE);
  return { start, end: start + load.durationMinutes };
}

export type LoadStatus = "scheduled" | "running" | "finished";

export function loadStatus(load: LoadTest, now: number): LoadStatus {
  const minute = Math.floor(now / MINUTE);
  const w = loadWindow(load);
  if (minute < w.start) return "scheduled";
  if (minute >= w.end) return "finished";
  return "running";
}

function activeLoads(model: MetricModel, targetId: string, minute: number): LoadReach[] {
  return model.loads.filter((l) => {
    if (l.load.targetId !== targetId || !l.reaches) return false;
    const w = loadWindow(l.load);
    return minute >= w.start && minute < w.end;
  });
}

/** ALB가 받은 분당 요청 */
function albRequests(model: MetricModel, albId: string, minute: number): { total: number; forwarded: number } {
  let total = 0;
  let forwarded = 0;
  for (const l of activeLoads(model, albId, minute)) {
    total += l.load.requestsPerMinute;
    if (!l.albOnly) forwarded += l.load.requestsPerMinute;
  }
  return { total, forwarded };
}

/** 인스턴스가 처리한 분당 요청 (직접 + ALB가 나눠 준 몫) */
function ec2Requests(model: MetricModel, ec2Id: string, minute: number): number {
  let n = activeLoads(model, ec2Id, minute).reduce((s, l) => s + l.load.requestsPerMinute, 0);
  for (const [albId, healthy] of model.albHealthy) {
    if (!healthy.some((e) => e.id === ec2Id)) continue;
    n += albRequests(model, albId, minute).forwarded / healthy.length;
  }
  return n;
}

function ec2Cpu(model: MetricModel, ec2: ResourceOfEc2, minute: number): number {
  const base = 1.5 + smoothNoise(`${ec2.id}:cpu`, minute) * 3;
  const load = (ec2Requests(model, ec2.id, minute) / INSTANCE_CAPACITY_RPM[ec2.config.instanceType]) * 85;
  const jitter = load > 0 ? (smoothNoise(`${ec2.id}:jit`, minute) - 0.5) * 6 : 0;
  return Math.min(100, Math.max(0, base + load + jitter));
}

const latencyFromCpu = (cpu: number) => 0.015 + (cpu > 70 ? ((cpu - 70) / 30) ** 2 * 2.5 : cpu / 70 / 50);

/** 분 단위 원시 값 (데이터 없음이면 null) */
export function rawValue(model: MetricModel, ref: Pick<MetricRef, "namespace" | "metricName" | "resourceId">, minute: number): number | null {
  const { topology: topo } = model;
  const r = topo.get(ref.resourceId);
  if (!r) return null;
  if (ref.namespace === "AWS/EC2" && r.type === "ec2") {
    if (r.config.state !== "running") return null;
    const req = ec2Requests(model, r.id, minute);
    switch (ref.metricName) {
      case "CPUUtilization":
        return ec2Cpu(model, r, minute);
      case "NetworkIn":
        return Math.round(1500 + smoothNoise(`${r.id}:in`, minute) * 4000 + req * 900);
      case "NetworkOut":
        return Math.round(1200 + smoothNoise(`${r.id}:out`, minute) * 3000 + req * 5200);
      case "StatusCheckFailed":
        return 0;
      default:
        return null;
    }
  }
  if (ref.namespace === "AWS/ApplicationELB" && r.type === "alb") {
    if (r.config.state !== "active") return null;
    const healthy = model.albHealthy.get(r.id) ?? [];
    const { total, forwarded } = albRequests(model, r.id, minute);
    const toTargets = healthy.length ? forwarded : 0;
    const elb5xx = total - toTargets;
    const ok = healthy.filter((e) => e.config.httpResponseCode < 500);
    const target2xx = healthy.length ? toTargets * (healthy.filter((e) => e.config.httpResponseCode >= 200 && e.config.httpResponseCode < 300).length / healthy.length) : 0;
    const target5xx = healthy.length ? toTargets * ((healthy.length - ok.length) / healthy.length) : 0;
    switch (ref.metricName) {
      case "RequestCount":
        return total;
      case "TargetResponseTime": {
        if (!toTargets || !healthy.length) return null;
        const avg = healthy.reduce((s, e) => s + latencyFromCpu(ec2Cpu(model, e, minute)), 0) / healthy.length;
        return Math.round(avg * 1000) / 1000;
      }
      case "HTTPCode_Target_2XX_Count":
        return Math.round(target2xx);
      case "HTTPCode_Target_5XX_Count":
        return Math.round(target5xx);
      case "HTTPCode_ELB_5XX_Count":
        return Math.round(elb5xx);
      case "HealthyHostCount":
        return healthy.length;
      case "UnHealthyHostCount":
        return model.albUnhealthy.get(r.id) ?? 0;
      default:
        return null;
    }
  }
  if (ref.namespace === "AWS/RDS" && r.type === "rds") {
    if (r.config.state !== "available") return null;
    // 같은 VPC 인스턴스가 받는 요청이 많을수록 DB도 바빠진다고 가정
    const vpc = topo.vpcOf(r.id);
    const appRequests = topo
      .ofType("ec2")
      .filter((e) => e.config.state === "running" && topo.vpcOf(e.id) === vpc)
      .reduce((s, e) => s + ec2Requests(model, e.id, minute), 0);
    switch (ref.metricName) {
      case "CPUUtilization":
        return Math.min(100, 3 + smoothNoise(`${r.id}:cpu`, minute) * 4 + appRequests / 400);
      case "DatabaseConnections":
        return Math.round(smoothNoise(`${r.id}:conn`, minute) * 2 + Math.min(150, appRequests / 100));
      case "FreeStorageSpace":
        return Math.round(r.config.allocatedStorageGb * 1e9 * (0.92 - smoothNoise(`${r.id}:disk`, Math.floor(minute / 60)) * 0.02));
      default:
        return null;
    }
  }
  if (ref.namespace === "AWS/NATGateway" && r.type === "nat-gateway") {
    if (r.config.state !== "available") return null;
    switch (ref.metricName) {
      case "BytesOutToDestination":
        return Math.round(20000 + smoothNoise(`${r.id}:bytes`, minute) * 180000);
      case "ActiveConnectionCount":
        return Math.round(smoothNoise(`${r.id}:conn`, minute) * 6);
      default:
        return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 집계

export interface Datapoint {
  /** 기간 시작 시각 (ms) */
  t: number;
  value: number | null;
}

function aggregate(values: number[], stat: MetricRef["stat"]): number | null {
  if (!values.length) return null;
  if (stat === "Sum") return values.reduce((s, v) => s + v, 0);
  if (stat === "Maximum") return Math.max(...values);
  if (stat === "Minimum") return Math.min(...values);
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** [start, end) 구간을 period(초) 간격으로 집계한 데이터 포인트 */
export function metricSeries(model: MetricModel, ref: MetricRef, periodSeconds: number, start: number, end: number): Datapoint[] {
  const step = Math.max(1, Math.round(periodSeconds / 60));
  const first = Math.floor(start / MINUTE / step) * step;
  const last = Math.floor(end / MINUTE);
  const points: Datapoint[] = [];
  for (let m = first; m + step <= last + 1 && points.length < 2000; m += step) {
    const values: number[] = [];
    for (let k = 0; k < step; k++) {
      const v = rawValue(model, ref, m + k);
      if (v !== null) values.push(v);
    }
    points.push({ t: m * MINUTE, value: aggregate(values, ref.stat) });
  }
  return points;
}

// ---------------------------------------------------------------- 경보

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA";

export const COMPARISON_SYMBOL: Record<Alarm["comparison"], string> = {
  GreaterThanThreshold: ">",
  GreaterThanOrEqualToThreshold: ">=",
  LessThanThreshold: "<",
  LessThanOrEqualToThreshold: "<=",
};

export function breaches(alarm: Pick<Alarm, "comparison" | "threshold">, value: number): boolean {
  switch (alarm.comparison) {
    case "GreaterThanThreshold":
      return value > alarm.threshold;
    case "GreaterThanOrEqualToThreshold":
      return value >= alarm.threshold;
    case "LessThanThreshold":
      return value < alarm.threshold;
    default:
      return value <= alarm.threshold;
  }
}

export interface AlarmEvaluation {
  state: AlarmState;
  at: number;
  datapoints: Datapoint[];
  breaching: number;
  reason: string;
}

/** at 시각 기준으로 직전에 끝난 evaluationPeriods개 기간을 평가한다 */
export function evaluateAlarm(model: MetricModel, alarm: Alarm, at: number, previous: AlarmState = "INSUFFICIENT_DATA"): AlarmEvaluation {
  const period = alarm.period * 1000;
  const end = Math.floor(at / period) * period;
  const start = end - alarm.evaluationPeriods * period;
  const datapoints = metricSeries(model, alarm.metric, alarm.period, start, end - 1);
  let breaching = 0;
  let available = 0;
  for (const d of datapoints) {
    if (d.value === null) {
      if (alarm.treatMissingData === "breaching") {
        breaching += 1;
        available += 1;
      } else if (alarm.treatMissingData === "notBreaching") available += 1;
      continue;
    }
    available += 1;
    if (breaches(alarm, d.value)) breaching += 1;
  }
  const sym = COMPARISON_SYMBOL[alarm.comparison];
  const fmt = (v: number | null) => (v === null ? "없음" : String(Math.round(v * 100) / 100));
  const recent = datapoints.map((d) => fmt(d.value)).join(", ");
  if (available === 0) {
    if (alarm.treatMissingData === "ignore") return { state: previous, at, datapoints, breaching, reason: `최근 데이터가 없어 이전 상태(${previous})를 유지합니다.` };
    return { state: "INSUFFICIENT_DATA", at, datapoints, breaching, reason: `최근 ${alarm.evaluationPeriods}개 기간에 데이터가 없습니다 (리소스가 중지되었거나 요청이 없음).` };
  }
  if (breaching >= alarm.datapointsToAlarm) {
    return { state: "ALARM", at, datapoints, breaching, reason: `최근 데이터 포인트 [${recent}] 중 ${breaching}개가 임계값(${sym} ${alarm.threshold})을 넘었습니다 (${alarm.datapointsToAlarm}개 이상이면 경보).` };
  }
  return { state: "OK", at, datapoints, breaching, reason: `최근 데이터 포인트 [${recent}] 중 임계값(${sym} ${alarm.threshold})을 넘은 것이 ${breaching}개라 경보 조건(${alarm.datapointsToAlarm}개)에 못 미칩니다.` };
}

export interface AlarmTransition {
  at: number;
  from: AlarmState;
  to: AlarmState;
  reason: string;
}

/** 경보를 만든 시점부터 now까지 기간마다 평가해 상태 변화 기록을 만든다 (최근 maxSteps 기간) */
export function alarmHistory(model: MetricModel, alarm: Alarm, now: number, maxSteps = 288): { current: AlarmEvaluation; transitions: AlarmTransition[] } {
  const period = alarm.period * 1000;
  const created = Date.parse(alarm.createdAt);
  const firstEval = Math.max(Math.ceil(created / period) * period, Math.floor(now / period) * period - (maxSteps - 1) * period);
  let state: AlarmState = "INSUFFICIENT_DATA";
  const transitions: AlarmTransition[] = [];
  let current = evaluateAlarm(model, alarm, Math.max(created, firstEval), state);
  for (let at = firstEval; at <= now; at += period) {
    current = evaluateAlarm(model, alarm, at, state);
    if (current.state !== state) {
      transitions.push({ at, from: state, to: current.state, reason: current.reason });
      state = current.state;
    }
  }
  // 경보를 방금 만들어 아직 평가 시점이 없으면 지금 기준으로 한 번 평가
  if (firstEval > now) {
    current = evaluateAlarm(model, alarm, now, state);
    if (current.state !== state) transitions.push({ at: now, from: state, to: current.state, reason: current.reason });
  }
  return { current, transitions: transitions.reverse() };
}

export function alarmStates(model: MetricModel, alarms: Alarm[], now: number): Map<string, AlarmEvaluation> {
  return new Map(alarms.map((a) => [a.id, alarmHistory(model, a, now, 60).current]));
}

// ---------------------------------------------------------------- 표시 도우미

export function metricResources(project: Project, topology: Topology, type: MetricResourceType): { id: string; label: string; state: string }[] {
  return topology.ofType(type).map((r) => ({ id: r.id, label: `${r.id}${r.name ? ` (${displayName(r)})` : ""}`, state: "state" in r.config ? String(r.config.state) : "" }));
}

export function formatMetricValue(value: number | null, unit: MetricDefinition["unit"] | undefined): string {
  if (value === null) return "데이터 없음";
  if (unit === "Percent") return `${value.toFixed(1)}%`;
  if (unit === "Seconds") return value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`;
  if (unit === "Bytes") {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}GB`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}MB`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}KB`;
    return `${Math.round(value)}B`;
  }
  return Number.isInteger(value) ? value.toLocaleString("ko-KR") : value.toFixed(1);
}

export function metricLabel(ref: Pick<MetricRef, "namespace" | "metricName" | "resourceId" | "stat">, project?: Project): string {
  const def = metricDefinition(ref);
  const resource = project?.resources.find((r) => r.id === ref.resourceId);
  const name = resource ? displayName(resource) : ref.resourceId;
  return `${name} · ${def?.label ?? ref.metricName} (${ref.stat})`;
}
