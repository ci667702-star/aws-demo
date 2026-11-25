"use client";

/**
 * Systems Manager 콘솔 (가상): Parameter Store(생성·편집·기록·경로 조회·접근 테스트), 관리형 노드, Session Manager.
 * SecureString 값은 입력받지 않는다. 관리형 노드 판정과 세션 명령의 출력은 샌드박스 설정으로 계산한 결과이며, 실제 에이전트·셸은 없다.
 */
import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { createId } from "@/lib/engine/ids";
import { analyzeInvocation } from "@/lib/engine/lambda-engine";
import { SSM_PARAMETER_TYPES, type ResourceOfType, type SsmParameter } from "@/lib/engine/resource-models";
import { evaluateParameterAccess } from "@/lib/engine/service-access";
import {
  childPaths,
  managedNodeStatus,
  PARAMETER_VALUE_LIMIT,
  parameterArn,
  parametersByPath,
  runPortCheck,
  runSessionCommand,
  sessionCommands,
  startSessionPermission,
  validateParameterName,
  validateParameterValue,
  virtualParameterValue,
  type ManagedNodeStatus,
  type NodeCheck,
  type SessionOutput,
} from "@/lib/engine/ssm-engine";
import { displayName } from "@/lib/engine/topology-engine";
import { deleteParameter, putParameter } from "@/lib/project/ssm-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, RadioGroup, SelectInput, TextArea, TextInput, Tiles, Toggle } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { AccessSteps, AccessTestPanel } from "../access-test";
import { InstanceState, useQueryTab, useSelection, useTopology } from "../common";
import { OutcomeStatus } from "../lambda/lambda-functions";

type Ec2 = ResourceOfType<"ec2">;

const TYPE_INFO: Record<SsmParameter["type"], { label: string; description: string }> = {
  String: { label: "String", description: "일반 텍스트 값 (예: DB 호스트 이름, 기능 켜기/끄기)" },
  StringList: { label: "StringList", description: "쉼표로 구분한 값 목록 (예: subnet-a,subnet-b)" },
  SecureString: { label: "SecureString", description: "KMS 키로 암호화해 저장하는 비밀 값 (이 시뮬레이터는 값을 입력받지 않음)" },
};

const TIER_LABEL: Record<SsmParameter["tier"], string> = { Standard: "표준 (Standard)", Advanced: "고급 (Advanced)" };

// ================================================================ 개요

export function SsmOverviewPage() {
  const project = useProject();
  const { instances, statuses } = useNodeStatuses();
  const managed = instances.filter((i) => statuses.get(i.id)?.managed).length;
  return (
    <SpaceBetween>
      <PageHeader
        title="AWS Systems Manager (가상)"
        info={<InfoLink topic="ssm" />}
        description="설정 값을 한곳에 보관하고(Parameter Store), SSH 키나 열린 포트 없이 서버에 접속합니다(Session Manager). 실제 AWS에 요청하지 않습니다."
      />
      <PageGuide topic="ssm" />
      <div className="grid gap-4 @2xl/main:grid-cols-3">
        <Container header={<ContainerHeader title={`Parameter Store (${project.services.ssm.parameters.length})`} info={<InfoLink topic="parameter-store" />} />}>
          <p className="mb-3 text-sm text-aws-text-2">DB 주소·기능 플래그 같은 설정 값을 /my-app/prod/… 같은 계층 이름으로 보관합니다.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={href("/ssm/parameters")}>파라미터 보기</ButtonLink>
            <ButtonLink variant="primary" href={href("/ssm/parameters/create")}>
              파라미터 생성
            </ButtonLink>
          </div>
        </Container>
        <Container header={<ContainerHeader title={`관리형 노드 (${managed}/${instances.length})`} info={<InfoLink topic="managed-node" />} />}>
          <p className="mb-3 text-sm text-aws-text-2">SSM Agent가 Systems Manager에 연결된 EC2 인스턴스입니다. IAM 역할과 밖으로 나가는 HTTPS 경로가 필요합니다.</p>
          <ButtonLink href={href("/ssm/nodes")}>노드 보기</ButtonLink>
        </Container>
        <Container header={<ContainerHeader title="Session Manager" info={<InfoLink topic="session-manager" />} />}>
          <p className="mb-3 text-sm text-aws-text-2">인바운드 포트(22)나 배스천 호스트 없이 브라우저에서 서버 셸을 엽니다 (가상 명령).</p>
          <ButtonLink href={href("/ssm/sessions")}>세션 시작</ButtonLink>
        </Container>
      </div>
    </SpaceBetween>
  );
}

