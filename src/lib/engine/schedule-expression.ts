/**
 * EventBridge Scheduler 일정 표현식: rate(), cron(), at().
 * AWS 문서의 규칙을 따른다.
 *  - rate(값 단위): 단위는 minute(s)·hour(s)·day(s). 값이 1이면 단수, 2 이상이면 복수
 *  - cron(분 시 일 월 요일 연도): 필드 6개. 일과 요일 중 하나는 반드시 ?. 요일은 1(일요일)~7(토요일) 또는 SUN~SAT
 *  - at(yyyy-mm-ddThh:mm:ss): 한 번만 실행
 * 시간대는 일광 절약 시간이 없는 시간대만 다룬다(고정 오프셋). 실제로 시간이 흐르거나 함수가 실행되지는 않는다.
 */
import type { ScheduleTimezone } from "./resource-models";

export const MINUTE_MS = 60_000;

/** 시간대의 UTC 오프셋 (분) */
export const TIMEZONE_OFFSET_MINUTES: Record<ScheduleTimezone, number> = {
  "Asia/Seoul": 540,
  UTC: 0,
  "Asia/Tokyo": 540,
  "Asia/Singapore": 480,
};

interface CronField {
  any: boolean;
  values: Set<number>;
}

export interface CronFields {
  minutes: CronField;
  hours: CronField;
  /** null이면 ? (요일로 정한다) */
  dayOfMonth: (CronField & { last: boolean }) | null;
  months: CronField;
  /** null이면 ? (일로 정한다). nth: "2#1"처럼 그 달의 n번째 요일 */
  dayOfWeek: (CronField & { nth: { dow: number; n: number }[] }) | null;
  years: CronField;
}

export type ParsedSchedule =
  | { kind: "rate"; value: number; unit: "minute" | "hour" | "day"; intervalMs: number }
  | { kind: "cron"; fields: CronFields }
  | { kind: "at"; year: number; month: number; day: number; hour: number; minute: number; second: number };

export type ScheduleParse = { ok: true; value: ParsedSchedule } | { ok: false; error: string };

const fail = (error: string): ScheduleParse => ({ ok: false, error });

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** "1-5/2", "MON-FRI", "0,30" 같은 필드 하나를 숫자 집합으로 바꾼다 */
function parseField(text: string, min: number, max: number, label: string, names?: string[]): CronField | string {
  if (text === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  const toNumber = (token: string): number | null => {
    const upper = token.toUpperCase();
    if (names) {
      const index = names.indexOf(upper);
      if (index >= 0) return index + min;
    }
    if (!/^\d+$/.test(token)) return null;
    return Number(token);
  };
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    if (part.split("/").length > 2) return `${label}의 '${part}'이(가) 올바르지 않습니다.`;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) return `${label}의 간격 '/${stepText}'이(가) 올바르지 않습니다.`;
    let from: number | null;
    let to: number | null;
    if (rangeText === "*") {
      from = min;
      to = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      from = toNumber(a);
      to = toNumber(b);
    } else {
      from = toNumber(rangeText);
      to = stepText === undefined ? from : max;
    }
    if (from === null || to === null) return `${label}에 '${part}'을(를) 쓸 수 없습니다.`;
    if (from < min || to > max || from > to) return `${label}은(는) ${min}~${max} 범위여야 합니다 ('${part}').`;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { any: false, values };
}

