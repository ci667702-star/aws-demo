"use client";

import { cn } from "cn";
import { useMemo, useSyncExternalStore } from "react";
import { buildMetricModel, metricDefinition, metricSeries, type AlarmState, type MetricModel } from "@/lib/engine/cloudwatch-engine";
import type { MetricRef, Project } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { useAnalysis } from "../../analysis-context";
import { StatusIndicator } from "../../ui/status";
import type { ChartSeries } from "./metric-chart";

// ---------------------------------------------------------------- 시계 (15초마다 갱신)

const TICK = 15_000;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clockTimer) clockTimer = setInterval(() => clockListeners.forEach((l) => l()), TICK);
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** 15초 단위로 내림한 현재 시각. 지표·경보 화면이 시간이 흐르면 저절로 갱신된다. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / TICK) * TICK,
    () => 0,
  );
}

export function useMetricModel(): MetricModel {
  const { project, topology, health } = useAnalysis();
  return useMemo(() => buildMetricModel(project, topology, health), [project, topology, health]);
}

// ---------------------------------------------------------------- 표시

export function AlarmStateBadge({ state }: { state: AlarmState }) {
  if (state === "ALARM") return <StatusIndicator type="error">경보 상태 (ALARM)</StatusIndicator>;
  if (state === "OK") return <StatusIndicator type="success">정상 (OK)</StatusIndicator>;
  return <StatusIndicator type="pending">데이터 부족</StatusIndicator>;
}

export const RANGES = [
  { minutes: 60, label: "1시간" },
  { minutes: 180, label: "3시간" },
  { minutes: 720, label: "12시간" },
  { minutes: 1440, label: "1일" },
];

export const PERIOD_OPTIONS = [
  { value: "60", label: "1분" },
  { value: "300", label: "5분" },
  { value: "900", label: "15분" },
];

export const STAT_OPTIONS = [
  { value: "Average", label: "평균 (Average)" },
  { value: "Sum", label: "합계 (Sum)" },
  { value: "Maximum", label: "최대 (Maximum)" },
  { value: "Minimum", label: "최소 (Minimum)" },
];

/** 차트 위 한 줄짜리 기간 선택 (프리셋 버튼) */
export function RangePicker({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  return (
    <div role="radiogroup" aria-label="기간" className="inline-flex overflow-hidden rounded-full border-2 border-aws-border-strong">
      {RANGES.map((r) => (
        <button
          key={r.minutes}
          type="button"
          role="radio"
          aria-checked={value === r.minutes}
          onClick={() => onChange(r.minutes)}
          className={cn(
            "px-3 py-1 text-[13px] font-bold transition-colors",
            value === r.minutes ? "bg-aws-link text-aws-surface" : "text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** 범위에 맞는 기본 집계 기간 (점이 너무 많아지지 않게) */
export const periodForRange = (minutes: number) => (minutes <= 180 ? 60 : minutes <= 720 ? 300 : 900);

export function seriesFor(model: MetricModel, project: Project, refs: MetricRef[], period: number, start: number, end: number): ChartSeries[] {
  return refs.map((ref) => {
    const def = metricDefinition(ref);
    const resource = project.resources.find((r) => r.id === ref.resourceId);
    return {
      key: `${ref.namespace}|${ref.metricName}|${ref.resourceId}|${ref.stat}`,
      label: `${resource ? displayName(resource) : ref.resourceId} · ${def?.label ?? ref.metricName}`,
      points: metricSeries(model, ref, period, start, end),
      unit: def?.unit,
    };
  });
}

export const refKey = (ref: Pick<MetricRef, "namespace" | "metricName" | "resourceId">) => `${ref.namespace}|${ref.metricName}|${ref.resourceId}`;
