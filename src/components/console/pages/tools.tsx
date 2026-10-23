"use client";

/** 구성 검사, 가상 비용 추정, 이벤트 기록 */
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { useMemo, useState } from "react";
import { DEFAULT_COST_ASSUMPTIONS, estimateCost, resolveCostAssumptions } from "@/lib/engine/cost-engine";
import { RESOURCE_TYPE_INFO, type CostAssumptions } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import type { Severity, ValidationCategory, ValidationFinding } from "@/lib/engine/validation-engine";
import { setCostAssumptions } from "@/lib/project/mutations";
import { useProjectStore } from "@/lib/store/project-store";
import { formatDateTime, formatMoney } from "@/lib/ui/format";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject, useRunAction } from "../console-context";
import { resourceHref } from "../router";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox, SearchInput, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink } from "../ui/links";
import { ResourceTable } from "../ui/table";
import { StatusIndicator } from "../ui/status";

// ================================================================ 구성 검사

const SEVERITY: Record<Severity, { label: string; icon: React.ElementType; color: string }> = {
  error: { label: "오류", icon: CircleX, color: "text-aws-error" },
  warning: { label: "경고", icon: TriangleAlert, color: "text-aws-warning" },
  info: { label: "정보", icon: Info, color: "text-aws-info" },
};

const CATEGORY_LABEL: Record<ValidationCategory, string> = {
  network: "네트워크",
  security: "보안",
  compute: "컴퓨팅",
  "load-balancing": "로드 밸런싱",
  database: "데이터베이스",
  general: "일반",
};