function parseCron(body: string): ScheduleParse {
  const parts = body.trim().split(/\s+/);
  if (parts.length === 5) return fail("cron 표현식은 필드가 6개(분 시 일 월 요일 연도)입니다. Linux cron(5개)과 달리 마지막에 연도가 있습니다. 예: cron(0 9 * * ? *)");
  if (parts.length !== 6) return fail(`cron 표현식의 필드가 ${parts.length}개입니다. 분 시 일 월 요일 연도의 6개여야 합니다.`);
  const [mi, h, dom, mo, dow, y] = parts;
  if (dom === "?" && dow === "?") return fail("일(day-of-month)과 요일(day-of-week)을 둘 다 ?로 둘 수 없습니다. 하나는 값이나 *를 쓰세요.");
  if (dom !== "?" && dow !== "?") return fail("일(day-of-month)과 요일(day-of-week) 중 하나는 ?여야 합니다. 예: 매일 → cron(0 9 * * ? *), 평일 → cron(0 9 ? * MON-FRI *)");
  const minutes = parseField(mi, 0, 59, "분");
  if (typeof minutes === "string") return fail(minutes);
  const hours = parseField(h, 0, 23, "시");
  if (typeof hours === "string") return fail(hours);
  const months = parseField(mo, 1, 12, "월", MONTH_NAMES);
  if (typeof months === "string") return fail(months);
  const years = parseField(y, 1970, 2199, "연도");
  if (typeof years === "string") return fail(years);

  let dayOfMonth: CronFields["dayOfMonth"] = null;
  if (dom !== "?") {
    if (/W/i.test(dom)) return fail("이 시뮬레이터는 W(가장 가까운 평일)를 지원하지 않습니다.");
    if (dom.toUpperCase() === "L") dayOfMonth = { any: false, values: new Set(), last: true };
    else {
      const f = parseField(dom, 1, 31, "일");
      if (typeof f === "string") return fail(f);
      dayOfMonth = { ...f, last: false };
    }
  }
  let dayOfWeek: CronFields["dayOfWeek"] = null;
  if (dow !== "?") {
    if (dow.includes("#")) {
      const [d, n] = dow.split("#");
      const day = /^\d$/.test(d) ? Number(d) : DAY_NAMES.indexOf(d.toUpperCase()) + 1;
      const nth = Number(n);
      if (!(day >= 1 && day <= 7) || !(nth >= 1 && nth <= 5)) return fail(`요일의 '${dow}'이(가) 올바르지 않습니다. 예: 2#1 = 그 달의 첫 번째 월요일`);
      dayOfWeek = { any: false, values: new Set(), nth: [{ dow: day, n: nth }] };
    } else if (/L/i.test(dow)) {
      return fail("이 시뮬레이터는 요일의 L(마지막 요일)을 지원하지 않습니다.");
    } else {
      if (/^0$|(^|[,-])0($|[,/-])/.test(dow)) return fail("요일에 0은 쓸 수 없습니다. AWS는 1(일요일)~7(토요일)이며, Linux cron의 0=일요일과 다릅니다.");
      const f = parseField(dow, 1, 7, "요일", DAY_NAMES);
      if (typeof f === "string") return fail(f);
      dayOfWeek = { ...f, nth: [] };
    }
  }
  return { ok: true, value: { kind: "cron", fields: { minutes, hours, dayOfMonth, months, dayOfWeek, years } } };
}

/** rate(), cron(), at() 표현식을 해석한다 */
export function parseScheduleExpression(text: string): ScheduleParse {
  const expr = text.trim();
  const rate = /^rate\((.*)\)$/i.exec(expr);
  if (rate) {
    const m = /^\s*(\d+)\s+([a-z]+)\s*$/i.exec(rate[1]);
    if (!m) return fail("rate 표현식은 rate(값 단위) 형식입니다. 예: rate(5 minutes)");
    const value = Number(m[1]);
    const unitText = m[2].toLowerCase();
    const singular = unitText.replace(/s$/, "");
    if (!["minute", "hour", "day"].includes(singular)) return fail("rate의 단위는 minute(s), hour(s), day(s) 중 하나입니다.");
    if (value < 1) return fail("rate의 값은 1 이상이어야 합니다.");
    if (value === 1 && unitText.endsWith("s")) return fail(`값이 1이면 단수를 씁니다: rate(1 ${singular})`);
    if (value > 1 && !unitText.endsWith("s")) return fail(`값이 2 이상이면 복수를 씁니다: rate(${value} ${singular}s)`);
    const unit = singular as "minute" | "hour" | "day";
    const intervalMs = value * MINUTE_MS * (unit === "minute" ? 1 : unit === "hour" ? 60 : 1440);
    return { ok: true, value: { kind: "rate", value, unit, intervalMs } };
  }
  const cron = /^cron\((.*)\)$/i.exec(expr);
  if (cron) return parseCron(cron[1]);
  const at = /^at\((.*)\)$/i.exec(expr);
  if (at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(at[1].trim());
    if (!m) return fail("at 표현식은 at(yyyy-mm-ddThh:mm:ss) 형식입니다. 예: at(2026-12-01T09:00:00)");
    const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return fail("at 표현식의 날짜나 시각이 올바르지 않습니다.");
    return { ok: true, value: { kind: "at", year, month, day, hour, minute, second } };
  }
  return fail("일정 표현식은 rate(...), cron(...), at(...) 중 하나입니다. 예: rate(5 minutes)");
}

