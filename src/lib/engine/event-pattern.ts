/**
 * EventBridge 이벤트 패턴 검사와 일치 판정 (대표 기능만).
 * 지원: 값 목록(정확히 일치), prefix, suffix, equals-ignore-case, anything-but, exists, numeric, 중첩 객체.
 * 이벤트의 값이 배열이면 원소 중 하나라도 일치하면 일치로 본다 (AWS와 같음).
 * 실제 이벤트 버스나 AWS 서비스 이벤트는 없고, 화면에서 넣은 테스트 이벤트로만 판정한다.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Matcher = string | number | boolean | null | { [op: string]: Json };

export type PatternParse = { ok: true; pattern: Record<string, Json> } | { ok: false; error: string };

const OPERATORS = ["prefix", "suffix", "equals-ignore-case", "anything-but", "exists", "numeric"] as const;
const NUMERIC_OPS = ["<", "<=", "=", ">", ">="];

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkMatcher(m: Json, path: string): string | null {
  if (m === null || ["string", "number", "boolean"].includes(typeof m)) return null;
  if (!isObject(m)) return `"${path}"의 배열 안에는 값이나 연산자 객체만 쓸 수 있습니다.`;
  const keys = Object.keys(m);
  if (keys.length !== 1) return `"${path}"의 연산자 객체에는 키가 하나만 있어야 합니다. 예: {"prefix": "web-"}`;
  const op = keys[0];
  const arg = m[op];
  if (!(OPERATORS as readonly string[]).includes(op)) return `"${path}"의 연산자 "${op}"은(는) 이 시뮬레이터에서 지원하지 않습니다. (지원: ${OPERATORS.join(", ")})`;
  if ((op === "prefix" || op === "suffix" || op === "equals-ignore-case") && typeof arg !== "string") return `"${path}"의 ${op} 값은 문자열이어야 합니다.`;
  if (op === "exists" && typeof arg !== "boolean") return `"${path}"의 exists 값은 true 또는 false입니다.`;
  if (op === "numeric") {
    if (!Array.isArray(arg) || arg.length === 0 || arg.length % 2 !== 0) return `"${path}"의 numeric은 ["연산자", 숫자, ...] 형식입니다. 예: {"numeric": [">", 0, "<=", 5]}`;
    for (let i = 0; i < arg.length; i += 2) {
      if (!NUMERIC_OPS.includes(String(arg[i])) || typeof arg[i + 1] !== "number") return `"${path}"의 numeric 조건이 올바르지 않습니다. 연산자는 ${NUMERIC_OPS.join(" ")} 중 하나입니다.`;
    }
  }
  if (op === "anything-but" && !(Array.isArray(arg) || typeof arg === "string" || typeof arg === "number" || (isObject(arg) && typeof arg.prefix === "string"))) {
    return `"${path}"의 anything-but은 값, 값 목록, 또는 {"prefix": "..."}입니다.`;
  }
  return null;
}

function checkNode(node: Record<string, Json>, path: string): string | null {
  const keys = Object.keys(node);
  if (!keys.length) return path ? `"${path}" 객체가 비어 있습니다.` : "이벤트 패턴이 비어 있습니다. 예: {\"source\": [\"aws.ec2\"]}";
  for (const key of keys) {
    const value = node[key];
    const p = path ? `${path}.${key}` : key;
    if (isObject(value)) {
      const e = checkNode(value, p);
      if (e) return e;
    } else if (Array.isArray(value)) {
      if (!value.length) return `"${p}" 배열이 비어 있습니다.`;
      for (const m of value) {
        const e = checkMatcher(m, p);
        if (e) return e;
      }
    } else {
      return `"${p}" 값은 배열이어야 합니다. 예: "${key}": [${JSON.stringify(value)}] (패턴의 값은 항상 목록으로 씁니다)`;
    }
  }
  return null;
}

/** 이벤트 패턴 JSON을 검사한다 (AWS의 InvalidEventPatternException에 해당하는 실수를 설명과 함께 알려 준다) */
export function parseEventPattern(text: string): PatternParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 형식이 아닙니다: ${(e as Error).message}` };
  }
  if (!isObject(value)) return { ok: false, error: "이벤트 패턴은 JSON 객체여야 합니다. 예: {\"source\": [\"aws.ec2\"]}" };
  const error = checkNode(value, "");
  return error ? { ok: false, error } : { ok: true, pattern: value };
}

export interface MatchStep {
  path: string;
  ok: boolean;
  detail: string;
}

export interface MatchResult {
  matched: boolean;
  steps: MatchStep[];
}

const show = (v: unknown) => (v === undefined ? "(없음)" : JSON.stringify(v));

function matchOne(m: Matcher, v: Json | undefined): boolean {
  if (!isObject(m)) return v !== undefined && !isObject(v) && !Array.isArray(v) && (typeof m === "number" && typeof v === "number" ? m === v : m === v);
  const [op, arg] = Object.entries(m)[0];
  if (op === "exists") return arg ? v !== undefined : v === undefined;
  if (v === undefined || isObject(v) || Array.isArray(v)) return false;
  switch (op) {
    case "prefix":
      return typeof v === "string" && v.startsWith(String(arg));
    case "suffix":
      return typeof v === "string" && v.endsWith(String(arg));
    case "equals-ignore-case":
      return typeof v === "string" && v.toLowerCase() === String(arg).toLowerCase();
    case "anything-but": {
      if (isObject(arg) && typeof arg.prefix === "string") return !(typeof v === "string" && v.startsWith(arg.prefix));
      const list = Array.isArray(arg) ? arg : [arg];
      return !list.some((x) => x === v);
    }
    case "numeric": {
      if (typeof v !== "number") return false;
      const conds = arg as Json[];
      for (let i = 0; i < conds.length; i += 2) {
        const n = conds[i + 1] as number;
        const ok = { "<": v < n, "<=": v <= n, "=": v === n, ">": v > n, ">=": v >= n }[String(conds[i])];
        if (!ok) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function matchNode(pattern: Record<string, Json>, event: Json | undefined, path: string, steps: MatchStep[]): boolean {
  let all = true;
  for (const [key, rule] of Object.entries(pattern)) {
    const p = path ? `${path}.${key}` : key;
    const value = isObject(event) ? event[key] : undefined;
    if (isObject(rule)) {
      if (!isObject(value)) {
        steps.push({ path: p, ok: false, detail: `이벤트에 객체 "${p}"가 없습니다 (값: ${show(value)}).` });
        all = false;
        continue;
      }
      if (!matchNode(rule, value, p, steps)) all = false;
      continue;
    }
    const matchers = rule as Matcher[];
    const candidates: (Json | undefined)[] = Array.isArray(value) ? (value.length ? value : [undefined]) : [value];
    const ok = matchers.some((m) => candidates.some((c) => matchOne(m, c)));
    steps.push({
      path: p,
      ok,
      detail: ok ? `이벤트 값 ${show(value)}이(가) 패턴 ${show(rule)}과 일치합니다.` : `이벤트 값 ${show(value)}이(가) 패턴 ${show(rule)}과 일치하지 않습니다.`,
    });
    if (!ok) all = false;
  }
  return all;
}

/** 이벤트가 패턴과 일치하는지, 필드별 근거와 함께 판정한다. 패턴의 모든 필드가 일치해야 일치다 */
export function matchEventPattern(pattern: Record<string, Json>, event: unknown): MatchResult {
  const steps: MatchStep[] = [];
  const matched = matchNode(pattern, event as Json, "", steps);
  return { matched, steps };
}

/** 테스트용 예시 이벤트 (실제 AWS 이벤트 구조를 단순화) */
export const SAMPLE_EVENTS: { id: string; label: string; event: Record<string, Json> }[] = [
  {
    id: "ec2-state",
    label: "EC2 인스턴스 상태 변경",
    event: {
      version: "0",
      id: "11111111-2222-3333-4444-555555555555",
      "detail-type": "EC2 Instance State-change Notification",
      source: "aws.ec2",
      account: "123456789012",
      time: "2026-11-05T09:00:00Z",
      region: "ap-northeast-2",
      resources: ["arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc123"],
      detail: { "instance-id": "i-0abc123", state: "stopped" },
    },
  },
  {
    id: "s3-created",
    label: "S3 객체 생성",
    event: {
      version: "0",
      id: "22222222-3333-4444-5555-666666666666",
      "detail-type": "Object Created",
      source: "aws.s3",
      account: "123456789012",
      time: "2026-11-05T09:00:00Z",
      region: "ap-northeast-2",
      resources: ["arn:aws:s3:::school-uploads"],
      detail: { bucket: { name: "school-uploads" }, object: { key: "reports/2026/score.csv", size: 2048 } },
    },
  },
  {
    id: "alarm-state",
    label: "CloudWatch 경보 상태 변경",
    event: {
      version: "0",
      id: "33333333-4444-5555-6666-777777777777",
      "detail-type": "CloudWatch Alarm State Change",
      source: "aws.cloudwatch",
      account: "123456789012",
      time: "2026-11-05T09:00:00Z",
      region: "ap-northeast-2",
      resources: ["arn:aws:cloudwatch:ap-northeast-2:123456789012:alarm:high-cpu"],
      detail: { alarmName: "high-cpu", state: { value: "ALARM" }, previousState: { value: "OK" } },
    },
  },
  {
    id: "custom",
    label: "직접 만든 앱 이벤트",
    event: {
      version: "0",
      id: "44444444-5555-6666-7777-888888888888",
      "detail-type": "SignupCompleted",
      source: "school.app",
      account: "123456789012",
      time: "2026-11-05T09:00:00Z",
      region: "ap-northeast-2",
      resources: [],
      detail: { userId: "student-42", grade: 2 },
    },
  },
];