// ================================================================ Parameter Store

function ParameterNotFound() {
  return (
    <Container>
      <EmptyState title="파라미터를 찾을 수 없습니다" description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/ssm/parameters")}>파라미터 목록</ButtonLink>} />
    </Container>
  );
}

export function ParameterListPage() {
  const project = useProject();
  const params = project.services.ssm.parameters;
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = params.find((p) => p.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="parameter-store" />
      <ResourceTable<SsmParameter>
        ariaLabel="파라미터 목록"
        items={params}
        trackBy={(p) => p.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(p) => p.name}
        filterPlaceholder="파라미터 찾기"
        defaultSort={{ columnId: "name" }}
        header={
          <PageHeader
            title="내 파라미터"
            counter={`(${params.length})`}
            info={<InfoLink topic="parameter-store" />}
            description="애플리케이션 설정 값을 코드 밖에 보관합니다 (가상)."
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "edit", text: "편집", disabled: !current },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "edit") navigate(`/ssm/parameters/${current.id}/edit`);
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/ssm/parameters/create")}>
                  파라미터 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="파라미터 없음" description="설정 값을 파라미터로 만들면 여러 서버·함수가 같은 값을 이름으로 읽을 수 있습니다." action={<ButtonLink href={href("/ssm/parameters/create")}>파라미터 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (p) => <a className="font-mono font-bold break-all text-aws-link hover:underline" href={href(`/ssm/parameters/${p.id}`)}>{p.name}</a>, sortValue: (p) => p.name },
          { id: "type", header: "유형", cell: (p) => p.type, sortValue: (p) => p.type },
          { id: "tier", header: "계층", cell: (p) => TIER_LABEL[p.tier] },
          { id: "version", header: "버전", cell: (p) => p.version, sortValue: (p) => p.version },
          { id: "updated", header: "마지막 수정 날짜", cell: (p) => formatDateTime(p.updatedAt), sortValue: (p) => p.updatedAt },
          { id: "desc", optional: true, header: "설명", cell: (p) => <span className="text-aws-text-2">{p.description || "–"}</span> },
        ]}
      />
      <PathLookup params={params} />
      {deleting && current && <DeleteParameterModal param={current} onClose={() => setDeleting(false)} onDeleted={() => setSelected([])} />}
    </SpaceBetween>
  );
}

