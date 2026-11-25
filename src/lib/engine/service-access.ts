/**
 * "누가 어디서 AWS API를 부르는가" 판정 (Secrets Manager·Systems Manager 접근 테스트가 함께 쓴다).
 * - 어디서: EC2 인스턴스나 VPC에 연결한 Lambda는 서비스의 퍼블릭 엔드포인트(HTTPS 443)까지 나가는 길이 있어야 한다.
 *   (실제 AWS에서는 VPC 인터페이스 엔드포인트로도 닿을 수 있지만 이 시뮬레이터는 지원하지 않는다)
 * - 누구로: IAM 사용자의 액세스 키, 역할의 임시 자격 증명, 인스턴스 프로파일, Lambda 실행 역할
 * 실제 요청은 보내지 않고, 샌드박스 설정으로 결과를 계산한다.
 */
import { parseIpv4 } from "./cidr-utils";
import { simulateWithTopology } from "./connectivity-engine";
import { evaluateIam, principalLabel, type IamDecision, type IamPrincipal } from "./iam-engine";
import { analyzeInvocation, internetPath } from "./lambda-engine";
import type { Project, Secret } from "./resource-models";
import { currentVersion, isPendingDeletion, liveSecrets, secretArn, SECRETS_ENDPOINT_HOST } from "./secrets-engine";
import { evaluateSecurityGroups } from "./security-group-engine";
import { parameterArn, SSM_ENDPOINT_HOST } from "./ssm-engine";
import { displayName, type Topology } from "./topology-engine";

export type ApiCaller =
  | { kind: "user"; userId: string }
  | { kind: "role"; roleId: string }
  | { kind: "instance"; instanceId: string }
  | { kind: "lambda"; functionId: string };

export interface AccessStep {
  title: string;
  status: "pass" | "fail" | "info" | "warn";
  detail: string;
  link?: { label: string; path: string };
}

export interface ApiAccessResult {
  ok: boolean;
  /** AWS 오류 코드 (성공이면 "OK") */
  code: string;
  summary: string;
  steps: AccessStep[];
  principal: IamPrincipal | null;
  decision: IamDecision | null;
}

/** AWS 서비스 퍼블릭 엔드포인트를 대표하는 문서용 주소 (실제 주소 아님) */
const ENDPOINT_IP = "192.0.2.90";
const ENDPOINT = parseIpv4(ENDPOINT_IP)!;

export interface CallerResolution {
  principal: IamPrincipal | null;
  steps: AccessStep[];
  failure: { code: string; summary: string } | null;
}

