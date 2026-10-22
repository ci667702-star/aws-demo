"use client";

import { useMemo, useState } from "react";
import { Calculator, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResourceIcon } from "@/components/resource-visuals";
import { DEFAULT_COST_ASSUMPTIONS, estimateCost, resolveCostAssumptions } from "@/lib/engine/cost-engine";
import type { CostAssumptions } from "@/lib/engine/resource-models";
import { setCostAssumptions } from "@/lib/project/mutations";
import { useProjectStore } from "@/lib/store/project-store";
import { formatMoney } from "@/lib/ui/format";
import { useProjectActions } from "../inspector/use-project-actions";

type NumberKey = {
  [K in keyof CostAssumptions]: CostAssumptions[K] extends number ? K : never;
}[keyof CostAssumptions];

const USAGE_FIELDS: { key: NumberKey; label: string; max: number }[] = [
  { key: "hoursPerMonth", label: "월 사용 시간", max: 744 },
  { key: "dataProcessedGb", label: "NAT/ALB 처리 데이터 (GB/월)", max: 1_000_000 },
  { key: "dataTransferOutGb", label: "인터넷 방향 전송 (GB/월)", max: 1_000_000 },
];

const RATE_FIELDS: { key: NumberKey; label: string }[] = [
  { key: "natHourly", label: "NAT Gateway / 시간" },
  { key: "natPerGb", label: "NAT 처리 / GB" },
  { key: "albHourly", label: "ALB / 시간" },
  { key: "albPerGb", label: "ALB 처리 / GB" },
  { key: "publicIpv4Hourly", label: "퍼블릭 IPv4 / 시간" },
  { key: "dataTransferOutPerGb", label: "인터넷 전송 / GB" },
  { key: "rdsStorageGbMonth", label: "RDS 스토리지 / GB-월" },
];

function NumberCell({ value, onCommit, label, max = 1_000_000 }: { value: number; onCommit: (v: number) => void; label: string; max?: number }) {
  const [draft, setDraft] = useState(String(value));
  const [prev, setPrev] = useState(value);
  const [error, setError] = useState(false);
  if (value !== prev) {
    setPrev(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    if (!draft.trim() || !Number.isFinite(n) || n < 0 || n > max) {
      setError(true);
      return;
    }
    setError(false);
    if (n !== value) onCommit(n);
  };
  return (
    <Input
      value={draft}
      aria-label={label}
      aria-invalid={error}
      title={error ? `0~${max} 사이의 숫자를 입력하세요.` : undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        setError(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="h-7 w-24 text-right font-mono text-xs"
    />
  );
}

export function CostPanel({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId])!;
  const actions = useProjectActions(projectId);
  const assumptions = resolveCostAssumptions(project);
  const report = useMemo(() => estimateCost(project, assumptions), [project, assumptions]);
  const [showRates, setShowRates] = useState(false);

  const save = (patch: Partial<CostAssumptions>) =>
    actions.run("가상 비용 가정값 변경", (p) => setCostAssumptions(p, { ...resolveCostAssumptions(p), ...patch }));

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(280px,340px)_1fr]" data-testid="cost-panel">
      <div className="space-y-3 overflow-auto border-b p-3 lg:border-r lg:border-b-0">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
          <p>
            <b>교육용 가상 비용</b>입니다. 실제 AWS 요금표가 아닌 가정 단가로 계산하며 실제 청구 금액이 아닙니다. 단가는 아래에서 직접 바꿀 수 있습니다.
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">사용량 가정</p>
          {USAGE_FIELDS.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-2 text-xs">
              <span>{f.label}</span>
              <NumberCell label={f.label} value={assumptions[f.key]} max={f.max} onCommit={(v) => save({ [f.key]: v })} />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <button type="button" className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowRates((s) => !s)} aria-expanded={showRates}>
              교육용 가정 단가 {showRates ? "접기" : "편집"}
            </button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!project.costAssumptions}
              onClick={() => actions.run("가상 비용 가정값 초기화", (p) => setCostAssumptions(p, null))}
            >
              <RotateCcw /> 기본값
            </Button>
          </div>
          {showRates && (
            <div className="space-y-1.5">
              {RATE_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-2 text-xs">
                  <span>{f.label}</span>
                  <NumberCell label={f.label} value={assumptions[f.key]} onCommit={(v) => save({ [f.key]: v })} />
                </div>
              ))}
              <p className="pt-1 text-[11px] font-medium text-muted-foreground">EC2 / 시간</p>
              {Object.keys(DEFAULT_COST_ASSUMPTIONS.ec2Hourly).map((type) => (
                <div key={type} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{type}</span>
                  <NumberCell label={`${type} 시간당`} value={assumptions.ec2Hourly[type] ?? 0} onCommit={(v) => save({ ec2Hourly: { ...assumptions.ec2Hourly, [type]: v } })} />
                </div>
              ))}
              <p className="pt-1 text-[11px] font-medium text-muted-foreground">RDS / 시간</p>
              {Object.keys(DEFAULT_COST_ASSUMPTIONS.rdsHourly).map((cls) => (
                <div key={cls} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{cls}</span>
                  <NumberCell label={`${cls} 시간당`} value={assumptions.rdsHourly[cls] ?? 0} onCommit={(v) => save({ rdsHourly: { ...assumptions.rdsHourly, [cls]: v } })} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 overflow-auto p-3">
        <div className="mb-3 flex items-center justify-between rounded-lg border p-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Calculator className="size-4" aria-hidden /> 월 예상 가상 비용 (교육용 추정치)
          </span>
          <span className="font-mono text-lg font-semibold" data-testid="cost-total">
            {formatMoney(report.total)}
          </span>
        </div>
        {report.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">리소스가 없습니다.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 font-medium">리소스</th>
                <th className="py-1.5 font-medium">계산 (가정)</th>
                <th className="py-1.5 text-right font-medium">가상 비용</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((line) => (
                <tr key={line.resourceId} className="border-b align-top">
                  <td className="py-1.5 pr-2">
                    <span className="inline-flex items-center gap-1.5">
                      <ResourceIcon type={line.resourceType} size="sm" className="size-5" />
                      {line.resourceName}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {line.items.length === 0 ? (
                      <span>{line.note}</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {line.items.map((i) => (
                          <li key={i.label}>
                            {i.label}: {i.quantity.toLocaleString()} {i.unit} × {formatMoney(i.rate)} = {formatMoney(i.amount)}
                          </li>
                        ))}
                        {line.note && <li>{line.note}</li>}
                      </ul>
                    )}
                  </td>
                  <td className="py-1.5 text-right font-mono">{formatMoney(line.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
