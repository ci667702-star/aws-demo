/**
 * EventBridge 콘솔 동작: Scheduler 일정과 기본 이벤트 버스의 규칙.
 * 일정·규칙은 실제로 실행되지 않는다. 일정은 표현식으로 실행 시각만 계산하고, 규칙은 테스트 이벤트로만 확인한다.
 */
import { parseEventPattern } from "@/lib/engine/event-pattern";
import { createId } from "@/lib/engine/ids";
import { lambdaArn, ruleArn } from "@/lib/engine/lambda-engine";
import { SCHEDULE_TIMEZONES, type EventRule, type Project, type Resource, type Schedule, type ScheduleTimezone, type Services } from "@/lib/engine/resource-models";
import { describeSchedule, formatInTimezone, nextRunTimes, parseScheduleExpression } from "@/lib/engine/schedule-expression";
import { awsFail, type ActionResult } from "./console-actions";
import { createPolicy, createRole } from "./iam-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withEventBridge(project: Project, update: (eb: Services["eventbridge"]) => Services["eventbridge"]): Project {
  return touch({ ...project, services: { ...project.services, eventbridge: update(project.services.eventbridge) } });
}

const lambdaOf = (project: Project, id: string) => project.resources.find((r): r is Extract<Resource, { type: "lambda" }> => r.id === id && r.type === "lambda");
const fnArn = (fn: Extract<Resource, { type: "lambda" }>) => lambdaArn(fn.name || fn.id);
const shortId = () => createId("x").split("-").pop()!;

// ---------------------------------------------------------------- 일정 (EventBridge Scheduler)

const SCHEDULE_NAME = /^[0-9A-Za-z_.-]{1,64}$/;

export interface ScheduleInput {
  name: string;
  description: string;
  expression: string;
  timezone: ScheduleTimezone;
  flexibleWindowMinutes: number;
  state: Schedule["state"];
  targetLambdaId: string;
  /** 기존 실행 역할 (createRole이면 무시) */
  roleId: string | null;
  /** AWS 콘솔의 '이 일정에 대한 새 역할 만들기': 대상 함수 하나만 호출하는 역할 */
  createRole?: boolean;
  input: string;
  retryAttempts: number;
}

function checkScheduleFields(project: Project, input: ScheduleInput, selfId?: string): ActionResult | null {
  const name = input.name.trim();
  if (!SCHEDULE_NAME.test(name)) return awsFail("ValidationException", "일정 이름은 1~64자의 영문·숫자·마침표(.)·하이픈(-)·밑줄(_)이어야 합니다.");
  if (project.services.eventbridge.schedules.some((s) => s.name === name && s.id !== selfId)) return awsFail("ConflictException", `Schedule ${name} already exists.`, "같은 그룹(default)에 같은 이름의 일정이 이미 있습니다.");
  if (input.description.length > 512) return awsFail("ValidationException", "설명은 512자 이하여야 합니다.");
  const parsed = parseScheduleExpression(input.expression);
  if (!parsed.ok) return awsFail("ValidationException", `Invalid Schedule Expression ${input.expression.trim()}.`, parsed.error);
  if (!(SCHEDULE_TIMEZONES as readonly string[]).includes(input.timezone)) return awsFail("ValidationException", "지원하지 않는 시간대입니다.");
  if (!Number.isInteger(input.flexibleWindowMinutes) || input.flexibleWindowMinutes < 0 || input.flexibleWindowMinutes > 1440) {
    return awsFail("ValidationException", "유연한 시간 창은 끔(0) 또는 1~1,440분이어야 합니다.");
  }
  if (!Number.isInteger(input.retryAttempts) || input.retryAttempts < 0 || input.retryAttempts > 185) return awsFail("ValidationException", "재시도 횟수는 0~185 사이여야 합니다.");
  if (input.input.length > 8192) return awsFail("ValidationException", "입력은 8KB 이하여야 합니다.");
  try {
    JSON.parse(input.input || "{}");
  } catch {
    return awsFail("ValidationException", "입력(Payload)은 올바른 JSON이어야 합니다. 예: {\"report\": \"daily\"}");
  }
  if (!lambdaOf(project, input.targetLambdaId)) return awsFail("ValidationException", "대상 Lambda 함수를 고르세요.", "함수가 없다면 Lambda 콘솔에서 먼저 만드세요.");
  return null;
}

