"use client";

/**
 * Lambda 콘솔 (가상): 함수 목록·생성·상세(코드·테스트·모니터링·구성).
 * 코드는 실행하지 않고, 테스트 호출은 실행 역할·네트워크·코드 템플릿으로 결과를 계산해 보여 준다.
 */
import { useMemo, useState } from "react";
import { evaluateIam } from "@/lib/engine/iam-engine";
import { actingArn, actingIdentity, actingPrincipal } from "@/lib/engine/iam-session";
import {
  analyzeInvocation,
  deliverableSchedules,
  invokeLambda,
  LAMBDA_TEMPLATE_INFO,
  lambdaArn,
  ruleArn,
  ruleCanInvoke,
  scheduleCanInvoke,
  templateCode,
  type InvokeOutcome,
  type InvokeResult,
} from "@/lib/engine/lambda-engine";
import {
  LAMBDA_ARCHITECTURES,
  LAMBDA_CODE_TEMPLATES,
  LAMBDA_PERMISSION_PRINCIPALS,
  LAMBDA_RUNTIMES,
  type ConfigOf,
  type LambdaCodeTemplate,
  type MetricRef,
  type Project,
  type ResourceOfType,
} from "@/lib/engine/resource-models";
import { formatInTimezone, nextRunTimes } from "@/lib/engine/schedule-expression";
import { displayName } from "@/lib/engine/topology-engine";
import { deleteFunction } from "@/lib/project/console-actions";
import {
  addFunctionPermission,
  createFunction,
  removeFunctionPermission,
  setFunctionVpc,
  setReservedConcurrency,
  updateFunctionCode,
  updateFunctionConfiguration,
} from "@/lib/project/lambda-actions";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, resourcePath, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, MultiSelect, RadioGroup, SelectInput, TextArea, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText, StatusIndicator, type StatusType } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { MetricCharts } from "../cloudwatch/cw-metrics";
import { periodForRange, RangePicker, useNow } from "../cloudwatch/cw-shared";
import { ResourceNotFound, useQueryTab, useResource, useSelection, useTopology } from "../common";

type Fn = ResourceOfType<"lambda">;
type LambdaConfig = ConfigOf<"lambda">;

export const RUNTIME_LABEL: Record<LambdaConfig["runtime"], string> = { "nodejs22.x": "Node.js 22.x", "python3.13": "Python 3.13", java21: "Java 21" };

const OUTCOME: Record<InvokeOutcome, { type: StatusType; label: string }> = {
  success: { type: "success", label: "성공" },
  error: { type: "error", label: "오류" },
  timeout: { type: "error", label: "시간 초과" },
  throttled: { type: "warning", label: "제한됨 (Throttled)" },
  invalid: { type: "error", label: "실행할 수 없음" },
};

export function OutcomeStatus({ outcome }: { outcome: InvokeOutcome }) {
  return <StatusIndicator type={OUTCOME[outcome].type}>{OUTCOME[outcome].label}</StatusIndicator>;
}

function triggersOf(project: Project, fnId: string) {
  const { schedules, rules } = project.services.eventbridge;
  return { schedules: schedules.filter((s) => s.targetLambdaId === fnId), rules: rules.filter((r) => r.targetLambdaIds.includes(fnId)) };
}

