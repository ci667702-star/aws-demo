"use client";

import { ArrowRight } from "lucide-react";
import { effectivePolicyIds, SANDBOX_ACCOUNT_ID } from "@/lib/engine/iam-engine";
import type { Project } from "@/lib/engine/resource-models";
import { useProject } from "../../console-context";
import { href } from "../../router";
import { ButtonLink } from "../../ui/button";
import { Container, ContainerHeader, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { PageGuide } from "../../ui/page-guide";
import { CopyText, StatusIndicator, type StatusType } from "../../ui/status";
import { StartTutorialButton } from "../../tutorial/tutorial-menu";
import { ResourceTiles } from "../dashboards";

interface Recommendation {
  title: string;
  status: StatusType;
  detail: string;
  link?: { label: string; path: string };
}

/** AWS IAM 대시보드의 '보안 권장 사항'을 흉내 낸 점검 */
export function iamRecommendations(project: Project): Recommendation[] {
  const { users } = project.services.iam;
  const recs: Recommendation[] = [];
  recs.push(
    users.length
      ? { title: "일상 작업에 IAM 사용자 사용", status: "success", detail: `IAM 사용자 ${users.length}명이 있습니다. 루트 사용자는 계정 설정처럼 꼭 필요한 일에만 씁니다.` }
      : { title: "일상 작업에 IAM 사용자 사용", status: "info", detail: "루트 사용자 대신 쓸 IAM 사용자를 만드세요.", link: { label: "사용자 생성", path: "/iam/users/create" } },
  );
  const noMfa = users.filter((u) => u.consoleAccess && !u.mfaEnabled);
  recs.push(
    noMfa.length
      ? { title: "콘솔 사용자에게 MFA 할당", status: "warning", detail: `MFA 없이 콘솔에 로그인하는 사용자: ${noMfa.map((u) => u.name).join(", ")}`, link: { label: `${noMfa[0].name} 보안 자격 증명`, path: `/iam/users/${noMfa[0].id}?tab=credentials` } }
      : { title: "콘솔 사용자에게 MFA 할당", status: "success", detail: "MFA가 없는 콘솔 사용자가 없습니다." },
  );
  const admins = users.filter((u) => effectivePolicyIds(project, { kind: "user", user: u }).includes("aws:AdministratorAccess"));
  recs.push(
    admins.length > 1
      ? { title: "관리자 권한 최소화", status: "warning", detail: `AdministratorAccess를 가진 사용자가 ${admins.length}명입니다 (${admins.map((u) => u.name).join(", ")}). 필요한 권한만 주세요.` }
      : { title: "관리자 권한 최소화", status: "success", detail: admins.length ? `관리자는 ${admins[0].name} 한 명입니다.` : "AdministratorAccess를 가진 사용자가 없습니다." },
  );
  const computeKeys = users.flatMap((u) => u.accessKeys.filter((k) => k.status === "Active" && k.useCase === "aws-compute").map(() => u));
  recs.push(
    computeKeys.length
      ? { title: "서버에는 액세스 키 대신 역할", status: "warning", detail: `AWS 컴퓨팅 서비스용으로 만든 활성 액세스 키가 ${computeKeys.length}개 있습니다. EC2에는 IAM 역할을 연결하세요.`, link: { label: "EC2용 역할 생성", path: "/iam/roles/create?service=ec2" } }
      : { title: "서버에는 액세스 키 대신 역할", status: "success", detail: "서버용 장기 액세스 키가 없습니다." },
  );
  const twoActive = users.filter((u) => u.accessKeys.filter((k) => k.status === "Active").length > 1);
  if (twoActive.length) {
    recs.push({ title: "사용하지 않는 액세스 키 정리", status: "info", detail: `활성 키가 2개인 사용자: ${twoActive.map((u) => u.name).join(", ")}. 키를 교체한 뒤에는 옛 키를 비활성화하고 삭제하세요.` });
  }
  return recs;
}

const FLOW = [
  { title: "누가 (주체)", body: "IAM 사용자, 역할, 또는 인터넷의 익명 사용자" },
  { title: "무엇을 (작업)", body: "예: s3:GetObject (객체 읽기), ec2:RunInstances" },
  { title: "어디에 (리소스)", body: "예: arn:aws:s3:::my-bucket/*" },
  { title: "결과", body: "명시적 Deny가 있으면 거부 → Allow가 있으면 허용 → 아무것도 없으면 기본 거부" },
];

export function IamDashboardPage() {
  const project = useProject();
  const { users, groups, roles, policies } = project.services.iam;
  const keys = users.flatMap((u) => u.accessKeys);
  const recs = iamRecommendations(project);
  return (
    <SpaceBetween>
      <PageHeader
        title="IAM 대시보드"
        info={<InfoLink topic="iam" />}
        description="IAM(Identity and Access Management)은 '누가 무엇을 할 수 있는지' 정하는 서비스입니다. 이 샌드박스의 IAM은 가상이며 실제 AWS 계정·자격 증명과 연결되지 않습니다."
        actions={
          <>
            <StartTutorialButton tutorialId="iam-access-key" label="따라하기 튜토리얼" />
            <ButtonLink variant="primary" href={href("/iam/users/create")}>
              사용자 생성
            </ButtonLink>
          </>
        }
      />
      <PageGuide topic="iam" />
      <Container header={<ContainerHeader title="IAM 리소스" />}>
        <ResourceTiles
          tiles={[
            { label: "사용자 그룹", value: groups.length, path: "/iam/groups" },
            { label: "사용자", value: users.length, path: "/iam/users", detail: `콘솔 접근 ${users.filter((u) => u.consoleAccess).length}명` },
            { label: "역할", value: roles.length, path: "/iam/roles" },
            { label: "고객 관리형 정책", value: policies.length, path: "/iam/policies" },
            { label: "액세스 키 (가상)", value: keys.length, path: "/iam/users", detail: `활성 ${keys.filter((k) => k.status === "Active").length}개` },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="권한은 이렇게 결정됩니다" info={<InfoLink topic="iam-policy" />} />}>
        <ol className="grid gap-3 md:grid-cols-4">
          {FLOW.map((f, i) => (
            <li key={f.title} className="relative rounded-xl border border-aws-border bg-aws-surface-2 p-4">
              <p className="text-sm font-bold text-aws-link">
                {i + 1}. {f.title}
              </p>
              <p className="mt-1 text-[15px] leading-relaxed text-aws-text">{f.body}</p>
              {i < FLOW.length - 1 && <ArrowRight className="absolute top-1/2 -right-3 hidden size-5 -translate-y-1/2 text-aws-text-2 md:block" aria-hidden />}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-aws-text-2">
          직접 확인해 보려면{" "}
          <a className="text-aws-link hover:underline" href={href("/iam/simulator")}>
            정책 시뮬레이터
          </a>
          에서 주체·작업·리소스를 골라 보세요.
        </p>
      </Container>
      <Container header={<ContainerHeader title="보안 권장 사항" description="AWS 모범 사례를 기준으로 이 샌드박스의 IAM 설정을 점검합니다." />}>
        <ul className="divide-y divide-aws-divider">
          {recs.map((r) => (
            <li key={r.title} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-0.5">
                <StatusIndicator type={r.status}>
                  <span className="font-bold">{r.title}</span>
                </StatusIndicator>
                <p className="pl-6 text-sm text-aws-text-2">{r.detail}</p>
              </div>
              {r.link && (
                <a className="text-sm text-aws-link hover:underline" href={href(r.link.path)}>
                  {r.link.label}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Container>
      <Container header={<ContainerHeader title="AWS 계정 (가상)" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "계정 ID", value: <CopyText text={SANDBOX_ACCOUNT_ID} />, info: undefined },
            { label: "계정 별칭", value: "없음" },
            { label: "참고", value: "123456789012는 AWS 문서에서 쓰는 예시 계정 ID입니다." },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
}