// ---------------------------------------------------------------- 실행 시각 계산

const fieldHas = (f: CronField, v: number) => f.any || f.values.has(v);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 이 날(시간대 기준 달력)에 cron이 실행되는지 */
function cronDayMatches(f: CronFields, year: number, month: number, day: number): boolean {
  if (!fieldHas(f.years, year) || !fieldHas(f.months, month)) return false;
  if (f.dayOfMonth) {
    if (f.dayOfMonth.last) return day === daysInMonth(year, month);
    return fieldHas(f.dayOfMonth, day);
  }
  if (f.dayOfWeek) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1;
    if (f.dayOfWeek.nth.length) return f.dayOfWeek.nth.some((x) => x.dow === dow && Math.ceil(day / 7) === x.n);
    return fieldHas(f.dayOfWeek, dow);
  }
  return false;
}

const sortedValues = (f: CronField, min: number, max: number) => (f.any ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : [...f.values].sort((a, b) => a - b));

/** 기준 시각을 시작점으로 둔 rate 일정의 첫 실행 (만든 시각 + 간격) */
const rateFirst = (anchorMs: number, intervalMs: number) => anchorMs + intervalMs;

/**
 * after 이후(after 포함 안 함)의 실행 시각을 최대 count개 구한다 (UTC ms).
 * rate는 anchor(만든 시각)부터 간격마다, cron은 시간대 달력 기준, at은 한 번.
 * 일정을 만들기 전(anchor 이전)의 시각은 실행하지 않은 것으로 본다.
 */
