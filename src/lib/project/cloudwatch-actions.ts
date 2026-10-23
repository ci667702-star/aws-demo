/**
 * 가상 CloudWatch 콘솔 동작: 경보, 대시보드, 가상 부하.
 * 실제 지표를 수집하거나 알림(SNS 이메일 등)을 보내지 않는다.
 */
import { metricDefinition, MINUTE, NAMESPACE_RESOURCE } from "@/lib/engine/cloudwatch-engine";
import { createId } from "@/lib/engine/ids";
import type { Alarm, Dashboard, DashboardWidget, LoadTest, MetricRef, Project, Services } from "@/lib/engine/resource-models";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withCw(project: Project, update: (cw: Services["cloudwatch"]) => Services["cloudwatch"]): Project {
  return touch({ ...project, services: { ...project.services, cloudwatch: update(project.services.cloudwatch) } });
}

function checkMetric(project: Project, metric: MetricRef): ActionResult | null {
  const def = metricDefinition(metric);
  if (!def) return awsFail("InvalidParameterValue", `지원하지 않는 지표입니다: ${metric.namespace} ${metric.metricName}`);
  const resource = project.resources.find((r) => r.id === metric.resourceId);
  if (!resource) return awsFail("ResourceNotFound", `리소스 ${metric.resourceId}을(를) 찾을 수 없습니다.`);
  if (resource.type !== NAMESPACE_RESOURCE[metric.namespace]) return awsFail("InvalidParameterValue", `${metric.namespace} 지표는 ${resource.type} 리소스에 쓸 수 없습니다.`);
  return null;
}

// ---------------------------------------------------------------- 경보

export type AlarmInput = Omit<Alarm, "id" | "createdAt">;

function checkAlarm(project: Project, input: AlarmInput, exceptId?: string): ActionResult | null {
  const name = input.name.trim();
  if (!name) return awsFail("ValidationError", "경보 이름을 입력하세요.");
  if (name.length > 255) return awsFail("ValidationError", "경보 이름은 255자 이하여야 합니다.");
  if (project.services.cloudwatch.alarms.some((a) => a.name === name && a.id !== exceptId)) return awsFail("ResourceAlreadyExists", `경보 이름 ${name}이(가) 이미 있습니다.`);
  const metricError = checkMetric(project, input.metric);
  if (metricError) return metricError;
  if (![60, 300, 900].includes(input.period)) return awsFail("InvalidParameterValue", "기간은 1분, 5분, 15분 중 하나여야 합니다.");
  if (!Number.isFinite(input.threshold)) return awsFail("InvalidParameterValue", "임계값은 숫자여야 합니다.");
  if (!Number.isInteger(input.evaluationPeriods) || input.evaluationPeriods < 1 || input.evaluationPeriods > 10) return awsFail("InvalidParameterValue", "평가 기간 수는 1~10이어야 합니다.");
  if (!Number.isInteger(input.datapointsToAlarm) || input.datapointsToAlarm < 1 || input.datapointsToAlarm > input.evaluationPeriods) {
    return awsFail("InvalidParameterValue", "경보를 울릴 데이터 포인트 수(M)는 1 이상, 평가 기간 수(N) 이하여야 합니다.", "예: 3개 기간 중 2개가 넘으면 경보 → M=2, N=3");
  }
  return null;
}

export function createAlarm(project: Project, input: AlarmInput): ActionResult {
  const invalid = checkAlarm(project, input);
  if (invalid) return invalid;
  if (project.services.cloudwatch.alarms.length >= 100) return awsFail("LimitExceeded", "이 시뮬레이터에서는 경보를 100개까지 만들 수 있습니다.");
  const alarm: Alarm = { ...input, name: input.name.trim(), description: input.description.trim(), id: createId("alarm"), createdAt: new Date().toISOString() };
  return ok(withCw(project, (cw) => ({ ...cw, alarms: [...cw.alarms, alarm] })), [], alarm.id);
}

