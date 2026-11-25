"use client";

/**
 * EventBridge 콘솔 (가상): Scheduler 일정, 기본 이벤트 버스의 규칙, 테스트 이벤트 보내기.
 * 일정은 실행 시각만 계산하고, 규칙은 콘솔에서 보낸 테스트 이벤트로만 동작을 확인한다 (샌드박스 리소스는 이벤트를 만들지 않음).
 */
import { useMemo, useState } from "react";
import { matchEventPattern, parseEventPattern, SAMPLE_EVENTS, type MatchStep } from "@/lib/engine/event-pattern";
import { sendTestEvent, type RuleDelivery } from "@/lib/engine/eventbridge-engine";
import { analyzeInvocation, ruleArn, ruleCanInvoke, scheduleArn, scheduleCanInvoke } from "@/lib/engine/lambda-engine";
import { SCHEDULE_TIMEZONES, type EventRule, type Project, type Schedule, type ScheduleTimezone } from "@/lib/engine/resource-models";
import { describeSchedule, formatInTimezone, MINUTE_MS, nextRunTimes, parseScheduleExpression, TIMEZONE_OFFSET_MINUTES } from "@/lib/engine/schedule-expression";
import { displayName } from "@/lib/engine/topology-engine";
import {
  createRule,
  createSchedule,
  deleteRule,
  deleteSchedule,
  setRuleState,
  setScheduleState,
  updateRule,
  updateSchedule,
  type RuleInput,
  type ScheduleInput,
} from "@/lib/project/eventbridge-actions";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, MultiSelect, RadioGroup, SelectInput, TextArea, TextInput, Toggle } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { useNow } from "../cloudwatch/cw-shared";
import { useSelection, useTopology } from "../common";
import { InvokeResultView, OutcomeStatus } from "../lambda/lambda-functions";

const StateBadge = ({ state }: { state: "ENABLED" | "DISABLED" }) =>
  state === "ENABLED" ? <StatusIndicator type="success">활성</StatusIndicator> : <StatusIndicator type="stopped">비활성</StatusIndicator>;

function FunctionLink({ project, id }: { project: Project; id: string }) {
  const fn = project.resources.find((r) => r.id === id && r.type === "lambda");
  if (!fn) return <span className="text-aws-error">{id} (삭제됨)</span>;
  return (
    <a className="text-aws-link hover:underline" href={href(`/lambda/functions/${fn.id}`)}>
      {displayName(fn)}
    </a>
  );
}

function RoleLink({ project, id }: { project: Project; id: string | null }) {
  const role = project.services.iam.roles.find((r) => r.id === id);
  if (!role) return <span className="text-aws-error">없음</span>;
  return (
    <a className="text-aws-link hover:underline" href={href(`/iam/roles/${role.id}`)}>
      {role.name}
    </a>
  );
}

// ================================================================ 개요

export function EventBridgeOverviewPage() {
  const project = useProject();
  const { rules, schedules } = project.services.eventbridge;
  return (
    <SpaceBetween>
      <PageHeader title="Amazon EventBridge (가상)" info={<InfoLink topic="eventbridge" />} description="정해진 시각(Scheduler 일정)이나 이벤트(규칙)가 오면 Lambda 함수를 호출합니다. 실제 AWS에 일정이나 규칙을 만들지 않습니다." />
      <PageGuide topic="eventbridge" />
      <div className="grid gap-4 @2xl/main:grid-cols-3">
        <Container header={<ContainerHeader title={`일정 (${schedules.length})`} info={<InfoLink topic="eventbridge-scheduler" />} />}>
          <p className="mb-3 text-sm text-aws-text-2">&apos;매일 9시&apos;, &apos;5분마다&apos;처럼 정해진 시각에 함수를 호출합니다.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={href("/eventbridge/schedules")}>일정 보기</ButtonLink>
            <ButtonLink variant="primary" href={href("/eventbridge/schedules/create")}>
              일정 생성
            </ButtonLink>
          </div>
        </Container>
        <Container header={<ContainerHeader title={`규칙 (${rules.length})`} info={<InfoLink topic="eventbridge-rules" />} />}>
          <p className="mb-3 text-sm text-aws-text-2">&apos;EC2가 중지되면&apos;처럼 이벤트 패턴과 일치하는 이벤트가 오면 함수를 호출합니다.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={href("/eventbridge/rules")}>규칙 보기</ButtonLink>
            <ButtonLink variant="primary" href={href("/eventbridge/rules/create")}>
              규칙 생성
            </ButtonLink>
          </div>
        </Container>
        <Container header={<ContainerHeader title="테스트 이벤트" />}>
          <p className="mb-3 text-sm text-aws-text-2">샌드박스 리소스는 이벤트를 만들지 않습니다. 예시 이벤트를 보내 규칙이 일치하는지 확인하세요.</p>
          <ButtonLink href={href("/eventbridge/send-event")}>테스트 이벤트 보내기</ButtonLink>
        </Container>
      </div>
    </SpaceBetween>
  );
}

// ================================================================ 일정

