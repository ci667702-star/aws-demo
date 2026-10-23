"use client";

import { useState } from "react";
import { groupArn } from "@/lib/engine/iam-engine";
import type { IamGroup } from "@/lib/engine/resource-models";
import { createGroup, deleteGroup, setGroupMembers, setGroupPolicies } from "@/lib/project/iam-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, MultiSelect, TextInput } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { CopyText } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { useQueryTab } from "../common";
import { PolicyName, PolicyPicker } from "./iam-shared";

function useMembers(groupId: string) {
  return useProject().services.iam.users.filter((u) => u.groupIds.includes(groupId));
}

export function GroupListPage() {
  const project = useProject();
  const run = useRunAction();
  const { groups, users } = project.services.iam;
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const current = groups.find((g) => g.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="iam" />
      <ResourceTable<IamGroup>
        ariaLabel="사용자 그룹 목록"
        items={groups}
        trackBy={(g) => g.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(g) => g.name}
        header={
          <PageHeader
            title="사용자 그룹"
            counter={`(${groups.length})`}
            info={<InfoLink topic="iam" />}
            description="그룹에 정책을 붙이면 그룹에 속한 모든 사용자가 같은 권한을 받습니다. 예: developers, readers"
            actions={
              <>
                <Button disabled={!current} onClick={() => setDeleting(true)}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/iam/groups/create")}>
                  그룹 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="사용자 그룹 없음" description="직무별로 그룹을 만들고 정책을 연결해 두면 새 사용자에게 권한 주기가 쉬워집니다." action={<ButtonLink href={href("/iam/groups/create")}>그룹 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "그룹 이름", cell: (g) => <a className="font-bold text-aws-link hover:underline" href={href(`/iam/groups/${g.id}`)}>{g.name}</a>, sortValue: (g) => g.name },
          { id: "users", header: "사용자", cell: (g) => `${users.filter((u) => u.groupIds.includes(g.id)).length}명` },
          { id: "policies", header: "권한", cell: (g) => (g.policyIds.length ? `정책 ${g.policyIds.length}개` : "정의되지 않음") },
          { id: "created", header: "생성일", cell: (g) => formatDateTime(g.createdAt), sortValue: (g) => g.createdAt, optional: true },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`그룹 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteGroup", (p) => deleteGroup(p, current.id), { success: () => `그룹 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>그룹을 삭제하면 구성원들은 이 그룹을 통해 받던 권한을 잃습니다. 사용자 자체는 삭제되지 않습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

export function CreateGroupPage() {
  const project = useProject();
  const run = useRunAction();
  const [name, setName] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [policyIds, setPolicyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    const r = run("CreateGroup", (p) => createGroup(p, { name, userIds, policyIds }), { success: () => `사용자 그룹 ${name.trim()}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/iam/groups/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween tour="iam-group-form">
      <PageHeader title="사용자 그룹 생성" info={<InfoLink topic="iam" />} description="그룹 이름을 정하고, 구성원과 권한 정책을 고릅니다. 둘 다 나중에 바꿀 수 있습니다." />
      <Container header={<ContainerHeader title="사용자 그룹 이름 지정" />}>
        <FormField label="사용자 그룹 이름" constraint="최대 128자. 영문자, 숫자, + = , . @ _ - 사용 가능">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: developers" maxLength={128} />
        </FormField>
      </Container>
      <Container header={<ContainerHeader title={`그룹에 사용자 추가 - 선택 사항 (${userIds.length})`} />}>
        {project.services.iam.users.length ? (
          <MultiSelect aria-label="그룹 구성원" selected={userIds} onChange={setUserIds} options={project.services.iam.users.map((u) => ({ value: u.id, label: u.name }))} />
        ) : (
          <p className="text-[15px] text-aws-text-2">아직 사용자가 없습니다. 그룹을 먼저 만들고 사용자를 만들 때 이 그룹을 고를 수도 있습니다.</p>
        )}
      </Container>
      <Container header={<ContainerHeader title={`권한 정책 연결 - 선택 사항 (${policyIds.length})`} info={<InfoLink topic="iam-policy" />} />}>
        <PolicyPicker selected={policyIds} onChange={setPolicyIds} />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href("/iam/groups")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={create}>
          그룹 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function GroupDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const group = project.services.iam.groups.find((g) => g.id === id);
  const members = useMembers(id);
  const [tab, setTab] = useQueryTab("users");
  const [editing, setEditing] = useState<"users" | "policies" | null>(null);
  if (!group) {
    return (
      <Container>
        <EmptyState title="그룹을 찾을 수 없습니다" action={<ButtonLink href={href("/iam/groups")}>사용자 그룹 목록</ButtonLink>} />
      </Container>
    );
  }
  return (
    <SpaceBetween>
      <PageHeader title={group.name} />
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "ARN (예시 계정)", value: <CopyText text={groupArn(group.name)} /> },
            { label: "생성일", value: formatDateTime(group.createdAt) },
            { label: "구성원", value: `${members.length}명` },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="그룹 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "users",
            label: `사용자 (${members.length})`,
            content: (
              <Container header={<ContainerHeader title="이 그룹의 사용자" actions={<Button onClick={() => setEditing("users")}>사용자 추가/제거</Button>} />}>
                {members.length ? (
                  <ul className="space-y-1">
                    {members.map((u) => (
                      <li key={u.id}>
                        <a className="text-aws-link hover:underline" href={href(`/iam/users/${u.id}`)}>
                          {u.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[15px] text-aws-text-2">구성원이 없습니다.</p>
                )}
              </Container>
            ),
          },
          {
            id: "permissions",
            label: `권한 (${group.policyIds.length})`,
            content: (
              <Container header={<ContainerHeader title="권한 정책" description="여기 연결한 정책은 모든 구성원에게 적용됩니다." actions={<Button onClick={() => setEditing("policies")}>권한 추가/제거</Button>} />}>
                {group.policyIds.length ? (
                  <ul className="space-y-1">
                    {group.policyIds.map((pid) => (
                      <li key={pid}>
                        <PolicyName id={pid} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[15px] text-aws-text-2">연결된 정책이 없습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      {editing === "users" && (
        <EditMembers
          group={group}
          memberIds={members.map((m) => m.id)}
          onClose={() => setEditing(null)}
          onSave={(ids) => run("AddUserToGroup", (p) => setGroupMembers(p, group.id, ids), { success: () => "그룹 구성원을 변경했습니다.", flashError: true }).ok}
        />
      )}
      {editing === "policies" && <EditGroupPolicies group={group} onClose={() => setEditing(null)} />}
    </SpaceBetween>
  );
}

function EditMembers({ group, memberIds, onClose, onSave }: { group: IamGroup; memberIds: string[]; onClose: () => void; onSave: (ids: string[]) => boolean }) {
  const users = useProject().services.iam.users;
  const [selected, setSelected] = useState(memberIds);
  return (
    <Modal
      open
      onClose={onClose}
      title={`${group.name} 구성원`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={() => onSave(selected) && onClose()}>
            저장
          </Button>
        </>
      }
    >
      {users.length ? (
        <MultiSelect aria-label="구성원" selected={selected} onChange={setSelected} options={users.map((u) => ({ value: u.id, label: u.name }))} />
      ) : (
        <p>
          사용자가 없습니다.{" "}
          <a className="text-aws-link hover:underline" href={href("/iam/users/create")}>
            사용자 생성
          </a>
        </p>
      )}
    </Modal>
  );
}

function EditGroupPolicies({ group, onClose }: { group: IamGroup; onClose: () => void }) {
  const run = useRunAction();
  const [selected, setSelected] = useState(group.policyIds);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      size="large"
      onClose={onClose}
      title={`${group.name}에 연결할 정책`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const r = run("AttachGroupPolicy", (p) => setGroupPolicies(p, group.id, selected), { success: () => "그룹 권한을 변경했습니다." });
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
