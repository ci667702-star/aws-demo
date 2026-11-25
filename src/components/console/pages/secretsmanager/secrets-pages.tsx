"use client";

/**
 * Secrets Manager 콘솔 (가상): 보안 암호 목록·저장, 상세(값 검색·새 버전·교체·버전·접근 테스트), 삭제 예약과 취소.
 * 비밀 값은 입력받거나 저장하지 않는다. 화면에 보이는 값은 보안 암호 ID·버전으로 계산한 연습용 문자열(PGSIM-…)이다.
 */
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { analyzeInvocation } from "@/lib/engine/lambda-engine";
import type { Secret } from "@/lib/engine/resource-models";
import { currentVersion, deletionTime, isPendingDeletion, liveSecrets, nextRotationTime, secretArn, secretNameLooksLikeArnSuffix, secretString, validateSecretName } from "@/lib/engine/secrets-engine";
import { checkSecretRotation, evaluateSecretAccess, ROTATION_ROLE_ACTIONS } from "@/lib/engine/service-access";
import { displayName } from "@/lib/engine/topology-engine";
import { configureRotation, createSecret, deleteSecret, putSecretValue, restoreSecret, rotateSecretNow, updateSecretDescription } from "@/lib/project/secrets-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, SelectInput, TextInput, Tiles, Toggle } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { AccessSteps, AccessTestPanel } from "../access-test";
import { useNow } from "../cloudwatch/cw-shared";
import { useQueryTab, useSelection, useTopology } from "../common";
import { OutcomeStatus } from "../lambda/lambda-functions";

const KIND_LABEL: Record<Secret["kind"], string> = { rds: "Amazon RDS 데이터베이스 자격 증명", other: "다른 유형의 보안 암호 (키/값)" };

const isoAt = (ms: number) => new Date(ms).toISOString();

function SecretState({ secret }: { secret: Secret }) {
  if (!isPendingDeletion(secret)) return <StatusIndicator type="success">사용 가능</StatusIndicator>;
  return <StatusIndicator type="warning">삭제 예약됨 ({formatDateTime(isoAt(deletionTime(secret)!))} 삭제)</StatusIndicator>;
}

function SecretNotFound() {
  return (
    <Container>
      <EmptyState
        title="보안 암호를 찾을 수 없습니다"
        description="삭제되었거나(복구 기간이 끝나면 완전히 사라집니다) 주소가 올바르지 않습니다."
        action={<ButtonLink href={href("/secretsmanager/secrets")}>보안 암호 목록</ButtonLink>}
      />
    </Container>
  );
}

