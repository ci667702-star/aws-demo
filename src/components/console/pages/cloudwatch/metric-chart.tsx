"use client";

/**
 * CloudWatch 지표 선 그래프 (SVG).
 * - 선 2px, 끝점 표시, 옅은 격자, 축은 실선 헤어라인
 * - 십자선 + 툴팁(같은 시각의 모든 시리즈 값), 키보드 ←/→ 이동
 * - 시리즈 2개 이상이면 범례, 언제나 '표로 보기' 제공 (색만으로 구분하지 않도록)
 */
import { cn } from "cn";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMetricValue, type Datapoint, type MetricDefinition } from "@/lib/engine/cloudwatch-engine";

export const SERIES_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"];

export interface ChartSeries {
  key: string;
  label: string;
  points: Datapoint[];
  unit?: MetricDefinition["unit"];
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function axisLabel(v: number, unit: MetricDefinition["unit"] | undefined): string {
  if (unit === "Percent") return `${Math.round(v)}%`;
  if (unit === "Seconds") return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(1)}s`;
  if (unit === "Bytes") return formatMetricValue(v, "Bytes");
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const timeLabel = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720];

const MARGIN = { top: 12, right: 16, bottom: 28, left: 56 };

export function MetricChart({
  series,
  start,
  end,
  height = 220,
  threshold,
  ariaLabel,
  emptyText = "이 기간에 데이터가 없습니다.",
}: {
  series: ChartSeries[];
  start: number;
  end: number;
  /** 그림 영역 높이 (x축 글자 영역 제외) */
  height?: number;
  threshold?: { value: number; label: string } | null;
  ariaLabel: string;
  emptyText?: string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const unit = series[0]?.unit;
  const times = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b), [series]);
  const values = series.flatMap((s) => s.points.map((p) => p.value).filter((v): v is number => v !== null));
  const empty = values.length === 0;
  const rawMax = Math.max(0, ...values, threshold ? threshold.value : 0);
  const yMax = unit === "Percent" ? Math.min(100, Math.max(10, niceMax(rawMax * 1.1))) : niceMax(rawMax * 1.1 || 1);
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height;
  const x = (t: number) => MARGIN.left + (end === start ? 0 : ((t - start) / (end - start)) * plotW);
  const y = (v: number) => MARGIN.top + plotH - (Math.min(v, yMax) / yMax) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const spanMin = (end - start) / 60000;
  const stepMin = TICK_STEPS.find((s) => spanMin / s <= Math.max(2, Math.floor(plotW / 90))) ?? 1440;
  const xTicks: number[] = [];
  for (let t = Math.ceil(start / (stepMin * 60000)) * stepMin * 60000; t <= end; t += stepMin * 60000) xTicks.push(t);

  const paths = series.map((s) => {
    const segments: string[] = [];
    const singles: { t: number; v: number }[] = [];
    let current: { t: number; v: number }[] = [];
    const flush = () => {
      if (current.length === 1) singles.push(current[0]);
      else if (current.length > 1) segments.push(current.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(""));
      current = [];
    };
    for (const p of s.points) {
      if (p.value === null) flush();
      else current.push({ t: p.t, v: p.value });
    }
    flush();
    const last = [...s.points].reverse().find((p) => p.value !== null);
    return { segments, singles, last };
  });

  const hoverT = hover !== null ? times[hover] : null;
  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!times.length || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = start + ((px - MARGIN.left) / plotW) * (end - start);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    setHover(best);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!times.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const cur = hover ?? times.length - 1;
      setHover(Math.max(0, Math.min(times.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1))));
    }
    if (e.key === "Escape") setHover(null);
  };

  const tooltipLeft = hoverT !== null ? Math.min(Math.max(x(hoverT) + 12, MARGIN.left), Math.max(MARGIN.left, width - 220)) : 0;

  return (
    <figure className="space-y-2" aria-label={ariaLabel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {series.length > 1 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-aws-text-2" aria-label="범례">
            {series.map((s, i) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
                {s.label}
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <button type="button" className="text-[13px] text-aws-link hover:underline" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? "그래프로 보기" : "표로 보기"}
        </button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-aws-border">
          <table className="w-full border-collapse text-[13px]" aria-label={`${ariaLabel} 데이터`}>
            <thead className="sticky top-0 bg-aws-surface-2">
              <tr className="text-left text-aws-text-2">
                <th className="px-3 py-1.5 font-bold">시각</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-1.5 font-bold">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...times].reverse().map((t) => (
                <tr key={t} className="border-t border-aws-divider">
                  <td className="px-3 py-1">{timeLabel(t)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-1">
                      {formatMetricValue(s.points.find((p) => p.t === t)?.value ?? null, s.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="relative" style={{ height: plotH + MARGIN.top + MARGIN.bottom }}>
          {width > 0 && (
            <svg
              width={width}
              height={plotH + MARGIN.top + MARGIN.bottom}
              role="img"
              aria-label={`${ariaLabel}. ←/→ 키로 시각을 옮겨 값을 볼 수 있습니다.`}
              tabIndex={0}
              onPointerMove={onPointer}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
              className="block rounded focus-visible:outline-2 focus-visible:outline-aws-focus"
            >
              {yTicks.map((v, i) => (
                <g key={i}>
                  <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(v)} y2={y(v)} stroke={i === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--aws-text-3)" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {axisLabel(v, unit)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text key={t} x={x(t)} y={MARGIN.top + plotH + 18} textAnchor="middle" fontSize={11} fill="var(--aws-text-3)" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {timeLabel(t)}
                </text>
              ))}
              {threshold && threshold.value <= yMax && (
                <g>
                  <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--viz-critical)" strokeWidth={1.5} />
                  <text x={MARGIN.left + plotW - 4} y={y(threshold.value) - 6} textAnchor="end" fontSize={11} fill="var(--aws-text-2)">
                    {threshold.label}
                  </text>
                </g>
              )}
              {paths.map((p, i) => (
                <g key={series[i].key} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} fill={SERIES_COLORS[i % SERIES_COLORS.length]}>
                  {p.segments.map((d, k) => (
                    <path key={k} d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                  {p.singles.map((s) => (
                    <circle key={s.t} cx={x(s.t)} cy={y(s.v)} r={3} stroke="none" />
                  ))}
                  {p.last && p.last.value !== null && <circle cx={x(p.last.t)} cy={y(p.last.value)} r={4} stroke="var(--aws-surface)" strokeWidth={2} />}
                </g>
              ))}
              {hoverT !== null && (
                <g pointerEvents="none">
                  <line x1={x(hoverT)} x2={x(hoverT)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--aws-text-3)" strokeWidth={1} />
                  {series.map((s, i) => {
                    const v = s.points.find((p) => p.t === hoverT)?.value;
                    return v == null ? null : <circle key={s.key} cx={x(hoverT)} cy={y(v)} r={4} fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--aws-surface)" strokeWidth={2} />;
                  })}
                </g>
              )}
            </svg>
          )}
          {empty && width > 0 && (
            <p className="pointer-events-none absolute inset-x-0 text-center text-sm text-aws-text-2" style={{ top: MARGIN.top + plotH / 2 - 10, paddingLeft: MARGIN.left }}>
              {emptyText}
            </p>
          )}
          {hoverT !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 w-[208px] rounded-lg border border-aws-border bg-aws-surface p-2.5 text-[13px] shadow-lg"
              style={{ left: tooltipLeft }}
              role="status"
              aria-live="polite"
            >
              <p className="mb-1 text-aws-text-2">{timeLabel(hoverT)}</p>
              <ul className="space-y-0.5">
                {series.map((s, i) => (
                  <li key={s.key} className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
                    <span className="font-bold text-aws-text tabular-nums">{formatMetricValue(s.points.find((p) => p.t === hoverT)?.value ?? null, s.unit)}</span>
                    <span className="truncate text-aws-text-2">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** 숫자 위젯: 최신 값 + 작은 추세선 */
export function MetricNumber({ series }: { series: ChartSeries[] }) {
  return (
    <ul className={cn("grid gap-4", series.length > 1 ? "sm:grid-cols-2" : "")}>
      {series.map((s, i) => {
        const last = [...s.points].reverse().find((p) => p.value !== null);
        const pts = s.points.slice(-12);
        const vals = pts.map((p) => p.value).filter((v): v is number => v !== null);
        const max = Math.max(1e-9, ...vals);
        const min = Math.min(0, ...vals);
        const W = 120;
        const H = 32;
        const d = pts
          .map((p, k) => (p.value === null ? null : `${(k / Math.max(1, pts.length - 1)) * W},${H - ((p.value - min) / (max - min || 1)) * (H - 4) - 2}`))
          .filter(Boolean)
          .map((c, k) => `${k ? "L" : "M"}${c}`)
          .join("");
        return (
          <li key={s.key} className="space-y-1">
            <p className="flex items-center gap-1.5 text-sm text-aws-text-2">
              <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
              {s.label}
            </p>
            <div className="flex items-end justify-between gap-3">
              <span className="text-[28px] leading-none font-bold text-aws-text">{formatMetricValue(last?.value ?? null, s.unit)}</span>
              {d && (
                <svg width={W} height={H} aria-hidden className="shrink-0">
                  <path d={d} fill="none" stroke="var(--aws-text-3)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