export function ChecksPage() {
  const analysis = useAnalysis();
  const [severities, setSeverities] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const [category, setCategory] = useState<string>("");
  const [query, setQuery] = useState("");
  const findings = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analysis.findings.filter((f) => severities[f.severity] && (!category || f.category === category) && (!q || `${f.ruleId} ${f.title} ${f.cause} ${f.resourceIds.join(" ")}`.toLowerCase().includes(q)));
  }, [analysis.findings, severities, category, query]);
  return (
    <SpaceBetween>
      <PageHeader
        title="구성 검사"
        info={<InfoLink topic="checks" />}
        description="현재 구성을 검증 규칙으로 검사한 결과입니다. 구성을 바꾸면 즉시 다시 검사합니다."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(SEVERITY) as Severity[]).map((s) => {
          const meta = SEVERITY[s];
          return (
            <Container key={s}>
              <div className="flex items-center justify-between">
                <span className={cn("flex items-center gap-2 font-bold", meta.color)}>
                  <meta.icon className="size-5" aria-hidden />
                  {meta.label}
                </span>
                <span className="text-3xl font-bold text-aws-text" data-testid={`check-count-${s}`}>
                  {analysis.counts[s]}
                </span>
              </div>
            </Container>
          );
        })}
      </div>
      <Container
        header={
          <ContainerHeader
            title="검사 결과"
            counter={`(${findings.length})`}
            description={`마지막 검사 ${formatDateTime(analysis.analyzedAt)} · ${analysis.durationMs}ms`}
          />
        }
      >
        <SpaceBetween size="m">
          <div className="flex flex-wrap items-center gap-4">
            {(Object.keys(SEVERITY) as Severity[]).map((s) => (
              <Checkbox key={s} checked={severities[s]} onChange={(v) => setSeverities({ ...severities, [s]: v })}>
                {SEVERITY[s].label} ({analysis.counts[s]})
              </Checkbox>
            ))}
            <SelectInput className="w-44" aria-label="분류" value={category} onChange={setCategory} placeholder="모든 분류" options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} />
            <SearchInput value={query} onChange={setQuery} placeholder="규칙 ID, 제목, 리소스 검색" className="w-full max-w-sm" />
          </div>
          {findings.length === 0 ? (
            <EmptyState
              title={analysis.findings.length === 0 ? "발견된 문제가 없습니다" : "선택한 조건에 해당하는 결과가 없습니다"}
              description={analysis.findings.length === 0 ? undefined : "정보 항목은 기본적으로 숨겨져 있습니다."}
            />
          ) : (
            <ul className="divide-y divide-aws-divider" aria-label="검사 결과 목록">
              {findings.map((f) => (
                <FindingRow key={f.id} finding={f} />
              ))}
            </ul>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

function FindingRow({ finding }: { finding: ValidationFinding }) {
  const { topology } = useAnalysis();
  const meta = SEVERITY[finding.severity];
  return (
    <li className="py-3" data-testid="finding" data-rule={finding.ruleId}>
      <ExpandableSection
        header={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <meta.icon className={cn("size-4 shrink-0", meta.color)} aria-label={meta.label} />
            <span>{finding.title}</span>
            <span className="font-mono text-xs font-normal text-aws-text-2">
              {finding.ruleId} · {CATEGORY_LABEL[finding.category]}
            </span>
          </span>
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-bold text-aws-text-2">원인</dt>
            <dd>{finding.cause}</dd>
          </div>
          <div>
            <dt className="font-bold text-aws-text-2">문제가 되는 설정</dt>
            <dd className="font-mono text-[13px]">{finding.condition}</dd>
          </div>
          <div>
            <dt className="font-bold text-aws-text-2">수정 방법</dt>
            <dd>
              <ul className="list-disc pl-5">
                {finding.fix.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="font-bold text-aws-text-2">수정하면 달라지는 점</dt>
            <dd>{finding.impact}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-bold text-aws-text-2">관련 리소스</dt>
            <dd className="flex flex-wrap gap-3">
              {finding.resourceIds.length
                ? finding.resourceIds.map((id) => {
                    const r = topology.get(id);
                    return r ? (
                      <a key={id} href={resourceHref(r.type, r.id)} className="text-aws-link hover:underline">
                        {RESOURCE_TYPE_INFO[r.type].label}: {displayName(r)}
                      </a>
                    ) : (
                      <span key={id}>{id}</span>
                    );
                  })
                : "–"}
            </dd>
          </div>
          <div className="rounded-lg bg-aws-surface-2 p-3 sm:col-span-2">
            <dt className="font-bold text-aws-text-2">관련 AWS 개념</dt>
            <dd>{finding.concept}</dd>
          </div>
        </dl>
      </ExpandableSection>
    </li>
  );
}

// ================================================================ 가상 비용

type NumberKey = { [K in keyof CostAssumptions]: CostAssumptions[K] extends number ? K : never }[keyof CostAssumptions];

const USAGE_FIELDS: { key: NumberKey; label: string; max: number }[] = [
  { key: "hoursPerMonth", label: "월 사용 시간", max: 744 },
  { key: "dataProcessedGb", label: "NAT/ALB 처리 데이터 (GB/월)", max: 1_000_000 },
  { key: "dataTransferOutGb", label: "인터넷 방향 전송 (GB/월)", max: 1_000_000 },
];

const RATE_FIELDS: { key: NumberKey; label: string }[] = [
  { key: "natHourly", label: "NAT 게이트웨이 / 시간" },
  { key: "natPerGb", label: "NAT 처리 / GB" },
  { key: "albHourly", label: "ALB / 시간" },
  { key: "albPerGb", label: "ALB 처리 / GB" },
  { key: "publicIpv4Hourly", label: "퍼블릭 IPv4 / 시간" },
  { key: "dataTransferOutPerGb", label: "인터넷 전송 / GB" },
  { key: "rdsStorageGbMonth", label: "RDS 스토리지 / GB-월" },
];

function NumberField({ label, value, max = 1_000_000, onCommit }: { label: string; value: number; max?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [prev, setPrev] = useState(value);
  const [error, setError] = useState(false);
  if (value !== prev) {
    setPrev(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    if (!draft.trim() || !Number.isFinite(n) || n < 0 || n > max) return setError(true);
    setError(false);
    if (n !== value) onCommit(n);
  };
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <TextInput
        aria-label={label}
        aria-invalid={error || undefined}
        title={error ? `0~${max} 사이의 숫자` : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-28 text-right font-mono"
      />
    </label>
  );
}

export function BillingPage() {
  const project = useProject();
  const run = useRunAction();
  const assumptions = resolveCostAssumptions(project);
  const report = useMemo(() => estimateCost(project, assumptions), [project, assumptions]);
  const save = (patch: Partial<CostAssumptions>) => run("UpdateCostAssumptions", (p) => setCostAssumptions(p, { ...resolveCostAssumptions(p), ...patch }), { flashError: true });
  return (
    <SpaceBetween>
      <PageHeader title="가상 비용 추정" info={<InfoLink topic="billing" />} description="구성한 리소스로 계산한 교육용 월 비용 추정치입니다." />
      <Alert type="warning" header="실제 요금이 아닙니다">
        이 값은 학습용 가정 단가로 계산한 가상 비용이며 실제 AWS 청구 금액이나 요금표가 아닙니다. 아래에서 가정값을 직접 바꿀 수 있습니다.
      </Alert>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Container header={<ContainerHeader title="월 예상 가상 비용" description="리소스별 계산 내역" />}>
          <SpaceBetween size="m">
            <p className="text-3xl font-bold" data-testid="cost-total">
              {formatMoney(report.total)}
            </p>
            {report.lines.length === 0 ? (
              <p className="text-sm text-aws-text-2">리소스가 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm" aria-label="비용 내역">
                  <thead>
                    <tr className="border-b border-aws-border text-left text-aws-text-2">
                      <th className="px-3 py-2 font-bold">리소스</th>
                      <th className="px-3 py-2 font-bold">계산 (가정)</th>
                      <th className="px-3 py-2 text-right font-bold">가상 비용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines.map((line) => (
                      <tr key={line.resourceId} className="border-b border-aws-divider align-top">
                        <td className="px-3 py-2">
                          <ResourceLink id={line.resourceId} showName />
                          <span className="block text-xs text-aws-text-2">{RESOURCE_TYPE_INFO[line.resourceType].label}</span>
                        </td>
                        <td className="px-3 py-2 text-[13px] text-aws-text-2">
                          {line.items.length === 0 ? (
                            line.note
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
                        <td className="px-3 py-2 text-right font-mono">{formatMoney(line.subtotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-aws-text-2">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </SpaceBetween>
        </Container>
        <Container header={<ContainerHeader title="가정값" actions={<Button variant="link" disabled={!project.costAssumptions} onClick={() => run("ResetCostAssumptions", (p) => setCostAssumptions(p, null))}>기본값</Button>} />}>
          <SpaceBetween size="m">
            <SpaceBetween size="s">
              <p className="text-xs font-bold text-aws-text-2">사용량</p>
              {USAGE_FIELDS.map((f) => (
                <NumberField key={f.key} label={f.label} value={assumptions[f.key]} max={f.max} onCommit={(v) => save({ [f.key]: v })} />
              ))}
            </SpaceBetween>
            <ExpandableSection header="교육용 가정 단가 편집">
              <SpaceBetween size="s">
                {RATE_FIELDS.map((f) => (
                  <NumberField key={f.key} label={f.label} value={assumptions[f.key]} onCommit={(v) => save({ [f.key]: v })} />
                ))}
                <p className="pt-1 text-xs font-bold text-aws-text-2">EC2 / 시간</p>
                {Object.keys(DEFAULT_COST_ASSUMPTIONS.ec2Hourly).map((type) => (
                  <NumberField key={type} label={type} value={assumptions.ec2Hourly[type] ?? 0} onCommit={(v) => save({ ec2Hourly: { ...assumptions.ec2Hourly, [type]: v } })} />
                ))}
                <p className="pt-1 text-xs font-bold text-aws-text-2">RDS / 시간</p>
                {Object.keys(DEFAULT_COST_ASSUMPTIONS.rdsHourly).map((cls) => (
                  <NumberField key={cls} label={cls} value={assumptions.rdsHourly[cls] ?? 0} onCommit={(v) => save({ rdsHourly: { ...assumptions.rdsHourly, [cls]: v } })} />
                ))}
              </SpaceBetween>
            </ExpandableSection>
          </SpaceBetween>
        </Container>
      </div>
    </SpaceBetween>
  );
}

// ================================================================ 이벤트 기록

const KIND_LABEL: Record<string, { label: string; type: "success" | "error" | "info" | "pending" | "stopped" }> = {
  edit: { label: "성공", type: "success" },
  error: { label: "오류", type: "error" },
  undo: { label: "실행 취소", type: "stopped" },
  redo: { label: "다시 실행", type: "stopped" },
  simulation: { label: "분석", type: "info" },
  validation: { label: "검사", type: "info" },
  system: { label: "상태 변경", type: "pending" },
};

export function ActivityPage() {
  const projectId = useConsoleProjectId();
  const activity = useProjectStore((s) => s.activity);
  const entries = useMemo(() => activity.filter((a) => a.projectId === projectId), [activity, projectId]);
  return (
    <ResourceTable
      ariaLabel="이벤트 기록"
      items={entries}
      trackBy={(e) => e.id}
      pageSize={50}
      header={
        <PageHeader
          title="이벤트 기록"
          counter={`(${entries.length})`}
          description="이 브라우저 세션에서 실행한 작업과 상태 변경 기록입니다 (최근 200개, 새로고침하면 사라짐)."
        />
      }
      empty={<EmptyState title="기록된 이벤트가 없습니다" description="리소스를 만들거나 수정하면 여기에 표시됩니다." />}
      columns={[
        { id: "time", header: "이벤트 시간", cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.at)}</span>, sortValue: (e) => e.at },
        { id: "kind", header: "결과", cell: (e) => { const k = KIND_LABEL[e.kind] ?? { label: e.kind, type: "info" as const }; return <StatusIndicator type={k.type}>{k.label}</StatusIndicator>; } },
        { id: "name", header: "이벤트 이름", cell: (e) => <span className="font-mono text-[13px]">{eventName(e.message)}</span>, filterValue: (e) => e.message },
        { id: "message", header: "내용", cell: (e) => <span className="text-[13px] break-words text-aws-text-2">{eventDetail(e.message)}</span> },
      ]}
      defaultSort={{ columnId: "time", descending: true }}
    />
  );
}

function eventName(message: string): string {
  const m = /^([A-Z][A-Za-z]+)/.exec(message);
  return m ? m[1] : "–";
}

function eventDetail(message: string): string {
  const name = eventName(message);
  return name === "–" ? message : message.slice(name.length).replace(/^\s*(—|:)?\s*/, "") || "–";
}