/** GetParametersByPath: 계층 이름으로 여러 설정을 한 번에 읽는 방법 */
function PathLookup({ params }: { params: SsmParameter[] }) {
  const [path, setPath] = useState(() => childPaths(params, "/")[0] ?? "/");
  const [recursive, setRecursive] = useState(false);
  const clean = path.trim() || "/";
  const valid = clean.startsWith("/");
  const found = valid ? parametersByPath(params, clean, recursive) : [];
  const folders = valid && !recursive ? childPaths(params, clean) : [];
  const parent = clean === "/" ? null : clean.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
  return (
    <Container
      header={
        <ContainerHeader
          title="경로로 조회 (GetParametersByPath)"
          info={<InfoLink topic="parameter-store" />}
          description="이름을 /my-app/prod/… 처럼 계층으로 지으면, 애플리케이션이 한 경로 아래 설정을 한 번에 읽을 수 있습니다. 요청은 보내지 않고 목록에서 계산합니다."
        />
      }
    >
      <SpaceBetween size="m">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="경로" className="min-w-64 flex-1" constraint="/로 시작합니다." error={valid ? undefined : "경로는 /로 시작해야 합니다."}>
            <TextInput value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" aria-label="조회할 경로" />
          </FormField>
          <div className="mb-7">
            <Checkbox checked={recursive} onChange={setRecursive}>
              하위 경로까지 모두 (--recursive)
            </Checkbox>
          </div>
        </div>
        {(folders.length > 0 || parent) && (
          <div className="flex flex-wrap gap-2" aria-label="하위 경로">
            {parent && (
              <Button variant="link" onClick={() => setPath(parent)}>
                ↑ {parent}
              </Button>
            )}
            {folders.map((f) => (
              <Button key={f} iconLeft={<FolderOpen aria-hidden />} onClick={() => setPath(f)}>
                {f}
              </Button>
            ))}
          </div>
        )}
        <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">
          aws ssm get-parameters-by-path --path {clean}
          {recursive ? " --recursive" : ""}
        </pre>
        {found.length ? (
          <ul className="divide-y divide-aws-divider text-sm" data-testid="path-lookup-result">
            {found.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <a className="font-mono break-all text-aws-link hover:underline" href={href(`/ssm/parameters/${p.id}`)}>
                  {p.name}
                </a>
                <Badge>{p.type}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">
            {valid ? `${clean} 바로 아래에 파라미터가 없습니다.${folders.length ? " 하위 경로를 누르거나 '하위 경로까지 모두'를 켜 보세요." : ""}` : "경로를 고치세요."}
          </p>
        )}
        <p className="text-[13px] text-aws-text-2">이 시뮬레이터는 이름이 /로 시작하는 파라미터만 경로 조회에 포함합니다.</p>
      </SpaceBetween>
    </Container>
  );
}

interface ParamDraft {
  name: string;
  description: string;
  tier: SsmParameter["tier"];
  type: SsmParameter["type"];
  value: string;
}

function ParameterForm({ draft, set, existing }: { draft: ParamDraft; set: (p: Partial<ParamDraft>) => void; existing?: SsmParameter }) {
  const nameError = !existing && draft.name.trim() ? validateParameterName(draft.name.trim()) : null;
  const valueError = draft.type !== "SecureString" && draft.value ? validateParameterValue(draft.type, draft.tier, draft.value) : null;
  return (
    <Container header={<ContainerHeader title="파라미터 세부 정보" />}>
      <SpaceBetween size="m">
        <FormField
          help={{ docKey: "ssm", field: "parameterName" }}
          label="이름"
          constraint={existing ? "만든 뒤에는 이름을 바꿀 수 없습니다." : "계층은 /로 구분합니다. 예: /my-app/prod/db-host (aws·ssm으로 시작할 수 없음)"}
          error={nameError ?? undefined}
        >
          <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!!existing} maxLength={1011} className="font-mono" />
        </FormField>
        <FormField label="설명" optional>
          <TextInput value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={1024} />
        </FormField>
        <FormField help={{ docKey: "ssm", field: "parameterTier" }} label="계층">
          <Tiles
            aria-label="계층"
            columns={2}
            value={draft.tier}
            onChange={(v) => set({ tier: v as SsmParameter["tier"] })}
            items={[
              { value: "Standard", label: TIER_LABEL.Standard, description: "값 4KB까지, 추가 요금 없음. 대부분 이것으로 충분합니다.", disabled: existing?.tier === "Advanced" },
              { value: "Advanced", label: TIER_LABEL.Advanced, description: "값 8KB까지, 파라미터마다 월 요금. 고급에서 표준으로는 되돌릴 수 없습니다." },
            ]}
          />
        </FormField>
        <FormField help={{ docKey: "ssm", field: "parameterType" }} label="유형" constraint={existing ? "이 시뮬레이터에서는 만든 뒤 유형을 바꿀 수 없습니다." : undefined}>
          <RadioGroup
            aria-label="유형"
            value={draft.type}
            onChange={(v) => set({ type: v as SsmParameter["type"] })}
            items={SSM_PARAMETER_TYPES.map((t) => ({ value: t, label: TYPE_INFO[t].label, description: TYPE_INFO[t].description, disabled: !!existing && existing.type !== t }))}
          />
        </FormField>
        {draft.type === "SecureString" ? (
          <>
            <FormField label="KMS 키 소스" constraint="고객 관리형 키는 이 시뮬레이터가 지원하지 않습니다.">
              <SelectInput value="alias/aws/ssm" onChange={() => undefined} disabled options={[{ value: "alias/aws/ssm", label: "내 현재 계정 — alias/aws/ssm (AWS 관리형 키)" }]} />
            </FormField>
            <FormField help={{ docKey: "ssm", field: "parameterValue" }} label="값">
              <Alert type="info">SecureString 값은 입력받지 않습니다. 저장하면 연습용 가상 값(PGSIM-…)이 {existing ? "새 버전으로 " : ""}만들어집니다. 실제 비밀 값이 아닙니다.</Alert>
            </FormField>
          </>
        ) : (
          <FormField
            help={{ docKey: "ssm", field: "parameterValue" }}
            label="값"
            constraint={`최대 ${PARAMETER_VALUE_LIMIT[draft.tier].toLocaleString("ko-KR")}자.${draft.type === "StringList" ? " 쉼표로 구분합니다 (예: subnet-a,subnet-b)." : ""} 암호·토큰은 넣지 말고 SecureString을 쓰세요.`}
            error={valueError ?? undefined}
          >
            <TextArea value={draft.value} onChange={(e) => set({ value: e.target.value })} rows={3} />
          </FormField>
        )}
      </SpaceBetween>
    </Container>
  );
}