function checkSchedulerRole(project: Project, roleId: string | null): ActionResult | null {
  if (!roleId) return awsFail("ValidationException", "실행 역할을 선택하세요. 일정은 이 역할로 대상을 호출합니다.");
  const role = project.services.iam.roles.find((r) => r.id === roleId);
  if (!role) return awsFail("ValidationException", `역할 ${roleId}을(를) 찾을 수 없습니다.`);
  if (role.trustedEntity !== "scheduler.amazonaws.com") {
    return awsFail(
      "ValidationException",
      "The execution role you provide must allow AWS EventBridge Scheduler to assume the role.",
      `역할 ${role.name}의 신뢰 정책이 scheduler.amazonaws.com을 허용하지 않습니다. 'AWS 서비스 - EventBridge Scheduler'로 만든 역할을 고르거나 새 역할을 만드세요.`,
    );
  }
  return null;
}

/** 대상 함수 하나에 lambda:InvokeFunction만 허용하는 실행 역할을 만든다 (콘솔이 자동으로 만드는 역할과 같은 모양) */
function createSchedulerRole(project: Project, targetLambdaId: string): { project: Project; roleId: string; roleName: string } | ActionResult {
  const fn = lambdaOf(project, targetLambdaId);
  if (!fn) return awsFail("ValidationException", "대상 Lambda 함수를 고르세요.");
  const suffix = shortId();
  const document = JSON.stringify(
    { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [fnArn(fn), `${fnArn(fn)}:*`] }] },
    null,
    2,
  );
  const policy = createPolicy(project, { name: `Amazon-EventBridge-Scheduler-Execution-Policy-${suffix}`, description: `EventBridge Scheduler가 함수 ${fn.name || fn.id}을(를) 호출하는 권한 (콘솔에서 자동 생성)`, document });
  if (!policy.ok) return policy;
  const roleName = `Amazon_EventBridge_Scheduler_LAMBDA_${suffix}`;
  const role = createRole(policy.project, { name: roleName, description: "EventBridge Scheduler가 Lambda 함수를 호출할 때 맡는 역할 (콘솔에서 자동 생성)", trustedEntity: "scheduler.amazonaws.com", policyIds: [policy.createdId!] });
  if (!role.ok) return role;
  return { project: role.project, roleId: role.createdId!, roleName };
}

function scheduleNotes(schedule: Schedule, now = Date.now()): string[] {
  const parsed = parseScheduleExpression(schedule.expression);
  if (!parsed.ok) return [];
  if (schedule.state === "DISABLED") return ["일정이 비활성 상태라 함수를 호출하지 않습니다."];
  const next = nextRunTimes(parsed.value, schedule.timezone, Date.parse(schedule.createdAt), now, 1)[0];
  if (next === undefined) return [parsed.value.kind === "at" ? "지정한 시각이 이미 지나 이 일정은 실행되지 않습니다." : "다음 실행 시각이 없습니다."];
  return [`${describeSchedule(parsed.value)} 실행합니다. 다음 실행 (가상): ${formatInTimezone(next, schedule.timezone)}`];
}

export function createSchedule(project: Project, input: ScheduleInput): ActionResult {
  const invalid = checkScheduleFields(project, input);
  if (invalid) return invalid;
  let p = project;
  let roleId = input.roleId;
  const notes: string[] = [];
  if (input.createRole) {
    const made = createSchedulerRole(p, input.targetLambdaId);
    if ("ok" in made) return made;
    p = made.project;
    roleId = made.roleId;
    notes.push(`실행 역할 ${made.roleName}을(를) 만들었습니다 (이 함수의 lambda:InvokeFunction만 허용).`);
  }
  const roleError = checkSchedulerRole(p, roleId);
  if (roleError) return roleError;
  const schedule: Schedule = {
    id: createId("sched"),
    name: input.name.trim(),
    description: input.description.trim(),
    expression: input.expression.trim(),
    timezone: input.timezone,
    flexibleWindowMinutes: input.flexibleWindowMinutes,
    state: input.state,
    targetLambdaId: input.targetLambdaId,
    roleId,
    input: input.input.trim() || "{}",
    retryAttempts: input.retryAttempts,
    createdAt: new Date().toISOString(),
  };
  return ok(
    withEventBridge(p, (eb) => ({ ...eb, schedules: [...eb.schedules, schedule] })),
    [...notes, ...scheduleNotes(schedule)],
    schedule.id,
  );
}

