/** AWS IAM 대시보드의 '보안 권장 사항'을 흉내 낸 점검 (콘솔 IAM 대시보드와 리소스 설명 패널이 함께 쓴다) */
import { effectivePolicyIds } from "./iam-engine";
import type { Project } from "./resource-models";

export interface IamRecommendation {
  title: string;
  tone: "ok" | "warn" | "info";
  detail: string;
  /** 심화 모드 콘솔 경로 */
  link?: { label: string; path: string };
}

export function iamRecommendations(project: Project): IamRecommendation[] {
  const { users } = project.services.iam;
  const recs: IamRecommendation[] = [];
  recs.push(
    users.length
      ? { title: "일상 작업에 IAM 사용자 사용", tone: "ok", detail: `IAM 사용자 ${users.length}명이 있습니다. 루트 사용자는 계정 설정처럼 꼭 필요한 일에만 씁니다.` }
      : { title: "일상 작업에 IAM 사용자 사용", tone: "info", detail: "루트 사용자 대신 쓸 IAM 사용자를 만드세요.", link: { label: "사용자 생성", path: "/iam/users/create" } },
  );
  const noMfa = users.filter((u) => u.consoleAccess && !u.mfaEnabled);
  recs.push(
    noMfa.length
      ? { title: "콘솔 사용자에게 MFA 할당", tone: "warn", detail: `MFA 없이 콘솔에 로그인하는 사용자: ${noMfa.map((u) => u.name).join(", ")}`, link: { label: `${noMfa[0].name} 보안 자격 증명`, path: `/iam/users/${noMfa[0].id}?tab=credentials` } }
      : { title: "콘솔 사용자에게 MFA 할당", tone: "ok", detail: "MFA가 없는 콘솔 사용자가 없습니다." },
  );
  const admins = users.filter((u) => effectivePolicyIds(project, { kind: "user", user: u }).includes("aws:AdministratorAccess"));
  recs.push(
    admins.length > 1
      ? { title: "관리자 권한 최소화", tone: "warn", detail: `AdministratorAccess를 가진 사용자가 ${admins.length}명입니다 (${admins.map((u) => u.name).join(", ")}). 필요한 권한만 주세요.` }
      : { title: "관리자 권한 최소화", tone: "ok", detail: admins.length ? `관리자는 ${admins[0].name} 한 명입니다.` : "AdministratorAccess를 가진 사용자가 없습니다." },
  );
  const computeKeys = users.flatMap((u) => u.accessKeys.filter((k) => k.status === "Active" && k.useCase === "aws-compute"));
  recs.push(
    computeKeys.length
      ? { title: "서버에는 액세스 키 대신 역할", tone: "warn", detail: `AWS 컴퓨팅 서비스용으로 만든 활성 액세스 키가 ${computeKeys.length}개 있습니다. EC2에는 IAM 역할을 연결하세요.`, link: { label: "EC2용 역할 생성", path: "/iam/roles/create?service=ec2" } }
      : { title: "서버에는 액세스 키 대신 역할", tone: "ok", detail: "서버용 장기 액세스 키가 없습니다." },
  );
  const twoActive = users.filter((u) => u.accessKeys.filter((k) => k.status === "Active").length > 1);
  if (twoActive.length) {
    recs.push({ title: "사용하지 않는 액세스 키 정리", tone: "info", detail: `활성 키가 2개인 사용자: ${twoActive.map((u) => u.name).join(", ")}. 키를 교체한 뒤에는 옛 키를 비활성화하고 삭제하세요.` });
  }
  return recs;
}
