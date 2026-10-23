"use client";

import { useState } from "react";
import { roleArn, trustPolicyDocument } from "@/lib/engine/iam-engine";
import type { IamRole } from "@/lib/engine/resource-models";
import { createRole, deleteRole, instancesUsingRole, setRolePolicies } from "@/lib/project/iam-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, resourceHref, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, TextArea, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { useQueryTab } from "../common";
import { PolicyDocumentView, PolicyName, PolicyPicker } from "./iam-shared";

export const TRUSTED_ENTITY_LABEL: Record<IamRole["trustedEntity"], string> = {
  "ec2.amazonaws.com": "AWS 서비스: EC2",
  "lambda.amazonaws.com": "AWS 서비스: Lambda",
  account: "AWS 계정: 이 계정",
};

export function RoleListPage() {
  const project = useProject();
  const run = useRunAction();
  const { roles } = project.services.iam;
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const current = roles.find((r) => r.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="iam-role" />
      <ResourceTable<IamRole>
        ariaLabel="IAM 역할 목록"
        items={roles}
        trackBy={(r) => r.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.name}
        header={
          <PageHeader
            title="역할"
            counter={`(${roles.length})`}
            info={<InfoLink topic="iam-role" />}
            description="역할은 장기 키 없이 잠시 빌려 쓰는 권한입니다. EC2 서버에 역할을 붙이면 키를 서버에 넣지 않고도 S3 등을 쓸 수 있습니다."
            actions={
              <>
                <Button disabled={!current} onClick={() => setDeleting(true)}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/iam/roles/create")}>
                  역할 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="역할 없음" description="EC2 인스턴스가 S3에 접근해야 한다면 'AWS 서비스 → EC2' 역할을 만들어 보세요." action={<ButtonLink href={href("/iam/roles/create")}>역할 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "역할 이름", cell: (r) => <a className="font-bold text-aws-link hover:underline" href={href(`/iam/roles/${r.id}`)}>{r.name}</a>, sortValue: (r) => r.name },
          { id: "trusted", header: "신뢰할 수 있는 엔터티", cell: (r) => TRUSTED_ENTITY_LABEL[r.trustedEntity] },
          { id: "policies", header: "권한 정책", cell: (r) => `${r.policyIds.length}개` },
          { id: "instances", header: "사용 중인 인스턴스", cell: (r) => `${instancesUsingRole(project, r.id).length}대` },
          { id: "created", header: "생성일", cell: (r) => formatDateTime(r.createdAt), sortValue: (r) => r.createdAt, optional: true },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`역할 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteRole", (p) => deleteRole(p, current.id), { success: () => `역할 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>이 역할을 쓰는 인스턴스가 있으면 삭제할 수 없습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

const ENTITY_TILES: { value: IamRole["trustedEntity"]; label: string; description: string }[] = [
  { value: "ec2.amazonaws.com", label: "AWS 서비스 - EC2", description: "EC2 인스턴스가 이 역할의 권한으로 다른 서비스를 호출합니다. 가장 흔한 사용 사례입니다." },
  { value: "lambda.amazonaws.com", label: "AWS 서비스 - Lambda", description: "Lambda 함수용 역할입니다. (이 시뮬레이터에서 Lambda 실행은 지원하지 않습니다)" },
  { value: "account", label: "AWS 계정 - 이 계정", description: "같은 계정의 사용자가 역할을 넘겨받아(AssumeRole) 잠시 다른 권한으로 작업합니다." },
];

export function CreateRolePage() {
  const run = useRunAction();
  const { query } = useHashLocation();
  // 인스턴스의 'IAM 역할 수정'에서 왔다면 만든 뒤 그 화면으로 돌아간다 (콘솔 내부 경로만 허용)
  const rawReturn = query.get("returnTo");
  const returnTo = rawReturn && /^\/[\w/.-]+$/.test(rawReturn) ? rawReturn : null;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [entity, setEntity] = useState<IamRole["trustedEntity"]>(query.get("service") === "lambda" ? "lambda.amazonaws.com" : "ec2.amazonaws.com");
  const [policyIds, setPolicyIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    const r = run("CreateRole", (p) => createRole(p, { name, description, trustedEntity: entity, policyIds }), {
      success: () => `역할 ${name.trim()}을(를) 만들었습니다.${returnTo ? " 이제 인스턴스에 연결할 수 있습니다." : ""}`,
    });
    if (r.ok && r.createdId) navigate(returnTo ?? `/iam/roles/${r.createdId}`, returnTo ? { query: { roleId: r.createdId } } : {});
    else if (!r.ok) setError(withHint(r));
  };
  const steps = ["신뢰할 수 있는 엔터티 선택", "권한 추가", "이름 지정, 검토 및 생성"];
  return (
    <SpaceBetween>
      <PageHeader title="역할 생성" info={<InfoLink topic="iam-role" />} description={`${step}단계 / 3단계 — ${steps[step - 1]}`} />
      <ol className="flex flex-wrap gap-4 text-[15px]" aria-label="단계">
        {steps.map((label, i) => (
          <li key={label} className={i + 1 === step ? "font-bold text-aws-link" : "text-aws-text-2"} aria-current={i + 1 === step ? "step" : undefined}>
            {i + 1}단계 · {label}
          </li>
        ))}
      </ol>
      {step === 1 && (
        <Container header={<ContainerHeader title="신뢰할 수 있는 엔터티 유형" description="누가 이 역할을 '넘겨받아' 쓸 수 있는지 정합니다. 이것이 신뢰 정책이 됩니다." />}>
          <Tiles aria-label="신뢰할 수 있는 엔터티" columns={3} value={entity} onChange={(v) => setEntity(v as IamRole["trustedEntity"])} items={ENTITY_TILES} />
        </Container>
      )}
      {step === 2 && (
        <Container header={<ContainerHeader title="권한 정책" info={<InfoLink topic="iam-policy" />} description="역할을 넘겨받은 쪽이 할 수 있는 일입니다. 필요한 만큼만 고르세요." />}>
          <PolicyPicker selected={policyIds} onChange={setPolicyIds} />
        </Container>
      )}
      {step === 3 && (
        <>
          <Container header={<ContainerHeader title="역할 세부 정보" />}>
            <SpaceBetween size="m">
              <FormField label="역할 이름" constraint="최대 64자. 영문자, 숫자, + = , . @ _ - 사용 가능">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: web-server-s3-read" maxLength={64} />
              </FormField>
              <FormField label="설명" optional>
                <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} placeholder="예: 웹 서버가 정적 파일 버킷을 읽기 위한 역할" />
              </FormField>
            </SpaceBetween>
          </Container>
          <Container header={<ContainerHeader title="1단계: 신뢰할 수 있는 엔터티" description="자동으로 만들어지는 신뢰 정책입니다." />}>
            <PolicyDocumentView document={trustPolicyDocument({ trustedEntity: entity })} kind="trust" />
          </Container>
          <Container header={<ContainerHeader title={`2단계: 권한 (${policyIds.length})`} />}>
            {policyIds.length ? (
              <ul className="space-y-1">
                {policyIds.map((pid) => (
                  <li key={pid}>
                    <PolicyName id={pid} />
                  </li>
                ))}
              </ul>
            ) : (
              <Alert type="warning">권한 정책이 없습니다. 역할을 넘겨받아도 아무 작업도 할 수 없습니다.</Alert>
            )}
          </Container>
        </>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        {step === 1 ? (
          <ButtonLink variant="link" href={href(returnTo ?? "/iam/roles")}>
            취소
          </ButtonLink>
        ) : (
          <Button variant="link" onClick={() => setStep((step - 1) as 1 | 2)}>
            이전
          </Button>
        )}
        {step < 3 ? (
          <Button variant="primary" onClick={() => setStep((step + 1) as 2 | 3)}>
            다음
          </Button>
        ) : (
          <Button variant="primary" onClick={create}>
            역할 생성
          </Button>
        )}
      </FormActions>
    </SpaceBetween>
  );
}

export function RoleDetailPage({ id }: { id: string }) {
  const project = useProject();
  const role = project.services.iam.roles.find((r) => r.id === id);
  const [tab, setTab] = useQueryTab("permissions");
  const [editing, setEditing] = useState(false);
  if (!role) {
    return (
      <Container>
        <EmptyState title="역할을 찾을 수 없습니다" action={<ButtonLink href={href("/iam/roles")}>역할 목록</ButtonLink>} />
      </Container>
    );
  }
  const instances = instancesUsingRole(project, role.id);
  return (
    <SpaceBetween>
      <PageHeader title={role.name} description={role.description || undefined} />
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "ARN (예시 계정)", value: <CopyText text={roleArn(role.name)} /> },
            { label: "신뢰할 수 있는 엔터티", value: TRUSTED_ENTITY_LABEL[role.trustedEntity] },
            { label: "생성일", value: formatDateTime(role.createdAt) },
            {
              label: "인스턴스 프로파일 ARN",
              value: role.trustedEntity === "ec2.amazonaws.com" ? <CopyText text={roleArn(role.name).replace(":role/", ":instance-profile/")} /> : "– (EC2용 역할만 생성됨)",
            },
            { label: "최대 세션 지속 시간", value: "1시간 (가상)" },
            { label: "사용 중인 인스턴스", value: `${instances.length}대` },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="역할 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "permissions",
            label: `권한 (${role.policyIds.length})`,
            content: (
              <Container header={<ContainerHeader title="권한 정책" actions={<Button onClick={() => setEditing(true)}>권한 추가/제거</Button>} />}>
                {role.policyIds.length ? (
                  <ul className="space-y-1">
                    {role.policyIds.map((pid) => (
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
          {
            id: "trust",
            label: "신뢰 관계",
            content: (
              <Container header={<ContainerHeader title="신뢰할 수 있는 엔터티" info={<InfoLink topic="iam-role" />} description="이 주체만 역할을 넘겨받을(sts:AssumeRole) 수 있습니다. 이 시뮬레이터에서는 생성 후 바꿀 수 없습니다." />}>
                <PolicyDocumentView document={trustPolicyDocument(role)} kind="trust" />
              </Container>
            ),
          },
          {
            id: "instances",
            label: `인스턴스 (${instances.length})`,
            content: (
              <Container
                header={
                  <ContainerHeader
                    title="이 역할을 쓰는 EC2 인스턴스"
                    description={role.trustedEntity === "ec2.amazonaws.com" ? "인스턴스 상세 → 작업 → 보안 → IAM 역할 수정에서 연결합니다." : "EC2를 신뢰하지 않는 역할은 인스턴스에 연결할 수 없습니다."}
                  />
                }
              >
                {instances.length ? (
                  <ul className="space-y-1">
                    {instances.map((i) => (
                      <li key={i.id}>
                        <a className="text-aws-link hover:underline" href={resourceHref("ec2", i.id)}>
                          {i.id}
                        </a>{" "}
                        {i.name && <span className="text-aws-text-2">({i.name})</span>} <Badge>{i.config.state}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[15px] text-aws-text-2">연결된 인스턴스가 없습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      {editing && <EditRolePolicies role={role} onClose={() => setEditing(false)} />}
    </SpaceBetween>
  );
}

function EditRolePolicies({ role, onClose }: { role: IamRole; onClose: () => void }) {
  const run = useRunAction();
  const [selected, setSelected] = useState(role.policyIds);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      size="large"
      onClose={onClose}
      title={`${role.name}의 권한 정책`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const r = run("AttachRolePolicy", (p) => setRolePolicies(p, role.id, selected), { success: () => "역할 권한을 변경했습니다." });
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