export function nextRunTimes(schedule: ParsedSchedule, timezone: ScheduleTimezone, anchorMs: number, after: number, count: number): number[] {
  const offset = TIMEZONE_OFFSET_MINUTES[timezone] * MINUTE_MS;
  if (schedule.kind === "at") {
    const t = Date.UTC(schedule.year, schedule.month - 1, schedule.day, schedule.hour, schedule.minute, schedule.second) - offset;
    return t > after && t >= anchorMs && count > 0 ? [t] : [];
  }
  if (schedule.kind === "rate") {
    const first = rateFirst(anchorMs, schedule.intervalMs);
    const k = after < first ? 0 : Math.floor((after - first) / schedule.intervalMs) + 1;
    return Array.from({ length: count }, (_, i) => first + (k + i) * schedule.intervalMs);
  }
  const f = schedule.fields;
  const hours = sortedValues(f.hours, 0, 23);
  const minutes = sortedValues(f.minutes, 0, 59);
  const out: number[] = [];
  after = Math.max(after, anchorMs - 1);
  const startWall = new Date(after + offset);
  let day = Date.UTC(startWall.getUTCFullYear(), startWall.getUTCMonth(), startWall.getUTCDate());
  // 최대 5년까지 찾는다 (cron(0 0 29 2 ? *)처럼 드물게 실행되는 일정도 찾도록)
  for (let i = 0; i < 366 * 5 && out.length < count; i++, day += 1440 * MINUTE_MS) {
    const d = new Date(day);
    if (!cronDayMatches(f, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = day + (h * 60 + m) * MINUTE_MS - offset;
        if (t > after) {
          out.push(t);
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}

/** [from, to) 구간의 실행 횟수 */
export function countRuns(schedule: ParsedSchedule, timezone: ScheduleTimezone, anchorMs: number, from: number, to: number): number {
  if (to <= from) return 0;
  if (schedule.kind === "rate") {
    const first = rateFirst(anchorMs, schedule.intervalMs);
    const runsBefore = (t: number) => (t <= first ? 0 : Math.ceil((t - first) / schedule.intervalMs));
    return Math.max(0, runsBefore(to) - runsBefore(from));
  }
  if (schedule.kind === "at") {
    const [t] = nextRunTimes(schedule, timezone, anchorMs, from - 1, 1);
    return t !== undefined && t < to ? 1 : 0;
  }
  let n = 0;
  let after = from - 1;
  // 분 단위로 실행되는 일정도 한 달(약 43,200번)까지는 셀 수 있도록 나눠서 센다
  while (n < 100_000) {
    const batch = nextRunTimes(schedule, timezone, anchorMs, after, 500);
    const inRange = batch.filter((t) => t < to);
    n += inRange.length;
    if (inRange.length < batch.length || batch.length < 500) break;
    after = batch[batch.length - 1];
  }
  return n;
}

/** 이 분(minute, 1970년부터의 분)에 시작하는 실행 횟수 — CloudWatch 가상 지표용 */
export function runsInMinute(schedule: ParsedSchedule, timezone: ScheduleTimezone, anchorMs: number, minute: number): number {
  const start = minute * MINUTE_MS;
  if (schedule.kind === "cron") {
    if (start < anchorMs) return 0;
    const offset = TIMEZONE_OFFSET_MINUTES[timezone] * MINUTE_MS;
    const wall = new Date(start + offset);
    const f = schedule.fields;
    if (!fieldHas(f.minutes, wall.getUTCMinutes()) || !fieldHas(f.hours, wall.getUTCHours())) return 0;
    return cronDayMatches(f, wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()) ? 1 : 0;
  }
  return countRuns(schedule, timezone, anchorMs, start, start + MINUTE_MS);
}

// ---------------------------------------------------------------- 설명

const pad = (n: number) => String(n).padStart(2, "0");

/** 사람이 읽는 설명 (대표적인 모양만, 나머지는 표현식 그대로) */
export function describeSchedule(schedule: ParsedSchedule): string {
  if (schedule.kind === "rate") {
    const unit = { minute: "분", hour: "시간", day: "일" }[schedule.unit];
    return schedule.value === 1 ? `1${unit}마다` : `${schedule.value}${unit}마다`;
  }
  if (schedule.kind === "at") return `${schedule.year}-${pad(schedule.month)}-${pad(schedule.day)} ${pad(schedule.hour)}:${pad(schedule.minute)}에 한 번`;
  const f = schedule.fields;
  const single = (x: CronField) => (!x.any && x.values.size === 1 ? [...x.values][0] : null);
  const h = single(f.hours);
  const m = single(f.minutes);
  const time = h !== null && m !== null ? `${pad(h)}:${pad(m)}` : null;
  const everyDay = f.months.any && f.years.any && ((f.dayOfMonth?.any ?? false) || (f.dayOfWeek?.any ?? false));
  if (time && everyDay) return `매일 ${time}`;
  if (time && f.dayOfWeek && !f.dayOfWeek.any && !f.dayOfWeek.nth.length && f.months.any) {
    const days = [...f.dayOfWeek.values].sort((a, b) => a - b);
    const names = days.map((d) => "일월화수목금토"[d - 1]).join("·");
    return days.length === 5 && days.join() === "2,3,4,5,6" ? `평일 ${time}` : `매주 ${names}요일 ${time}`;
  }
  if (time && f.dayOfMonth && !f.dayOfMonth.any && f.months.any) {
    return f.dayOfMonth.last ? `매달 마지막 날 ${time}` : `매달 ${[...f.dayOfMonth.values].sort((a, b) => a - b).join("·")}일 ${time}`;
  }
  return "cron 일정";
}

/** 시간대 기준 표시용 문자열 (예: 2026-11-05 09:00 KST) */
export function formatInTimezone(utcMs: number, timezone: ScheduleTimezone): string {
  const d = new Date(utcMs + TIMEZONE_OFFSET_MINUTES[timezone] * MINUTE_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (${timezone})`;
}
