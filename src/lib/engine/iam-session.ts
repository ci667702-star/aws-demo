/**
 * 지금 작업하는 자격 증명 (가상 콘솔 로그인).
 * 프로젝트의 services.iam.session에 사용자·역할 ID만 저장하고, 없으면 루트 사용자로 본다.
 * 실제 로그인·암호·임시 자격 증명은 만들지 않는다.
 */
import { ACCOUNT_ROOT_ARN, principalArn, SANDBOX_ACCOUNT_ID, type IamPrincipal } from "./iam-engine";
import type { IamRole, IamUser, Project } from "./resource-models";

export type ActingIdentity =
  | { kind: "root" }
  | { kind: "user"; user: IamUser }
  | { kind: "role"; role: IamRole; sourceUser: IamUser | null };

/** 저장된 세션을 실제 사용자·역할로 풀어 준다. 대상이 지워졌으면 루트로 돌아간다. */
export function actingIdentity(project: Project): ActingIdentity {
  const session = project.services.iam.session;
  if (!session) return { kind: "root" };
  const { users, roles } = project.services.iam;
  if (session.kind === "user") {
    const user = users.find((u) => u.id === session.id);
    return user ? { kind: "user", user } : { kind: "root" };
  }
  const role = roles.find((r) => r.id === session.id);
  if (!role) return { kind: "root" };
  return { kind: "role", role, sourceUser: users.find((u) => u.id === session.sourceUserId) ?? null };
}

/** IAM 평가에 쓰는 주체. 루트는 정책과 관계없이 모두 허용되므로 null */
export function actingPrincipal(identity: ActingIdentity): IamPrincipal | null {
  if (identity.kind === "user") return { kind: "user", user: identity.user };
  if (identity.kind === "role") return { kind: "role", role: identity.role };
  return null;
}

/** 오류 메시지에 쓰는 ARN (역할은 AWS처럼 assumed-role ARN) */
export function actingArn(identity: ActingIdentity): string {
  if (identity.kind === "root") return ACCOUNT_ROOT_ARN;
  if (identity.kind === "role") {
    const session = identity.sourceUser?.name ?? "console";
    return `arn:aws:sts::${SANDBOX_ACCOUNT_ID}:assumed-role/${identity.role.name}/${session}`;
  }
  return principalArn({ kind: "user", user: identity.user }) ?? ACCOUNT_ROOT_ARN;
}

export function actingLabel(identity: ActingIdentity): string {
  if (identity.kind === "root") return "루트 사용자";
  if (identity.kind === "user") return `IAM 사용자 ${identity.user.name}`;
  return identity.sourceUser ? `역할 ${identity.role.name} (사용자 ${identity.sourceUser.name}이(가) 전환)` : `역할 ${identity.role.name}`;
}

/** 짧은 이름 (상단 메뉴 표시용) */
export function actingShortName(identity: ActingIdentity): string {
  if (identity.kind === "root") return "루트";
  if (identity.kind === "user") return identity.user.name;
  return identity.role.name;
}

export function roleTrustsAccount(role: IamRole): boolean {
  return role.trustedEntity === "account";
}