function nextRunText(schedule: Schedule, now: number): string {
  const parsed = parseScheduleExpression(schedule.expression);
  if (!parsed.ok) return "표현식 오류";
  if (schedule.state === "DISABLED") return "–";
  const next = nextRunTimes(parsed.value, schedule.timezone, Date.parse(schedule.createdAt), now, 1)[0];
  return next === undefined ? "없음 (지난 시각)" : formatInTimezone(next, schedule.timezone);
}

export function ScheduleListPage() {
  const project = useProject();
  const run = useRunAction();
  const now = useNow();
  const schedules = project.services.eventbridge.schedules;
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = schedules.find((s) => s.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="eventbridge-scheduler" />
      <ResourceTable<Schedule>
        ariaLabel="일정 목록"
        items={schedules}
        trackBy={(s) => s.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(s) => s.name}
        header={
          <PageHeader
            title="일정"
            counter={`(${schedules.length})`}
            info={<InfoLink topic="eventbridge-scheduler" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "enable", text: "활성화", disabled: current?.state !== "DISABLED" },
                    { id: "disable", text: "비활성화", disabled: current?.state !== "ENABLED" },
                    { id: "edit", text: "편집", disabled: !current },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "enable" || a === "disable") run("UpdateSchedule", (p) => setScheduleState(p, current.id, a === "enable" ? "ENABLED" : "DISABLED"), { success: () => `일정 ${current.name}을(를) ${a === "enable" ? "활성화" : "비활성화"}했습니다.`, flashError: true });
                    if (a === "edit") navigate(`/eventbridge/schedules/${current.id}/edit`);
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/eventbridge/schedules/create")}>
                  일정 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="일정 없음" description="일정을 만들면 정해진 시각마다 Lambda 함수를 호출합니다 (가상)." action={<ButtonLink href={href("/eventbridge/schedules/create")}>일정 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "일정 이름", cell: (s) => <a className="font-bold text-aws-link hover:underline" href={href(`/eventbridge/schedules/${s.id}`)}>{s.name}</a>, sortValue: (s) => s.name },
          { id: "state", header: "상태", cell: (s) => <StateBadge state={s.state} /> },
          { id: "expression", header: "일정 표현식", cell: (s) => <span className="font-mono text-[13px]">{s.expression}</span> },
          { id: "next", header: "다음 실행 (가상)", cell: (s) => nextRunText(s, now) },
          { id: "target", header: "대상", cell: (s) => <FunctionLink project={project} id={s.targetLambdaId} /> },
          {
            id: "invoke",
            header: "호출",
            cell: (s) => {
              const can = scheduleCanInvoke(project, s, project.resources.find((r): r is Extract<typeof r, { type: "lambda" }> => r.id === s.targetLambdaId && r.type === "lambda"));
              return can.ok ? <Badge color="green">가능</Badge> : <Badge color="red" title={can.reason}>실패</Badge>;
            },
          },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`일정 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteSchedule", (p) => deleteSchedule(p, current.id), { success: () => `일정 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>일정을 삭제하면 더 이상 함수를 호출하지 않습니다. 대상 함수와 실행 역할은 남습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

const EXPRESSION_PRESETS: { label: string; expression: (tz: ScheduleTimezone) => string }[] = [
  { label: "5분마다", expression: () => "rate(5 minutes)" },
  { label: "1시간마다", expression: () => "rate(1 hour)" },
  { label: "매일 09:00", expression: () => "cron(0 9 * * ? *)" },
  { label: "평일 09:00", expression: () => "cron(0 9 ? * MON-FRI *)" },
  {
    label: "내일 09:00 한 번",
    expression: (tz) => {
      const local = new Date(Date.now() + TIMEZONE_OFFSET_MINUTES[tz] * MINUTE_MS + 86_400_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `at(${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T09:00:00)`;
    },
  },
];

type ScheduleDraft = Omit<ScheduleInput, "flexibleWindowMinutes" | "retryAttempts"> & { flexible: string; retries: string; roleMode: "create" | "existing" };

function ScheduleForm({ draft, set, isEdit }: { draft: ScheduleDraft; set: (p: Partial<ScheduleDraft>) => void; isEdit: boolean }) {
  const project = useProject();
  const topo = useTopology();
  const now = useNow();
  const parsed = parseScheduleExpression(draft.expression);
  const preview = parsed.ok ? nextRunTimes(parsed.value, draft.timezone, now, now, 3) : [];
  const fns = topo.ofType("lambda");
  const schedulerRoles = project.services.iam.roles.filter((r) => r.trustedEntity === "scheduler.amazonaws.com");
  return (
    <>
      <Container header={<ContainerHeader title="일정 세부 정보" />}>
        <SpaceBetween size="m">
          <FormField label="일정 이름" constraint={isEdit ? "만든 뒤에는 이름을 바꿀 수 없습니다." : "1~64자의 영문·숫자·마침표·하이픈·밑줄"}>
            <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={isEdit} maxLength={64} />
          </FormField>
          <FormField label="설명" optional>
            <TextInput value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={512} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="일정 패턴" info={<InfoLink topic="schedule-expression" />} />}>
        <SpaceBetween size="m">
          <div className="flex flex-wrap gap-2" aria-label="자주 쓰는 일정">
            {EXPRESSION_PRESETS.map((p) => (
              <Button key={p.label} onClick={() => set({ expression: p.expression(draft.timezone) })}>
                {p.label}
              </Button>
            ))}
          </div>
          <FormField
            help={{ docKey: "eventbridge", field: "scheduleExpression" }}
            label="일정 표현식"
            constraint="rate(5 minutes) · cron(분 시 일 월 요일 연도) · at(2026-12-01T09:00:00)"
            error={draft.expression.trim() && !parsed.ok ? parsed.error : undefined}
          >
            <TextInput value={draft.expression} onChange={(e) => set({ expression: e.target.value })} className="font-mono" placeholder="cron(0 9 ? * MON-FRI *)" />
          </FormField>
          <FormField help={{ docKey: "eventbridge", field: "timezone" }} label="시간대">
            <SelectInput value={draft.timezone} onChange={(v) => set({ timezone: v as ScheduleTimezone })} options={SCHEDULE_TIMEZONES.map((z) => ({ value: z, label: z }))} />
          </FormField>
          {parsed.ok && (
            <Alert type="info" header={`${describeSchedule(parsed.value)} (${draft.timezone})`}>
              {preview.length ? (
                <>
                  다음 실행 (가상): {preview.map((t) => formatInTimezone(t, draft.timezone)).join(" · ")}
                  {parsed.value.kind === "rate" && " — rate 일정은 만든 시각부터 주기를 셉니다."}
                </>
              ) : (
                "지정한 시각이 이미 지나 실행되지 않습니다."
              )}
            </Alert>
          )}
          <FormField help={{ docKey: "eventbridge", field: "flexibleTimeWindow" }} label="유연한 시간 창 (분)" constraint="0이면 끔. 1~1,440분">
            <TextInput value={draft.flexible} onChange={(e) => set({ flexible: e.target.value })} inputMode="numeric" className="max-w-32" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="대상" description="이 시뮬레이터는 Lambda 함수 호출(Invoke)만 지원합니다." />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "eventbridge", field: "scheduleTarget" }} label="Lambda 함수">
            <SelectInput value={draft.targetLambdaId} onChange={(v) => set({ targetLambdaId: v })} placeholder={fns.length ? "함수 선택" : "함수가 없습니다"} options={fns.map((f) => ({ value: f.id, label: displayName(f) }))} />
          </FormField>
          {!fns.length && (
            <Alert type="info">
              먼저 <a href={href("/lambda/functions/create")}>Lambda 함수를 만드세요</a>.
            </Alert>
          )}
          <FormField help={{ docKey: "eventbridge", field: "scheduleInput" }} label="입력 (Payload)" constraint="JSON">
            <TextArea value={draft.input} onChange={(e) => set({ input: e.target.value })} rows={3} className="font-mono text-[13px]" spellCheck={false} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="설정" />}>
        <SpaceBetween size="m">
          <Toggle checked={draft.state === "ENABLED"} onChange={(v) => set({ state: v ? "ENABLED" : "DISABLED" })} description="끄면 일정은 남지만 함수를 호출하지 않습니다.">
            일정 활성화
          </Toggle>
          <FormField help={{ docKey: "eventbridge", field: "schedulerRole" }} label="실행 역할" info={<InfoLink topic="eventbridge-scheduler" />}>
            <RadioGroup
              aria-label="실행 역할"
              value={draft.roleMode}
              onChange={(v) => set({ roleMode: v as ScheduleDraft["roleMode"] })}
              items={[
                { value: "create", label: "이 일정에 대한 새 역할 만들기", description: "고른 함수 하나의 lambda:InvokeFunction만 허용하는 역할을 만듭니다." },
                { value: "existing", label: "기존 역할 사용", description: "scheduler.amazonaws.com을 신뢰하는 역할만 고를 수 있습니다." },
              ]}
            />
          </FormField>
          {draft.roleMode === "existing" && (
            <FormField label="기존 역할">
              <SelectInput value={draft.roleId ?? ""} onChange={(v) => set({ roleId: v || null })} placeholder={schedulerRoles.length ? "역할 선택" : "Scheduler용 역할이 없습니다"} options={schedulerRoles.map((r) => ({ value: r.id, label: r.name }))} />
            </FormField>
          )}
          <ExpandableSection header="재시도 정책">
            <FormField help={{ docKey: "eventbridge", field: "retryPolicy" }} label="최대 재시도 횟수" constraint="0~185 (기본값 185). 이 시뮬레이터는 재시도를 계산하지 않습니다.">
              <TextInput value={draft.retries} onChange={(e) => set({ retries: e.target.value })} inputMode="numeric" className="max-w-32" />
            </FormField>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    </>
  );
}