/** 호출자가 서비스 엔드포인트까지 닿는지와, 어떤 자격 증명으로 요청에 서명하는지 */
export function resolveApiCaller(project: Project, topo: Topology, caller: ApiCaller, endpointHost: string): CallerResolution {
  const steps: AccessStep[] = [];
  const fail = (code: string, summary: string): CallerResolution => ({ principal: null, steps, failure: { code, summary } });
  const { users, roles } = project.services.iam;

  if (caller.kind === "user") {
    const user = users.find((u) => u.id === caller.userId);
    if (!user) {
      steps.push({ title: "자격 증명", status: "fail", detail: "IAM 사용자를 찾을 수 없습니다." });
      return fail("UnrecognizedClientException", "IAM 사용자를 찾을 수 없습니다.");
    }
    steps.push({ title: "네트워크", status: "info", detail: `인터넷(노트북의 CLI·SDK 등)에서 ${endpointHost}(으)로 요청한다고 가정합니다.` });
    const active = user.accessKeys.find((k) => k.status === "Active");
    if (!active) {
      steps.push({
        title: "자격 증명",
        status: "fail",
        detail: `${user.name}에게 활성 액세스 키가 없어 프로그램(CLI·SDK)이 요청에 서명할 수 없습니다.`,
        link: { label: "액세스 키 만들기", path: `/iam/users/${user.id}/create-access-key` },
      });
      return fail("UnrecognizedClientException", "사용할 수 있는 액세스 키가 없습니다.");
    }
    steps.push({ title: "자격 증명", status: "pass", detail: `${user.name}의 액세스 키 ${active.id}(가상)로 요청에 서명합니다.` });
    return { principal: { kind: "user", user }, steps, failure: null };
  }

  if (caller.kind === "role") {
    const role = roles.find((r) => r.id === caller.roleId);
    if (!role) {
      steps.push({ title: "자격 증명", status: "fail", detail: "역할을 찾을 수 없습니다." });
      return fail("AccessDeniedException", "역할을 찾을 수 없습니다.");
    }
    steps.push({ title: "자격 증명", status: "pass", detail: `역할 ${role.name}의 임시 자격 증명으로 요청한다고 가정합니다 (네트워크는 따지지 않음).` });
    return { principal: { kind: "role", role }, steps, failure: null };
  }

  if (caller.kind === "instance") {
    const inst = topo.getOfType(caller.instanceId, "ec2");
    if (!inst) {
      steps.push({ title: "요청하는 서버", status: "fail", detail: "인스턴스를 찾을 수 없습니다." });
      return fail("InstanceNotFound", "인스턴스를 찾을 수 없습니다.");
    }
    if (inst.config.state !== "running") {
      steps.push({ title: "요청하는 서버", status: "fail", detail: `${displayName(inst)}이(가) ${inst.config.state} 상태라 요청을 보낼 수 없습니다.` });
      return fail("InstanceNotRunning", "인스턴스가 실행 중이 아닙니다.");
    }
    const network = simulateWithTopology(topo, { source: { kind: "resource", resourceId: inst.id }, destination: { kind: "internet", ip: ENDPOINT_IP }, protocol: "tcp", port: 443 });
    const title = `네트워크: ${displayName(inst)} → ${endpointHost}:443`;
    if (network.outcome !== "success") {
      const fixes = network.failure?.fixes ?? [];
      steps.push({
        title,
        status: "fail",
        detail: `${network.failure?.reason ?? network.summary}${fixes.length ? ` 해결 방법: ${fixes[0]}` : ""} (프라이빗 서브넷이라면 NAT 경로가 필요합니다. 실제 AWS에서는 VPC 인터페이스 엔드포인트로도 닿을 수 있지만 이 시뮬레이터는 지원하지 않습니다.)`,
        link: { label: "Reachability Analyzer에서 자세히 보기", path: "/vpc/reachability/create" },
      });
      return fail("ConnectTimeout", "서버에서 서비스 엔드포인트까지 네트워크로 연결되지 않아 요청이 시간 초과됩니다.");
    }
    steps.push({ title, status: "pass", detail: "라우팅·보안 그룹·네트워크 ACL을 통과해 서비스의 퍼블릭 엔드포인트에 연결됩니다." });
    const role = roles.find((r) => r.id === inst.config.iamRoleId);
    if (!role) {
      steps.push({
        title: "자격 증명",
        status: "fail",
        detail: "인스턴스에 IAM 역할(인스턴스 프로파일)이 없어 요청에 서명할 자격 증명이 없습니다. 서버에 액세스 키를 넣지 말고 역할을 연결하세요.",
        link: { label: "IAM 역할 연결", path: `/ec2/instances/${inst.id}/iam-role` },
      });
      return fail("NoCredentialsError", "인스턴스에 자격 증명(IAM 역할)이 없습니다.");
    }
    steps.push({ title: "자격 증명", status: "pass", detail: `인스턴스에 연결된 역할 ${role.name}의 임시 자격 증명으로 요청에 서명합니다 (액세스 키를 서버에 저장하지 않음).` });
    return { principal: { kind: "role", role }, steps, failure: null };
  }

  const fn = topo.getOfType(caller.functionId, "lambda");
  if (!fn) {
    steps.push({ title: "요청하는 함수", status: "fail", detail: "Lambda 함수를 찾을 수 없습니다." });
    return fail("ResourceNotFoundException", "Lambda 함수를 찾을 수 없습니다.");
  }
  const role = roles.find((r) => r.id === fn.config.roleId);
  if (!role || role.trustedEntity !== "lambda.amazonaws.com") {
    steps.push({
      title: "자격 증명",
      status: "fail",
      detail: role ? `역할 ${role.name}의 신뢰 정책이 lambda.amazonaws.com을 허용하지 않아 함수가 실행되지 않습니다.` : "함수에 실행 역할이 없어 실행되지 않습니다.",
      link: { label: "함수 권한 구성", path: `/lambda/functions/${fn.id}?tab=config&section=permissions` },
    });
    return fail("InvalidParameterValueException", "함수의 실행 역할을 맡을 수 없습니다.");
  }
  const path = internetPath(topo, fn);
  const title = `네트워크: ${displayName(fn)} → ${endpointHost}:443`;
  if (!path.ok) {
    steps.push({ title, status: "fail", detail: `${path.detail} 연결을 기다리다 함수의 제한 시간이 지나 중단됩니다.`, link: { label: "함수 VPC 편집", path: `/lambda/functions/${fn.id}/edit-vpc` } });
    return fail("Task timed out", "VPC에 연결한 함수에서 서비스 엔드포인트로 나가는 경로(NAT)가 없습니다.");
  }
  const subnets = topo.lambdaSubnets(fn.id);
  if (subnets.length) {
    const out = evaluateSecurityGroups(topo.securityGroupsOf(fn.id), "outbound", { protocol: "tcp", port: 443, peerIp: ENDPOINT, peerSecurityGroupIds: [] });
    if (!out.allowed) {
      steps.push({ title, status: "fail", detail: "함수 보안 그룹의 아웃바운드 규칙이 HTTPS(443)를 허용하지 않아 연결을 기다리다 시간 초과됩니다." });
      return fail("Task timed out", "함수 보안 그룹이 HTTPS(443) 아웃바운드를 허용하지 않습니다.");
    }
  }
  steps.push({ title, status: path.partial ? "warn" : "pass", detail: path.detail });
  steps.push({ title: "자격 증명", status: "pass", detail: `실행 역할 ${role.name}의 임시 자격 증명으로 요청에 서명합니다.` });
  return { principal: { kind: "role", role }, steps, failure: null };
}