/** UpdateSchedule: 이름은 바꿀 수 없다 */
export function updateSchedule(project: Project, scheduleId: string, input: Omit<ScheduleInput, "name">): ActionResult {
  const current = project.services.eventbridge.schedules.find((s) => s.id === scheduleId);
  if (!current) return awsFail("ResourceNotFoundException", "일정을 찾을 수 없습니다.");
  const full = { ...input, name: current.name };
  const invalid = checkScheduleFields(project, full, current.id);
  if (invalid) return invalid;
  let p = project;
  let roleId = input.roleId;
  const notes: string[] = [];
  if (input.createRole) {
    const made = createSchedulerRole(p, input.targetLambdaId);
    if ("ok" in made) return made;
    p = made.project;
    roleId = made.roleId;
    notes.push(`실행 역할 ${made.roleName}을(를) 만들었습니다 (이 함수의 lambda:InvokeFunction만 허용).`);
  }
  const roleError = checkSchedulerRole(p, roleId);
  if (roleError) return roleError;
  const updated: Schedule = {
    ...current,
    description: input.description.trim(),
    expression: input.expression.trim(),
    timezone: input.timezone,
    flexibleWindowMinutes: input.flexibleWindowMinutes,
    state: input.state,
    targetLambdaId: input.targetLambdaId,
    roleId,
    input: input.input.trim() || "{}",
    retryAttempts: input.retryAttempts,
  };
  return ok(withEventBridge(p, (eb) => ({ ...eb, schedules: eb.schedules.map((s) => (s.id === scheduleId ? updated : s)) })), [...notes, ...scheduleNotes(updated)]);
}

export function setScheduleState(project: Project, scheduleId: string, state: Schedule["state"]): ActionResult {
  const current = project.services.eventbridge.schedules.find((s) => s.id === scheduleId);
  if (!current) return awsFail("ResourceNotFoundException", "일정을 찾을 수 없습니다.");
  const updated = { ...current, state };
  return ok(withEventBridge(project, (eb) => ({ ...eb, schedules: eb.schedules.map((s) => (s.id === scheduleId ? updated : s)) })), scheduleNotes(updated));
}

export function deleteSchedule(project: Project, scheduleId: string): ActionResult {
  const current = project.services.eventbridge.schedules.find((s) => s.id === scheduleId);
  if (!current) return awsFail("ResourceNotFoundException", "일정을 찾을 수 없습니다.");
  const role = project.services.iam.roles.find((r) => r.id === current.roleId);
  const notes = role?.name.startsWith("Amazon_EventBridge_Scheduler_") ? [`자동으로 만든 실행 역할 ${role.name}은(는) 남아 있습니다 (AWS도 함께 지우지 않습니다). 필요 없으면 IAM에서 지우세요.`] : [];
  return ok(withEventBridge(project, (eb) => ({ ...eb, schedules: eb.schedules.filter((s) => s.id !== scheduleId) })), notes);
}

// ---------------------------------------------------------------- 규칙 (기본 이벤트 버스)

const RULE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export interface RuleInput {
  name: string;
  description: string;
  eventPattern: string;
  state: EventRule["state"];
  targetLambdaIds: string[];
  /** 콘솔처럼 대상 함수의 리소스 기반 정책에 이 규칙의 호출 허용을 자동으로 추가한다 (끄면 CLI로 대상만 추가한 것과 같음) */
  addPermissions: boolean;
}

function checkRuleFields(project: Project, input: RuleInput, selfId?: string): ActionResult | null {
  const name = input.name.trim();
  if (!RULE_NAME.test(name)) return awsFail("ValidationException", "규칙 이름은 1~64자의 영문·숫자·마침표(.)·하이픈(-)·밑줄(_)이어야 합니다.");
  if (project.services.eventbridge.rules.some((r) => r.name === name && r.id !== selfId)) return awsFail("ResourceAlreadyExistsException", `Rule ${name} already exists on EventBus default.`);
  if (input.description.length > 512) return awsFail("ValidationException", "설명은 512자 이하여야 합니다.");
  const parsed = parseEventPattern(input.eventPattern);
  if (!parsed.ok) return awsFail("InvalidEventPatternException", "Event pattern is not valid.", parsed.error);
  const targets = [...new Set(input.targetLambdaIds)];
  if (targets.length > 5) return awsFail("LimitExceededException", "규칙 하나에 대상은 최대 5개까지 추가할 수 있습니다.");
  for (const id of targets) if (!lambdaOf(project, id)) return awsFail("ValidationException", `대상 함수 ${id}을(를) 찾을 수 없습니다.`);
  return null;
}