function toScheduleInput(d: ScheduleDraft): ScheduleInput | string {
  if (!/^\d+$/.test(d.flexible) || !/^\d+$/.test(d.retries)) return "[ValidationException] 유연한 시간 창과 재시도 횟수는 정수여야 합니다.";
  return {
    name: d.name,
    description: d.description,
    expression: d.expression,
    timezone: d.timezone,
    flexibleWindowMinutes: Number(d.flexible),
    state: d.state,
    targetLambdaId: d.targetLambdaId,
    roleId: d.roleMode === "existing" ? d.roleId : null,
    createRole: d.roleMode === "create",
    input: d.input,
    retryAttempts: Number(d.retries),
  };
}

export function CreateSchedulePage() {
  const { query } = useHashLocation();
  const run = useRunAction();
  const [draft, setDraft] = useState<ScheduleDraft>(() => ({
    name: "my-schedule",
    description: "",
    expression: "rate(5 minutes)",
    timezone: "Asia/Seoul",
    flexible: "0",
    state: "ENABLED",
    targetLambdaId: query.get("target") ?? "",
    roleId: null,
    roleMode: "create",
    input: "{}",
    retries: "185",
  }));
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...p }));
  const submit = () => {
    setError(null);
    const input = toScheduleInput(draft);
    if (typeof input === "string") return setError(input);
    const r = run("CreateSchedule", (p) => createSchedule(p, input), { success: () => `일정 ${draft.name.trim()}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/eventbridge/schedules/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween tour="schedule-form">
      <PageHeader title="일정 생성" info={<InfoLink topic="eventbridge-scheduler" />} description="EventBridge Scheduler 일정을 만듭니다 (가상). 실행 시각을 계산해 Lambda 지표와 가상 비용에 반영합니다." />
      <ScheduleForm draft={draft} set={set} isEdit={false} />
      <FormActions error={error ? <ErrorAlert message={error} header="일정을 만들 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/eventbridge/schedules")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          일정 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditSchedulePage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const schedule = project.services.eventbridge.schedules.find((s) => s.id === id);
  const [draft, setDraft] = useState<ScheduleDraft | null>(() =>
    schedule
      ? {
          name: schedule.name,
          description: schedule.description,
          expression: schedule.expression,
          timezone: schedule.timezone,
          flexible: String(schedule.flexibleWindowMinutes),
          state: schedule.state,
          targetLambdaId: schedule.targetLambdaId,
          roleId: schedule.roleId,
          roleMode: "existing",
          input: schedule.input,
          retries: String(schedule.retryAttempts),
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  if (!schedule || !draft) return <ScheduleNotFound />;
  const set = (p: Partial<ScheduleDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const save = () => {
    setError(null);
    const input = toScheduleInput(draft);
    if (typeof input === "string") return setError(input);
    const r = run("UpdateSchedule", (p) => updateSchedule(p, schedule.id, input), { success: () => `일정 ${schedule.name}을(를) 저장했습니다.` });
    if (r.ok) navigate(`/eventbridge/schedules/${schedule.id}`);
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`일정 편집: ${schedule.name}`} info={<InfoLink topic="eventbridge-scheduler" />} />
      <ScheduleForm draft={draft} set={set} isEdit />
      <FormActions error={error ? <ErrorAlert message={error} header="일정을 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(`/eventbridge/schedules/${schedule.id}`)}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

function ScheduleNotFound() {
  return (
    <Container>
      <EmptyState title="일정을 찾을 수 없습니다" description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/eventbridge/schedules")}>일정 목록</ButtonLink>} />
    </Container>
  );
}

export function ScheduleDetailPage({ id }: { id: string }) {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  const now = useNow();
  const [deleting, setDeleting] = useState(false);
  const schedule = project.services.eventbridge.schedules.find((s) => s.id === id);
  if (!schedule) return <ScheduleNotFound />;
  const parsed = parseScheduleExpression(schedule.expression);
  const fn = topo.getOfType(schedule.targetLambdaId, "lambda") ?? undefined;
  const can = scheduleCanInvoke(project, schedule, fn);
  const analysis = fn ? analyzeInvocation(project, topo, fn) : null;
  const next = parsed.ok && schedule.state === "ENABLED" ? nextRunTimes(parsed.value, schedule.timezone, Date.parse(schedule.createdAt), now, 10) : [];
  return (
    <SpaceBetween>
      <PageHeader
        title={schedule.name}
        info={<InfoLink topic="eventbridge-scheduler" />}
        description={schedule.description || undefined}
        actions={
          <>
            <Button onClick={() => run("UpdateSchedule", (p) => setScheduleState(p, schedule.id, schedule.state === "ENABLED" ? "DISABLED" : "ENABLED"), { success: () => `일정을 ${schedule.state === "ENABLED" ? "비활성화" : "활성화"}했습니다.`, flashError: true })}>
              {schedule.state === "ENABLED" ? "비활성화" : "활성화"}
            </Button>
            <ButtonLink href={href(`/eventbridge/schedules/${schedule.id}/edit`)}>편집</ButtonLink>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
          </>
        }
      />
      <Container header={<ContainerHeader title="일정 세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "상태", value: <StateBadge state={schedule.state} /> },
            { label: "일정 표현식", value: <span className="font-mono text-[13px]">{schedule.expression}</span> },
            { label: "의미", value: parsed.ok ? describeSchedule(parsed.value) : <span className="text-aws-error">{parsed.error}</span> },
            { label: "시간대", value: schedule.timezone },
            { label: "유연한 시간 창", value: schedule.flexibleWindowMinutes ? `${schedule.flexibleWindowMinutes}분` : "끔" },
            { label: "재시도", value: `최대 ${schedule.retryAttempts}회` },
            { label: "대상", value: <FunctionLink project={project} id={schedule.targetLambdaId} /> },
            { label: "실행 역할", value: <RoleLink project={project} id={schedule.roleId} /> },
            { label: "일정 ARN (가상)", value: <CopyText text={scheduleArn(schedule.name)} /> },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="호출 확인 (가상)" />}>
        <SpaceBetween size="s">
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-2" data-testid="schedule-invoke">
            <StatusIndicator type={can.ok ? "success" : "error"} className="font-bold">
              {can.ok ? "Scheduler가 함수를 호출할 수 있음" : "Scheduler가 함수를 호출할 수 없음"}
            </StatusIndicator>
            <span className="text-sm text-aws-text-2">{can.reason}</span>
          </div>
          {analysis && can.ok && (
            <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
              <span className="font-bold">함수가 실행되면:</span> <OutcomeStatus outcome={analysis.outcome} />
              {analysis.outcome !== "success" && <span className="text-aws-text-2">{analysis.checks.find((c) => c.status === "fail")?.detail}</span>}
            </div>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="다음 실행 10회 (가상)" />}>
        {next.length ? (
          <ol className="list-decimal space-y-0.5 pl-6 text-sm">
            {next.map((t) => (
              <li key={t}>{formatInTimezone(t, schedule.timezone)}</li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-aws-text-2">{schedule.state === "DISABLED" ? "비활성 일정이라 실행하지 않습니다." : parsed.ok ? "앞으로 실행할 시각이 없습니다." : "표현식이 올바르지 않습니다."}</p>
        )}
      </Container>
      <ExpandableSection header="입력 (Payload)">
        <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">{schedule.input}</pre>
      </ExpandableSection>
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`일정 ${schedule.name} 삭제`}
          confirmText={schedule.name}
          onConfirm={() => {
            const r = run("DeleteSchedule", (p) => deleteSchedule(p, schedule.id), { success: () => `일정 ${schedule.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            navigate("/eventbridge/schedules");
            return null;
          }}
        >
          <p>일정을 삭제하면 더 이상 함수를 호출하지 않습니다. 대상 함수와 실행 역할은 남습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

// ================================================================ 규칙

const PATTERN_PRESETS: { label: string; pattern: object }[] = [
  { label: "EC2 인스턴스 중지", pattern: { source: ["aws.ec2"], "detail-type": ["EC2 Instance State-change Notification"], detail: { state: ["stopped"] } } },
  { label: "S3 객체 생성 (reports/)", pattern: { source: ["aws.s3"], "detail-type": ["Object Created"], detail: { object: { key: [{ prefix: "reports/" }] } } } },
  { label: "CloudWatch 경보 ALARM", pattern: { source: ["aws.cloudwatch"], "detail-type": ["CloudWatch Alarm State Change"], detail: { state: { value: ["ALARM"] } } } },
  { label: "직접 만든 앱 이벤트", pattern: { source: ["school.app"], "detail-type": ["SignupCompleted"] } },
];

const pretty = (o: unknown) => JSON.stringify(o, null, 2);

type RuleDraft = RuleInput;

function RuleForm({ draft, set, isEdit }: { draft: RuleDraft; set: (p: Partial<RuleDraft>) => void; isEdit: boolean }) {
  const topo = useTopology();
  const parsed = parseEventPattern(draft.eventPattern);
  const fns = topo.ofType("lambda");
  return (
    <>
      <Container header={<ContainerHeader title="규칙 세부 정보" description="이벤트 버스: default (AWS 서비스 이벤트를 받는 기본 버스)" />}>
        <SpaceBetween size="m">
          <FormField label="이름" constraint={isEdit ? "만든 뒤에는 이름을 바꿀 수 없습니다." : "1~64자의 영문·숫자·마침표·하이픈·밑줄"}>
            <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={isEdit} maxLength={64} />
          </FormField>
          <FormField label="설명" optional>
            <TextInput value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={512} />
          </FormField>
          <Toggle checked={draft.state === "ENABLED"} onChange={(v) => set({ state: v ? "ENABLED" : "DISABLED" })}>
            규칙 활성화
          </Toggle>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="이벤트 패턴" info={<InfoLink topic="eventbridge-rules" />} />}>
        <SpaceBetween size="m">
          <div className="flex flex-wrap gap-2" aria-label="예시 패턴">
            {PATTERN_PRESETS.map((p) => (
              <Button key={p.label} onClick={() => set({ eventPattern: pretty(p.pattern) })}>
                {p.label}
              </Button>
            ))}
          </div>
          <FormField help={{ docKey: "eventbridge", field: "eventPattern" }} label="이벤트 패턴 (JSON)" error={draft.eventPattern.trim() && !parsed.ok ? parsed.error : undefined} constraint="값은 항상 배열로 씁니다. 예: {&quot;source&quot;: [&quot;aws.ec2&quot;]}">
            <TextArea value={draft.eventPattern} onChange={(e) => set({ eventPattern: e.target.value })} rows={8} className="font-mono text-[13px]" spellCheck={false} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="대상" description="패턴과 일치한 이벤트를 받을 Lambda 함수 (최대 5개)" />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "eventbridge", field: "ruleTargets" }} label="Lambda 함수">
            <MultiSelect aria-label="대상 함수" selected={draft.targetLambdaIds} onChange={(v) => set({ targetLambdaIds: v })} max={5} empty="함수가 없습니다. Lambda에서 먼저 만드세요." options={fns.map((f) => ({ value: f.id, label: displayName(f), description: f.id }))} />
          </FormField>
          <Checkbox
            checked={draft.addPermissions}
            onChange={(v) => set({ addPermissions: v })}
            description="콘솔은 대상 함수의 리소스 기반 정책에 이 규칙(events.amazonaws.com)의 호출 허용을 자동으로 넣습니다. 끄면 CLI로 대상만 추가한 것과 같아 함수가 호출되지 않습니다."
          >
            Lambda 호출 권한 자동 추가 (콘솔 기본 동작)
          </Checkbox>
        </SpaceBetween>
      </Container>
    </>
  );
}