/** 자격 증명 기반 정책으로 작업이 허용되는지 평가하고 단계에 기록한다 */
export function evaluateApiPermission(project: Project, principal: IamPrincipal, action: string, resource: string, steps: AccessStep[]): IamDecision {
  const decision = evaluateIam(project, principal, action, resource);
  steps.push({
    title: `권한: ${principalLabel(principal)} → ${action}`,
    status: decision.decision === "allowed" ? "pass" : "fail",
    detail: `${decision.explanation.join(" ")} (리소스: ${resource})`,
    link: decision.decision === "allowed" ? undefined : { label: "정책 시뮬레이터", path: "/iam/simulator" },
  });
  return decision;
}

/** 접근 테스트에서 고를 수 있는 호출자 목록 */
export function apiCallerOptions(project: Project, topo: Topology): { value: string; label: string; caller: ApiCaller }[] {
  const { users, roles } = project.services.iam;
  return [
    ...topo.ofType("lambda").map((f) => ({ value: `lambda:${f.id}`, label: `Lambda 함수 ${displayName(f)}`, caller: { kind: "lambda" as const, functionId: f.id } })),
    ...topo
      .ofType("ec2")
      .filter((e) => e.config.state !== "terminated")
      .map((e) => ({ value: `instance:${e.id}`, label: `EC2 인스턴스 ${displayName(e)}`, caller: { kind: "instance" as const, instanceId: e.id } })),
    ...roles.map((r) => ({ value: `role:${r.id}`, label: `IAM 역할 ${r.name}`, caller: { kind: "role" as const, roleId: r.id } })),
    ...users.map((u) => ({ value: `user:${u.id}`, label: `IAM 사용자 ${u.name}`, caller: { kind: "user" as const, userId: u.id } })),
  ];
}

// ---------------------------------------------------------------- Secrets Manager