function triggerSummary(project: Project, fnId: string): string {
  const t = triggersOf(project, fnId);
  const parts = [t.schedules.length && `일정 ${t.schedules.length}`, t.rules.length && `규칙 ${t.rules.length}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "없음";
}

const TEMPLATE_TARGET_HELP: Partial<Record<LambdaCodeTemplate, string>> = {
  "s3-list": "읽을 S3 버킷 이름",
  "http-get": "호출할 HTTPS 주소 (실제로 요청하지 않습니다)",
  "rds-query": "접속할 DB 인스턴스",
  "secret-get": "읽을 보안 암호 (Secrets Manager)",
  "ssm-get": "읽을 파라미터 (Parameter Store)",
};

// ================================================================ 목록

export function FunctionListPage() {
  const topo = useTopology();
  const project = useProject();
  const fns = topo.ofType("lambda");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = fns.find((f) => f.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="lambda" />
      <ResourceTable<Fn>
        ariaLabel="함수 목록"
        items={fns}
        trackBy={(f) => f.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(f) => f.name || f.id}
        header={
          <PageHeader
            title="함수"
            counter={`(${fns.length})`}
            info={<InfoLink topic="lambda" />}
            actions={
              <>
                <Button disabled={!current} onClick={() => setDeleting(true)}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/lambda/functions/create")}>
                  함수 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={
          <EmptyState
            title="함수 없음"
            description="함수를 만들면 서버 없이 코드를 실행하는 흐름을 가상으로 실험할 수 있습니다. 코드는 실제로 실행되지 않습니다."
            action={<ButtonLink href={href("/lambda/functions/create")}>함수 생성</ButtonLink>}
          />
        }
        columns={[
          { id: "name", header: "함수 이름", cell: (f) => <TypedResourceLink type="lambda" id={f.id}>{f.name || f.id}</TypedResourceLink>, sortValue: (f) => f.name },
          { id: "runtime", header: "런타임", cell: (f) => RUNTIME_LABEL[f.config.runtime] },
          { id: "memory", optional: true, header: "메모리", cell: (f) => `${f.config.memoryMb}MB` },
          { id: "vpc", header: "VPC", cell: (f) => (topo.lambdaSubnets(f.id).length ? <ResourceLink id={topo.vpcOf(f.id)} /> : "–") },
          { id: "triggers", header: "트리거", cell: (f) => triggerSummary(project, f.id) },
          { id: "outcome", header: "호출하면 (가상)", cell: (f) => <OutcomeStatus outcome={analyzeInvocation(project, topo, f).outcome} /> },
        ]}
      />
      <FunctionDeleteModal fn={deleting ? current : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

function FunctionDeleteModal({ fn, onClose }: { fn: Fn | undefined; onClose: () => void }) {
  const run = useRunAction();
  const project = useProject();
  if (!fn) return null;
  const t = triggersOf(project, fn.id);
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={`함수 ${fn.name || fn.id} 삭제`}
      confirmText="confirm"
      onConfirm={() => {
        const r = run("DeleteFunction", (p) => deleteFunction(p, fn.id), { success: () => `함수 ${fn.name || fn.id}을(를) 삭제했습니다.` });
        if (!r.ok) return withHint(r);
        navigate("/lambda/functions");
        return null;
      }}
    >
      <p>함수와 설정(실행 역할 연결, VPC 연결, 리소스 기반 정책)을 삭제합니다. 실행 역할 자체는 IAM에 남습니다.</p>
      {(t.schedules.length > 0 || t.rules.length > 0) && (
        <Alert type="warning">
          이 함수를 대상으로 하는 일정 {t.schedules.length}개와 규칙 {t.rules.length}개는 삭제되지 않고 남아, 이후 호출이 실패합니다 (AWS와 같음).
        </Alert>
      )}
    </DeleteModal>
  );
}

// ================================================================ 생성

function VpcFields({ subnetIds, setSubnetIds, sgIds, setSgIds }: { subnetIds: string[]; setSubnetIds: (v: string[]) => void; sgIds: string[]; setSgIds: (v: string[]) => void }) {
  const topo = useTopology();
  const vpcOfFirst = subnetIds.length ? topo.vpcOfSubnet(subnetIds[0]) : null;
  const [vpcId, setVpcId] = useState<string>(vpcOfFirst ?? "");
  const subnets = vpcId ? topo.subnetsOfVpc(vpcId) : [];
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  const KIND = { public: "퍼블릭 (Lambda는 인터넷에 나갈 수 없음)", "private-nat": "프라이빗 (NAT 경로 있음)", "private-isolated": "프라이빗 (외부 경로 없음)", unattached: "-" } as const;
  return (
    <SpaceBetween size="m">
      <FormField label="VPC" description="VPC 안의 RDS 같은 프라이빗 리소스에 접근할 때만 연결합니다. 비워 두면 VPC 밖에서 실행됩니다.">
        <SelectInput
          value={vpcId}
          onChange={(v) => {
            setVpcId(v);
            setSubnetIds([]);
            setSgIds([]);
          }}
          placeholder="VPC에 연결하지 않음"
          options={topo.ofType("vpc").map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))}
        />
      </FormField>
      {vpcId && (
        <>
          <FormField help={{ docKey: "lambda", field: "subnets" }} label="서브넷" constraint="가용 영역이 다른 서브넷 2개 이상을 권장합니다. 인터넷이 필요하면 NAT 경로가 있는 프라이빗 서브넷을 고르세요.">
            <MultiSelect
              aria-label="서브넷"
              selected={subnetIds}
              onChange={setSubnetIds}
              max={16}
              empty="이 VPC에 서브넷이 없습니다."
              options={subnets.map((s) => ({ value: s.id, label: `${s.id} (${displayName(s)})`, description: `${s.config.availabilityZone} · ${s.config.cidr} · ${KIND[topo.classifySubnet(s.id).kind]}` }))}
            />
          </FormField>
          <FormField help={{ docKey: "lambda", field: "securityGroups" }} label="보안 그룹" constraint="최대 5개. 함수는 연결을 받지 않으므로 아웃바운드 규칙이 중요합니다.">
            <MultiSelect aria-label="보안 그룹" selected={sgIds} onChange={setSgIds} max={5} empty="이 VPC에 보안 그룹이 없습니다." options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.id})`, description: g.config.description }))} />
          </FormField>
        </>
      )}
    </SpaceBetween>
  );
}

