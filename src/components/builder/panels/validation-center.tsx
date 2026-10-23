"use client";

import { useMemo, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Crosshair, Info, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResourceIcon } from "@/components/resource-visuals";
import type { Severity, ValidationCategory, ValidationFinding } from "@/lib/engine/validation-engine";
import { useEditorStore } from "@/lib/store/editor-store";
import { formatTime } from "@/lib/ui/format";
import { useAnalysis } from "@/components/console/analysis-context";

const SEVERITY_META: Record<Severity, { label: string; icon: typeof CircleX; className: string }> = {
  error: { label: "오류", icon: CircleX, className: "text-red-600 dark:text-red-400" },
  warning: { label: "경고", icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400" },
  info: { label: "정보", icon: Info, className: "text-sky-600 dark:text-sky-400" },
};

const CATEGORY_LABEL: Record<ValidationCategory, string> = {
  network: "네트워크",
  security: "보안",
  compute: "컴퓨팅",
  "load-balancing": "로드 밸런싱",
  database: "데이터베이스",
  general: "일반",
};

export function ValidationCenter({ onRevalidate }: { onRevalidate: () => void }) {
  const analysis = useAnalysis();
  const focusResources = useEditorStore((s) => s.focusResources);
  const [severities, setSeverities] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const [category, setCategory] = useState<ValidationCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analysis.findings.filter(
      (f) =>
        severities[f.severity] &&
        (category === "all" || f.category === category) &&
        (!q || `${f.ruleId} ${f.title} ${f.cause}`.toLowerCase().includes(q)),
    );
  }, [analysis.findings, severities, category, query]);

  return (
    <div className="flex h-full flex-col" data-testid="validation-center">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {(Object.keys(SEVERITY_META) as Severity[]).map((s) => {
          const meta = SEVERITY_META[s];
          const Icon = meta.icon;
          return (
            <Button
              key={s}
              variant={severities[s] ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={severities[s]}
              onClick={() => setSeverities((x) => ({ ...x, [s]: !x[s] }))}
            >
              <Icon className={meta.className} />
              {meta.label} {analysis.counts[s]}
            </Button>
          );
        })}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ValidationCategory | "all")}
          aria-label="분류 필터"
          className="h-6 rounded-md border border-input bg-transparent px-1.5 text-xs dark:bg-input/30"
        >
          <option value="all">전체 분류</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="규칙/내용 검색" aria-label="검증 결과 검색" className="h-6 w-40 pl-5 text-xs" />
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            마지막 검증 {formatTime(analysis.analyzedAt)} · {analysis.durationMs}ms
          </span>
          <Button variant="outline" size="xs" onClick={onRevalidate}>
            <RotateCcw /> 다시 검증
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
            <CircleCheck className="size-5 text-emerald-600" aria-hidden />
            {analysis.findings.length === 0
              ? "검증 결과 문제가 발견되지 않았습니다."
              : "선택한 필터에 해당하는 결과가 없습니다. (정보 항목은 기본적으로 숨겨져 있습니다)"}
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((f) => (
              <FindingItem
                key={f.id}
                finding={f}
                expanded={expanded === f.id}
                onToggle={() => setExpanded((e) => (e === f.id ? null : f.id))}
                onFocus={(ids) => focusResources(ids)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FindingItem({
  finding,
  expanded,
  onToggle,
  onFocus,
}: {
  finding: ValidationFinding;
  expanded: boolean;
  onToggle: () => void;
  onFocus: (ids: string[]) => void;
}) {
  const analysis = useAnalysis();
  const meta = SEVERITY_META[finding.severity];
  const Icon = meta.icon;
  return (
    <li data-testid="finding" data-rule={finding.ruleId}>
      <div className="flex flex-col gap-1 px-3 py-2 hover:bg-muted/40 sm:flex-row sm:items-start sm:gap-2">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2 text-left" aria-expanded={expanded}>
          <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden />
          <Icon className={cn("mt-0.5 size-4 shrink-0", meta.className)} aria-label={meta.label} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
              {finding.title}
              <span className="font-mono text-[10px] font-normal text-muted-foreground">
                {finding.ruleId} · {CATEGORY_LABEL[finding.category]}
              </span>
            </span>
            <span className={cn("block text-xs text-muted-foreground", !expanded && "line-clamp-1")}>{finding.cause}</span>
          </span>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-1 pl-11 sm:justify-end sm:pl-0">
          {finding.resourceIds.slice(0, 3).map((id) => {
            const r = analysis.topology.get(id);
            if (!r) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onFocus([id])}
                className="inline-flex max-w-32 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                title={`${r.name}(으)로 이동`}
              >
                <ResourceIcon type={r.type} size="sm" className="size-4 [&_svg]:size-2.5" />
                <span className="truncate">{r.name}</span>
              </button>
            );
          })}
          {finding.resourceIds.length > 0 && (
            <Button variant="ghost" size="icon-xs" aria-label="관련 리소스로 이동" onClick={() => onFocus(finding.resourceIds)}>
              <Crosshair />
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <dl className="grid gap-2 px-10 pb-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-medium">문제 원인</dt>
            <dd className="text-muted-foreground">{finding.cause}</dd>
          </div>
          <div>
            <dt className="font-medium">발생 조건 (문제가 되는 설정)</dt>
            <dd className="font-mono text-[11px] text-muted-foreground">{finding.condition}</dd>
          </div>
          <div>
            <dt className="font-medium">수정 방법</dt>
            <dd>
              <ul className="list-disc pl-4 text-muted-foreground">
                {finding.fix.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="font-medium">수정하면 달라지는 결과</dt>
            <dd className="text-muted-foreground">{finding.impact}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-medium">관련 AWS 개념</dt>
            <dd className="rounded-md bg-muted/50 p-2 text-muted-foreground">{finding.concept}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}