export function updateAlarm(project: Project, alarmId: string, input: AlarmInput): ActionResult {
  const existing = project.services.cloudwatch.alarms.find((a) => a.id === alarmId);
  if (!existing) return awsFail("ResourceNotFound", "경보를 찾을 수 없습니다.");
  const invalid = checkAlarm(project, input, alarmId);
  if (invalid) return invalid;
  // 조건이 바뀌면 처음부터 다시 평가한다 (AWS도 설정을 바꾸면 상태를 다시 계산)
  const updated: Alarm = { ...existing, ...input, name: input.name.trim(), description: input.description.trim(), createdAt: new Date().toISOString() };
  return ok(withCw(project, (cw) => ({ ...cw, alarms: cw.alarms.map((a) => (a.id === alarmId ? updated : a)) })), ["경보 설정을 바꿔 상태를 다시 평가합니다."]);
}

export function deleteAlarms(project: Project, alarmIds: string[]): ActionResult {
  const ids = new Set(alarmIds);
  if (!project.services.cloudwatch.alarms.some((a) => ids.has(a.id))) return awsFail("ResourceNotFound", "경보를 찾을 수 없습니다.");
  return ok(withCw(project, (cw) => ({ ...cw, alarms: cw.alarms.filter((a) => !ids.has(a.id)) })));
}

// ---------------------------------------------------------------- 대시보드

const DASHBOARD_NAME = /^[A-Za-z0-9_-]+$/;

export function createDashboard(project: Project, name: string): ActionResult {
  const clean = name.trim();
  if (!clean || clean.length > 255) return awsFail("InvalidParameterInput", "대시보드 이름은 1~255자여야 합니다.");
  if (!DASHBOARD_NAME.test(clean)) return awsFail("InvalidParameterInput", "대시보드 이름에는 영문자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있습니다.");
  if (project.services.cloudwatch.dashboards.some((d) => d.name === clean)) return awsFail("ResourceAlreadyExists", `대시보드 ${clean}이(가) 이미 있습니다.`);
  if (project.services.cloudwatch.dashboards.length >= 20) return awsFail("LimitExceeded", "이 시뮬레이터에서는 대시보드를 20개까지 만들 수 있습니다.");
  const dashboard: Dashboard = { id: createId("dash"), name: clean, createdAt: new Date().toISOString(), widgets: [] };
  return ok(withCw(project, (cw) => ({ ...cw, dashboards: [...cw.dashboards, dashboard] })), [], dashboard.id);
}

export function deleteDashboard(project: Project, dashboardId: string): ActionResult {
  if (!project.services.cloudwatch.dashboards.some((d) => d.id === dashboardId)) return awsFail("ResourceNotFound", "대시보드를 찾을 수 없습니다.");
  return ok(withCw(project, (cw) => ({ ...cw, dashboards: cw.dashboards.filter((d) => d.id !== dashboardId) })));
}

export function addWidget(project: Project, dashboardId: string, input: Omit<DashboardWidget, "id">): ActionResult {
  const dashboard = project.services.cloudwatch.dashboards.find((d) => d.id === dashboardId);
  if (!dashboard) return awsFail("ResourceNotFound", "대시보드를 찾을 수 없습니다.");
  const title = input.title.trim();
  if (!title || title.length > 100) return awsFail("InvalidParameterInput", "위젯 제목은 1~100자여야 합니다.");
  if (!input.metrics.length || input.metrics.length > 5) return awsFail("InvalidParameterInput", "위젯에는 지표를 1~5개 넣을 수 있습니다.");
  for (const m of input.metrics) {
    const invalid = checkMetric(project, m);
    if (invalid) return invalid;
  }
  if (dashboard.widgets.length >= 20) return awsFail("LimitExceeded", "대시보드에는 위젯을 20개까지 넣을 수 있습니다.");
  const widget: DashboardWidget = { id: createId("widget"), title, type: input.type, metrics: input.metrics };
  return ok(withCw(project, (cw) => ({ ...cw, dashboards: cw.dashboards.map((d) => (d.id === dashboardId ? { ...d, widgets: [...d.widgets, widget] } : d)) })), [], widget.id);
}