export function CreateParameterPage() {
  const run = useRunAction();
  const [draft, setDraft] = useState<ParamDraft>({ name: "/my-app/prod/db-host", description: "", tier: "Standard", type: "String", value: "db.internal.example" });
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<ParamDraft>) => setDraft((d) => ({ ...d, ...p }));
  const submit = () => {
    setError(null);
    const r = run("PutParameter", (p) => putParameter(p, { ...draft, overwrite: false }), { success: () => `파라미터 ${draft.name.trim()}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/ssm/parameters/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="파라미터 생성" info={<InfoLink topic="parameter-store" />} description="Parameter Store에 설정 값을 만듭니다 (가상)." />
      <ParameterForm draft={draft} set={set} />
      <FormActions error={error ? <ErrorAlert message={error} header="파라미터를 만들 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/ssm/parameters")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          파라미터 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditParameterPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const param = project.services.ssm.parameters.find((p) => p.id === id);
  const [draft, setDraft] = useState<ParamDraft | null>(() => (param ? { name: param.name, description: param.description, tier: param.tier, type: param.type, value: param.value ?? "" } : null));
  const [error, setError] = useState<string | null>(null);
  if (!param || !draft) return <ParameterNotFound />;
  const set = (p: Partial<ParamDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const save = () => {
    setError(null);
    const r = run("PutParameter", (p) => putParameter(p, { ...draft, name: param.name, overwrite: true }), { success: () => `파라미터 ${param.name}을(를) 저장했습니다.` });
    if (r.ok) navigate(`/ssm/parameters/${param.id}`);
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`파라미터 편집: ${param.name}`} info={<InfoLink topic="parameter-store" />} description="저장하면 새 버전이 만들어지고, 이전 값은 기록에 남습니다." />
      <ParameterForm draft={draft} set={set} existing={param} />
      <FormActions error={error ? <ErrorAlert message={error} header="파라미터를 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(`/ssm/parameters/${param.id}`)}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function ParameterDetailPage({ id }: { id: string }) {
  const project = useProject();
  const [tab, setTab] = useQueryTab("overview");
  const [deleting, setDeleting] = useState(false);
  const param = project.services.ssm.parameters.find((p) => p.id === id);
  if (!param) return <ParameterNotFound />;
  return (
    <SpaceBetween>
      <PageHeader
        title={<span className="font-mono">{param.name}</span>}
        info={<InfoLink topic="parameter-store" />}
        description={param.description || undefined}
        actions={
          <>
            <ButtonLink href={href(`/ssm/parameters/${param.id}/edit`)}>편집</ButtonLink>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
          </>
        }
      />
      <Tabs
        ariaLabel="파라미터 세부 정보"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "개요", content: <ParameterOverview param={param} /> },
          { id: "history", label: "기록", content: <ParameterHistory param={param} /> },
          { id: "access", label: "접근 테스트", content: <ParameterAccess param={param} /> },
        ]}
      />
      {deleting && <DeleteParameterModal param={param} onClose={() => setDeleting(false)} onDeleted={() => navigate("/ssm/parameters")} />}
    </SpaceBetween>
  );
}

function ParameterOverview({ param }: { param: SsmParameter }) {
  const [decrypted, setDecrypted] = useState(false);
  const secure = param.type === "SecureString";
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="파라미터 세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "이름", value: <span className="font-mono">{param.name}</span> },
            { label: "유형", value: param.type },
            { label: "계층", value: TIER_LABEL[param.tier] },
            { label: "버전", value: param.version },
            { label: "마지막 수정 날짜", value: formatDateTime(param.updatedAt) },
            { label: "데이터 형식", value: "text" },
            ...(secure ? [{ label: "KMS 키", value: "alias/aws/ssm" }] : []),
            { label: "ARN (가상)", value: <CopyText text={parameterArn(param.name)} /> },
            { label: "설명", value: param.description || "–" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="값" info={<InfoLink topic="parameter-store" />} />}>
        {secure ? (
          <SpaceBetween size="s">
            <Toggle checked={decrypted} onChange={setDecrypted} description="화면을 연 사람의 권한과 관계없이 연습용 값을 보여 줍니다. 애플리케이션이 읽을 수 있는지는 '접근 테스트' 탭에서 확인하세요.">
              복호화된 값 표시
            </Toggle>
            <div className="flex flex-wrap items-center gap-2" data-testid="parameter-value">
              <span className="font-mono text-[15px] break-all">{decrypted ? virtualParameterValue(param, param.version) : "••••••••••••"}</span>
              {decrypted && <Badge color="orange">연습용 가상 값</Badge>}
            </div>
          </SpaceBetween>
        ) : (
          <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px] whitespace-pre-wrap break-all" data-testid="parameter-value">
            {param.value}
          </pre>
        )}
      </Container>
    </SpaceBetween>
  );
}

function ParameterHistory({ param }: { param: SsmParameter }) {
  const [decrypted, setDecrypted] = useState(false);
  const secure = param.type === "SecureString";
  const rows = [{ version: param.version, value: param.value, modifiedAt: param.updatedAt }, ...param.history];
  const shown = (r: (typeof rows)[number]) => (secure ? (decrypted ? virtualParameterValue(param, r.version) : "••••••••••••") : (r.value ?? ""));
  return (
    <SpaceBetween>
      {secure && (
        <Toggle checked={decrypted} onChange={setDecrypted}>
          복호화된 값 표시
        </Toggle>
      )}
      <ResourceTable
        ariaLabel="파라미터 기록"
        items={rows}
        trackBy={(r) => String(r.version)}
        filtering={false}
        header={<ContainerHeader title="기록" counter={`(${rows.length})`} description="값을 바꿀 때마다 버전이 1씩 올라갑니다. 애플리케이션은 이름:버전(예: /my-app/db:2)으로 이전 값을 읽을 수도 있습니다." />}
        columns={[
          { id: "version", header: "버전", cell: (r) => (r.version === param.version ? <span className="font-bold">{r.version} (현재)</span> : r.version) },
          { id: "value", header: "값", cell: (r) => <span className="font-mono text-[13px] break-all">{shown(r)}</span> },
          { id: "modified", header: "수정 날짜", cell: (r) => formatDateTime(r.modifiedAt) },
        ]}
      />
    </SpaceBetween>
  );
}

function ParameterAccess({ param }: { param: SsmParameter }) {
  const project = useProject();
  const topo = useTopology();
  const [withDecryption, setWithDecryption] = useState(true);
  const readers = topo.ofType("lambda").filter((f) => f.config.codeTemplate === "ssm-get" && f.config.templateTarget.trim() === param.name);
  return (
    <SpaceBetween>
      <AccessTestPanel
        title="GetParameter 접근 테스트"
        description="고른 호출자가 이 파라미터를 읽을 수 있는지 네트워크 → 자격 증명 → IAM 권한 순서로 확인합니다."
        action="ssm:GetParameter"
        testId="parameter-access"
        evaluate={(caller) => evaluateParameterAccess(project, topo, param.id, caller, withDecryption)}
      >
        {param.type === "SecureString" && (
          <div className="mb-8">
            <Checkbox checked={withDecryption} onChange={setWithDecryption}>
              WithDecryption (복호화해서 읽기)
            </Checkbox>
          </div>
        )}
      </AccessTestPanel>
      <Container header={<ContainerHeader title={`이 파라미터를 읽는 Lambda 함수 (${readers.length})`} description="코드 템플릿이 'Parameter Store 파라미터 읽기'이고 대상이 이 파라미터 이름인 함수입니다." />}>
        {readers.length ? (
          <ul className="divide-y divide-aws-divider text-sm">
            {readers.map((f) => {
              const result = analyzeInvocation(project, topo, f);
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
                  <a className="font-bold text-aws-link hover:underline" href={href(`/lambda/functions/${f.id}`)}>
                    {displayName(f)}
                  </a>
                  <OutcomeStatus outcome={result.outcome} />
                  {result.outcome !== "success" && <span className="text-aws-text-2">{result.checks.find((c) => c.status === "fail")?.detail}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">없습니다. Lambda 함수의 코드 탭에서 템플릿을 &apos;Parameter Store 파라미터 읽기&apos;로 바꾸고 이 파라미터를 고르면 여기에 나타납니다.</p>
        )}
      </Container>
    </SpaceBetween>
  );
}

function DeleteParameterModal({ param, onClose, onDeleted }: { param: SsmParameter; onClose: () => void; onDeleted?: () => void }) {
  const run = useRunAction();
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={`파라미터 ${param.name} 삭제`}
      onConfirm={() => {
        const r = run("DeleteParameter", (p) => deleteParameter(p, param.id), { success: () => `파라미터 ${param.name}을(를) 삭제했습니다.` });
        if (!r.ok) return withHint(r);
        onDeleted?.();
        return null;
      }}
    >
      <p>파라미터와 모든 버전 기록을 삭제합니다. 이 파라미터를 읽는 애플리케이션은 ParameterNotFound 오류를 받습니다.</p>
    </DeleteModal>
  );
}

// ================================================================ 관리형 노드

/** 노드 판정 근거 (해결 방법 포함) */
function NodeChecks({ checks }: { checks: NodeCheck[] }) {
  return <AccessSteps steps={checks.map((c) => ({ title: c.title, status: c.status, detail: c.fix ? `${c.detail} 해결: ${c.fix}` : c.detail, link: c.link }))} />;
}

function useNodeStatuses(): { instances: Ec2[]; statuses: Map<string, ManagedNodeStatus> } {
  const project = useProject();
  const topo = useTopology();
  return useMemo(() => {
    const instances = topo.ofType("ec2").filter((e) => e.config.state !== "terminated");
    return { instances, statuses: new Map(instances.map((i) => [i.id, managedNodeStatus(project, topo, i)])) };
  }, [project, topo]);
}

function NodeBadge({ status }: { status: ManagedNodeStatus | undefined }) {
  return status?.managed ? <StatusIndicator type="success">온라인 (관리형 노드)</StatusIndicator> : <StatusIndicator type="error">연결 안 됨</StatusIndicator>;
}

function NodeTable({
  nodes: { instances, statuses },
  selected,
  onSelect,
  title,
  description,
  actions,
}: {
  nodes: ReturnType<typeof useNodeStatuses>;
  selected: string[];
  onSelect: (ids: string[]) => void;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  const project = useProject();
  return (
    <ResourceTable<Ec2>
      ariaLabel="인스턴스 목록"
      items={instances}
      trackBy={(i) => i.id}
      selectionType="single"
      selectedIds={selected}
      onSelectionChange={onSelect}
      rowLabel={(i) => displayName(i)}
      header={<PageHeader title={title} counter={`(${instances.length})`} info={<InfoLink topic="managed-node" />} description={description} actions={actions} />}
      empty={<EmptyState title="인스턴스 없음" description="EC2 인스턴스를 시작하면 여기에 나타납니다." action={<ButtonLink href={href("/ec2/instances/launch")}>인스턴스 시작</ButtonLink>} />}
      columns={[
        { id: "name", header: "이름", cell: (i) => displayName(i), sortValue: (i) => displayName(i) },
        {
          id: "id",
          header: "노드 ID",
          cell: (i) => (
            <a className="font-mono text-aws-link hover:underline" href={href(`/ec2/instances/${i.id}`)}>
              {i.id}
            </a>
          ),
        },
        { id: "state", header: "인스턴스 상태", cell: (i) => <InstanceState state={i.config.state} /> },
        { id: "ssm", header: "SSM Agent 연결", cell: (i) => <NodeBadge status={statuses.get(i.id)} /> },
        { id: "problem", header: "문제", cell: (i) => <span className="text-aws-text-2">{statuses.get(i.id)?.checks.find((c) => c.status === "fail")?.title ?? "–"}</span> },
        { id: "role", optional: true, header: "IAM 역할", cell: (i) => project.services.iam.roles.find((r) => r.id === i.config.iamRoleId)?.name ?? "없음" },
      ]}
    />
  );
}

export function ManagedNodesPage() {
  const nodes = useNodeStatuses();
  const { instances, statuses } = nodes;
  const [selected, setSelected] = useSelection();
  const current = instances.find((i) => i.id === selected[0]) ?? (instances.length === 1 ? instances[0] : undefined);
  const status = current ? statuses.get(current.id) : undefined;
  return (
    <SpaceBetween>
      <PageGuide topic="managed-node" />
      <NodeTable nodes={nodes} selected={selected} onSelect={setSelected} title="관리형 노드" description="EC2 인스턴스마다 Systems Manager에 연결될 조건을 판정합니다 (가상). 인스턴스를 고르면 근거를 보여 줍니다." />
      {current && status && (
        <Container
          header={
            <ContainerHeader
              title={`노드 상태: ${displayName(current)}`}
              description={status.managed ? "Systems Manager에 연결되어 세션을 열 수 있습니다." : "아래에서 실패한 항목을 고치면 연결됩니다. 설정을 바꾸면 바로 다시 판정합니다."}
              actions={<ButtonLink href={href(`/ssm/sessions/${current.id}`)}>세션 시작</ButtonLink>}
            />
          }
        >
          <div data-testid="node-checks" data-managed={status.managed}>
            <NodeChecks checks={status.checks} />
          </div>
        </Container>
      )}
    </SpaceBetween>
  );
}

// ================================================================ Session Manager

export function SessionManagerPage() {
  const nodes = useNodeStatuses();
  const [selected, setSelected] = useSelection();
  return (
    <SpaceBetween>
      <PageGuide topic="session-manager" />
      <NodeTable
        nodes={nodes}
        selected={selected}
        onSelect={setSelected}
        title="세션 시작"
        description="세션을 열 인스턴스를 고르세요. SSH 키·인바운드 포트 없이 연결합니다 (가상 셸)."
        actions={
          <Button variant="primary" disabled={!selected[0]} onClick={() => selected[0] && navigate(`/ssm/sessions/${selected[0]}`)}>
            세션 시작
          </Button>
        }
      />
    </SpaceBetween>
  );
}

interface TranscriptEntry extends SessionOutput {
  key: string;
}

const PORT_TARGET_TYPES = ["rds", "ec2", "alb"] as const;

export function SessionPage({ id }: { id: string }) {
  const project = useProject();
  const topo = useTopology();
  const [sessionId] = useState(() => `session-${createId("s").split("-").pop()}`);
  const [log, setLog] = useState<TranscriptEntry[]>([]);
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("");
  const inst = topo.getOfType(id, "ec2");
  if (!inst) {
    return (
      <Container>
        <EmptyState title="인스턴스를 찾을 수 없습니다" description={`${id}은(는) 존재하지 않거나 삭제되었습니다.`} action={<ButtonLink href={href("/ssm/sessions")}>세션 시작으로</ButtonLink>} />
      </Container>
    );
  }
  const status = managedNodeStatus(project, topo, inst);
  const permission = startSessionPermission(project, inst);
  const windows = inst.config.ami === "windows-server-2022";
  const prompt = windows ? "PS C:\\Windows\\system32>" : "sh-5.2$";
  const push = (out: SessionOutput | null) => out && setLog((l) => [...l, { ...out, key: `${l.length}` }]);
  const targets = PORT_TARGET_TYPES.flatMap((t) => topo.ofType(t)).filter((r) => r.id !== inst.id);
  const pickTarget = (value: string) => {
    setTarget(value);
    const r = topo.get(value);
    setPort(r?.type === "rds" ? String(r.config.port) : r ? "80" : "");
  };
  const header = (
    <PageHeader
      title={`세션: ${displayName(inst)}`}
      info={<InfoLink topic="session-manager" />}
      description={`대상 ${inst.id} · 시작한 사람: ${permission.who}`}
      actions={<ButtonLink href={href("/ssm/sessions")}>{status.managed && permission.ok ? "종료" : "돌아가기"}</ButtonLink>}
    />
  );
  if (!permission.ok) {
    return (
      <SpaceBetween>
        {header}
        <ErrorAlert message={`[AccessDeniedException] ${permission.reason}`} header="세션을 시작할 수 없습니다" />
        <p className="text-sm text-aws-text-2">
          세션을 여는 사람(지금 가상 로그인한 자격 증명)에게 ssm:StartSession 권한이 필요합니다. <a className="text-aws-link hover:underline" href={href("/iam/simulator")}>정책 시뮬레이터</a>에서 확인하세요.
        </p>
      </SpaceBetween>
    );
  }
  if (!status.managed) {
    return (
      <SpaceBetween>
        {header}
        <ErrorAlert message={`[TargetNotConnected] ${inst.id} is not connected.`} header="세션을 시작할 수 없습니다" />
        <Container header={<ContainerHeader title="관리형 노드가 되려면" description="아래에서 실패한 항목을 고치면 세션을 열 수 있습니다. 설정을 바꾸면 바로 다시 판정합니다." />}>
          <div data-testid="node-checks" data-managed={false}>
            <NodeChecks checks={status.checks} />
          </div>
        </Container>
      </SpaceBetween>
    );
  }
  return (
    <SpaceBetween>
      {header}
      <Alert type="info">
        가상 셸입니다. 정해진 명령만 실행할 수 있고, 출력은 실제 서버가 아니라 이 샌드박스의 설정(IAM 역할·라우팅·보안 그룹·가상 서비스)으로 계산합니다.
      </Alert>
      <Container
        header={
          <ContainerHeader
            title="명령"
            description="눌러서 실행합니다. 결과 아래에 왜 그런 출력이 나왔는지 설명합니다."
            actions={
              <Button variant="link" onClick={() => setLog([])} disabled={!log.length}>
                화면 지우기
              </Button>
            }
          />
        }
      >
        <SpaceBetween size="m">
          <div className="flex flex-wrap gap-2" aria-label="실행할 명령">
            {sessionCommands(inst).map((c) => (
              <Button key={c.id} title={c.purpose} onClick={() => push(runSessionCommand(project, topo, inst, c.id))} className="font-mono">
                {c.command}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="포트 확인 (nc) 대상" className="min-w-56 flex-1" constraint="배스천 없이 프라이빗 DB·서버의 포트가 열려 있는지 확인합니다.">
              <SelectInput value={target} onChange={pickTarget} placeholder={targets.length ? "대상 선택" : "대상이 없습니다"} options={targets.map((r) => ({ value: r.id, label: `${displayName(r)} (${r.type === "rds" ? "RDS" : r.type === "alb" ? "ALB" : "EC2"})` }))} />
            </FormField>
            <FormField label="포트" className="w-28">
              <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </FormField>
            <Button className="mb-6" disabled={!target || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535} onClick={() => push(runPortCheck(topo, inst, target, Number(port)))}>
              nc -zv 실행
            </Button>
          </div>
        </SpaceBetween>
      </Container>
      <section aria-label="세션 출력" className="overflow-hidden rounded-2xl border border-aws-border">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#232f3e] px-4 py-2 text-[13px] text-[#e9ebed]">
          <span className="font-mono">세션 ID (가상): {sessionId}</span>
          <span>사용자: {windows ? `${inst.id.toUpperCase()}\\ssm-user` : "ssm-user"}</span>
        </div>
        <div className="max-h-[480px] space-y-3 overflow-y-auto bg-[#0f141a] p-4 font-mono text-[13px] leading-relaxed text-[#e9ebed]" data-testid="session-output">
          <p className="text-[#aab7b8]">Starting session with SessionId: {sessionId}</p>
          {log.map((entry) => (
            <div key={entry.key}>
              <p>
                <span className="text-[#7dd3fc]">{prompt}</span> {entry.command}
              </p>
              {entry.lines.map((line, i) => (
                <p key={i} className={entry.ok ? "whitespace-pre-wrap" : "whitespace-pre-wrap text-[#fca5a5]"}>
                  {line}
                </p>
              ))}
              <p className="mt-1 font-sans text-[12px] text-[#aab7b8]"># {entry.why}</p>
            </div>
          ))}
          <p>
            <span className="text-[#7dd3fc]">{prompt}</span> <span className="animate-pulse">▌</span>
          </p>
        </div>
      </section>
    </SpaceBetween>
  );
}
