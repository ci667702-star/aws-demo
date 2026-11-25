/**
 * 가상 EventBridge 기본 이벤트 버스.
 * 샌드박스 리소스는 이벤트를 만들지 않으므로, 콘솔에서 넣은 테스트 이벤트로만 규칙의 동작을 계산한다.
 * 이벤트는 저장하지 않고, 규칙마다 패턴 일치 여부와 대상 함수를 호출했을 때의 결과만 돌려준다.
 */
import { matchEventPattern, parseEventPattern, type MatchResult } from "./event-pattern";
import { invokeLambda, ruleCanInvoke, type InvokeResult, type TriggerStatus } from "./lambda-engine";
import type { EventRule, Project, ResourceOfType } from "./resource-models";
import type { Topology } from "./topology-engine";

export interface TargetDelivery {
  functionId: string;
  fn: ResourceOfType<"lambda"> | undefined;
  permission: TriggerStatus;
  /** 호출 권한이 있을 때 함수를 호출한 결과 */
  result: InvokeResult | null;
}

export interface RuleDelivery {
  rule: EventRule;
  patternError: string | null;
  match: MatchResult | null;
  /** 활성 규칙이고 패턴이 일치해 대상으로 보냈는지 */
  delivered: boolean;
  targets: TargetDelivery[];
}

export type TestEventResult = { ok: true; deliveries: RuleDelivery[] } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 테스트 이벤트를 기본 이벤트 버스에 넣었을 때의 결과 (ruleId를 주면 그 규칙만) */
export function sendTestEvent(project: Project, topo: Topology, eventText: string, ruleId?: string): TestEventResult {
  let event: unknown;
  try {
    event = JSON.parse(eventText);
  } catch (e) {
    return { ok: false, error: `JSON 형식이 아닙니다: ${(e as Error).message}` };
  }
  if (!isObject(event)) return { ok: false, error: "이벤트는 JSON 객체여야 합니다." };
  if (typeof event.source !== "string" || !event.source) return { ok: false, error: "이벤트에 source(문자열)가 있어야 합니다. 예: \"source\": \"school.app\"" };
  if (typeof event["detail-type"] !== "string" || !event["detail-type"]) return { ok: false, error: "이벤트에 detail-type(문자열)이 있어야 합니다." };
  if (!isObject(event.detail)) return { ok: false, error: "이벤트에 detail(객체)이 있어야 합니다. 비어 있어도 {}로 넣습니다." };
  const text = JSON.stringify(event);
  const rules = project.services.eventbridge.rules.filter((r) => !ruleId || r.id === ruleId);
  const deliveries = rules.map((rule): RuleDelivery => {
    const parsed = parseEventPattern(rule.eventPattern);
    if (!parsed.ok) return { rule, patternError: parsed.error, match: null, delivered: false, targets: [] };
    const match = matchEventPattern(parsed.pattern, event);
    const delivered = rule.state === "ENABLED" && match.matched;
    const targets = delivered
      ? rule.targetLambdaIds.map((id) => {
          const fn = topo.getOfType(id, "lambda") ?? undefined;
          const permission = ruleCanInvoke(rule, fn);
          return { functionId: id, fn, permission, result: fn && permission.ok ? invokeLambda(project, topo, fn, text) : null };
        })
      : [];
    return { rule, patternError: null, match, delivered, targets };
  });
  return { ok: true, deliveries };
}