export function removeWidget(project: Project, dashboardId: string, widgetId: string): ActionResult {
  const dashboard = project.services.cloudwatch.dashboards.find((d) => d.id === dashboardId);
  if (!dashboard?.widgets.some((w) => w.id === widgetId)) return awsFail("ResourceNotFound", "위젯을 찾을 수 없습니다.");
  return ok(withCw(project, (cw) => ({ ...cw, dashboards: cw.dashboards.map((d) => (d.id === dashboardId ? { ...d, widgets: d.widgets.filter((w) => w.id !== widgetId) } : d)) })));
}

// ---------------------------------------------------------------- 가상 부하

export interface LoadInput {
  name: string;
  targetId: string;
  port: number;
  requestsPerMinute: number;
  durationMinutes: number;
  /** 시작 시점 (분). 0이면 지금, 음수면 과거부터 이미 진행된 것으로 가정해 그래프를 바로 볼 수 있다 */
  startOffsetMinutes: number;
}

export function createLoadTest(project: Project, input: LoadInput, now: number = Date.now()): ActionResult {
  const name = input.name.trim();
  if (!name || name.length > 100) return awsFail("ValidationError", "부하 이름은 1~100자여야 합니다.");
  const target = project.resources.find((r) => r.id === input.targetId);
  if (!target || (target.type !== "alb" && target.type !== "ec2")) return awsFail("InvalidParameterValue", "대상은 로드 밸런서나 EC2 인스턴스여야 합니다.");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return awsFail("InvalidParameterValue", "포트는 1~65535 사이여야 합니다.");
  if (!Number.isInteger(input.requestsPerMinute) || input.requestsPerMinute < 1 || input.requestsPerMinute > 100000) return awsFail("InvalidParameterValue", "분당 요청 수는 1~100,000이어야 합니다.");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1440) return awsFail("InvalidParameterValue", "지속 시간은 1~1440분이어야 합니다.");
  if (!Number.isInteger(input.startOffsetMinutes) || input.startOffsetMinutes > 0 || input.startOffsetMinutes < -1440) return awsFail("InvalidParameterValue", "시작 시점이 올바르지 않습니다.");
  if (project.services.cloudwatch.loads.length >= 50) return awsFail("LimitExceeded", "가상 부하는 50개까지 만들 수 있습니다. 끝난 부하를 삭제하세요.");
  const start = (Math.floor(now / MINUTE) + input.startOffsetMinutes) * MINUTE;
  const load: LoadTest = {
    id: createId("load"),
    name,
    targetId: target.id,
    port: input.port,
    requestsPerMinute: input.requestsPerMinute,
    startAt: new Date(start).toISOString(),
    durationMinutes: input.durationMinutes,
    createdAt: new Date(now).toISOString(),
  };
  return ok(withCw(project, (cw) => ({ ...cw, loads: [...cw.loads, load] })), [], load.id);
}

/** 진행 중인 부하를 지금 멈춘다 (지난 기록은 남는다) */
export function stopLoadTest(project: Project, loadId: string, now: number = Date.now()): ActionResult {
  const load = project.services.cloudwatch.loads.find((l) => l.id === loadId);
  if (!load) return awsFail("ResourceNotFound", "가상 부하를 찾을 수 없습니다.");
  const startMinute = Math.floor(Date.parse(load.startAt) / MINUTE);
  const elapsed = Math.max(0, Math.floor(now / MINUTE) - startMinute);
  if (elapsed >= load.durationMinutes) return ok(project, ["이미 끝난 부하입니다."]);
  const durationMinutes = Math.max(1, elapsed);
  return ok(withCw(project, (cw) => ({ ...cw, loads: cw.loads.map((l) => (l.id === loadId ? { ...l, durationMinutes } : l)) })));
}

export function deleteLoadTest(project: Project, loadId: string): ActionResult {
  if (!project.services.cloudwatch.loads.some((l) => l.id === loadId)) return awsFail("ResourceNotFound", "가상 부하를 찾을 수 없습니다.");
  return ok(withCw(project, (cw) => ({ ...cw, loads: cw.loads.filter((l) => l.id !== loadId) })), ["부하 기록을 삭제해 지난 지표 그래프에서도 사라집니다."]);
}