/** 대상 함수마다 이 규칙(events.amazonaws.com + 규칙 ARN)의 호출 허용을 넣는다 (이미 있으면 그대로) */
function grantRulePermissions(project: Project, ruleName: string, functionIds: string[]): { project: Project; granted: string[] } {
  const arn = ruleArn(ruleName);
  const granted: string[] = [];
  const resources = project.resources.map((r) => {
    if (r.type !== "lambda" || !functionIds.includes(r.id)) return r;
    if (r.config.permissions.some((p) => p.principal === "events.amazonaws.com" && (p.sourceArn === arn || !p.sourceArn))) return r;
    granted.push(r.name || r.id);
    const sid = `AWSEvents_${ruleName}_${shortId()}`.slice(0, 100);
    return { ...r, config: { ...r.config, permissions: [...r.config.permissions, { sid, principal: "events.amazonaws.com" as const, sourceArn: arn }] } };
  });
  return { project: { ...project, resources }, granted };
}

function permissionNotes(granted: string[], input: RuleInput): string[] {
  if (granted.length) return [`함수 ${granted.join(", ")}의 리소스 기반 정책에 이 규칙의 호출 허용을 추가했습니다 (lambda:AddPermission, 콘솔 기본 동작).`];
  if (!input.addPermissions && input.targetLambdaIds.length) return ["리소스 기반 정책을 추가하지 않았습니다. 함수에 이 규칙의 호출 허용이 없으면 이벤트가 일치해도 함수가 호출되지 않습니다."];
  return [];
}

export function createRule(project: Project, input: RuleInput): ActionResult {
  const invalid = checkRuleFields(project, input);
  if (invalid) return invalid;
  const rule: EventRule = {
    id: createId("rule"),
    name: input.name.trim(),
    description: input.description.trim(),
    state: input.state,
    eventPattern: input.eventPattern.trim(),
    targetLambdaIds: [...new Set(input.targetLambdaIds)],
    createdAt: new Date().toISOString(),
  };
  const { project: p, granted } = input.addPermissions ? grantRulePermissions(project, rule.name, rule.targetLambdaIds) : { project, granted: [] };
  const notes = permissionNotes(granted, input);
  if (!rule.targetLambdaIds.length) notes.push("대상이 없어 일치한 이벤트가 어디에도 전달되지 않습니다.");
  return ok(withEventBridge(p, (eb) => ({ ...eb, rules: [...eb.rules, rule] })), notes, rule.id);
}

/** PutRule·PutTargets·RemoveTargets: 이름은 바꿀 수 없다 */
export function updateRule(project: Project, ruleId: string, input: Omit<RuleInput, "name">): ActionResult {
  const current = project.services.eventbridge.rules.find((r) => r.id === ruleId);
  if (!current) return awsFail("ResourceNotFoundException", "규칙을 찾을 수 없습니다.");
  const full = { ...input, name: current.name };
  const invalid = checkRuleFields(project, full, current.id);
  if (invalid) return invalid;
  const targets = [...new Set(input.targetLambdaIds)];
  const added = targets.filter((id) => !current.targetLambdaIds.includes(id));
  const { project: p, granted } = input.addPermissions ? grantRulePermissions(project, current.name, added) : { project, granted: [] };
  const updated: EventRule = { ...current, description: input.description.trim(), state: input.state, eventPattern: input.eventPattern.trim(), targetLambdaIds: targets };
  const notes = permissionNotes(granted, { ...full, targetLambdaIds: added });
  if (current.targetLambdaIds.some((id) => !targets.includes(id))) notes.push("대상에서 뺀 함수의 리소스 기반 정책은 남아 있습니다 (AWS도 자동으로 지우지 않습니다).");
  return ok(withEventBridge(p, (eb) => ({ ...eb, rules: eb.rules.map((r) => (r.id === ruleId ? updated : r)) })), notes);
}

export function setRuleState(project: Project, ruleId: string, state: EventRule["state"]): ActionResult {
  if (!project.services.eventbridge.rules.some((r) => r.id === ruleId)) return awsFail("ResourceNotFoundException", "규칙을 찾을 수 없습니다.");
  return ok(withEventBridge(project, (eb) => ({ ...eb, rules: eb.rules.map((r) => (r.id === ruleId ? { ...r, state } : r)) })));
}

export function deleteRule(project: Project, ruleId: string): ActionResult {
  const current = project.services.eventbridge.rules.find((r) => r.id === ruleId);
  if (!current) return awsFail("ResourceNotFoundException", "규칙을 찾을 수 없습니다.");
  const notes = current.targetLambdaIds.length ? ["대상을 함께 제거했습니다. 함수의 리소스 기반 정책은 남아 있습니다 (AWS도 자동으로 지우지 않습니다)."] : [];
  return ok(withEventBridge(project, (eb) => ({ ...eb, rules: eb.rules.filter((r) => r.id !== ruleId) })), notes);
}
