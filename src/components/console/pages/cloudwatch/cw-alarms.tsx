"use client";

import { useState } from "react";
import { alarmHistory, COMPARISON_SYMBOL, METRIC_CATALOG, metricDefinition, NAMESPACE_RESOURCE, type AlarmState } from "@/lib/engine/cloudwatch-engine";
import type { Alarm, MetricRef, Project } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { createAlarm, deleteAlarms, updateAlarm, type AlarmInput } from "@/lib/project/cloudwatch-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useAnalysis } from "../../analysis-context";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, resourceHref, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, RadioGroup, SelectInput, TextArea, TextInput, Toggle } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { ResourceTable } from "../../ui/table";
import { AlarmStateBadge, PERIOD_OPTIONS, RangePicker, STAT_OPTIONS, useMetricModel, useNow } from "./cw-shared";
import { MetricCharts } from "./cw-metrics";

const COMPARISON_LABEL: Record<Alarm["comparison"], string> = {
  GreaterThanThreshold: "보다 큼 (>)",
  GreaterThanOrEqualToThreshold: "크거나 같음 (>=)",
  LessThanThreshold: "보다 작음 (<)",
  LessThanOrEqualToThreshold: "작거나 같음 (<=)",
};

const MISSING_LABEL: Record<Alarm["treatMissingData"], string> = {
  missing: "누락 (데이터가 없으면 판단을 미룸)",
  notBreaching: "정상으로 처리 (임계값을 넘지 않은 것으로 봄)",
  breaching: "위반으로 처리 (임계값을 넘은 것으로 봄)",
  ignore: "무시 (현재 상태 유지)",
};

export function conditionText(alarm: Pick<Alarm, "metric" | "comparison" | "threshold" | "period" | "evaluationPeriods" | "datapointsToAlarm">): string {
  const def = metricDefinition(alarm.metric);
  return `${def?.label ?? alarm.metric.metricName} ${COMPARISON_SYMBOL[alarm.comparison]} ${alarm.threshold}${def?.unit === "Percent" ? "%" : ""} · ${alarm.period / 60}분 기간 ${alarm.evaluationPeriods}개 중 ${alarm.datapointsToAlarm}개`;
}

function resourceName(project: Project, id: string) {
  const r = project.resources.find((x) => x.id === id);
  return r ? displayName(r) : `${id} (삭제됨)`;
}

