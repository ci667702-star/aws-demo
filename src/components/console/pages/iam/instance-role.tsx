"use client";

import { useState } from "react";
import { displayName } from "@/lib/engine/topology-engine";
import { setInstanceRole } from "@/lib/project/iam-actions";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, resourcePath, useHashLocation } from "../../router";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, SelectInput } from "../../ui/form";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { ResourceNotFound, useResource } from "../common";

/** 인스턴스에 연결된 IAM 역할 링크 */
export function InstanceRoleLink({ roleId }: { roleId: string | null }) {
  const role = useProject().services.iam.roles.find((r) => r.id === roleId);
  if (!roleId) return <>–</>;
  if (!role) return <span className="text-aws-text-2">{roleId} (삭제됨)</span>;
  return (
    <a className="text-aws-link hover:underline" href={href(`/iam/roles/${role.id}`)}>
      {role.name}
    </a>
  );
}

/** EC2용(EC2를 신뢰하는) 역할 선택 상자 */
export function Ec2RoleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const roles = useProject().services.iam.roles;
  return (
    <SelectInput
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: "IAM 역할 없음" },
        ...roles.map((r) => ({
          value: r.id,
          label: r.name,
          description: r.trustedEntity === "ec2.amazonaws.com" ? `권한 정책 ${r.policyIds.length}개` : "EC2를 신뢰하지 않아 선택할 수 없음",
          disabled: r.trustedEntity !== "ec2.amazonaws.com",
        })),
      ]}
    />
  );
}

export function ModifyInstanceRolePage({ id }: { id: string }) {
  const inst = useResource(id, "ec2");
  const run = useRunAction();
  const { query } = useHashLocation();
  // 역할 생성 화면에서 돌아오면 방금 만든 역할을 미리 선택한다
  const [roleId, setRoleId] = useState(query.get("roleId") ?? inst?.config.iamRoleId ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!inst) return <ResourceNotFound type="ec2" id={id} />;
  const back = resourcePath("ec2", inst.id);
  const save = () => {
    const r = run("ReplaceIamInstanceProfileAssociation", (p) => setInstanceRole(p, inst.id, roleId || null), {
      success: () => (roleId ? `인스턴스 ${inst.id}에 IAM 역할을 연결했습니다.` : `인스턴스 ${inst.id}에서 IAM 역할을 분리했습니다.`),
    });
    if (r.ok) navigate(back, { query: { tab: "security" } });
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader
        title="IAM 역할 수정"
        info={<InfoLink topic="iam-role" />}
        description={`${inst.id} (${displayName(inst)}) — 이 서버 안의 프로그램은 연결한 역할의 권한으로 AWS를 호출합니다. 서버에 액세스 키를 넣을 필요가 없습니다.`}
      />
      <Container header={<ContainerHeader title="IAM 역할" description="역할을 바꾸면 실행 중인 인스턴스에도 바로 적용됩니다 (실제 AWS에서는 몇 초 걸릴 수 있음)." />}>
        <SpaceBetween size="m">
          <FormField label="IAM 역할" description="신뢰할 수 있는 엔터티가 'AWS 서비스: EC2'인 역할만 고를 수 있습니다." error={error ?? undefined}>
            <Ec2RoleSelect value={roleId} onChange={setRoleId} />
          </FormField>
          <p className="text-sm">
            <a className="text-aws-link hover:underline" href={href("/iam/roles/create", { service: "ec2", returnTo: `${back}/iam-role` })}>
              새 IAM 역할 생성
            </a>
          </p>
        </SpaceBetween>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(back)}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          IAM 역할 업데이트
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