/** 키 이름만 입력받는 편집기 (값 칸은 없다) */
function KeyNamesEditor({ keys, onChange }: { keys: string[]; onChange: (keys: string[]) => void }) {
  const set = (i: number, v: string) => onChange(keys.map((k, j) => (j === i ? v : k)));
  return (
    <div className="space-y-2" data-testid="secret-keys">
      {keys.map((k, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <TextInput aria-label={`키 ${i + 1}`} value={k} onChange={(e) => set(i, e.target.value)} placeholder="예: api_key" maxLength={64} className="max-w-xs font-mono" />
          <span className="text-sm text-aws-text-2">값: 가상 값(PGSIM-…) 자동 생성</span>
          <Button variant="icon" aria-label={`키 ${i + 1} 제거`} disabled={keys.length <= 1} onClick={() => onChange(keys.filter((_, j) => j !== i))}>
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button iconLeft={<Plus aria-hidden />} onClick={() => onChange([...keys, ""])} disabled={keys.length >= 10}>
        행 추가
      </Button>
    </div>
  );
}

// ================================================================ 목록

export function SecretListPage() {
  const project = useProject();
  const run = useRunAction();
  const now = useNow();
  const secrets = liveSecrets(project, now);
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = secrets.find((s) => s.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="secretsmanager" />
      <ResourceTable<Secret>
        ariaLabel="보안 암호 목록"
        items={secrets}
        trackBy={(s) => s.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(s) => s.name}
        filterPlaceholder="보안 암호 찾기"
        header={
          <PageHeader
            title="보안 암호"
            counter={`(${secrets.length})`}
            info={<InfoLink topic="secretsmanager" />}
            description="DB 암호·API 키 같은 비밀 값을 코드 밖에 두고, 권한이 있는 애플리케이션만 읽게 합니다 (가상). 실제 비밀 값은 입력받지 않습니다."
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "restore", text: "삭제 취소", disabled: !current || !isPendingDeletion(current) },
                    { id: "delete", text: "보안 암호 삭제", disabled: !current || isPendingDeletion(current), danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "restore") run("RestoreSecret", (p) => restoreSecret(p, current.id), { success: () => `보안 암호 ${current.name}의 삭제를 취소했습니다.`, flashError: true });
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/secretsmanager/secrets/create")}>
                  새 보안 암호 저장
                </ButtonLink>
              </>
            }
          />
        }
        empty={
          <EmptyState
            title="보안 암호 없음"
            description="DB 자격 증명이나 API 키를 보안 암호로 저장하면, 코드에 암호를 넣지 않고 IAM 권한으로 읽게 할 수 있습니다."
            action={<ButtonLink href={href("/secretsmanager/secrets/create")}>새 보안 암호 저장</ButtonLink>}
          />
        }
        columns={[
          { id: "name", header: "보안 암호 이름", cell: (s) => <a className="font-bold break-all text-aws-link hover:underline" href={href(`/secretsmanager/secrets/${s.id}`)}>{s.name}</a>, sortValue: (s) => s.name },
          { id: "desc", header: "설명", cell: (s) => <span className="text-aws-text-2">{s.description || "–"}</span> },
          { id: "kind", header: "유형", cell: (s) => (s.kind === "rds" ? "RDS 자격 증명" : "키/값") },
          { id: "state", header: "상태", cell: (s) => <SecretState secret={s} /> },
          { id: "rotation", header: "교체", cell: (s) => (s.rotation.enabled ? <Badge color="green">{s.rotation.days}일마다</Badge> : <Badge>꺼짐</Badge>) },
          { id: "updated", optional: true, header: "마지막 변경", cell: (s) => formatDateTime(s.updatedAt), sortValue: (s) => s.updatedAt },
        ]}
      />
      {deleting && current && <DeleteSecretModal secret={current} onClose={() => setDeleting(false)} onDeleted={() => setSelected([])} />}
    </SpaceBetween>
  );
}

// ================================================================ 저장 (생성)

export function CreateSecretPage() {
  const topo = useTopology();
  const run = useRunAction();
  const dbs = topo.ofType("rds");
  const [kind, setKind] = useState<Secret["kind"]>(dbs.length ? "rds" : "other");
  const [rdsId, setRdsId] = useState(dbs[0]?.id ?? "");
  const [username, setUsername] = useState("admin");
  const [keys, setKeys] = useState<string[]>(["api_key"]);
  const [name, setName] = useState("prod/my-app/db");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameError = name.trim() ? validateSecretName(name.trim()) : null;
  const submit = () => {
    setError(null);
    const r = run("CreateSecret", (p) => createSecret(p, { name, description, kind, rdsId: kind === "rds" ? rdsId : null, username, keys }), { success: () => `보안 암호 ${name.trim()}을(를) 저장했습니다.` });
    if (r.ok && r.createdId) navigate(`/secretsmanager/secrets/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="새 보안 암호 저장" info={<InfoLink topic="secretsmanager" />} description="보안 암호를 만듭니다 (가상). 이 시뮬레이터는 실제 암호나 키 값을 입력받지 않고, 연습용 가상 값을 대신 만듭니다." />
      <Alert type="info" header="실제 비밀 값을 넣지 마세요">
        이름·설명·키 이름에는 비밀 값을 적지 않습니다. 값은 보안 암호 ID와 버전으로 계산한 연습용 문자열(PGSIM-…)이며, 어떤 시스템의 암호도 아닙니다.
      </Alert>
      <Container header={<ContainerHeader title="보안 암호 유형" />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "secretsmanager", field: "secretType" }} label="보안 암호 유형">
            <Tiles
              aria-label="보안 암호 유형"
              columns={2}
              value={kind}
              onChange={(v) => setKind(v as Secret["kind"])}
              items={[
                { value: "rds", label: KIND_LABEL.rds, description: "DB 사용자 이름과 암호를 저장합니다. 연결 정보(엔진·호스트·포트)가 함께 들어갑니다.", disabled: !dbs.length },
                { value: "other", label: KIND_LABEL.other, description: "API 키 같은 값을 키/값 쌍으로 저장합니다." },
              ]}
            />
          </FormField>
          {kind === "rds" ? (
            <>
              <FormField label="사용자 이름" constraint="영문자로 시작하는 1~16자의 영문·숫자·밑줄. 암호는 입력받지 않습니다.">
                <TextInput value={username} onChange={(e) => setUsername(e.target.value)} maxLength={16} className="max-w-xs font-mono" />
              </FormField>
              <FormField label="암호">
                <p className="text-sm text-aws-text-2">입력받지 않습니다. 연습용 가상 값(PGSIM-…)을 만들어 보안 암호에 넣었다고 가정합니다.</p>
              </FormField>
              <FormField label="데이터베이스" constraint="이 자격 증명을 쓰는 RDS 데이터베이스">
                <SelectInput value={rdsId} onChange={setRdsId} placeholder="데이터베이스 선택" options={dbs.map((d) => ({ value: d.id, label: `${displayName(d)} (${d.config.engine})` }))} />
              </FormField>
            </>
          ) : (
            <FormField help={{ docKey: "secretsmanager", field: "secretKeys" }} label="키/값 쌍" description="키 이름만 정합니다. 키마다 연습용 가상 값이 만들어집니다 (최대 10개).">
              <KeyNamesEditor keys={keys} onChange={setKeys} />
            </FormField>
          )}
          {!dbs.length && <p className="text-sm text-aws-text-2">RDS 자격 증명을 저장하려면 먼저 RDS에서 데이터베이스를 만드세요.</p>}
          <FormField help={{ docKey: "secretsmanager", field: "encryptionKey" }} label="암호화 키" constraint="고객 관리형 KMS 키는 이 시뮬레이터가 지원하지 않습니다.">
            <SelectInput value="aws/secretsmanager" onChange={() => undefined} disabled options={[{ value: "aws/secretsmanager", label: "aws/secretsmanager (AWS 관리형 키)" }]} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="보안 암호 구성" />}>
        <SpaceBetween size="m">
          <FormField
            help={{ docKey: "secretsmanager", field: "secretName" }}
            label="보안 암호 이름"
            constraint={secretNameLooksLikeArnSuffix(name.trim()) ? "이름이 '-'와 6자로 끝나면 ARN 끝의 임의 접미사와 헷갈릴 수 있습니다." : "1~512자. 영문·숫자와 /_+=.@- 문자. 예: prod/my-app/db (만든 뒤에는 바꿀 수 없음)"}
            error={nameError ?? undefined}
          >
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={512} className="font-mono" />
          </FormField>
          <FormField label="설명" optional>
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2048} />
          </FormField>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="보안 암호를 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/secretsmanager/secrets")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

// ================================================================ 상세

export function SecretDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const now = useNow();
  const [tab, setTab] = useQueryTab("overview");
  const [deleting, setDeleting] = useState(false);
  const secret = liveSecrets(project, now).find((s) => s.id === id);
  if (!secret) return <SecretNotFound />;
  const pending = isPendingDeletion(secret);
  const restore = () => run("RestoreSecret", (p) => restoreSecret(p, secret.id), { success: () => `보안 암호 ${secret.name}의 삭제를 취소했습니다.`, flashError: true });
  return (
    <SpaceBetween>
      <PageHeader
        title={secret.name}
        info={<InfoLink topic="secretsmanager" />}
        description={secret.description || undefined}
        actions={pending ? <Button onClick={restore}>삭제 취소</Button> : <Button onClick={() => setDeleting(true)}>삭제</Button>}
      />
      {pending && (
        <Alert type="warning" header="이 보안 암호는 삭제가 예약되어 있습니다">
          {formatDateTime(isoAt(deletionTime(secret)!))}에 완전히 삭제됩니다. 그때까지 값을 읽을 수 없고(GetSecretValue 실패) 설정도 바꿀 수 없습니다.
        </Alert>
      )}
      <Tabs
        ariaLabel="보안 암호 세부 정보"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "개요", content: <OverviewTab secret={secret} /> },
          { id: "rotation", label: "교체", content: <RotationTab secret={secret} /> },
          { id: "versions", label: "버전", content: <VersionsTab secret={secret} /> },
          { id: "access", label: "접근 테스트", content: <AccessTab secret={secret} /> },
        ]}
      />
      {deleting && <DeleteSecretModal secret={secret} onClose={() => setDeleting(false)} />}
    </SpaceBetween>
  );
}

function OverviewTab({ secret }: { secret: Secret }) {
  const project = useProject();
  const [editing, setEditing] = useState(false);
  const pending = isPendingDeletion(secret);
  const db = secret.rdsId ? project.resources.find((r) => r.id === secret.rdsId) : undefined;
  return (
    <SpaceBetween>
      <Container
        header={
          <ContainerHeader
            title="보안 암호 세부 정보"
            actions={
              <Button onClick={() => setEditing(true)} disabled={pending}>
                설명 편집
              </Button>
            }
          />
        }
      >
        <KeyValueGrid
          columns={3}
          items={[
            { label: "암호화 키", value: "aws/secretsmanager" },
            { label: "보안 암호 이름", value: <span className="font-mono">{secret.name}</span> },
            { label: "보안 암호 ARN (가상)", value: <CopyText text={secretArn(secret)} /> },
            { label: "설명", value: secret.description || "–" },
            { label: "유형", value: KIND_LABEL[secret.kind] },
            ...(secret.kind === "rds"
              ? [{ label: "데이터베이스", value: db ? <a className="text-aws-link hover:underline" href={href(`/rds/databases/${db.id}`)}>{displayName(db)}</a> : <span className="text-aws-error">삭제됨</span> }]
              : []),
            { label: "상태", value: <SecretState secret={secret} /> },
            { label: "만든 날짜", value: formatDateTime(secret.createdAt) },
            { label: "마지막 변경", value: formatDateTime(secret.updatedAt) },
          ]}
        />
      </Container>
      <SecretValueView secret={secret} />
      <ExpandableSection header="애플리케이션에서 읽는 방법 (예시 코드)">
        <SpaceBetween size="s">
          <p className="text-sm text-aws-text-2">코드에 암호를 넣지 않고, 실행할 때 보안 암호를 읽습니다. 서버·함수의 IAM 역할에 이 보안 암호의 secretsmanager:GetSecretValue 권한이 있어야 합니다. (이 시뮬레이터는 코드를 실행하지 않습니다)</p>
          <pre className="overflow-x-auto rounded-xl bg-[#0f141a] p-4 font-mono text-[13px] leading-relaxed text-[#e9ebed]" aria-label="예시 코드">
            {`# Python (boto3)
import boto3, json
client = boto3.client("secretsmanager")
value = client.get_secret_value(SecretId="${secret.name}")
secret = json.loads(value["SecretString"])`}
          </pre>
        </SpaceBetween>
      </ExpandableSection>
      {editing && <DescriptionModal secret={secret} onClose={() => setEditing(false)} />}
    </SpaceBetween>
  );
}

function SecretValueView({ secret }: { secret: Secret }) {
  const project = useProject();
  const [shown, setShown] = useState(false);
  const [plain, setPlain] = useState(false);
  const [editing, setEditing] = useState(false);
  const pending = isPendingDeletion(secret);
  const version = currentVersion(secret);
  const value = secretString(project, secret, version.versionId);
  return (
    <Container
      header={
        <ContainerHeader
          title="보안 암호 값"
          info={<InfoLink topic="secretsmanager" />}
          description="값은 이 화면을 연 사람(가상 로그인)의 권한과 관계없이 연습용으로 보여 줍니다. 애플리케이션이 읽을 수 있는지는 '접근 테스트' 탭에서 확인하세요."
          actions={
            <>
              <Button onClick={() => setShown(!shown)} data-testid="secret-retrieve">
                {shown ? "값 숨기기" : "보안 암호 값 검색"}
              </Button>
              <Button onClick={() => setEditing(true)} disabled={pending}>
                새 값 저장
              </Button>
            </>
          }
        />
      }
    >
      {!shown ? (
        <p className="text-sm text-aws-text-2">값은 기본으로 숨겨져 있습니다. &apos;보안 암호 값 검색&apos;을 누르면 AWSCURRENT 버전의 값을 보여 줍니다.</p>
      ) : pending ? (
        <ErrorAlert message="[InvalidRequestException] You can't perform this operation on the secret because it was marked for deletion." header="값을 읽을 수 없습니다" />
      ) : (
        <SpaceBetween size="s">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="보기 방식" className="inline-flex rounded-full border border-aws-border-strong p-0.5">
              {[
                { on: false, label: "키/값" },
                { on: true, label: "일반 텍스트" },
              ].map((o) => (
                <button key={o.label} type="button" aria-pressed={plain === o.on} onClick={() => setPlain(o.on)} className={plain === o.on ? "rounded-full bg-aws-link px-3 py-1 text-sm font-bold text-white" : "rounded-full px-3 py-1 text-sm text-aws-text-2 hover:text-aws-text"}>
                  {o.label}
                </button>
              ))}
            </div>
            <Badge color="orange">연습용 가상 값</Badge>
            <span className="text-[13px] text-aws-text-2">버전 {version.versionId.slice(0, 8)}… (AWSCURRENT)</span>
          </div>
          {plain ? (
            <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]" data-testid="secret-value">
              {JSON.stringify(value, null, 2)}
            </pre>
          ) : (
            <table className="w-full text-sm" data-testid="secret-value">
              <thead>
                <tr className="border-b border-aws-divider text-left text-aws-text-2">
                  <th className="py-1.5 pr-4 font-bold">키</th>
                  <th className="py-1.5 font-bold">값</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(value).map(([k, v]) => (
                  <tr key={k} className="border-b border-aws-divider last:border-b-0">
                    <td className="py-1.5 pr-4 font-mono">{k}</td>
                    <td className="py-1.5 font-mono break-all">{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SpaceBetween>
      )}
      {editing && <PutValueModal secret={secret} onClose={() => setEditing(false)} />}
    </Container>
  );
}

function DescriptionModal({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const run = useRunAction();
  const [text, setText] = useState(secret.description);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const r = run("UpdateSecret", (p) => updateSecretDescription(p, secret.id, text), { success: () => "설명을 저장했습니다." });
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="설명 편집"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <FormField label="설명" constraint="최대 2,048자">
          <TextInput value={text} onChange={(e) => setText(e.target.value)} maxLength={2048} />
        </FormField>
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}

/** PutSecretValue: 새 버전 (새 가상 값). 키/값 유형은 키 구성도 바꿀 수 있다 */
function PutValueModal({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const run = useRunAction();
  const [keys, setKeys] = useState<string[]>(secret.keys);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const r = run("PutSecretValue", (p) => putSecretValue(p, secret.id, secret.kind === "other" ? keys : undefined), { success: () => "새 값을 저장했습니다 (새 버전)." });
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="새 값 저장 (PutSecretValue)"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <p>
          새 버전이 만들어져 <span className="font-mono">AWSCURRENT</span> 레이블을 받고, 지금 버전은 <span className="font-mono">AWSPREVIOUS</span>가 됩니다. 값은 입력받지 않고 새 가상 값으로 바뀝니다.
        </p>
        {secret.kind === "other" ? (
          <FormField label="키" description="키 이름을 바꾸거나 더할 수 있습니다.">
            <KeyNamesEditor keys={keys} onChange={setKeys} />
          </FormField>
        ) : (
          <p className="text-aws-text-2">RDS 자격 증명은 사용자 이름을 그대로 두고 암호만 새 가상 값으로 바꿉니다. (실제로는 DB의 암호도 같이 바꿔야 합니다 — 교체 함수가 하는 일입니다.)</p>
        )}
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}

// ---------------------------------------------------------------- 교체

function RotationTab({ secret }: { secret: Secret }) {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  const [editing, setEditing] = useState(false);
  const pending = isPendingDeletion(secret);
  const fn = secret.rotation.lambdaId ? topo.getOfType(secret.rotation.lambdaId, "lambda") : null;
  const check = checkSecretRotation(project, topo, secret);
  const next = nextRotationTime(secret);
  return (
    <SpaceBetween>
      <Container
        header={
          <ContainerHeader
            title="교체 구성"
            info={<InfoLink topic="secrets-rotation" />}
            description="교체는 Lambda 함수가 새 암호를 만들어 대상(DB 등)과 보안 암호에 함께 적용하는 작업입니다."
            actions={
              <>
                <Button onClick={() => setEditing(true)} disabled={pending}>
                  교체 편집
                </Button>
                <Button
                  disabled={pending || !secret.rotation.lambdaId}
                  data-testid="secret-rotate-now"
                  onClick={() => run("RotateSecret", (p) => rotateSecretNow(p, secret.id), { success: () => "보안 암호를 교체했습니다 (가상).", flashError: true })}
                >
                  즉시 교체
                </Button>
              </>
            }
          />
        }
      >
        <KeyValueGrid
          columns={3}
          items={[
            { label: "교체 상태", value: secret.rotation.enabled ? <StatusIndicator type="success">사용</StatusIndicator> : <StatusIndicator type="stopped">사용 안 함</StatusIndicator> },
            { label: "교체 주기", value: `${secret.rotation.days}일` },
            {
              label: "교체 함수",
              value: fn ? (
                <a className="text-aws-link hover:underline" href={href(`/lambda/functions/${fn.id}`)}>
                  {displayName(fn)}
                </a>
              ) : secret.rotation.lambdaId ? (
                <span className="text-aws-error">삭제됨</span>
              ) : (
                "없음"
              ),
            },
            { label: "마지막 교체", value: secret.lastRotatedAt ? formatDateTime(secret.lastRotatedAt) : "–" },
            { label: "다음 교체 예정", value: next ? `${formatDateTime(isoAt(next))} (예정일만 계산)` : "–" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="교체가 성공할 조건" description="설정을 바꾸면 바로 다시 판정합니다. 교체 함수의 코드는 실행하지 않습니다." />}>
        <div data-testid="secret-rotation-checks" data-ok={check.ok}>
          <AccessSteps steps={check.checks} />
        </div>
        <p className="mt-3 text-[13px] text-aws-text-2">교체 함수의 실행 역할에 필요한 권한: {ROTATION_ROLE_ACTIONS.join(", ")}</p>
      </Container>
      <Alert type="info" header="이 시뮬레이터의 단순화">
        일정에 따른 자동 교체는 실행되지 않습니다 (예정일만 계산). &apos;즉시 교체&apos;는 위 조건이 모두 맞으면 교체 함수가 성공했다고 가정하고 새 버전을 AWSCURRENT로 올립니다. 실제 교체는 createSecret → setSecret → testSecret → finishSecret 네 단계로 진행되며, 그 사이 새 값은 AWSPENDING 레이블을 가집니다.
      </Alert>
      {editing && <RotationModal secret={secret} onClose={() => setEditing(false)} />}
    </SpaceBetween>
  );
}

function RotationModal({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const topo = useTopology();
  const run = useRunAction();
  const fns = topo.ofType("lambda");
  const [enabled, setEnabled] = useState(secret.rotation.enabled);
  const [days, setDays] = useState(String(secret.rotation.days));
  const [lambdaId, setLambdaId] = useState(secret.rotation.lambdaId ?? "");
  const [addPermission, setAddPermission] = useState(true);
  const [rotateNow, setRotateNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fn = fns.find((f) => f.id === lambdaId);
  const hasPermission = !!fn?.config.permissions.some((p) => p.principal === "secretsmanager.amazonaws.com");
  const save = () => {
    setError(null);
    if (!/^\d+$/.test(days)) return setError("[ValidationException] 교체 주기는 정수(일)여야 합니다.");
    const r = run(
      "RotateSecret",
      (p) => {
        const saved = configureRotation(p, secret.id, { enabled, days: Number(days), lambdaId: lambdaId || null, addPermission });
        if (!saved.ok || !enabled || !rotateNow) return saved;
        // 실제 콘솔처럼 저장하자마자 한 번 교체한다. 교체가 실패해도 구성은 저장된다
        const rotated = rotateSecretNow(saved.project, secret.id);
        return rotated.ok ? { ...rotated, notes: [...saved.notes, ...rotated.notes] } : { ...saved, notes: [...saved.notes, `즉시 교체는 실패했습니다: ${rotated.error}`] };
      },
      { success: () => "교체 구성을 저장했습니다." },
    );
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="교체 편집"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <Toggle checked={enabled} onChange={setEnabled} description="정해진 주기마다 교체 함수로 새 암호를 만들어 적용합니다.">
          자동 교체
        </Toggle>
        {enabled && (
          <>
            <FormField help={{ docKey: "secretsmanager", field: "rotation" }} label="교체 주기 (일)" constraint="1~365일. 실제 AWS는 cron·rate 일정과 교체 창도 지원합니다.">
              <TextInput value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="max-w-32" />
            </FormField>
            <FormField help={{ docKey: "secretsmanager", field: "rotationFunction" }} label="교체 함수 (Lambda)">
              <SelectInput value={lambdaId} onChange={setLambdaId} placeholder={fns.length ? "함수 선택" : "함수가 없습니다"} options={fns.map((f) => ({ value: f.id, label: displayName(f) }))} />
            </FormField>
            {!fns.length && (
              <Alert type="info">
                먼저 <a href={href("/lambda/functions/create")}>Lambda 함수를 만드세요</a>.
              </Alert>
            )}
            <Checkbox
              checked={addPermission || hasPermission}
              disabled={hasPermission}
              onChange={setAddPermission}
              description={hasPermission ? "이 함수에는 이미 secretsmanager.amazonaws.com의 호출 허용이 있습니다." : "Secrets Manager가 함수를 호출하려면 함수의 리소스 기반 정책에 이 허용이 있어야 합니다."}
            >
              함수에 Secrets Manager 호출 권한 추가 (lambda:AddPermission)
            </Checkbox>
            <Checkbox checked={rotateNow} onChange={setRotateNow} description="교체 조건이 맞지 않아 실패해도 구성은 저장됩니다.">
              저장하자마자 한 번 교체
            </Checkbox>
          </>
        )}
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}

// ---------------------------------------------------------------- 버전

function VersionsTab({ secret }: { secret: Secret }) {
  return (
    <SpaceBetween>
      <ResourceTable
        ariaLabel="보안 암호 버전"
        items={secret.versions}
        trackBy={(v) => v.versionId}
        filtering={false}
        header={<ContainerHeader title="버전" counter={`(${secret.versions.length})`} info={<InfoLink topic="secrets-rotation" />} description="값을 바꿀 때마다 새 버전이 생기고, 스테이징 레이블이 옮겨 갑니다." />}
        columns={[
          { id: "id", header: "버전 ID", cell: (v) => <span className="font-mono text-[13px] break-all">{v.versionId}</span> },
          {
            id: "stages",
            header: "스테이징 레이블",
            cell: (v) =>
              v.stages.length ? (
                <span className="flex flex-wrap gap-1">
                  {v.stages.map((s) => (
                    <Badge key={s} color={s === "AWSCURRENT" ? "green" : "blue"}>
                      {s}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-aws-text-2">없음 (곧 정리됨)</span>
              ),
          },
          { id: "created", header: "만든 날짜", cell: (v) => formatDateTime(v.createdAt), sortValue: (v) => v.createdAt },
        ]}
      />
      <p className="text-[13px] text-aws-text-2">AWSCURRENT는 애플리케이션이 기본으로 읽는 값, AWSPREVIOUS는 바로 전 값입니다. 레이블이 없는 오래된 버전은 AWS가 정리합니다.</p>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 접근 테스트

function AccessTab({ secret }: { secret: Secret }) {
  const project = useProject();
  const topo = useTopology();
  const now = useNow();
  const readers = topo.ofType("lambda").filter((f) => f.config.codeTemplate === "secret-get" && f.config.templateTarget.trim() === secret.name);
  return (
    <SpaceBetween>
      <AccessTestPanel
        title="GetSecretValue 접근 테스트"
        description="고른 호출자가 이 보안 암호의 값을 읽을 수 있는지 네트워크 → 자격 증명 → IAM 권한 → 보안 암호 상태 순서로 확인합니다."
        action="secretsmanager:GetSecretValue"
        testId="secret-access"
        evaluate={(caller) => evaluateSecretAccess(project, topo, secret.id, caller, now)}
      />
      <Container header={<ContainerHeader title={`이 보안 암호를 읽는 Lambda 함수 (${readers.length})`} description="코드 템플릿이 'Secrets Manager 보안 암호 읽기'이고 대상이 이 보안 암호 이름인 함수입니다." />}>
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
          <p className="text-sm text-aws-text-2">
            없습니다. Lambda 함수의 코드 탭에서 템플릿을 &apos;Secrets Manager 보안 암호 읽기&apos;로 바꾸고 이 보안 암호를 고르면 여기에 나타납니다.
          </p>
        )}
      </Container>
      <p className="text-[13px] text-aws-text-2">리소스 기반 정책(보안 암호에 붙이는 정책)과 다른 계정의 접근은 이 시뮬레이터가 지원하지 않습니다. 자격 증명 기반 정책(IAM 역할·사용자 정책)만 평가합니다.</p>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 삭제

function DeleteSecretModal({ secret, onClose, onDeleted }: { secret: Secret; onClose: () => void; onDeleted?: () => void }) {
  const run = useRunAction();
  const [days, setDays] = useState("30");
  const [force, setForce] = useState(false);
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={`보안 암호 ${secret.name} 삭제`}
      actionLabel={force ? "즉시 삭제" : "삭제 예약"}
      confirmText={force ? secret.name : undefined}
      onConfirm={() => {
        if (!force && !/^\d+$/.test(days)) return "[InvalidParameterException] 대기 기간은 7~30 사이의 정수여야 합니다.";
        const r = run("DeleteSecret", (p) => deleteSecret(p, secret.id, { recoveryDays: Number(days), force }), { success: () => (force ? `보안 암호 ${secret.name}을(를) 삭제했습니다.` : `보안 암호 ${secret.name}의 삭제를 예약했습니다.`) });
        if (!r.ok) return withHint(r);
        onDeleted?.();
        if (force) navigate("/secretsmanager/secrets");
        return null;
      }}
    >
      <p>보안 암호는 바로 지워지지 않고 대기 기간(복구 기간) 뒤에 삭제됩니다. 그동안 값을 읽을 수 없으며, 언제든 &apos;삭제 취소&apos;로 복원할 수 있습니다.</p>
      <FormField help={{ docKey: "secretsmanager", field: "deletion" }} label="대기 기간 (일)" constraint="7~30일">
        <TextInput value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="max-w-32" disabled={force} />
      </FormField>
      <Checkbox checked={force} onChange={setForce} description="실제 콘솔에는 없고 AWS CLI의 --force-delete-without-recovery에 해당합니다. 되돌릴 수 없습니다.">
        복구 기간 없이 즉시 삭제
      </Checkbox>
    </DeleteModal>
  );
}