export function AlarmListPage() {
  const project = useProject();
  const run = useRunAction();
  const model = useMetricModel();
  const now = useNow();
  const alarms = project.services.cloudwatch.alarms;
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const rows = alarms.map((a) => {
    const h = alarmHistory(model, a, now, 120);
    return { alarm: a, state: h.current.state, changedAt: h.transitions[0]?.at ?? Date.parse(a.createdAt) };
  });
  const shown = rows.filter((r) => filter === "all" || r.state === filter);
  type Row = (typeof rows)[number];
  return (
    <SpaceBetween>
      <PageGuide topic="cloudwatch-alarm" />
      <ResourceTable<Row>
        ariaLabel="경보 목록"
        items={shown}
        trackBy={(r) => r.alarm.id}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.alarm.name}
        header={
          <SpaceBetween size="m">
            <PageHeader
              title="경보"
              counter={`(${alarms.length})`}
              info={<InfoLink topic="cloudwatch-alarm" />}
              description="지표가 정한 조건(예: CPU 70% 초과)을 넘으면 경보 상태가 됩니다. 상태가 바뀌면 콘솔 오른쪽 아래에 가상 알림이 뜹니다."
              actions={
                <>
                  <Button disabled={!selected.length} onClick={() => setDeleting(true)}>
                    삭제
                  </Button>
                  <ButtonLink variant="primary" href={href("/cloudwatch/alarms/create")}>
                    경보 생성
                  </ButtonLink>
                </>
              }
            />
            <FormField label="상태로 필터링" className="max-w-xs">
              <SelectInput
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "모든 상태" },
                  { value: "ALARM", label: "경보 상태" },
                  { value: "OK", label: "정상" },
                  { value: "INSUFFICIENT_DATA", label: "데이터 부족" },
                ]}
              />
            </FormField>
          </SpaceBetween>
        }
        empty={<EmptyState title="경보 없음" description="예: 웹 서버 CPU가 70%를 넘으면 알려 주는 경보를 만들어 보세요." action={<ButtonLink href={href("/cloudwatch/alarms/create")}>경보 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (r) => <a className="font-bold text-aws-link hover:underline" href={href(`/cloudwatch/alarms/${r.alarm.id}`)}>{r.alarm.name}</a>, sortValue: (r) => r.alarm.name },
          { id: "state", header: "상태", cell: (r) => <AlarmStateBadge state={r.state} />, sortValue: (r) => r.state },
          { id: "changed", header: "마지막 상태 변경", cell: (r) => formatDateTime(new Date(r.changedAt).toISOString()), sortValue: (r) => r.changedAt },
          { id: "condition", header: "조건", cell: (r) => conditionText(r.alarm) },
          { id: "resource", header: "리소스", cell: (r) => resourceName(project, r.alarm.metric.resourceId), optional: true },
          { id: "notify", header: "알림", cell: (r) => (r.alarm.notify ? "켜짐" : "꺼짐"), optional: true },
        ]}
      />
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`경보 ${selected.length}개 삭제`}
          confirmText="삭제"
          onConfirm={() => {
            const r = run("DeleteAlarms", (p) => deleteAlarms(p, selected), { success: () => `경보 ${selected.length}개를 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>삭제한 경보는 더 이상 평가되지 않고 알림도 오지 않습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 생성·편집 마법사

const DEFAULT_THRESHOLD: Record<string, number> = { CPUUtilization: 70, TargetResponseTime: 1, HTTPCode_ELB_5XX_Count: 10, HTTPCode_Target_5XX_Count: 10, UnHealthyHostCount: 0, RequestCount: 1000, StatusCheckFailed: 0 };

function AlarmWizard({ initial, alarmId }: { initial: AlarmInput; alarmId?: string }) {
  const project = useProject();
  const run = useRunAction();
  const { topology } = useAnalysis();
  const now = useNow();
  const [step, setStep] = useState(1);
  const [value, setValue] = useState<AlarmInput>(initial);
  const [thresholdText, setThresholdText] = useState(String(initial.threshold));
  const [range, setRange] = useState(180);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<AlarmInput>) => setValue((v) => ({ ...v, ...patch }));
  const setMetric = (patch: Partial<MetricRef>) => setValue((v) => ({ ...v, metric: { ...v.metric, ...patch } }));
  const def = metricDefinition(value.metric);
  const resources = topology.ofType(NAMESPACE_RESOURCE[value.metric.namespace]);
  const threshold = Number(thresholdText);
  const steps = ["지표 및 조건 지정", "알림 구성", "이름 및 설명 추가", "미리 보기 및 생성"];
  const submit = () => {
    const input = { ...value, threshold };
    const r = alarmId
      ? run("PutMetricAlarm", (p) => updateAlarm(p, alarmId, input), { success: () => `경보 ${input.name.trim()}을(를) 저장했습니다.` })
      : run("PutMetricAlarm", (p) => createAlarm(p, input), { success: () => `경보 ${input.name.trim()}을(를) 만들었습니다.` });
    if (r.ok) navigate(`/cloudwatch/alarms/${alarmId ?? r.createdId}`);
    else setError(withHint(r));
  };
  const next = () => {
    setError(null);
    if (step === 1) {
      if (!value.metric.resourceId) return setError("[ValidationError] 리소스를 선택하세요.");
      if (thresholdText.trim() === "" || !Number.isFinite(threshold)) return setError("[ValidationError] 임계값에 숫자를 입력하세요.");
      if (value.datapointsToAlarm > value.evaluationPeriods) return setError("[ValidationError] 경보를 울릴 데이터 포인트 수(M)는 평가 기간 수(N)보다 클 수 없습니다.");
    }
    if (step === 3 && !value.name.trim()) return setError("[ValidationError] 경보 이름을 입력하세요.");
    setStep(step + 1);
  };
  return (
    <SpaceBetween tour="cw-alarm-form">
      <PageHeader title={alarmId ? "경보 편집" : "경보 생성"} info={<InfoLink topic="cloudwatch-alarm" />} description={`${step}단계 / 4단계 — ${steps[step - 1]}`} />
      <ol className="flex flex-wrap gap-4 text-[15px]" aria-label="단계">
        {steps.map((label, i) => (
          <li key={label} className={i + 1 === step ? "font-bold text-aws-link" : "text-aws-text-2"} aria-current={i + 1 === step ? "step" : undefined}>
            {i + 1}단계 · {label}
          </li>
        ))}
      </ol>
      {step === 1 && (
        <>
          <Container header={<ContainerHeader title="지표" description="경보가 지켜볼 지표 하나를 고릅니다." />}>
            <SpaceBetween size="m">
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="네임스페이스">
                  <SelectInput
                    value={value.metric.namespace}
                    onChange={(ns) => {
                      const first = METRIC_CATALOG.find((m) => m.namespace === ns)!;
                      setMetric({ namespace: ns as MetricRef["namespace"], metricName: first.metricName, resourceId: topology.ofType(NAMESPACE_RESOURCE[ns as MetricRef["namespace"]])[0]?.id ?? "", stat: first.defaultStat });
                    }}
                    options={(["AWS/EC2", "AWS/ApplicationELB", "AWS/RDS", "AWS/NATGateway"] as const).map((n) => ({ value: n, label: n }))}
                  />
                </FormField>
                <FormField label="리소스">
                  <SelectInput
                    value={value.metric.resourceId}
                    onChange={(id) => setMetric({ resourceId: id })}
                    placeholder={resources.length ? "선택" : "이 유형의 리소스가 없습니다"}
                    options={resources.map((r) => ({ value: r.id, label: `${displayName(r)} (${r.id})` }))}
                  />
                </FormField>
                <FormField label="지표 이름">
                  <SelectInput
                    value={value.metric.metricName}
                    onChange={(m) => {
                      const d = METRIC_CATALOG.find((x) => x.namespace === value.metric.namespace && x.metricName === m);
                      setMetric({ metricName: m, stat: d?.defaultStat ?? "Average" });
                      if (DEFAULT_THRESHOLD[m] !== undefined) setThresholdText(String(DEFAULT_THRESHOLD[m]));
                    }}
                    options={METRIC_CATALOG.filter((m) => m.namespace === value.metric.namespace).map((m) => ({ value: m.metricName, label: `${m.metricName} — ${m.label}` }))}
                  />
                </FormField>
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="통계">
                    <SelectInput value={value.metric.stat} onChange={(s) => setMetric({ stat: s as MetricRef["stat"] })} options={STAT_OPTIONS} />
                  </FormField>
                  <FormField label="기간">
                    <SelectInput value={String(value.period)} onChange={(p) => set({ period: Number(p) as AlarmInput["period"] })} options={PERIOD_OPTIONS} />
                  </FormField>
                </div>
              </div>
              {value.metric.resourceId ? (
                <div className="space-y-2">
                  <div className="flex justify-end">
                    <RangePicker value={range} onChange={setRange} />
                  </div>
                  <MetricCharts
                    refs={[value.metric]}
                    range={range}
                    period={value.period}
                    now={now}
                    threshold={Number.isFinite(threshold) && thresholdText.trim() !== "" ? { value: threshold, label: `임계값 ${COMPARISON_SYMBOL[value.comparison]} ${threshold}` } : null}
                  />
                </div>
              ) : (
                <Alert type="info">먼저 이 유형의 리소스를 만드세요.</Alert>
              )}
            </SpaceBetween>
          </Container>
          <Container header={<ContainerHeader title="조건" description="어떤 값이 되면 경보로 볼지 정합니다." />}>
            <SpaceBetween size="m">
              <FormField label={`${def?.label ?? "지표"} 값이 다음과 같을 때 경보`}>
                <RadioGroup aria-label="비교 연산자" value={value.comparison} onChange={(c) => set({ comparison: c as Alarm["comparison"] })} items={Object.entries(COMPARISON_LABEL).map(([v, label]) => ({ value: v, label }))} />
              </FormField>
              <FormField label="임계값" constraint={def?.unit === "Percent" ? "0~100 (%)" : def?.unit === "Seconds" ? "초 단위 (예: 0.5 = 500ms)" : def?.unit === "Bytes" ? "바이트 단위" : "숫자"}>
                <TextInput value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} inputMode="decimal" className="max-w-40" />
              </FormField>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="경보를 울릴 데이터 포인트 (M / N)" description="최근 N개 기간 중 M개가 조건을 넘으면 경보가 됩니다. 순간적인 튐을 거르려면 M을 2 이상으로 하세요.">
                  <div className="flex items-center gap-2">
                    <TextInput aria-label="M" value={String(value.datapointsToAlarm)} onChange={(e) => set({ datapointsToAlarm: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} inputMode="numeric" className="w-20" />
                    <span>/</span>
                    <TextInput aria-label="N" value={String(value.evaluationPeriods)} onChange={(e) => set({ evaluationPeriods: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} inputMode="numeric" className="w-20" />
                  </div>
                </FormField>
                <FormField label="누락된 데이터 처리" description="인스턴스가 중지되었거나 요청이 없으면 데이터가 비어 있습니다.">
                  <SelectInput value={value.treatMissingData} onChange={(t) => set({ treatMissingData: t as Alarm["treatMissingData"] })} options={Object.entries(MISSING_LABEL).map(([v, label]) => ({ value: v, label }))} />
                </FormField>
              </div>
            </SpaceBetween>
          </Container>
        </>
      )}
      {step === 2 && (
        <Container header={<ContainerHeader title="알림" description="실제 AWS에서는 SNS 주제로 이메일·문자를 보냅니다. 이 시뮬레이터는 실제로 아무것도 보내지 않고 콘솔에 알림만 표시합니다." />}>
          <Toggle checked={value.notify} onChange={(v) => set({ notify: v })} description="경보 상태가 ALARM이 되거나 OK로 돌아오면 화면 오른쪽 아래에 알림이 뜹니다 (콘솔을 열어 둔 동안).">
            상태가 바뀌면 콘솔 알림 표시
          </Toggle>
        </Container>
      )}
      {step === 3 && (
        <Container header={<ContainerHeader title="이름 및 설명" />}>
          <SpaceBetween size="m">
            <FormField label="경보 이름" constraint="최대 255자. 계정 안에서 하나뿐이어야 합니다.">
              <TextInput value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: web-cpu-high" maxLength={255} />
            </FormField>
            <FormField label="경보 설명" optional>
              <TextArea value={value.description} onChange={(e) => set({ description: e.target.value })} rows={2} maxLength={1024} placeholder="예: 웹 서버 CPU가 5분 동안 높으면 인스턴스 유형을 늘릴 것" />
            </FormField>
          </SpaceBetween>
        </Container>
      )}
      {step === 4 && (
        <Container header={<ContainerHeader title="미리 보기" />}>
          <KeyValueGrid
            columns={2}
            items={[
              { label: "이름", value: value.name },
              { label: "지표", value: `${value.metric.namespace} · ${value.metric.metricName} (${value.metric.stat})` },
              { label: "리소스", value: resourceName(project, value.metric.resourceId) },
              { label: "조건", value: conditionText({ ...value, threshold }) },
              { label: "누락된 데이터", value: MISSING_LABEL[value.treatMissingData] },
              { label: "알림", value: value.notify ? "콘솔 알림 표시" : "없음" },
            ]}
          />
        </Container>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        {step === 1 ? (
          <ButtonLink variant="link" href={href(alarmId ? `/cloudwatch/alarms/${alarmId}` : "/cloudwatch/alarms")}>
            취소
          </ButtonLink>
        ) : (
          <Button variant="link" onClick={() => setStep(step - 1)}>
            이전
          </Button>
        )}
        {step < 4 ? (
          <Button variant="primary" onClick={next}>
            다음
          </Button>
        ) : (
          <Button variant="primary" onClick={submit}>
            {alarmId ? "경보 저장" : "경보 생성"}
          </Button>
        )}
      </FormActions>
    </SpaceBetween>
  );
}

export function CreateAlarmPage() {
  const { topology } = useAnalysis();
  const { query } = useHashLocation();
  const ns = (query.get("ns") as MetricRef["namespace"]) || "AWS/EC2";
  const valid = METRIC_CATALOG.some((m) => m.namespace === ns);
  const namespace = valid ? ns : "AWS/EC2";
  const metricName = METRIC_CATALOG.some((m) => m.namespace === namespace && m.metricName === query.get("metric")) ? query.get("metric")! : METRIC_CATALOG.find((m) => m.namespace === namespace)!.metricName;
  const def = metricDefinition({ namespace, metricName })!;
  const stat = (STAT_OPTIONS.some((s) => s.value === query.get("stat")) ? query.get("stat") : def.defaultStat) as MetricRef["stat"];
  const resourceId = query.get("resource") ?? topology.ofType(NAMESPACE_RESOURCE[namespace])[0]?.id ?? "";
  return (
    <AlarmWizard
      initial={{
        name: "",
        description: "",
        metric: { namespace, metricName, resourceId, stat },
        period: 60,
        comparison: "GreaterThanThreshold",
        threshold: DEFAULT_THRESHOLD[metricName] ?? 0,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: "missing",
        notify: true,
      }}
    />
  );
}

export function EditAlarmPage({ id }: { id: string }) {
  const alarm = useProject().services.cloudwatch.alarms.find((a) => a.id === id);
  if (!alarm) return <AlarmNotFound />;
  const input: AlarmInput = {
    name: alarm.name,
    description: alarm.description,
    metric: alarm.metric,
    period: alarm.period,
    comparison: alarm.comparison,
    threshold: alarm.threshold,
    evaluationPeriods: alarm.evaluationPeriods,
    datapointsToAlarm: alarm.datapointsToAlarm,
    treatMissingData: alarm.treatMissingData,
    notify: alarm.notify,
  };
  return <AlarmWizard key={alarm.id} initial={input} alarmId={alarm.id} />;
}

function AlarmNotFound() {
  return (
    <Container>
      <EmptyState title="경보를 찾을 수 없습니다" action={<ButtonLink href={href("/cloudwatch/alarms")}>경보 목록</ButtonLink>} />
    </Container>
  );
}

// ---------------------------------------------------------------- 상세

const STATE_TEXT: Record<AlarmState, string> = { OK: "정상", ALARM: "경보", INSUFFICIENT_DATA: "데이터 부족" };

export function AlarmDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const model = useMetricModel();
  const now = useNow();
  const [range, setRange] = useState(180);
  const [deleting, setDeleting] = useState(false);
  const alarm = project.services.cloudwatch.alarms.find((a) => a.id === id);
  if (!alarm) return <AlarmNotFound />;
  const history = alarmHistory(model, alarm, now);
  const def = metricDefinition(alarm.metric);
  const resource = project.resources.find((r) => r.id === alarm.metric.resourceId);
  return (
    <SpaceBetween>
      <PageHeader
        title={alarm.name}
        description={alarm.description || undefined}
        actions={
          <>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
            <ButtonLink variant="primary" href={href(`/cloudwatch/alarms/${alarm.id}/edit`)}>
              편집
            </ButtonLink>
          </>
        }
      />
      <Container header={<ContainerHeader title="세부 정보" info={<InfoLink topic="cloudwatch-alarm" />} />}>
        <SpaceBetween size="m">
          <div className="space-y-1">
            <AlarmStateBadge state={history.current.state} />
            <p className="text-[15px]">{history.current.reason}</p>
          </div>
          <KeyValueGrid
            columns={3}
            items={[
              { label: "조건", value: conditionText(alarm) },
              { label: "지표", value: `${alarm.metric.namespace} · ${alarm.metric.metricName} (${alarm.metric.stat})` },
              { label: "리소스", value: resource ? <a className="text-aws-link hover:underline" href={resourceHref(resource.type, resource.id)}>{displayName(resource)}</a> : `${alarm.metric.resourceId} (삭제됨)` },
              { label: "누락된 데이터", value: MISSING_LABEL[alarm.treatMissingData] },
              { label: "알림", value: alarm.notify ? "콘솔 알림 표시 (가상)" : "없음" },
              { label: "생성 또는 마지막 수정", value: formatDateTime(alarm.createdAt) },
            ]}
          />
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title={`${def?.label ?? alarm.metric.metricName} 그래프`} description="빨간 가로선이 임계값입니다." actions={<RangePicker value={range} onChange={setRange} />} />}>
        <MetricCharts refs={[alarm.metric]} range={range} period={alarm.period} now={now} threshold={{ value: alarm.threshold, label: `임계값 ${COMPARISON_SYMBOL[alarm.comparison]} ${alarm.threshold}` }} />
      </Container>
      <Container header={<ContainerHeader title={`기록 (${history.transitions.length})`} description="경보를 만들거나 수정한 뒤의 상태 변화입니다 (최근 288개 기간)." />}>
        {history.transitions.length === 0 ? (
          <p className="text-[15px] text-aws-text-2">아직 상태 변화가 없습니다.</p>
        ) : (
          <ul className="divide-y divide-aws-divider">
            {history.transitions.map((t, i) => (
              <li key={i} className="space-y-0.5 py-2.5">
                <p className="text-sm text-aws-text-2">{formatDateTime(new Date(t.at).toISOString())}</p>
                <p className="font-bold">
                  {STATE_TEXT[t.from]} → {STATE_TEXT[t.to]}
                </p>
                <p className="text-sm">{t.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Container>
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`경보 ${alarm.name} 삭제`}
          confirmText="삭제"
          onConfirm={() => {
            const r = run("DeleteAlarms", (p) => deleteAlarms(p, [alarm.id]), { success: () => `경보 ${alarm.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            navigate("/cloudwatch/alarms");
            return null;
          }}
        >
          <p>삭제하면 더 이상 평가하지 않습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