export function CreateFunctionPage() {
  const project = useProject();
  const run = useRunAction();
  const [name, setName] = useState("my-function");
  const [runtime, setRuntime] = useState<LambdaConfig["runtime"]>("nodejs22.x");
  const [architecture, setArchitecture] = useState<LambdaConfig["architecture"]>("x86_64");
  const [roleMode, setRoleMode] = useState<"create" | "existing">("create");
  const [roleId, setRoleId] = useState("");
  const [template, setTemplate] = useState<LambdaCodeTemplate>("hello");
  const [subnetIds, setSubnetIds] = useState<string[]>([]);
  const [sgIds, setSgIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lambdaRoles = project.services.iam.roles.filter((r) => r.trustedEntity === "lambda.amazonaws.com");
  const submit = () => {
    setError(null);
    const r = run(
      "CreateFunction",
      (p) => createFunction(p, { name, runtime, architecture, roleId: roleMode === "existing" ? roleId || null : null, createRole: roleMode === "create", codeTemplate: template, subnetIds, securityGroupIds: sgIds }),
      { success: () => `함수 ${name.trim()}을(를) 만들었습니다.` },
    );
    if (r.ok && r.createdId) navigate(resourcePath("lambda", r.createdId));
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween tour="lambda-form">
      <PageHeader title="함수 생성" info={<InfoLink topic="lambda" />} description="가상 Lambda 함수를 만듭니다. 코드를 올리거나 실행하지 않고, 고른 코드 템플릿이 하는 일로 호출 결과를 계산합니다." />
      <PageGuide topic="lambda" />
      <Container header={<ContainerHeader title="기본 정보" />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "lambda", field: "name" }} label="함수 이름" constraint="1~64자의 영문·숫자·하이픈(-)·밑줄(_). 만든 뒤에는 바꿀 수 없습니다.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </FormField>
          <FormField help={{ docKey: "lambda", field: "runtime" }} label="런타임">
            <SelectInput value={runtime} onChange={(v) => setRuntime(v as LambdaConfig["runtime"])} options={LAMBDA_RUNTIMES.map((r) => ({ value: r, label: RUNTIME_LABEL[r] }))} />
          </FormField>
          <FormField help={{ docKey: "lambda", field: "architecture" }} label="아키텍처">
            <RadioGroup
              aria-label="아키텍처"
              value={architecture}
              onChange={(v) => setArchitecture(v as LambdaConfig["architecture"])}
              items={LAMBDA_ARCHITECTURES.map((a) => ({ value: a, label: a, description: a === "arm64" ? "AWS Graviton. 실행 시간 단가가 더 낮습니다." : "인텔·AMD 계열 (기본값)" }))}
            />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="권한" info={<InfoLink topic="lambda-role" />} description="함수는 실행 역할의 임시 자격 증명으로 실행됩니다. 코드에 액세스 키를 넣지 않습니다." />}>
        <SpaceBetween size="m">
          <RadioGroup
            aria-label="실행 역할"
            value={roleMode}
            onChange={(v) => setRoleMode(v as typeof roleMode)}
            items={[
              { value: "create", label: "기본 Lambda 권한을 가진 새 역할 생성", description: "CloudWatch Logs에 로그를 쓰는 권한만 있는 역할을 만듭니다 (VPC에 연결하면 네트워크 인터페이스 권한도 추가)." },
              { value: "existing", label: "기존 역할 사용", description: "lambda.amazonaws.com을 신뢰하는 역할만 고를 수 있습니다." },
            ]}
          />
          {roleMode === "existing" && (
            <FormField help={{ docKey: "lambda", field: "roleId" }} label="기존 역할">
              <SelectInput
                value={roleId}
                onChange={setRoleId}
                placeholder={lambdaRoles.length ? "역할 선택" : "Lambda용 역할이 없습니다"}
                options={lambdaRoles.map((r) => ({ value: r.id, label: r.name, description: `정책 ${r.policyIds.length}개` }))}
              />
            </FormField>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="코드 (가상 템플릿)" description="실제 코드 대신 '코드가 하는 일'을 고릅니다. 만든 뒤 코드 탭에서 바꿀 수 있습니다." />}>
        <Tiles
          aria-label="코드 템플릿"
          value={template}
          onChange={(v) => setTemplate(v as LambdaCodeTemplate)}
          items={LAMBDA_CODE_TEMPLATES.map((t) => ({ value: t, label: LAMBDA_TEMPLATE_INFO[t].label, description: LAMBDA_TEMPLATE_INFO[t].description }))}
        />
      </Container>
      <Container header={<ContainerHeader title="고급 설정: VPC" info={<InfoLink topic="lambda-vpc" />} />}>
        <VpcFields subnetIds={subnetIds} setSubnetIds={setSubnetIds} sgIds={sgIds} setSgIds={setSgIds} />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="함수를 생성할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/lambda/functions")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          함수 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

// ================================================================ 상세

export function FunctionDetailPage({ id }: { id: string }) {
  const fn = useResource(id, "lambda");
  const project = useProject();
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("code");
  const [deleting, setDeleting] = useState(false);
  if (!fn) return <ResourceNotFound type="lambda" id={id} />;
  const analysis = analyzeInvocation(project, topo, fn);
  const t = triggersOf(project, fn.id);
  const role = project.services.iam.roles.find((r) => r.id === fn.config.roleId);
  return (
    <SpaceBetween>
      <PageHeader
        title={fn.name || fn.id}
        info={<InfoLink topic="lambda" />}
        actions={
          <>
            <ButtonLink href={href("/eventbridge/schedules/create", { target: fn.id })}>일정 추가</ButtonLink>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
          </>
        }
      />
      <Container header={<ContainerHeader title="함수 개요" />}>
        <div className="grid gap-4 @2xl/main:grid-cols-[1fr_auto_1fr] @2xl/main:items-center">
          <div className="space-y-1.5 text-sm" aria-label="트리거">
            <p className="font-bold text-aws-text-2">트리거</p>
            {t.schedules.map((s) => (
              <a key={s.id} href={href(`/eventbridge/schedules/${s.id}`)} className="block rounded-lg border border-aws-border px-3 py-2 hover:border-aws-link">
                <span className="font-bold">EventBridge Scheduler</span> · {s.name} <span className="text-aws-text-2">({s.expression}{s.state === "DISABLED" ? ", 비활성" : ""})</span>
              </a>
            ))}
            {t.rules.map((r) => (
              <a key={r.id} href={href(`/eventbridge/rules/${r.id}`)} className="block rounded-lg border border-aws-border px-3 py-2 hover:border-aws-link">
                <span className="font-bold">EventBridge 규칙</span> · {r.name} <span className="text-aws-text-2">({r.state === "ENABLED" ? "활성" : "비활성"})</span>
              </a>
            ))}
            {!t.schedules.length && !t.rules.length && <p className="text-aws-text-2">트리거가 없습니다. 위의 &apos;일정 추가&apos;나 EventBridge 규칙으로 연결하세요.</p>}
          </div>
          <div className="rounded-xl border-2 border-aws-link px-4 py-3 text-center">
            <p className="font-bold">{fn.name || fn.id}</p>
            <p className="text-xs text-aws-text-2">
              {RUNTIME_LABEL[fn.config.runtime]} · {fn.config.memoryMb}MB · {fn.config.timeoutSeconds}초
            </p>
          </div>
          <div className="space-y-1.5 text-sm">
            <p className="font-bold text-aws-text-2">호출하면 (가상)</p>
            <OutcomeStatus outcome={analysis.outcome} />
            {analysis.outcome !== "success" && <p className="text-aws-text-2">{analysis.checks.find((c) => c.status === "fail")?.detail}</p>}
          </div>
        </div>
        <div className="mt-4">
          <KeyValueGrid
            columns={3}
            items={[
              { label: "함수 ARN (가상)", value: <CopyText text={lambdaArn(fn.name || fn.id)} /> },
              { label: "실행 역할", value: role ? <a className="text-aws-link hover:underline" href={href(`/iam/roles/${role.id}`)}>{role.name}</a> : <span className="text-aws-error">없음</span> },
              { label: "VPC", value: topo.lambdaSubnets(fn.id).length ? <ResourceLink id={topo.vpcOf(fn.id)} showName /> : "연결 안 함" },
            ]}
          />
        </div>
      </Container>
      <Tabs
        ariaLabel="함수 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "code", label: "코드", content: <CodeTab key={`${fn.id}-${fn.config.codeTemplate}`} fn={fn} /> },
          { id: "test", label: "테스트", content: <TestTab fn={fn} /> },
          { id: "monitor", label: "모니터링", content: <MonitorTab fn={fn} /> },
          { id: "config", label: "구성", content: <ConfigTab fn={fn} /> },
        ]}
      />
      <FunctionDeleteModal fn={deleting ? fn : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 코드

function CodeTab({ fn }: { fn: Fn }) {
  const topo = useTopology();
  const project = useProject();
  const run = useRunAction();
  const [template, setTemplate] = useState<LambdaCodeTemplate>(fn.config.codeTemplate);
  const [target, setTarget] = useState(fn.config.templateTarget);
  const [duration, setDuration] = useState(String(fn.config.virtualDurationMs));
  const [errorRate, setErrorRate] = useState(String(fn.config.errorRatePercent));
  const [error, setError] = useState<string | null>(null);
  const dirty = template !== fn.config.codeTemplate || target !== fn.config.templateTarget || duration !== String(fn.config.virtualDurationMs) || errorRate !== String(fn.config.errorRatePercent);
  const deploy = () => {
    setError(null);
    if (!/^\d+$/.test(duration) || !/^\d+(\.\d+)?$/.test(errorRate)) return setError("[InvalidParameterValueException] 가상 실행 시간과 오류 비율은 숫자여야 합니다.");
    const r = run("UpdateFunctionCode", (p) => updateFunctionCode(p, fn.id, { codeTemplate: template, templateTarget: target, virtualDurationMs: Number(duration), errorRatePercent: Number(errorRate) }), { success: () => "코드를 배포했습니다 (가상)." });
    if (!r.ok) setError(withHint(r));
  };
  const info = LAMBDA_TEMPLATE_INFO[template];
  const targetLabel = TEMPLATE_TARGET_HELP[template];
  return (
    <SpaceBetween>
      <Container
        header={
          <ContainerHeader
            title="코드 소스 (가상)"
            description="이 시뮬레이터는 코드를 실행하지 않습니다. 템플릿이 하는 일로 결과를 계산하며, 아래 코드는 참고용 예시입니다."
            actions={
              <Button variant="primary" disabled={!dirty} onClick={deploy}>
                Deploy
              </Button>
            }
          />
        }
      >
        <SpaceBetween size="m">
          <FormField help={{ docKey: "lambda", field: "codeTemplate" }} label="코드 템플릿" description={`${info.description} 필요 조건: ${info.needs}`}>
            <SelectInput value={template} onChange={(v) => { setTemplate(v as LambdaCodeTemplate); setTarget(""); }} options={LAMBDA_CODE_TEMPLATES.map((t) => ({ value: t, label: LAMBDA_TEMPLATE_INFO[t].label }))} />
          </FormField>
          {targetLabel && (
            <FormField help={{ docKey: "lambda", field: "templateTarget" }} label={targetLabel}>
              {template === "rds-query" ? (
                <SelectInput value={target} onChange={setTarget} placeholder="DB 인스턴스 선택" options={topo.ofType("rds").map((d) => ({ value: d.id, label: `${d.name} (${d.id})` }))} />
              ) : template === "s3-list" ? (
                <SelectInput value={target} onChange={setTarget} placeholder="버킷 선택" options={project.services.s3.buckets.map((b) => ({ value: b.name, label: b.name }))} />
              ) : template === "secret-get" ? (
                <SelectInput
                  value={target}
                  onChange={setTarget}
                  placeholder={project.services.secretsmanager.secrets.length ? "보안 암호 선택" : "보안 암호가 없습니다 (Secrets Manager에서 만드세요)"}
                  options={project.services.secretsmanager.secrets.map((s) => ({ value: s.name, label: s.deletion ? `${s.name} — 삭제 예약됨` : s.name }))}
                />
              ) : template === "ssm-get" ? (
                <SelectInput
                  value={target}
                  onChange={setTarget}
                  placeholder={project.services.ssm.parameters.length ? "파라미터 선택" : "파라미터가 없습니다 (Parameter Store에서 만드세요)"}
                  options={project.services.ssm.parameters.map((p) => ({ value: p.name, label: `${p.name} (${p.type})` }))}
                />
              ) : (
                <TextInput value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://api.example.com/health" />
              )}
            </FormField>
          )}
          <pre className="overflow-x-auto rounded-xl bg-[#0f141a] p-4 font-mono text-[13px] leading-relaxed text-[#e9ebed]" aria-label="참고용 코드">
            {templateCode(template, fn.config.runtime, target)}
          </pre>
          <ExpandableSection header="가상 실행 값 (실험용)">
            <SpaceBetween size="m">
              <FormField help={{ docKey: "lambda", field: "virtualDurationMs" }} label="가상 실행 시간 (ms)" constraint={`1~900,000ms. 제한 시간 ${fn.config.timeoutSeconds}초(${fn.config.timeoutSeconds * 1000}ms)보다 길면 시간 초과됩니다.`}>
                <TextInput value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" className="max-w-40" />
              </FormField>
              <FormField help={{ docKey: "lambda", field: "errorRatePercent" }} label="가상 오류 비율 (%)" constraint="일정이 호출한 실행 중 이 비율만큼 Errors 지표에 오류로 기록합니다.">
                <TextInput value={errorRate} onChange={(e) => setErrorRate(e.target.value)} inputMode="decimal" className="max-w-32" />
              </FormField>
            </SpaceBetween>
          </ExpandableSection>
          {error && <ErrorAlert message={error} header="배포할 수 없습니다" />}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 테스트

const DEFAULT_EVENT = JSON.stringify({ key1: "value1", key2: "value2" }, null, 2);

function TestTab({ fn }: { fn: Fn }) {
  const project = useProject();
  const topo = useTopology();
  const [event, setEvent] = useState(DEFAULT_EVENT);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const test = () => {
    setError(null);
    try {
      JSON.parse(event);
    } catch (e) {
      setResult(null);
      return setError(`[InvalidRequestContentException] 이벤트 JSON이 올바르지 않습니다: ${(e as Error).message}`);
    }
    // 콘솔에서 테스트하는 사람에게 lambda:InvokeFunction 권한이 있어야 한다 (루트는 항상 허용)
    const identity = actingIdentity(project);
    const principal = actingPrincipal(identity);
    const arn = lambdaArn(fn.name || fn.id);
    if (principal && evaluateIam(project, principal, "lambda:InvokeFunction", arn).decision !== "allowed") {
      setResult(null);
      return setError(`[AccessDeniedException] User: ${actingArn(identity)} is not authorized to perform: lambda:InvokeFunction on resource: ${arn}\n→ 해결 방법: 지금 자격 증명의 정책에 이 함수의 lambda:InvokeFunction 권한을 추가하세요.`);
    }
    setResult(invokeLambda(project, topo, fn, event));
  };
  return (
    <SpaceBetween>
      <Container
        header={
          <ContainerHeader
            title="테스트 이벤트"
            description="함수를 동기식으로 한 번 호출했다고 가정하고 결과를 계산합니다. 결과는 저장하지 않으며 지표·비용에도 넣지 않습니다."
            actions={
              <Button variant="primary" onClick={test} data-testid="lambda-test">
                테스트
              </Button>
            }
          />
        }
      >
        <FormField label="이벤트 JSON">
          <TextArea value={event} onChange={(e) => setEvent(e.target.value)} rows={6} className="font-mono text-[13px]" spellCheck={false} />
        </FormField>
      </Container>
      {error && <ErrorAlert message={error} header="함수를 호출할 수 없습니다" />}
      {result && <InvokeResultView result={result} />}
    </SpaceBetween>
  );
}

const CHECK_STATUS: Record<"pass" | "fail" | "warn" | "info", StatusType> = { pass: "success", fail: "error", warn: "warning", info: "info" };

export function InvokeResultView({ result }: { result: InvokeResult }) {
  return (
    <Container
      header={<ContainerHeader title="실행 결과 (가상)" description={result.outcome === "success" ? "함수가 성공적으로 실행되었습니다." : result.errorMessage ?? undefined} />}
    >
      <SpaceBetween size="m">
        <div data-testid="lambda-result">
          <OutcomeStatus outcome={result.outcome} />
        </div>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "요청 ID (가상)", value: <span className="font-mono text-[13px]">{result.requestId}</span> },
            { label: "실행 시간", value: `${result.durationMs.toFixed(2)} ms` },
            { label: "청구 시간", value: result.outcome === "invalid" || result.outcome === "throttled" ? "0 ms (실행 안 됨)" : `${result.billedMs} ms` },
            { label: "최대 메모리 사용", value: result.outcome === "invalid" || result.outcome === "throttled" ? "–" : `${result.memoryUsedMb} MB` },
          ]}
        />
        {result.response && (
          <div>
            <p className="mb-1 text-sm font-bold text-aws-text-2">응답</p>
            <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">{result.response}</pre>
          </div>
        )}
        <div>
          <p className="mb-1 text-sm font-bold text-aws-text-2">왜 이런 결과인가요?</p>
          <ul className="space-y-1.5 text-sm">
            {result.checks.map((c, i) => (
              <li key={i} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                <StatusIndicator type={CHECK_STATUS[c.status]} className="shrink-0 font-bold">
                  {c.title}
                </StatusIndicator>
                <span className="text-aws-text-2">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-sm font-bold text-aws-text-2">로그 출력 (가상 · 저장하지 않음)</p>
          {result.logs.length ? (
            <pre className="overflow-x-auto rounded-lg bg-[#0f141a] p-3 font-mono text-[12px] leading-relaxed text-[#e9ebed]">{result.logs.join("\n")}</pre>
          ) : (
            <p className="text-sm text-aws-text-2">함수가 실행되지 않아 로그가 없습니다.</p>
          )}
          {!result.canWriteLogs && result.logs.length > 0 && <p className="mt-1 text-[13px] text-aws-warning">실행 역할에 로그 권한이 없어 실제 AWS라면 이 로그가 CloudWatch Logs에 남지 않습니다.</p>}
        </div>
      </SpaceBetween>
    </Container>
  );
}

// ---------------------------------------------------------------- 모니터링

function MonitorTab({ fn }: { fn: Fn }) {
  const project = useProject();
  const now = useNow();
  const [range, setRange] = useState(60);
  const runs = useMemo(() => deliverableSchedules(project, fn), [project, fn]);
  const recent = useMemo(() => {
    const times = runs.flatMap((r) => nextRunTimes(r.parsed, r.schedule.timezone, r.anchor, now - 24 * 3_600_000, 200).filter((t) => t <= now).map((t) => ({ t, schedule: r.schedule })));
    return times.sort((a, b) => b.t - a.t).slice(0, 5);
  }, [runs, now]);
  const refs: MetricRef[] = (["Invocations", "Errors", "Duration", "Throttles"] as const).map((metricName) => ({
    namespace: "AWS/Lambda",
    metricName,
    resourceId: fn.id,
    stat: metricName === "Duration" ? "Average" : "Sum",
  }));
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="지표 (가상)" description="EventBridge 일정이 함수를 호출하는 시각마다 지표가 생깁니다. 콘솔의 테스트 호출은 지표에 넣지 않습니다." actions={<RangePicker value={range} onChange={setRange} />} />}>
        {runs.length ? (
          <MetricCharts refs={refs} range={range} period={periodForRange(range)} now={now} />
        ) : (
          <EmptyState
            title="지표 데이터 없음"
            description="이 함수를 호출하는 활성 일정이 없습니다. Lambda는 호출이 있을 때만 지표를 보냅니다."
            action={<ButtonLink href={href("/eventbridge/schedules/create", { target: fn.id })}>일정 추가</ButtonLink>}
          />
        )}
      </Container>
      <Container header={<ContainerHeader title="최근 일정 호출 (가상, 최근 24시간)" />}>
        {recent.length ? (
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li key={`${r.schedule.id}-${r.t}`}>
                {formatInTimezone(r.t, r.schedule.timezone)} · 일정 <a className="text-aws-link hover:underline" href={href(`/eventbridge/schedules/${r.schedule.id}`)}>{r.schedule.name}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">최근 24시간 안에 일정이 이 함수를 호출한 기록이 없습니다 (가상 계산).</p>
        )}
      </Container>
      <Alert type="info">
        경보를 만들려면 CloudWatch에서 AWS/Lambda 네임스페이스의 Errors(합계) 같은 지표를 고르세요.{" "}
        <a href={href("/cloudwatch/alarms/create", { ns: "AWS/Lambda", resource: fn.id })}>이 함수의 경보 만들기</a>
      </Alert>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 구성

/** 구성 탭 안의 항목 (?section=) */
function useSectionParam(defaultValue: string): [string, (v: string) => void] {
  const { path, query } = useHashLocation();
  const value = query.get("section") ?? defaultValue;
  const set = (next: string) => {
    const q: Record<string, string> = {};
    query.forEach((v, k) => (q[k] = v));
    q.section = next;
    navigate(path, { replace: true, query: q });
  };
  return [value, set];
}

function ConfigTab({ fn }: { fn: Fn }) {
  const project = useProject();
  const topo = useTopology();
  const [section, setSection] = useSectionParam("general");
  const subnets = topo.lambdaSubnets(fn.id);
  const sgs = topo.securityGroupsOf(fn.id);
  const t = triggersOf(project, fn.id);
  const SECTIONS = [
    { id: "general", label: "일반 구성" },
    { id: "permissions", label: "권한" },
    { id: "triggers", label: `트리거 (${t.schedules.length + t.rules.length})` },
    { id: "env", label: `환경 변수 (${fn.config.environment.length})` },
    { id: "vpc", label: "VPC" },
    { id: "concurrency", label: "동시성" },
  ];
  const active = SECTIONS.some((s) => s.id === section) ? section : "general";
  return (
    <div className="grid gap-4 @2xl/main:grid-cols-[200px_1fr]">
      <nav aria-label="구성 항목" className="flex flex-wrap gap-1 md:flex-col">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            aria-current={active === s.id ? "true" : undefined}
            className={`rounded-lg px-3 py-1.5 text-left text-sm ${active === s.id ? "bg-aws-selected font-bold text-aws-link" : "text-aws-text hover:bg-aws-bg"}`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {active === "general" && <GeneralConfig key={fn.id} fn={fn} />}
        {active === "permissions" && <PermissionsConfig fn={fn} />}
        {active === "triggers" && <TriggersConfig fn={fn} />}
        {active === "env" && <EnvironmentConfig key={fn.id} fn={fn} />}
        {active === "vpc" && (
          <Container header={<ContainerHeader title="VPC" info={<InfoLink topic="lambda-vpc" />} actions={<ButtonLink href={href(`${resourcePath("lambda", fn.id)}/edit-vpc`)}>편집</ButtonLink>} />}>
            {subnets.length ? (
              <KeyValueGrid
                columns={3}
                items={[
                  { label: "VPC", value: <ResourceLink id={topo.vpcOf(fn.id)} showName /> },
                  { label: "서브넷", value: subnets.map((s) => <div key={s.id}><ResourceLink id={s.id} showName /> <span className="text-aws-text-2">{s.config.availabilityZone}</span></div>) },
                  { label: "보안 그룹", value: sgs.map((g) => <div key={g.id}><ResourceLink id={g.id} /> ({g.name})</div>) },
                ]}
              />
            ) : (
              <p className="text-sm text-aws-text-2">VPC에 연결하지 않았습니다. 함수는 AWS가 관리하는 네트워크에서 실행되어 인터넷과 AWS 퍼블릭 API에는 닿지만, VPC 안의 프라이빗 리소스에는 닿지 않습니다.</p>
            )}
          </Container>
        )}
        {active === "concurrency" && <ConcurrencyConfig key={fn.id} fn={fn} />}
      </div>
    </div>
  );
}

function GeneralConfig({ fn }: { fn: Fn }) {
  const run = useRunAction();
  const [memory, setMemory] = useState(String(fn.config.memoryMb));
  const [timeout, setTimeoutValue] = useState(String(fn.config.timeoutSeconds));
  const [runtime, setRuntime] = useState(fn.config.runtime);
  const [handler, setHandler] = useState(fn.config.handler);
  const [architecture, setArchitecture] = useState(fn.config.architecture);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setError(null);
    if (!/^\d+$/.test(memory) || !/^\d+$/.test(timeout)) return setError("[InvalidParameterValueException] 메모리와 제한 시간은 정수여야 합니다.");
    const r = run("UpdateFunctionConfiguration", (p) => updateFunctionConfiguration(p, fn.id, { memoryMb: Number(memory), timeoutSeconds: Number(timeout), runtime, handler, architecture }), { success: () => "일반 구성을 저장했습니다." });
    if (!r.ok) setError(withHint(r));
  };
  return (
    <Container header={<ContainerHeader title="일반 구성" actions={<Button variant="primary" onClick={save}>저장</Button>} />}>
      <SpaceBetween size="m">
        <FormField help={{ docKey: "lambda", field: "memoryMb" }} label="메모리 (MB)" constraint="128~10,240MB. CPU도 메모리에 비례해 배정됩니다.">
          <TextInput value={memory} onChange={(e) => setMemory(e.target.value)} inputMode="numeric" className="max-w-40" />
        </FormField>
        <FormField help={{ docKey: "lambda", field: "timeoutSeconds" }} label="제한 시간 (초)" constraint="1~900초 (최대 15분)">
          <TextInput value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} inputMode="numeric" className="max-w-32" />
        </FormField>
        <FormField help={{ docKey: "lambda", field: "runtime" }} label="런타임">
          <SelectInput value={runtime} onChange={(v) => setRuntime(v as LambdaConfig["runtime"])} options={LAMBDA_RUNTIMES.map((r) => ({ value: r, label: RUNTIME_LABEL[r] }))} />
        </FormField>
        <FormField help={{ docKey: "lambda", field: "handler" }} label="핸들러">
          <TextInput value={handler} onChange={(e) => setHandler(e.target.value)} className="max-w-md font-mono" />
        </FormField>
        <FormField help={{ docKey: "lambda", field: "architecture" }} label="아키텍처">
          <SelectInput value={architecture} onChange={(v) => setArchitecture(v as LambdaConfig["architecture"])} options={LAMBDA_ARCHITECTURES.map((a) => ({ value: a, label: a }))} />
        </FormField>
        {error && <ErrorAlert message={error} header="저장할 수 없습니다" />}
      </SpaceBetween>
    </Container>
  );
}

function PermissionsConfig({ fn }: { fn: Fn }) {
  const project = useProject();
  const run = useRunAction();
  const role = project.services.iam.roles.find((r) => r.id === fn.config.roleId);
  const lambdaRoles = project.services.iam.roles.filter((r) => r.trustedEntity === "lambda.amazonaws.com");
  const [roleId, setRoleId] = useState(fn.config.roleId ?? "");
  const [error, setError] = useState<string | null>(null);
  const changeRole = () => {
    setError(null);
    const r = run("UpdateFunctionConfiguration", (p) => updateFunctionConfiguration(p, fn.id, { roleId: roleId || null }), { success: () => "실행 역할을 바꿨습니다." });
    if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="실행 역할" info={<InfoLink topic="lambda-role" />} />}>
        <SpaceBetween size="m">
          <KeyValueGrid
            columns={2}
            items={[
              { label: "역할 이름", value: role ? <a className="text-aws-link hover:underline" href={href(`/iam/roles/${role.id}`)}>{role.name}</a> : <span className="text-aws-error">없음 (함수를 실행할 수 없음)</span> },
              { label: "권한 정책", value: role ? `${role.policyIds.length}개` : "–" },
            ]}
          />
          <FormField help={{ docKey: "lambda", field: "roleId" }} label="역할 바꾸기">
            <div className="flex flex-wrap gap-2">
              <SelectInput className="min-w-64 flex-1" value={roleId} onChange={setRoleId} placeholder="역할 선택" options={lambdaRoles.map((r) => ({ value: r.id, label: r.name }))} />
              <Button onClick={changeRole} disabled={roleId === (fn.config.roleId ?? "")}>
                저장
              </Button>
            </div>
          </FormField>
          {error && <ErrorAlert message={error} header="역할을 바꿀 수 없습니다" />}
        </SpaceBetween>
      </Container>
      <Container
        header={<ContainerHeader title="리소스 기반 정책 (호출 권한)" info={<InfoLink topic="lambda-permissions" />} actions={<ButtonLink href={href(`${resourcePath("lambda", fn.id)}/add-permission`)}>권한 추가</ButtonLink>} />}
      >
        {fn.config.permissions.length ? (
          <ul className="divide-y divide-aws-divider text-sm">
            {fn.config.permissions.map((p) => (
              <li key={p.sid} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-mono font-bold">{p.sid}</span> · {p.principal} · <span className="break-all text-aws-text-2">{p.sourceArn || "모든 소스 (주의)"}</span>
                </span>
                <Button onClick={() => run("RemovePermission", (pr) => removeFunctionPermission(pr, fn.id, p.sid), { success: () => `문 ${p.sid}을(를) 삭제했습니다.`, flashError: true })}>삭제</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">없습니다. EventBridge 규칙의 대상으로 이 함수를 추가하면 콘솔이 자동으로 넣습니다.</p>
        )}
      </Container>
    </SpaceBetween>
  );
}

function TriggersConfig({ fn }: { fn: Fn }) {
  const project = useProject();
  const t = triggersOf(project, fn.id);
  return (
    <Container
      header={
        <ContainerHeader
          title="트리거"
          info={<InfoLink topic="eventbridge-scheduler" />}
          actions={
            <>
              <ButtonLink href={href("/eventbridge/rules/create", { target: fn.id })}>규칙 추가</ButtonLink>
              <ButtonLink variant="primary" href={href("/eventbridge/schedules/create", { target: fn.id })}>일정 추가</ButtonLink>
            </>
          }
        />
      }
    >
      {t.schedules.length || t.rules.length ? (
        <ul className="divide-y divide-aws-divider text-sm">
          {t.schedules.map((s) => {
            const can = scheduleCanInvoke(project, s, fn);
            return (
              <li key={s.id} className="space-y-0.5 py-2">
                <a className="font-bold text-aws-link hover:underline" href={href(`/eventbridge/schedules/${s.id}`)}>일정 {s.name}</a> <span className="font-mono text-[13px]">{s.expression}</span>{" "}
                {s.state === "DISABLED" ? <Badge>비활성</Badge> : can.ok ? <Badge color="green">호출 가능</Badge> : <Badge color="red">호출 실패</Badge>}
                <p className="text-aws-text-2">{can.reason}</p>
              </li>
            );
          })}
          {t.rules.map((r) => {
            const can = ruleCanInvoke(r, fn);
            return (
              <li key={r.id} className="space-y-0.5 py-2">
                <a className="font-bold text-aws-link hover:underline" href={href(`/eventbridge/rules/${r.id}`)}>규칙 {r.name}</a>{" "}
                {r.state === "DISABLED" ? <Badge>비활성</Badge> : can.ok ? <Badge color="green">호출 가능</Badge> : <Badge color="red">호출 실패</Badge>}
                <p className="text-aws-text-2">{can.reason}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-aws-text-2">이 함수를 호출하는 일정·규칙이 없습니다.</p>
      )}
    </Container>
  );
}

function EnvironmentConfig({ fn }: { fn: Fn }) {
  const run = useRunAction();
  const [rows, setRows] = useState(fn.config.environment.map((e) => ({ ...e })));
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setError(null);
    const r = run("UpdateFunctionConfiguration", (p) => updateFunctionConfiguration(p, fn.id, { environment: rows.filter((x) => x.key.trim() || x.value) }), { success: () => "환경 변수를 저장했습니다." });
    if (!r.ok) setError(withHint(r));
  };
  return (
    <Container header={<ContainerHeader title="환경 변수" description="비밀 값(암호·토큰·키)은 넣지 마세요. 이 시뮬레이터는 비밀 값을 저장하지 않습니다." actions={<Button variant="primary" onClick={save}>저장</Button>} />}>
      <SpaceBetween size="s">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <TextInput aria-label={`키 ${i + 1}`} value={row.key} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="키 (예: STAGE)" className="max-w-56 font-mono" />
            <TextInput aria-label={`값 ${i + 1}`} value={row.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="값 (예: dev)" className="max-w-md flex-1 font-mono" />
            <Button onClick={() => setRows(rows.filter((_, j) => j !== i))}>제거</Button>
          </div>
        ))}
        <div>
          <Button onClick={() => setRows([...rows, { key: "", value: "" }])} disabled={rows.length >= 50}>
            환경 변수 추가
          </Button>
        </div>
        {error && <ErrorAlert message={error} header="저장할 수 없습니다" />}
      </SpaceBetween>
    </Container>
  );
}

function ConcurrencyConfig({ fn }: { fn: Fn }) {
  const run = useRunAction();
  const [mode, setMode] = useState<"unreserved" | "reserved">(fn.config.reservedConcurrency === null ? "unreserved" : "reserved");
  const [value, setValue] = useState(String(fn.config.reservedConcurrency ?? 10));
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setError(null);
    if (mode === "reserved" && !/^\d+$/.test(value)) return setError("[InvalidParameterValueException] 예약 동시성은 0 이상의 정수여야 합니다.");
    const r = run(mode === "reserved" ? "PutFunctionConcurrency" : "DeleteFunctionConcurrency", (p) => setReservedConcurrency(p, fn.id, mode === "reserved" ? Number(value) : null), { success: () => "동시성 설정을 저장했습니다." });
    if (!r.ok) setError(withHint(r));
  };
  return (
    <Container header={<ContainerHeader title="동시성" actions={<Button variant="primary" onClick={save}>저장</Button>} />}>
      <SpaceBetween size="m">
        <RadioGroup
          aria-label="동시성"
          value={mode}
          onChange={(v) => setMode(v as typeof mode)}
          items={[
            { value: "unreserved", label: "예약되지 않은 계정 동시성 사용", description: "계정의 공용 동시성 풀을 다른 함수와 함께 씁니다 (기본값)." },
            { value: "reserved", label: "동시성 예약", description: "이 함수만 쓸 동시 실행 수를 떼어 둡니다. 0이면 모든 호출이 제한됩니다." },
          ]}
        />
        {mode === "reserved" && (
          <FormField help={{ docKey: "lambda", field: "reservedConcurrency" }} label="예약된 동시성" constraint="0~1000">
            <TextInput value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" className="max-w-32" />
          </FormField>
        )}
        {error && <ErrorAlert message={error} header="저장할 수 없습니다" />}
      </SpaceBetween>
    </Container>
  );
}

// ================================================================ 하위 작업 화면

export function EditFunctionVpcPage({ id }: { id: string }) {
  const fn = useResource(id, "lambda");
  const topo = useTopology();
  const run = useRunAction();
  const [subnetIds, setSubnetIds] = useState<string[]>(() => (fn ? topo.lambdaSubnets(fn.id).map((s) => s.id) : []));
  const [sgIds, setSgIds] = useState<string[]>(() => (fn ? topo.securityGroupsOf(fn.id).map((g) => g.id) : []));
  const [error, setError] = useState<string | null>(null);
  if (!fn) return <ResourceNotFound type="lambda" id={id} />;
  const save = () => {
    setError(null);
    const r = run("UpdateFunctionConfiguration", (p) => setFunctionVpc(p, fn.id, { subnetIds, securityGroupIds: sgIds }), { success: () => "VPC 설정을 저장했습니다." });
    if (r.ok) navigate(resourcePath("lambda", fn.id), { query: { tab: "config", section: "vpc" } });
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`VPC 편집: ${fn.name || fn.id}`} info={<InfoLink topic="lambda-vpc" />} description="VPC를 비우면 VPC 연결을 해제합니다. VPC에 연결하려면 실행 역할에 네트워크 인터페이스 관리 권한이 있어야 합니다." />
      <Container>
        <VpcFields subnetIds={subnetIds} setSubnetIds={setSubnetIds} sgIds={sgIds} setSgIds={setSgIds} />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("lambda", fn.id), { tab: "config", section: "vpc" })}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function AddFunctionPermissionPage({ id }: { id: string }) {
  const fn = useResource(id, "lambda");
  const project = useProject();
  const run = useRunAction();
  const [sid, setSid] = useState("allow-events");
  const [principal, setPrincipal] = useState<(typeof LAMBDA_PERMISSION_PRINCIPALS)[number]>("events.amazonaws.com");
  const [sourceArn, setSourceArn] = useState("");
  const [restrict, setRestrict] = useState(true);
  const [error, setError] = useState<string | null>(null);
  if (!fn) return <ResourceNotFound type="lambda" id={id} />;
  const ruleArns = project.services.eventbridge.rules.map((r) => ruleArn(r.name));
  const save = () => {
    setError(null);
    const r = run("AddPermission", (p) => addFunctionPermission(p, fn.id, { sid, principal, sourceArn: restrict ? sourceArn : "" }), { success: () => `문 ${sid.trim()}을(를) 추가했습니다.` });
    if (r.ok) navigate(resourcePath("lambda", fn.id), { query: { tab: "config", section: "permissions" } });
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`권한 추가: ${fn.name || fn.id}`} info={<InfoLink topic="lambda-permissions" />} description="lambda:AddPermission — 다른 서비스가 이 함수를 호출하도록 리소스 기반 정책에 문을 추가합니다." />
      <Container>
        <SpaceBetween size="m">
          <FormField label="문 ID (Statement ID)" constraint="1~100자의 영문·숫자·하이픈·밑줄">
            <TextInput value={sid} onChange={(e) => setSid(e.target.value)} className="max-w-md font-mono" />
          </FormField>
          <FormField help={{ docKey: "lambda", field: "permissions" }} label="주체 (Principal)">
            <SelectInput value={principal} onChange={(v) => setPrincipal(v as typeof principal)} options={LAMBDA_PERMISSION_PRINCIPALS.map((p) => ({ value: p, label: p, description: p === "events.amazonaws.com" ? "EventBridge 규칙" : "S3 이벤트 알림 (이 시뮬레이터는 S3 트리거를 실행하지 않음)" }))} />
          </FormField>
          <Checkbox checked={restrict} onChange={setRestrict} description="끄면 그 서비스의 모든 리소스(다른 계정 포함 가능)가 이 함수를 호출할 수 있습니다.">
            소스 ARN으로 호출할 수 있는 리소스 제한 (권장)
          </Checkbox>
          {restrict && (
            <FormField label="소스 ARN" constraint={ruleArns.length ? `예: ${ruleArns[0]}` : "예: arn:aws:events:ap-northeast-2:123456789012:rule/my-rule"}>
              <TextInput value={sourceArn} onChange={(e) => setSourceArn(e.target.value)} className="font-mono" placeholder="arn:aws:events:..." list="lambda-rule-arns" />
              <datalist id="lambda-rule-arns">
                {ruleArns.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </FormField>
          )}
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="권한을 추가할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("lambda", fn.id), { tab: "config", section: "permissions" })}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
