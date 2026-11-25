import { beforeEach, describe, expect, it } from "vitest";
import { matchEventPattern, parseEventPattern, SAMPLE_EVENTS } from "@/lib/engine/event-pattern";
import { sendTestEvent } from "@/lib/engine/eventbridge-engine";
import { ruleArn, scheduleCanInvoke } from "@/lib/engine/lambda-engine";
import type { Project, ResourceOfType } from "@/lib/engine/resource-models";
import { countRuns, describeSchedule, formatInTimezone, nextRunTimes, parseScheduleExpression, runsInMinute } from "@/lib/engine/schedule-expression";
import { buildTopology } from "@/lib/engine/topology-engine";
import { validateProject } from "@/lib/engine/validation-engine";
import * as aws from "@/lib/project/console-actions";
import * as eb from "@/lib/project/eventbridge-actions";
import * as iam from "@/lib/project/iam-actions";
import * as lambda from "@/lib/project/lambda-actions";
import { lambdaProject, scheduledLambdaProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function must(r: aws.ActionResult): Project {
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

const parse = (text: string) => {
  const r = parseScheduleExpression(text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const parseError = (text: string) => {
  const r = parseScheduleExpression(text);
  return r.ok ? "" : r.error;
};
const iso = (t: number) => new Date(t).toISOString();
const fnOf = (p: Project, name = "fn") => p.resources.find((r): r is ResourceOfType<"lambda"> => r.type === "lambda" && r.name === name)!;

describe("일정 표현식 (rate · cron · at)", () => {
  it("표현식을 해석하고 사람이 읽는 설명을 만든다", () => {
    expect(describeSchedule(parse("rate(5 minutes)"))).toBe("5분마다");
    expect(describeSchedule(parse("rate(1 hour)"))).toBe("1시간마다");
    expect(describeSchedule(parse("cron(0 9 * * ? *)"))).toBe("매일 09:00");
    expect(describeSchedule(parse("cron(0 9 ? * MON-FRI *)"))).toBe("평일 09:00");
    expect(describeSchedule(parse("cron(30 8 ? * 2,4 *)"))).toBe("매주 월·수요일 08:30");
    expect(describeSchedule(parse("at(2026-12-01T09:00:00)"))).toBe("2026-12-01 09:00에 한 번");
  });

  it("AWS 규칙에 맞지 않는 표현식은 이유와 함께 거부한다", () => {
    expect(parseError("rate(1 minutes)")).toContain("rate(1 minute)");
    expect(parseError("rate(5 minute)")).toContain("rate(5 minutes)");
    expect(parseError("cron(0 9 * * *)")).toContain("6개");
    expect(parseError("cron(0 9 * * * *)")).toContain("하나는 ?");
    expect(parseError("cron(0 9 ? * 0 *)")).toContain("0은 쓸 수 없습니다");
    expect(parseError("at(2026-02-30T09:00:00)")).toContain("올바르지 않습니다");
    expect(parseError("every 5 minutes")).toContain("rate(...)");
  });

  it("cron은 일정의 시간대 달력으로 계산한다 (평일 09:00 KST = 00:00 UTC)", () => {
    const fridayNight = Date.parse("2026-11-06T12:00:00Z");
    const runs = nextRunTimes(parse("cron(0 9 ? * MON-FRI *)"), "Asia/Seoul", 0, fridayNight, 3);
    expect(runs.map(iso)).toEqual(["2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
    expect(formatInTimezone(runs[0], "Asia/Seoul")).toBe("2026-11-09 09:00 (Asia/Seoul)");
    // 시간대를 UTC로 두면 같은 표현식이 한국 시간 18시에 실행된다
    expect(iso(nextRunTimes(parse("cron(0 9 ? * MON-FRI *)"), "UTC", 0, fridayNight, 1)[0])).toBe("2026-11-09T09:00:00.000Z");
    expect(countRuns(parse("cron(0 9 ? * MON-FRI *)"), "Asia/Seoul", 0, Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"))).toBe(21);
  });

  it("일정을 만들기 전의 시각은 실행하지 않은 것으로 본다 (지표·최근 호출에 나오지 않음)", () => {
    const daily = parse("cron(0 9 * * ? *)");
    const created = Date.parse("2026-11-05T03:00:00Z"); // 11월 5일 12:00 KST
    expect(nextRunTimes(daily, "Asia/Seoul", created, Date.parse("2026-11-04T00:00:00Z"), 1).map(iso)).toEqual(["2026-11-06T00:00:00.000Z"]);
    expect(runsInMinute(daily, "Asia/Seoul", created, Date.parse("2026-11-05T00:00:00Z") / 60_000)).toBe(0);
    expect(runsInMinute(daily, "Asia/Seoul", created, Date.parse("2026-11-06T00:00:00Z") / 60_000)).toBe(1);
    expect(nextRunTimes(parse("at(2026-11-05T09:00:00)"), "Asia/Seoul", created, 0, 1)).toEqual([]);
  });

  it("rate는 만든 시각부터 주기를 세고, at은 한 번만 실행한다", () => {
    const anchor = Date.parse("2026-11-01T00:00:30Z");
    const rate = parse("rate(5 minutes)");
    expect(nextRunTimes(rate, "UTC", anchor, anchor, 2).map(iso)).toEqual(["2026-11-01T00:05:30.000Z", "2026-11-01T00:10:30.000Z"]);
    expect(countRuns(rate, "UTC", anchor, anchor, anchor + 60 * 60_000)).toBe(11);
    const at = parse("at(2026-12-01T09:00:00)");
    expect(nextRunTimes(at, "Asia/Seoul", 0, Date.parse("2026-11-06T00:00:00Z"), 5).map(iso)).toEqual(["2026-12-01T00:00:00.000Z"]);
    expect(nextRunTimes(at, "Asia/Seoul", 0, Date.parse("2026-12-02T00:00:00Z"), 5)).toEqual([]);
  });
});

describe("이벤트 패턴", () => {
  const pattern = (o: object) => {
    const r = parseEventPattern(JSON.stringify(o));
    if (!r.ok) throw new Error(r.error);
    return r.pattern;
  };
  const event = (id: string) => SAMPLE_EVENTS.find((e) => e.id === id)!.event;
  const matches = (o: object, id: string) => matchEventPattern(pattern(o), event(id)).matched;

  it("값은 배열로 쓰고, 지원하는 연산자만 받아들인다", () => {
    expect(parseEventPattern('{"source": "aws.ec2"}')).toMatchObject({ ok: false, error: expect.stringContaining("배열") });
    expect(parseEventPattern('{"source": [{"wildcard": "aws.*"}]}')).toMatchObject({ ok: false, error: expect.stringContaining("지원하지 않습니다") });
    expect(parseEventPattern("{}").ok).toBe(false);
    expect(parseEventPattern("not json").ok).toBe(false);
    expect(parseEventPattern('{"source": ["aws.ec2"], "detail": {"state": ["stopped"]}}').ok).toBe(true);
  });

  it("필드는 모두 맞아야 하고(AND) 배열 안의 값은 하나만 맞으면 되며(OR), 틀린 필드를 알려 준다", () => {
    expect(matches({ source: ["aws.ec2"], detail: { state: ["stopped", "terminated"] } }, "ec2-state")).toBe(true);
    const miss = matchEventPattern(pattern({ source: ["aws.ec2"], detail: { state: ["running"] } }), event("ec2-state"));
    expect(miss.matched).toBe(false);
    expect(miss.steps.find((s) => !s.ok)?.path).toBe("detail.state");
  });

  it("prefix·suffix·numeric·anything-but·exists·equals-ignore-case와 배열 값을 판정한다", () => {
    expect(matches({ detail: { object: { key: [{ prefix: "reports/" }] } } }, "s3-created")).toBe(true);
    expect(matches({ detail: { object: { key: [{ suffix: ".csv" }] } } }, "s3-created")).toBe(true);
    expect(matches({ detail: { object: { size: [{ numeric: [">", 1000, "<=", 4096] }] } } }, "s3-created")).toBe(true);
    expect(matches({ detail: { bucket: { name: [{ "anything-but": "school-uploads" }] } } }, "s3-created")).toBe(false);
    expect(matches({ detail: { versionId: [{ exists: false }] } }, "s3-created")).toBe(true);
    expect(matches({ "detail-type": [{ "equals-ignore-case": "object created" }] }, "s3-created")).toBe(true);
    expect(matches({ resources: ["arn:aws:s3:::school-uploads"] }, "s3-created")).toBe(true);
  });
});

const scheduleInput = (targetLambdaId: string, overrides: Partial<eb.ScheduleInput> = {}): eb.ScheduleInput => ({
  name: "every-5",
  description: "",
  expression: "rate(5 minutes)",
  timezone: "Asia/Seoul",
  flexibleWindowMinutes: 0,
  state: "ENABLED",
  targetLambdaId,
  roleId: null,
  createRole: true,
  input: "{}",
  retryAttempts: 185,
  ...overrides,
});

describe("EventBridge Scheduler 일정", () => {
  const base = () => lambdaProject({ placement: "none", role: "basic", template: "hello" });

  it("'새 역할 만들기'의 역할은 scheduler.amazonaws.com을 신뢰하고 그 함수 하나만 호출할 수 있다", () => {
    const p = base();
    const r = eb.createSchedule(p, scheduleInput(fnOf(p).id));
    const after = must(r);
    const s = after.services.eventbridge.schedules[0];
    const role = after.services.iam.roles.find((x) => x.id === s.roleId)!;
    expect(role).toMatchObject({ trustedEntity: "scheduler.amazonaws.com", name: expect.stringMatching(/^Amazon_EventBridge_Scheduler_LAMBDA_/) });
    expect(scheduleCanInvoke(after, s, fnOf(after)).ok).toBe(true);
    expect(r.ok && r.notes.join(" ")).toContain("다음 실행 (가상)");
    // 최소 권한: 같은 역할로 다른 함수는 호출할 수 없다
    const withOther = must(lambda.createFunction(after, { name: "other", runtime: "nodejs22.x", architecture: "x86_64", roleId: fnOf(after).config.roleId }));
    expect(scheduleCanInvoke(withOther, { ...s, targetLambdaId: fnOf(withOther, "other").id }, fnOf(withOther, "other")).ok).toBe(false);
  });

  it("일정 입력을 AWS처럼 검사한다", () => {
    const p = base();
    const id = fnOf(p).id;
    expect(eb.createSchedule(p, scheduleInput(id, { expression: "rate(1 minutes)" }))).toMatchObject({ ok: false, error: expect.stringContaining("[ValidationException]") });
    expect(eb.createSchedule(p, scheduleInput(id, { input: "{bad" })).ok).toBe(false);
    expect(eb.createSchedule(p, scheduleInput("missing")).ok).toBe(false);
    expect(eb.createSchedule(p, scheduleInput(id, { createRole: false, roleId: fnOf(p).config.roleId }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("must allow AWS EventBridge Scheduler"),
    });
    const once = must(eb.createSchedule(p, scheduleInput(id)));
    expect(eb.createSchedule(once, scheduleInput(id))).toMatchObject({ ok: false, error: expect.stringContaining("[ConflictException]") });
  });

  it("비활성화하면 호출하지 않고, 대상 함수를 지워도 일정은 남아 실패한다", () => {
    const p = scheduledLambdaProject();
    const s = p.services.eventbridge.schedules[0];
    const disabled = must(eb.setScheduleState(p, s.id, "DISABLED"));
    expect(validateProject(disabled).findings.map((f) => f.ruleId)).not.toContain("EVB-001");
    const r = aws.deleteFunction(p, fnOf(p).id);
    expect(r.ok && r.notes[0]).toContain("일정 1개");
    if (!r.ok) return;
    expect(r.project.services.eventbridge.schedules).toHaveLength(1);
    expect(validateProject(r.project).findings.map((f) => f.ruleId)).toContain("EVB-001");
  });

  it("함수·일정이 쓰는 역할도 AWS처럼 지울 수 있지만, 이후 실패한다고 알린다", () => {
    const p = scheduledLambdaProject();
    const r = iam.deleteRole(p, fnOf(p).config.roleId!);
    expect(r.ok && r.notes.join(" ")).toContain("실행·호출이 실패");
  });
});

describe("EventBridge 규칙과 테스트 이벤트", () => {
  const ec2Event = (state = "stopped") => {
    const e = structuredClone(SAMPLE_EVENTS.find((x) => x.id === "ec2-state")!.event) as { detail: { state: string } };
    e.detail.state = state;
    return JSON.stringify(e);
  };

  it("콘솔처럼 대상 함수의 리소스 기반 정책을 자동으로 넣고, 일치하는 이벤트가 오면 함수를 호출한다", () => {
    const p = scheduledLambdaProject({ rule: "with-permission" });
    expect(fnOf(p).config.permissions).toEqual([expect.objectContaining({ principal: "events.amazonaws.com", sourceArn: ruleArn("ec2-stopped") })]);
    const sent = sendTestEvent(p, buildTopology(p), ec2Event());
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.deliveries[0]).toMatchObject({ delivered: true, targets: [{ permission: { ok: true }, result: { outcome: "success" } }] });
  });

  it("리소스 기반 정책이 없으면 이벤트가 일치해도 호출되지 않고 EVB-002로 알린다", () => {
    const p = scheduledLambdaProject({ rule: "no-permission" });
    const sent = sendTestEvent(p, buildTopology(p), ec2Event());
    expect(sent.ok && sent.deliveries[0].targets[0]).toMatchObject({ permission: { ok: false }, result: null });
    expect(validateProject(p).findings.map((f) => f.ruleId)).toContain("EVB-002");
  });

  it("패턴과 다른 이벤트는 일치하지 않고, 비활성 규칙은 일치해도 대상을 호출하지 않는다", () => {
    const p = scheduledLambdaProject({ rule: "with-permission" });
    const running = sendTestEvent(p, buildTopology(p), ec2Event("running"));
    expect(running.ok && running.deliveries[0]).toMatchObject({ delivered: false, match: { matched: false } });
    const off = must(eb.setRuleState(p, p.services.eventbridge.rules[0].id, "DISABLED"));
    const sent = sendTestEvent(off, buildTopology(off), ec2Event());
    expect(sent.ok && sent.deliveries[0]).toMatchObject({ delivered: false, match: { matched: true }, targets: [] });
  });

  it("테스트 이벤트에는 source·detail-type·detail이 있어야 한다", () => {
    const p = scheduledLambdaProject({ rule: "with-permission" });
    expect(sendTestEvent(p, buildTopology(p), '{"source": "x"}').ok).toBe(false);
    expect(sendTestEvent(p, buildTopology(p), "nope").ok).toBe(false);
  });

  it("규칙 입력을 검사하고, 대상은 최대 5개다", () => {
    const p = lambdaProject({ placement: "none", role: "basic", template: "hello" });
    const input = { name: "r", description: "", eventPattern: '{"source": "x"}', state: "ENABLED" as const, targetLambdaIds: [], addPermissions: true };
    expect(eb.createRule(p, input)).toMatchObject({ ok: false, error: expect.stringContaining("[InvalidEventPatternException]") });
    expect(eb.createRule(p, { ...input, eventPattern: '{"source": ["x"]}', targetLambdaIds: ["a", "b", "c", "d", "e", "f"] })).toMatchObject({ ok: false, error: expect.stringContaining("[LimitExceededException]") });
  });
});