export function CreateRulePage() {
  const { query } = useHashLocation();
  const run = useRunAction();
  const [draft, setDraft] = useState<RuleDraft>(() => ({
    name: "my-rule",
    description: "",
    eventPattern: pretty(PATTERN_PRESETS[0].pattern),
    state: "ENABLED",
    targetLambdaIds: query.get("target") ? [query.get("target")!] : [],
    addPermissions: true,
  }));
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...p }));
  const submit = () => {
    setError(null);
    const r = run("PutRule", (p) => createRule(p, draft), { success: () => `규칙 ${draft.name.trim()}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/eventbridge/rules/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="규칙 생성" info={<InfoLink topic="eventbridge-rules" />} description="기본 이벤트 버스에 규칙을 만듭니다 (가상). 샌드박스 리소스는 이벤트를 만들지 않으므로, 만든 뒤 테스트 이벤트로 확인하세요." />
      <PageGuide topic="eventbridge-rules" />
      <RuleForm draft={draft} set={set} isEdit={false} />
      <FormActions error={error ? <ErrorAlert message={error} header="규칙을 만들 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/eventbridge/rules")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          규칙 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditRulePage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const rule = project.services.eventbridge.rules.find((r) => r.id === id);
  const [draft, setDraft] = useState<RuleDraft | null>(() =>
    rule ? { name: rule.name, description: rule.description, eventPattern: rule.eventPattern, state: rule.state, targetLambdaIds: rule.targetLambdaIds, addPermissions: true } : null,
  );
  const [error, setError] = useState<string | null>(null);
  if (!rule || !draft) return <RuleNotFound />;
  const set = (p: Partial<RuleDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const save = () => {
    setError(null);
    const r = run("PutRule", (p) => updateRule(p, rule.id, draft), { success: () => `규칙 ${rule.name}을(를) 저장했습니다.` });
    if (r.ok) navigate(`/eventbridge/rules/${rule.id}`);
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`규칙 편집: ${rule.name}`} info={<InfoLink topic="eventbridge-rules" />} />
      <RuleForm draft={draft} set={set} isEdit />
      <FormActions error={error ? <ErrorAlert message={error} header="규칙을 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(`/eventbridge/rules/${rule.id}`)}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

function RuleNotFound() {
  return (
    <Container>
      <EmptyState title="규칙을 찾을 수 없습니다" description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/eventbridge/rules")}>규칙 목록</ButtonLink>} />
    </Container>
  );
}

export function RuleListPage() {
  const project = useProject();
  const run = useRunAction();
  const rules = project.services.eventbridge.rules;
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = rules.find((r) => r.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="eventbridge-rules" />
      <ResourceTable<EventRule>
        ariaLabel="규칙 목록"
        items={rules}
        trackBy={(r) => r.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.name}
        header={
          <PageHeader
            title="규칙"
            counter={`(${rules.length})`}
            info={<InfoLink topic="eventbridge-rules" />}
            description="이벤트 버스: default"
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "enable", text: "활성화", disabled: current?.state !== "DISABLED" },
                    { id: "disable", text: "비활성화", disabled: current?.state !== "ENABLED" },
                    { id: "edit", text: "편집", disabled: !current },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "enable" || a === "disable") run(a === "enable" ? "EnableRule" : "DisableRule", (p) => setRuleState(p, current.id, a === "enable" ? "ENABLED" : "DISABLED"), { success: () => `규칙 ${current.name}을(를) ${a === "enable" ? "활성화" : "비활성화"}했습니다.`, flashError: true });
                    if (a === "edit") navigate(`/eventbridge/rules/${current.id}/edit`);
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink href={href("/eventbridge/send-event")}>테스트 이벤트 보내기</ButtonLink>
                <ButtonLink variant="primary" href={href("/eventbridge/rules/create")}>
                  규칙 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="규칙 없음" description="규칙을 만들면 패턴과 일치하는 이벤트가 올 때 Lambda 함수를 호출합니다 (가상)." action={<ButtonLink href={href("/eventbridge/rules/create")}>규칙 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (r) => <a className="font-bold text-aws-link hover:underline" href={href(`/eventbridge/rules/${r.id}`)}>{r.name}</a>, sortValue: (r) => r.name },
          { id: "state", header: "상태", cell: (r) => <StateBadge state={r.state} /> },
          { id: "targets", header: "대상", cell: (r) => (r.targetLambdaIds.length ? r.targetLambdaIds.map((id) => <div key={id}><FunctionLink project={project} id={id} /></div>) : "없음") },
          { id: "desc", optional: true, header: "설명", cell: (r) => <span className="text-aws-text-2">{r.description}</span> },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`규칙 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteRule", (p) => deleteRule(p, current.id), { success: () => `규칙 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>규칙과 대상을 삭제합니다. 함수의 리소스 기반 정책은 남습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

export function RuleDetailPage({ id }: { id: string }) {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  const [deleting, setDeleting] = useState(false);
  const rule = project.services.eventbridge.rules.find((r) => r.id === id);
  if (!rule) return <RuleNotFound />;
  const parsed = parseEventPattern(rule.eventPattern);
  return (
    <SpaceBetween>
      <PageHeader
        title={rule.name}
        info={<InfoLink topic="eventbridge-rules" />}
        description={rule.description || undefined}
        actions={
          <>
            <Button onClick={() => run(rule.state === "ENABLED" ? "DisableRule" : "EnableRule", (p) => setRuleState(p, rule.id, rule.state === "ENABLED" ? "DISABLED" : "ENABLED"), { success: () => `규칙을 ${rule.state === "ENABLED" ? "비활성화" : "활성화"}했습니다.`, flashError: true })}>
              {rule.state === "ENABLED" ? "비활성화" : "활성화"}
            </Button>
            <ButtonLink href={href(`/eventbridge/rules/${rule.id}/edit`)}>편집</ButtonLink>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
          </>
        }
      />
      <Container header={<ContainerHeader title="규칙 세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "상태", value: <StateBadge state={rule.state} /> },
            { label: "이벤트 버스", value: "default" },
            { label: "규칙 ARN (가상)", value: <CopyText text={ruleArn(rule.name)} /> },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="이벤트 패턴" />}>
        {parsed.ok ? <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">{pretty(parsed.pattern)}</pre> : <ErrorAlert message={`[InvalidEventPatternException] ${parsed.error}`} header="패턴이 올바르지 않습니다" />}
      </Container>
      <Container header={<ContainerHeader title={`대상 (${rule.targetLambdaIds.length})`} />}>
        {rule.targetLambdaIds.length ? (
          <ul className="divide-y divide-aws-divider text-sm">
            {rule.targetLambdaIds.map((fid) => {
              const fn = topo.getOfType(fid, "lambda") ?? undefined;
              const can = ruleCanInvoke(rule, fn);
              return (
                <li key={fid} className="space-y-0.5 py-2">
                  <FunctionLink project={project} id={fid} /> {can.ok ? <Badge color="green">호출 가능</Badge> : <Badge color="red">호출 불가</Badge>}
                  <p className="text-aws-text-2">{can.reason}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">대상이 없어 일치한 이벤트가 어디에도 전달되지 않습니다.</p>
        )}
      </Container>
      <TestEventPanel ruleId={rule.id} />
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`규칙 ${rule.name} 삭제`}
          confirmText={rule.name}
          onConfirm={() => {
            const r = run("DeleteRule", (p) => deleteRule(p, rule.id), { success: () => `규칙 ${rule.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            navigate("/eventbridge/rules");
            return null;
          }}
        >
          <p>규칙과 대상을 삭제합니다. 함수의 리소스 기반 정책은 남습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

// ================================================================ 테스트 이벤트

function MatchSteps({ steps }: { steps: MatchStep[] }) {
  return (
    <ul className="space-y-0.5 text-[13px]">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <StatusIndicator type={s.ok ? "success" : "error"} className="shrink-0 font-mono">
            {s.path}
          </StatusIndicator>
          <span className="text-aws-text-2">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function DeliveryView({ d }: { d: RuleDelivery }) {
  const project = useProject();
  return (
    <div className="space-y-2 rounded-xl border border-aws-border p-3" data-testid={`delivery-${d.rule.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <a className="font-bold text-aws-link hover:underline" href={href(`/eventbridge/rules/${d.rule.id}`)}>
          규칙 {d.rule.name}
        </a>
        {d.patternError ? <Badge color="red">패턴 오류</Badge> : d.match?.matched ? <Badge color="green">일치</Badge> : <Badge>일치하지 않음</Badge>}
        {d.rule.state === "DISABLED" && <Badge color="orange">비활성 — 대상 호출 안 함</Badge>}
      </div>
      {d.patternError && <p className="text-sm text-aws-error">{d.patternError}</p>}
      {d.match && <MatchSteps steps={d.match.steps} />}
      {d.delivered && !d.targets.length && <p className="text-sm text-aws-text-2">일치했지만 대상이 없어 이벤트가 버려졌습니다.</p>}
      {d.targets.map((t) => (
        <div key={t.functionId} className="space-y-2 rounded-lg bg-aws-bg p-2">
          <p className="text-sm">
            대상 <FunctionLink project={project} id={t.functionId} />: {t.result ? <OutcomeStatus outcome={t.result.outcome} /> : <StatusIndicator type="error">호출 안 됨</StatusIndicator>}
          </p>
          {!t.permission.ok && <p className="text-sm text-aws-text-2">{t.permission.reason}</p>}
          {t.result && (
            <ExpandableSection header="함수 실행 결과 자세히">
              <InvokeResultView result={t.result} />
            </ExpandableSection>
          )}
        </div>
      ))}
    </div>
  );
}

function TestEventPanel({ ruleId }: { ruleId?: string }) {
  const project = useProject();
  const topo = useTopology();
  const [sample, setSample] = useState(SAMPLE_EVENTS[0].id);
  const [text, setText] = useState(pretty(SAMPLE_EVENTS[0].event));
  const [result, setResult] = useState<ReturnType<typeof sendTestEvent> | null>(null);
  const send = () => setResult(sendTestEvent(project, topo, text, ruleId));
  // 패턴만 빠르게 확인 (규칙 상세): 저장된 규칙 대신 화면에 보이는 이벤트로 바로 판정
  const rule = ruleId ? project.services.eventbridge.rules.find((r) => r.id === ruleId) : undefined;
  const quick = useMemo(() => {
    if (!rule) return null;
    const parsed = parseEventPattern(rule.eventPattern);
    if (!parsed.ok) return null;
    try {
      return matchEventPattern(parsed.pattern, JSON.parse(text));
    } catch {
      return null;
    }
  }, [rule, text]);
  return (
    <Container
      header={
        <ContainerHeader
          title="테스트 이벤트 보내기 (가상)"
          info={<InfoLink topic="eventbridge-rules" />}
          description={ruleId ? "이 규칙만 확인합니다. 이벤트는 저장하지 않습니다." : "기본 이벤트 버스의 모든 규칙에 보냅니다. 이벤트는 저장하지 않습니다."}
          actions={
            <Button variant="primary" onClick={send} data-testid="send-test-event">
              보내기
            </Button>
          }
        />
      }
    >
      <SpaceBetween size="m">
        <FormField help={{ docKey: "eventbridge", field: "testEvent" }} label="예시 이벤트">
          <SelectInput
            value={sample}
            onChange={(v) => {
              setSample(v);
              const s = SAMPLE_EVENTS.find((x) => x.id === v);
              if (s) setText(pretty(s.event));
              setResult(null);
            }}
            options={SAMPLE_EVENTS.map((s) => ({ value: s.id, label: s.label }))}
          />
        </FormField>
        <FormField label="이벤트 JSON" constraint="source, detail-type, detail이 있어야 합니다.">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="font-mono text-[13px]" spellCheck={false} />
        </FormField>
        {quick && !result && <p className="text-sm text-aws-text-2">패턴 미리 보기: {quick.matched ? "이 이벤트는 규칙과 일치합니다." : "이 이벤트는 규칙과 일치하지 않습니다."}</p>}
        {result && !result.ok && <ErrorAlert message={`[InvalidEventException] ${result.error}`} header="이벤트를 보낼 수 없습니다" />}
        {result?.ok && (
          <SpaceBetween size="s">
            {result.deliveries.length ? result.deliveries.map((d) => <DeliveryView key={d.rule.id} d={d} />) : <p className="text-sm text-aws-text-2">규칙이 없어 아무 일도 일어나지 않았습니다.</p>}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}

export function SendEventPage() {
  return (
    <SpaceBetween>
      <PageHeader title="테스트 이벤트 보내기" info={<InfoLink topic="eventbridge-rules" />} description="예시 이벤트를 기본 이벤트 버스에 넣었다고 가정하고, 규칙마다 패턴 일치와 대상 함수 호출 결과를 계산합니다." />
      <Alert type="info">
        실제 AWS에서는 EC2 상태 변경·S3 업로드 같은 서비스 이벤트가 기본 이벤트 버스로 자동으로 들어옵니다. 이 시뮬레이터의 리소스는 이벤트를 만들지 않으므로 여기서 직접 보냅니다.
      </Alert>
      <TestEventPanel />
    </SpaceBetween>
  );
}