/** GetSecretValue 접근 테스트: 네트워크 → 자격 증명 → IAM 권한 → 보안 암호 상태 */
export function evaluateSecretAccess(project: Project, topo: Topology, secretId: string, caller: ApiCaller, now = Date.now()): ApiAccessResult {
  const resolved = resolveApiCaller(project, topo, caller, SECRETS_ENDPOINT_HOST);
  const { steps } = resolved;
  if (resolved.failure || !resolved.principal) return { ok: false, code: resolved.failure?.code ?? "AccessDeniedException", summary: resolved.failure?.summary ?? "요청할 수 없습니다.", steps, principal: null, decision: null };
  const principal = resolved.principal;
  const secret = liveSecrets(project, now).find((x) => x.id === secretId);
  if (!secret) {
    steps.push({ title: "보안 암호 확인", status: "fail", detail: "보안 암호가 없습니다 (삭제되었을 수 있습니다)." });
    return { ok: false, code: "ResourceNotFoundException", summary: "Secrets Manager can't find the specified secret.", steps, principal, decision: null };
  }
  const arn = secretArn(secret);
  const decision = evaluateApiPermission(project, principal, "secretsmanager:GetSecretValue", arn, steps);
  if (decision.decision !== "allowed") {
    return { ok: false, code: "AccessDeniedException", summary: decision.decision === "explicit-deny" ? "명시적 Deny 때문에 거부되었습니다." : "secretsmanager:GetSecretValue를 허용하는 정책이 없어 거부되었습니다.", steps, principal, decision };
  }
  if (isPendingDeletion(secret)) {
    steps.push({ title: "보안 암호 상태", status: "fail", detail: "삭제가 예약된 보안 암호는 값을 읽을 수 없습니다. 필요하면 복구 기간 안에 '삭제 취소'로 복원하세요.", link: { label: "보안 암호", path: `/secretsmanager/secrets/${secret.id}` } });
    return { ok: false, code: "InvalidRequestException", summary: "You can't perform this operation on the secret because it was marked for deletion.", steps, principal, decision };
  }
  steps.push({ title: "복호화 (KMS)", status: "info", detail: "기본 암호화 키(aws/secretsmanager)를 쓰므로 같은 계정의 호출자는 추가 KMS 권한 없이 복호화됩니다. 고객 관리형 키는 kms:Decrypt 권한이 더 필요하지만 이 시뮬레이터는 지원하지 않습니다." });
  const version = currentVersion(secret);
  steps.push({ title: "값 반환", status: "pass", detail: `AWSCURRENT 버전(${version.versionId.slice(0, 8)}…)의 값을 돌려줍니다. 이 시뮬레이터의 값은 연습용 가상 문자열입니다.` });
  return { ok: true, code: "OK", summary: "보안 암호 값을 읽을 수 있습니다.", steps, principal, decision };
}

export interface RotationCheck {
  title: string;
  status: "pass" | "fail";
  detail: string;
}

/** 교체 함수의 실행 역할에 필요한 권한 */
export const ROTATION_ROLE_ACTIONS = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"] as const;

/**
 * 교체(RotateSecret)가 성공할 조건: 교체 함수가 있고, Secrets Manager가 그 함수를 호출할 수 있고(리소스 기반 정책),
 * 함수가 실행되며, 함수의 실행 역할이 이 보안 암호를 읽고 새 버전을 쓸 수 있어야 한다.
 */
