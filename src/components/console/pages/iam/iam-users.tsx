"use client";

import { Download, Eye, EyeOff, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { effectivePolicyIds, userArn } from "@/lib/engine/iam-engine";
import type { IamUser } from "@/lib/engine/resource-models";
import { createAccessKey, createUser, deleteAccessKey, deleteUser, setAccessKeyStatus, setUserConsoleAccess, setUserGroups, setUserMfa, setUserPolicies } from "@/lib/project/iam-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { downloadTextFile } from "@/lib/ui/download";
import { formatDateTime } from "@/lib/ui/format";
import { useConsoleProjectId, useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { notify } from "../../notify";
import { href, navigate } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, MultiSelect, RadioGroup, TextInput } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { useQueryTab } from "../common";
import { PolicyName, PolicyPicker } from "./iam-shared";

function useUser(id: string): IamUser | undefined {
  return useProject().services.iam.users.find((u) => u.id === id);
}

function NotFound({ what }: { what: string }) {
  return (
    <Container>
      <EmptyState title={`${what}을(를) 찾을 수 없습니다`} description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/iam")}>IAM 대시보드</ButtonLink>} />
    </Container>
  );
}

export function UserListPage() {
  const project = useProject();
  const run = useRunAction();
  const { users, groups } = project.services.iam;
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const current = users.find((u) => u.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="iam" />
      <ResourceTable<IamUser>
        ariaLabel="IAM 사용자 목록"
        items={users}
        trackBy={(u) => u.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(u) => u.name}
        header={
          <PageHeader
            title="사용자"
            counter={`(${users.length})`}
            info={<InfoLink topic="iam" />}
            description="IAM 사용자는 AWS를 사용하는 사람이나 프로그램 하나를 나타냅니다."
            actions={
              <>
                <Button disabled={!current} onClick={() => setDeleting(true)}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/iam/users/create")}>
                  사용자 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="사용자 없음" description="사람이나 프로그램마다 사용자를 만들고 필요한 권한만 주세요." action={<ButtonLink href={href("/iam/users/create")}>사용자 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "사용자 이름", cell: (u) => <a className="font-bold text-aws-link hover:underline" href={href(`/iam/users/${u.id}`)}>{u.name}</a>, sortValue: (u) => u.name },
          { id: "groups", header: "그룹", cell: (u) => u.groupIds.map((g) => groups.find((x) => x.id === g)?.name).filter(Boolean).join(", ") || "–" },
          { id: "keys", header: "액세스 키", cell: (u) => (u.accessKeys.length ? `${u.accessKeys.filter((k) => k.status === "Active").length}개 활성 / 전체 ${u.accessKeys.length}개` : "없음") },
          { id: "console", header: "콘솔 접근", cell: (u) => (u.consoleAccess ? "활성화됨" : "–") },
          { id: "mfa", header: "MFA", cell: (u) => (u.mfaEnabled ? <Badge color="green">가상 MFA</Badge> : "–"), optional: true },
          { id: "created", header: "생성일", cell: (u) => formatDateTime(u.createdAt), sortValue: (u) => u.createdAt, optional: true },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`사용자 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteUser", (p) => deleteUser(p, current.id), { success: () => `사용자 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>사용자와 연결된 액세스 키·그룹 소속·정책 연결이 함께 삭제됩니다. 이 사용자의 키를 쓰는 프로그램은 더 이상 동작하지 않습니다(가상).</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

export function CreateUserPage() {
  const project = useProject();
  const run = useRunAction();
  const { groups } = project.services.iam;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [consoleAccess, setConsoleAccess] = useState(false);
  const [mode, setMode] = useState<"group" | "direct">(groups.length ? "group" : "direct");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [policyIds, setPolicyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    const r = run("CreateUser", (p) => createUser(p, { name, consoleAccess, groupIds: mode === "group" ? groupIds : [], policyIds: mode === "direct" ? policyIds : [] }), {
      success: () => `사용자 ${name.trim()}을(를) 만들었습니다.`,
    });
    if (r.ok && r.createdId) navigate(`/iam/users/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween tour="iam-user-form">
      <PageHeader title="사용자 생성" info={<InfoLink topic="iam" />} description={`${step}단계 / 3단계 — ${["사용자 세부 정보", "권한 설정", "검토 및 생성"][step - 1]}`} />
      <ol className="flex flex-wrap gap-4 text-[15px]" aria-label="단계">
        {["사용자 세부 정보", "권한 설정", "검토 및 생성"].map((label, i) => (
          <li key={label} className={i + 1 === step ? "font-bold text-aws-link" : "text-aws-text-2"} aria-current={i + 1 === step ? "step" : undefined}>
            {i + 1}단계 · {label}
          </li>
        ))}
      </ol>
      {step === 1 && (
        <Container header={<ContainerHeader title="사용자 세부 정보" />}>
          <SpaceBetween size="m">
            <FormField label="사용자 이름" constraint="최대 64자. 영문자, 숫자, + = , . @ _ - 사용 가능">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: alice 또는 ci-bot" maxLength={64} />
            </FormField>
            <Checkbox checked={consoleAccess} onChange={setConsoleAccess} description="사람이 콘솔에 로그인해야 할 때만 켭니다. 이 시뮬레이터는 실제 로그인이나 암호를 만들지 않습니다.">
              AWS Management Console에 대한 사용자 액세스 권한 제공 (가상)
            </Checkbox>
          </SpaceBetween>
        </Container>
      )}
      {step === 2 && (
        <Container header={<ContainerHeader title="권한 설정" info={<InfoLink topic="iam-policy" />} description="권한은 그룹으로 관리하는 것이 좋습니다. 여러 사람에게 같은 권한을 한 번에 주고 뺄 수 있습니다." />}>
          <SpaceBetween size="m">
            <RadioGroup
              aria-label="권한 옵션"
              value={mode}
              onChange={(v) => setMode(v as typeof mode)}
              items={[
                { value: "group", label: "그룹에 사용자 추가", description: groups.length ? "그룹에 연결된 정책을 사용자가 물려받습니다 (권장)." : "아직 그룹이 없습니다. 사용자 그룹 메뉴에서 먼저 만들 수 있습니다.", disabled: !groups.length },
                { value: "direct", label: "직접 정책 연결", description: "이 사용자에게만 정책을 붙입니다." },
              ]}
            />
            {mode === "group" ? (
              <FormField label="사용자 그룹">
                <MultiSelect aria-label="사용자 그룹" selected={groupIds} onChange={setGroupIds} options={groups.map((g) => ({ value: g.id, label: g.name, description: `정책 ${g.policyIds.length}개` }))} />
              </FormField>
            ) : (
              <PolicyPicker selected={policyIds} onChange={setPolicyIds} />
            )}
            {mode === "direct" && policyIds.includes("aws:AdministratorAccess") && (
              <Alert type="warning">AdministratorAccess는 모든 작업을 허용합니다. 최소 권한 원칙에 따라 꼭 필요한 정책만 연결하세요.</Alert>
            )}
          </SpaceBetween>
        </Container>
      )}
      {step === 3 && (
        <Container header={<ContainerHeader title="검토" />}>
          <KeyValueGrid
            columns={2}
            items={[
              { label: "사용자 이름", value: name },
              { label: "콘솔 접근", value: consoleAccess ? "활성화 (가상)" : "없음" },
              { label: "그룹", value: mode === "group" && groupIds.length ? groupIds.map((g) => groups.find((x) => x.id === g)?.name).join(", ") : "–" },
              { label: "직접 연결한 정책", value: mode === "direct" && policyIds.length ? policyIds.map((id) => <div key={id}><PolicyName id={id} /></div>) : "–" },
            ]}
          />
          <p className="mt-4 text-sm text-aws-text-2">액세스 키는 사용자를 만든 뒤 [보안 자격 증명] 탭에서 필요할 때만 만듭니다.</p>
        </Container>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        {step === 1 ? (
          <ButtonLink variant="link" href={href("/iam/users")}>
            취소
          </ButtonLink>
        ) : (
          <Button variant="link" onClick={() => setStep((step - 1) as 1 | 2)}>
            이전
          </Button>
        )}
        {step < 3 ? (
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              if (step === 1 && !name.trim()) return setError("[ValidationError] 사용자 이름을 입력하세요.");
              setStep((step + 1) as 2 | 3);
            }}
          >
            다음
          </Button>
        ) : (
          <Button variant="primary" onClick={create}>
            사용자 생성
          </Button>
        )}
      </FormActions>
    </SpaceBetween>
  );
}

export function UserDetailPage({ id }: { id: string }) {
  const user = useUser(id);
  const project = useProject();
  const run = useRunAction();
  const [tab, setTab] = useQueryTab("permissions");
  const [editing, setEditing] = useState<"policies" | "groups" | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  if (!user) return <NotFound what="사용자" />;
  const groups = project.services.iam.groups;
  const inherited = user.groupIds.flatMap((gid) => {
    const g = groups.find((x) => x.id === gid);
    return g ? g.policyIds.map((pid) => ({ pid, via: g.name })) : [];
  });
  const effective = effectivePolicyIds(project, { kind: "user", user });
  return (
    <SpaceBetween>
      <PageHeader
        title={user.name}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "policies", text: "권한 추가/제거" },
              { id: "groups", text: "그룹 변경" },
              { id: "key", text: "액세스 키 만들기" },
            ]}
            onItemClick={(a) => {
              if (a === "policies") setEditing("policies");
              if (a === "groups") setEditing("groups");
              if (a === "key") navigate(`/iam/users/${user.id}/create-access-key`);
            }}
          />
        }
      />
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "ARN (예시 계정)", value: <CopyText text={userArn(user.name)} /> },
            { label: "생성일", value: formatDateTime(user.createdAt) },
            { label: "콘솔 접근", value: user.consoleAccess ? "활성화됨 (가상)" : "비활성화됨" },
            { label: "액세스 키", value: user.accessKeys.length ? user.accessKeys.map((k) => <div key={k.id} className="font-mono text-[13px]">{k.id} · {k.status === "Active" ? "활성" : "비활성"}</div>) : "없음" },
            { label: "적용되는 정책", value: `${effective.length}개` },
            { label: "MFA", value: user.mfaEnabled ? "할당됨 (가상)" : "없음" },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="사용자 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "permissions",
            label: `권한 (${effective.length})`,
            content: (
              <Container header={<ContainerHeader title="권한 정책" info={<InfoLink topic="iam-policy" />} description="직접 연결한 정책과 그룹에서 물려받은 정책이 모두 적용됩니다." actions={<Button onClick={() => setEditing("policies")}>권한 추가/제거</Button>} />}>
                {effective.length === 0 ? (
                  <p className="text-[15px] text-aws-text-2">연결된 정책이 없어 이 사용자는 아무 작업도 할 수 없습니다 (기본 거부).</p>
                ) : (
                  <ul className="divide-y divide-aws-divider">
                    {user.policyIds.map((pid) => (
                      <li key={`d-${pid}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <PolicyName id={pid} />
                        <Badge>직접 연결</Badge>
                      </li>
                    ))}
                    {inherited.map(({ pid, via }) => (
                      <li key={`g-${via}-${pid}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <PolicyName id={pid} />
                        <Badge color="blue">그룹 {via}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Container>
            ),
          },
          {
            id: "groups",
            label: `그룹 (${user.groupIds.length})`,
            content: (
              <Container header={<ContainerHeader title="사용자 그룹 멤버십" actions={<Button onClick={() => setEditing("groups")}>그룹 변경</Button>} />}>
                {user.groupIds.length ? (
                  <ul className="space-y-1">
                    {user.groupIds.map((gid) => {
                      const g = groups.find((x) => x.id === gid);
                      return (
                        <li key={gid}>
                          <a className="text-aws-link hover:underline" href={href(`/iam/groups/${gid}`)}>
                            {g?.name ?? gid}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-[15px] text-aws-text-2">속한 그룹이 없습니다.</p>
                )}
              </Container>
            ),
          },
          {
            id: "credentials",
            label: "보안 자격 증명",
            content: (
              <SpaceBetween>
                <Container header={<ContainerHeader title="콘솔 로그인 (가상)" />}>
                  <SpaceBetween size="m">
                    <Checkbox
                      checked={user.consoleAccess}
                      onChange={(v) => run("UpdateLoginProfile", (p) => setUserConsoleAccess(p, user.id, v), { success: () => (v ? "콘솔 접근을 켰습니다." : "콘솔 접근을 껐습니다."), flashError: true })}
                      description="실제 암호나 로그인 URL은 만들지 않습니다."
                    >
                      콘솔 접근 활성화
                    </Checkbox>
                    <Checkbox
                      checked={user.mfaEnabled}
                      disabled={!user.consoleAccess}
                      onChange={(v) => run("EnableMFADevice", (p) => setUserMfa(p, user.id, v), { success: () => (v ? "가상 MFA 디바이스를 할당했습니다." : "MFA를 해제했습니다."), flashError: true })}
                      description="로그인할 때 휴대폰 앱의 일회용 코드를 한 번 더 확인하는 2단계 인증입니다 (연습용 표시만 바뀝니다)."
                    >
                      MFA 디바이스 할당 (가상)
                    </Checkbox>
                  </SpaceBetween>
                </Container>
                <Container
                  header={
                    <ContainerHeader
                      title={`액세스 키 (${user.accessKeys.length}/2)`}
                      info={<InfoLink topic="iam-access-key" />}
                      description="CLI나 SDK 같은 프로그램이 이 사용자로 AWS를 호출할 때 씁니다. 비밀 키는 만들 때 한 번만 보입니다."
                      actions={
                        user.accessKeys.length >= 2 ? (
                          <Button variant="primary" disabled title="사용자당 액세스 키는 2개까지입니다. 하나를 삭제한 뒤 만드세요.">
                            액세스 키 만들기
                          </Button>
                        ) : (
                          <ButtonLink variant="primary" href={href(`/iam/users/${user.id}/create-access-key`)}>
                            액세스 키 만들기
                          </ButtonLink>
                        )
                      }
                    />
                  }
                >
                  {user.accessKeys.length === 0 ? (
                    <p className="text-[15px] text-aws-text-2">액세스 키가 없습니다. 가능하면 장기 키 대신 역할을 쓰세요.</p>
                  ) : (
                    <ul className="divide-y divide-aws-divider">
                      {user.accessKeys.map((k) => (
                        <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div>
                            <p className="font-mono text-[14px] font-bold">{k.id}</p>
                            <p className="text-sm text-aws-text-2">
                              {k.description || "설명 없음"} · 만든 날 {formatDateTime(k.createdAt)} · 비밀 키 …{k.secretHint}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {k.status === "Active" ? <StatusIndicator type="success">활성</StatusIndicator> : <StatusIndicator type="stopped">비활성</StatusIndicator>}
                            <Button
                              onClick={() =>
                                run("UpdateAccessKey", (p) => setAccessKeyStatus(p, user.id, k.id, k.status === "Active" ? "Inactive" : "Active"), {
                                  success: () => `액세스 키를 ${k.status === "Active" ? "비활성화" : "활성화"}했습니다.`,
                                  flashError: true,
                                })
                              }
                            >
                              {k.status === "Active" ? "비활성화" : "활성화"}
                            </Button>
                            <Button onClick={() => setDeletingKey(k.id)}>삭제</Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Container>
              </SpaceBetween>
            ),
          },
        ]}
      />
      {editing === "policies" && <EditUserPolicies user={user} onClose={() => setEditing(null)} />}
      {editing === "groups" && <EditUserGroups user={user} onClose={() => setEditing(null)} />}
      {deletingKey && (
        <DeleteModal
          open
          onClose={() => setDeletingKey(null)}
          title="액세스 키 삭제"
          confirmText="delete"
          onConfirm={() => {
            const r = run("DeleteAccessKey", (p) => deleteAccessKey(p, user.id, deletingKey), { success: () => "액세스 키를 삭제했습니다." });
            return r.ok ? null : withHint(r);
          }}
        >
          <p>
            <span className="font-mono">{deletingKey}</span> 키를 삭제합니다. AWS에서는 삭제하기 전에 먼저 비활성화해서 이 키를 쓰는 프로그램이 없는지 확인합니다.
          </p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

function EditUserPolicies({ user, onClose }: { user: IamUser; onClose: () => void }) {
  const run = useRunAction();
  const [selected, setSelected] = useState(user.policyIds);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      size="large"
      onClose={onClose}
      title={`${user.name}에 직접 연결할 정책`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const r = run("AttachUserPolicy", (p) => setUserPolicies(p, user.id, selected), { success: () => "권한을 변경했습니다." });
              if (r.ok) onClose();
              else setError(withHint(r));
            }}
          >
            저장
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <PolicyPicker selected={selected} onChange={setSelected} />
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}

function EditUserGroups({ user, onClose }: { user: IamUser; onClose: () => void }) {
  const run = useRunAction();
  const groups = useProject().services.iam.groups;
  const [selected, setSelected] = useState(user.groupIds);
  return (
    <Modal
      open
      onClose={onClose}
      title={`${user.name}의 그룹`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const r = run("AddUserToGroup", (p) => setUserGroups(p, user.id, selected), { success: () => "그룹 멤버십을 변경했습니다.", flashError: true });
              if (r.ok) onClose();
            }}
          >
            저장
          </Button>
        </>
      }
    >
      {groups.length ? (
        <MultiSelect aria-label="그룹" selected={selected} onChange={setSelected} options={groups.map((g) => ({ value: g.id, label: g.name, description: `정책 ${g.policyIds.length}개` }))} />
      ) : (
        <p>
          그룹이 없습니다.{" "}
          <a className="text-aws-link hover:underline" href={href("/iam/groups/create")}>
            그룹 생성
          </a>
        </p>
      )}
    </Modal>
  );
}

const USE_CASES: { value: string; label: string; advice: string }[] = [
  { value: "cli", label: "명령줄 인터페이스(CLI)", advice: "가능하면 AWS IAM Identity Center나 CloudShell처럼 장기 키가 필요 없는 방법을 고려하세요." },
  { value: "local-code", label: "로컬 코드", advice: "개발 도구가 임시 자격 증명을 지원하면 그쪽을 쓰세요." },
  { value: "aws-compute", label: "AWS 컴퓨팅 서비스에서 실행되는 애플리케이션", advice: "EC2·Lambda에서는 액세스 키 대신 IAM 역할을 연결하세요. 키를 서버에 넣으면 유출 위험이 큽니다." },
  { value: "third-party", label: "서드 파티 서비스", advice: "가능하면 해당 서비스가 지원하는 역할 위임(교차 계정 역할)을 쓰세요." },
  { value: "outside", label: "AWS 외부에서 실행되는 애플리케이션", advice: "IAM Roles Anywhere 같은 임시 자격 증명 방식을 검토하세요." },
  { value: "other", label: "기타", advice: "장기 키는 꼭 필요할 때만 만들고 주기적으로 교체하세요." },
];

export function CreateAccessKeyPage({ id }: { id: string }) {
  const user = useUser(id);
  const projectId = useConsoleProjectId();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [useCase, setUseCase] = useState("cli");
  const [understood, setUnderstood] = useState(false);
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advice = useMemo(() => USE_CASES.find((u) => u.value === useCase)?.advice, [useCase]);
  if (!user && !created) return <NotFound what="사용자" />;
  const create = () => {
    let secret: { accessKeyId: string; secretAccessKey: string } | null = null;
    const r = useProjectStore.getState().apply(projectId, "CreateAccessKey", (p) => {
      const res = createAccessKey(p, id, { useCase, description });
      if (res.ok) secret = { accessKeyId: res.accessKeyId, secretAccessKey: res.secretAccessKey };
      return res;
    });
    if (!r.ok) return setError(withHint(r));
    setCreated(secret);
    setStep(3);
    notify({ type: "success", title: "가상 액세스 키를 만들었습니다", description: "비밀 키는 지금 화면에서만 볼 수 있습니다." });
  };
  return (
    <SpaceBetween tour="iam-key-form">
      <PageHeader title="액세스 키 만들기" info={<InfoLink topic="iam-access-key" />} description={`사용자 ${user?.name ?? ""} · ${step}단계 / 3단계`} />
      <Alert type="info" header="가상 액세스 키">
        여기서 만드는 키는 학습용 가상 값(PGSIM으로 시작)이며 실제 AWS에서 동작하지 않습니다. 실제 AWS 키나 비밀 값을 이 화면에 입력하지 마세요.
      </Alert>
      {step === 1 && (
        <Container header={<ContainerHeader title="액세스 키 모범 사례 및 대안" description="먼저 키가 꼭 필요한지 확인합니다. 용도를 고르면 더 안전한 대안을 알려 드립니다." />}>
          <SpaceBetween size="m">
            <RadioGroup aria-label="사용 사례" value={useCase} onChange={setUseCase} items={USE_CASES.map((u) => ({ value: u.value, label: u.label }))} />
            {advice && (
              <Alert type={useCase === "aws-compute" ? "warning" : "info"} header="권장 대안">
                {advice}
              </Alert>
            )}
            <Checkbox checked={understood} onChange={setUnderstood}>
              위의 권장 사항을 이해했으며 액세스 키 생성을 계속하려고 합니다.
            </Checkbox>
          </SpaceBetween>
        </Container>
      )}
      {step === 2 && (
        <Container header={<ContainerHeader title="설명 태그 설정 - 선택 사항" description="나중에 어떤 키인지 알아볼 수 있게 용도를 적어 두세요." />}>
          <FormField label="설명 태그 값" constraint="최대 256자">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="예: 내 노트북 CLI" maxLength={256} />
          </FormField>
        </Container>
      )}
      {step === 3 && created && (
        <Container header={<ContainerHeader title="액세스 키 검색" description="이 화면을 벗어나면 비밀 액세스 키를 다시 볼 수 없습니다. 필요하면 지금 .csv 파일로 내려받으세요." />}>
          <SpaceBetween size="m">
            <Alert type="warning">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-1 size-4 shrink-0" aria-hidden />
                실제 키라면 절대 코드 저장소·메신저에 올리면 안 됩니다. 이 키는 가상 값이라 어디에도 쓸 수 없습니다.
              </span>
            </Alert>
            <KeyValueGrid
              columns={2}
              items={[
                { label: "액세스 키 ID", value: <CopyText text={created.accessKeyId} /> },
                {
                  label: "비밀 액세스 키",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] break-all">{showSecret ? created.secretAccessKey : "•".repeat(24)}</span>
                      <button type="button" className="inline-flex items-center gap-1 text-sm text-aws-link hover:underline" onClick={() => setShowSecret(!showSecret)}>
                        {showSecret ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                        {showSecret ? "숨기기" : "표시"}
                      </button>
                    </span>
                  ),
                },
              ]}
            />
            <div>
              <Button
                iconLeft={<Download aria-hidden />}
                onClick={() =>
                  downloadTextFile(`${user?.name ?? "user"}_virtual_accessKeys.csv`, `Access key ID,Secret access key,Note\n${created.accessKeyId},${created.secretAccessKey},AWS Playground virtual key - does not work on AWS\n`, "text/csv")
                }
              >
                .csv 파일 다운로드 (가상 키)
              </Button>
            </div>
          </SpaceBetween>
        </Container>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        {step === 1 && (
          <>
            <ButtonLink variant="link" href={href(`/iam/users/${id}?tab=credentials`)}>
              취소
            </ButtonLink>
            <Button variant="primary" disabled={!understood} onClick={() => setStep(2)}>
              다음
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            <Button variant="link" onClick={() => setStep(1)}>
              이전
            </Button>
            <Button variant="primary" onClick={create}>
              액세스 키 만들기
            </Button>
          </>
        )}
        {step === 3 && (
          <Button variant="primary" onClick={() => navigate(`/iam/users/${id}`, { query: { tab: "credentials" } })}>
            완료
          </Button>
        )}
      </FormActions>
    </SpaceBetween>
  );
}