export function checkSecretRotation(project: Project, topo: Topology, secret: Secret): { ok: boolean; checks: RotationCheck[] } {
  const checks: RotationCheck[] = [];
  const fn = secret.rotation.lambdaId ? topo.getOfType(secret.rotation.lambdaId, "lambda") : null;
  if (!fn) {
    checks.push({ title: "교체 함수", status: "fail", detail: secret.rotation.lambdaId ? "교체 함수가 삭제되었습니다. 교체 구성에서 다른 함수를 고르세요." : "교체 함수(Lambda)가 지정되지 않았습니다. 교체 구성에서 함수를 고르세요." });
    return { ok: false, checks };
  }
  checks.push({ title: "교체 함수", status: "pass", detail: `${displayName(fn)} 함수가 새 값을 만들고 대상에 적용한다고 가정합니다 (코드는 실행하지 않음).` });
  const invokable = fn.config.permissions.some((p) => p.principal === "secretsmanager.amazonaws.com");
  checks.push(
    invokable
      ? { title: "함수 호출 권한", status: "pass", detail: "함수의 리소스 기반 정책이 secretsmanager.amazonaws.com의 호출을 허용합니다." }
      : { title: "함수 호출 권한", status: "fail", detail: `함수 ${displayName(fn)}의 리소스 기반 정책에 secretsmanager.amazonaws.com의 호출 허용이 없습니다. 함수의 구성 → 권한에서 추가하세요.` },
  );
  const run = analyzeInvocation(project, topo, fn);
  const runnable = run.outcome !== "invalid" && run.outcome !== "throttled";
  checks.push(
    runnable
      ? { title: "함수 실행", status: "pass", detail: "함수가 실행될 수 있습니다 (실행 역할·동시성 확인)." }
      : { title: "함수 실행", status: "fail", detail: `함수가 실행되지 않습니다: ${run.checks.find((c) => c.status === "fail")?.detail ?? run.errorMessage ?? run.outcome}` },
  );
  const role = run.role;
  if (role && runnable) {
    const arn = secretArn(secret);
    const missing = ROTATION_ROLE_ACTIONS.filter((a) => evaluateIam(project, { kind: "role", role }, a, arn).decision !== "allowed");
    checks.push(
      missing.length
        ? { title: "실행 역할의 보안 암호 권한", status: "fail", detail: `실행 역할 ${role.name}에 이 보안 암호에 대한 ${missing.join(", ")} 권한이 없어 새 버전을 쓸 수 없습니다.` }
        : { title: "실행 역할의 보안 암호 권한", status: "pass", detail: `실행 역할 ${role.name}이(가) 이 보안 암호를 읽고 새 버전을 쓸 수 있습니다.` },
    );
    const path = internetPath(topo, fn);
    checks.push(
      path.ok
        ? { title: "네트워크", status: "pass", detail: `함수가 Secrets Manager 엔드포인트에 닿습니다. ${path.detail}` }
        : { title: "네트워크", status: "fail", detail: `함수가 Secrets Manager 엔드포인트에 닿지 않습니다. ${path.detail}` },
    );
  }
  return { ok: checks.every((c) => c.status === "pass"), checks };
}

// ---------------------------------------------------------------- Parameter Store

/** GetParameter 접근 테스트 */
export function evaluateParameterAccess(project: Project, topo: Topology, parameterId: string, caller: ApiCaller, withDecryption: boolean): ApiAccessResult {
  const resolved = resolveApiCaller(project, topo, caller, SSM_ENDPOINT_HOST);
  const { steps } = resolved;
  if (resolved.failure || !resolved.principal) return { ok: false, code: resolved.failure?.code ?? "AccessDeniedException", summary: resolved.failure?.summary ?? "요청할 수 없습니다.", steps, principal: null, decision: null };
  const principal = resolved.principal;
  const param = project.services.ssm.parameters.find((p) => p.id === parameterId);
  if (!param) {
    steps.push({ title: "파라미터 확인", status: "fail", detail: "파라미터가 없습니다." });
    return { ok: false, code: "ParameterNotFound", summary: "파라미터를 찾을 수 없습니다.", steps, principal, decision: null };
  }
  const decision = evaluateApiPermission(project, principal, "ssm:GetParameter", parameterArn(param.name), steps);
  if (decision.decision !== "allowed") {
    return { ok: false, code: "AccessDeniedException", summary: decision.decision === "explicit-deny" ? "명시적 Deny 때문에 거부되었습니다." : "ssm:GetParameter를 허용하는 정책이 없어 거부되었습니다.", steps, principal, decision };
  }
  if (param.type === "SecureString") {
    steps.push(
      withDecryption
        ? { title: "복호화 (KMS)", status: "info", detail: "기본 키(alias/aws/ssm)로 암호화된 값은 ssm:GetParameter 권한이 있는 같은 계정의 호출자가 복호화할 수 있습니다. 고객 관리형 키는 kms:Decrypt 권한이 더 필요하지만 이 시뮬레이터는 지원하지 않습니다." }
        : { title: "복호화 (KMS)", status: "warn", detail: "WithDecryption 없이 읽으면 SecureString은 암호화된 값 그대로 나옵니다. 값을 쓰려면 --with-decryption으로 읽으세요." },
    );
  }
  steps.push({ title: "값 반환", status: "pass", detail: `버전 ${param.version}의 값을 돌려줍니다.` });
  return { ok: true, code: "OK", summary: "파라미터 값을 읽을 수 있습니다.", steps, principal, decision };
}
