/**
 * 가상 IAM 콘솔 동작. 실제 자격 증명을 만들지 않는다.
 * 액세스 키는 PGSIM으로 시작하는 가상 값이며, 비밀 키는 만들 때 한 번만 돌려주고 저장하지 않는다.
 */
import { checkPolicyDocument, managedPolicy, policyAttachments } from "@/lib/engine/iam-engine";
import { createId } from "@/lib/engine/ids";
import type { IamAccessKey, IamGroup, IamPolicy, IamRole, IamUser, Project, ResourceOfType, Services } from "@/lib/engine/resource-models";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withIam(project: Project, update: (iam: Services["iam"]) => Services["iam"]): Project {
  return touch({ ...project, services: { ...project.services, iam: update(project.services.iam) } });
}

const NAME_PATTERN = /^[\w+=,.@-]+$/;

function checkName(kind: string, name: string, max: number): ActionResult | null {
  if (!name) return awsFail("ValidationError", `${kind} 이름을 입력하세요.`);
  if (name.length > max) return awsFail("ValidationError", `${kind} 이름은 ${max}자 이하여야 합니다.`);
  if (!NAME_PATTERN.test(name)) return awsFail("ValidationError", `${kind} 이름에는 영문자, 숫자, + = , . @ _ - 만 쓸 수 있습니다.`);
  return null;
}

function checkPolicyIds(project: Project, ids: string[]): ActionResult | null {
  for (const id of ids) {
    if (!managedPolicy(id) && !project.services.iam.policies.some((p) => p.id === id)) return awsFail("NoSuchEntity", `정책 ${id}을(를) 찾을 수 없습니다.`);
  }
  if (new Set(ids).size > 10) return awsFail("LimitExceeded", "한 사용자·그룹·역할에는 관리형 정책을 10개까지 연결할 수 있습니다.");
  return null;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------- 사용자

export function createUser(project: Project, input: { name: string; groupIds: string[]; policyIds: string[]; consoleAccess: boolean }): ActionResult {
  const name = input.name.trim();
  const invalid = checkName("사용자", name, 64) ?? checkPolicyIds(project, input.policyIds);
  if (invalid) return invalid;
  const { users, groups } = project.services.iam;
  if (users.some((u) => sameName(u.name, name))) return awsFail("EntityAlreadyExists", `사용자 이름 ${name}이(가) 이미 있습니다.`);
  if (users.length >= 100) return awsFail("LimitExceeded", "이 시뮬레이터에서는 사용자를 100명까지 만들 수 있습니다.");
  for (const g of input.groupIds) if (!groups.some((x) => x.id === g)) return awsFail("NoSuchEntity", `그룹 ${g}을(를) 찾을 수 없습니다.`);
  const user: IamUser = {
    id: createId("iamuser"),
    name,
    createdAt: new Date().toISOString(),
    groupIds: [...new Set(input.groupIds)],
    policyIds: [...new Set(input.policyIds)],
    accessKeys: [],
    consoleAccess: input.consoleAccess,
    mfaEnabled: false,
  };
  return ok(withIam(project, (iam) => ({ ...iam, users: [...iam.users, user] })), [], user.id);
}

function findUser(project: Project, userId: string): IamUser | undefined {
  return project.services.iam.users.find((u) => u.id === userId);
}

function updateUser(project: Project, userId: string, update: (u: IamUser) => IamUser): Project {
  return withIam(project, (iam) => ({ ...iam, users: iam.users.map((u) => (u.id === userId ? update(u) : u)) }));
}

export function deleteUser(project: Project, userId: string): ActionResult {
  const user = findUser(project, userId);
  if (!user) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.");
  const notes = [
    user.accessKeys.length ? `액세스 키 ${user.accessKeys.length}개를 함께 삭제했습니다.` : null,
    user.groupIds.length ? `그룹 ${user.groupIds.length}개에서 제거했습니다.` : null,
  ].filter((n): n is string => !!n);
  return ok(withIam(project, (iam) => ({ ...iam, users: iam.users.filter((u) => u.id !== userId) })), notes);
}

export function setUserPolicies(project: Project, userId: string, policyIds: string[]): ActionResult {
  const user = findUser(project, userId);
  if (!user) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.");
  const invalid = checkPolicyIds(project, policyIds);
  if (invalid) return invalid;
  return ok(updateUser(project, userId, (u) => ({ ...u, policyIds: [...new Set(policyIds)] })));
}

export function setUserGroups(project: Project, userId: string, groupIds: string[]): ActionResult {
  const user = findUser(project, userId);
  if (!user) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.");
  for (const g of groupIds) if (!project.services.iam.groups.some((x) => x.id === g)) return awsFail("NoSuchEntity", `그룹 ${g}을(를) 찾을 수 없습니다.`);
  if (groupIds.length > 10) return awsFail("LimitExceeded", "사용자는 그룹 10개까지 속할 수 있습니다.");
  return ok(updateUser(project, userId, (u) => ({ ...u, groupIds: [...new Set(groupIds)] })));
}

export function setUserConsoleAccess(project: Project, userId: string, consoleAccess: boolean): ActionResult {
  if (!findUser(project, userId)) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.");
  return ok(updateUser(project, userId, (u) => ({ ...u, consoleAccess, mfaEnabled: consoleAccess ? u.mfaEnabled : false })));
}

export function setUserMfa(project: Project, userId: string, enabled: boolean): ActionResult {
  const user = findUser(project, userId);
  if (!user) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.");
  if (enabled && !user.consoleAccess) return awsFail("ValidationError", "콘솔 로그인이 없는 사용자에게는 MFA 연습을 할 수 없습니다. 먼저 콘솔 접근을 켜세요.");
  return ok(updateUser(project, userId, (u) => ({ ...u, mfaEnabled: enabled })));
}

// ---------------------------------------------------------------- 액세스 키 (가상)

const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function randomString(chars: string, length: number): string {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** 가상 액세스 키 생성 — 실제 AWS 키 형식(AKIA…)과 구별되도록 PGSIM으로 시작하고, 비밀 키에도 SIMULATED 표시를 넣는다 */
export function generateVirtualAccessKey(): { accessKeyId: string; secretAccessKey: string } {
  return { accessKeyId: `PGSIM${randomString(KEY_CHARS, 15)}`, secretAccessKey: `SIMULATED${randomString(SECRET_CHARS, 31)}` };
}

export type AccessKeyResult = (ActionResult & { ok: false }) | { ok: true; project: Project; notes: string[]; createdId: string; accessKeyId: string; secretAccessKey: string };

export function createAccessKey(project: Project, userId: string, input: { useCase: string; description: string }): AccessKeyResult {
  const user = findUser(project, userId);
  if (!user) return awsFail("NoSuchEntity", "사용자를 찾을 수 없습니다.") as AccessKeyResult;
  if (user.accessKeys.length >= 2) {
    return awsFail("LimitExceeded", "사용자당 액세스 키는 최대 2개입니다.", "사용하지 않는 키를 비활성화한 뒤 삭제하세요.") as AccessKeyResult;
  }
  if (input.description.length > 256) return awsFail("ValidationError", "설명은 256자 이하여야 합니다.") as AccessKeyResult;
  const generated = generateVirtualAccessKey();
  const key: IamAccessKey = {
    id: generated.accessKeyId,
    secretHint: generated.secretAccessKey.slice(-4),
    status: "Active",
    useCase: input.useCase,
    description: input.description.trim(),
    createdAt: new Date().toISOString(),
  };
  return {
    ok: true,
    project: updateUser(project, userId, (u) => ({ ...u, accessKeys: [...u.accessKeys, key] })),
    notes: [],
    createdId: key.id,
    accessKeyId: generated.accessKeyId,
    secretAccessKey: generated.secretAccessKey,
  };
}

export function setAccessKeyStatus(project: Project, userId: string, keyId: string, status: IamAccessKey["status"]): ActionResult {
  const user = findUser(project, userId);
  if (!user?.accessKeys.some((k) => k.id === keyId)) return awsFail("NoSuchEntity", "액세스 키를 찾을 수 없습니다.");
  return ok(updateUser(project, userId, (u) => ({ ...u, accessKeys: u.accessKeys.map((k) => (k.id === keyId ? { ...k, status } : k)) })));
}

export function deleteAccessKey(project: Project, userId: string, keyId: string): ActionResult {
  const user = findUser(project, userId);
  const key = user?.accessKeys.find((k) => k.id === keyId);
  if (!user || !key) return awsFail("NoSuchEntity", "액세스 키를 찾을 수 없습니다.");
  if (key.status === "Active") return awsFail("ValidationError", "활성 상태의 키는 삭제할 수 없습니다.", "먼저 비활성화해 이 키를 쓰는 프로그램이 없는지 확인한 뒤 삭제하세요.");
  return ok(updateUser(project, userId, (u) => ({ ...u, accessKeys: u.accessKeys.filter((k) => k.id !== keyId) })));
}

// ---------------------------------------------------------------- 그룹

export function createGroup(project: Project, input: { name: string; policyIds: string[]; userIds: string[] }): ActionResult {
  const name = input.name.trim();
  const invalid = checkName("그룹", name, 128) ?? checkPolicyIds(project, input.policyIds);
  if (invalid) return invalid;
  const { groups, users } = project.services.iam;
  if (groups.some((g) => sameName(g.name, name))) return awsFail("EntityAlreadyExists", `그룹 이름 ${name}이(가) 이미 있습니다.`);
  if (groups.length >= 50) return awsFail("LimitExceeded", "이 시뮬레이터에서는 그룹을 50개까지 만들 수 있습니다.");
  for (const u of input.userIds) if (!users.some((x) => x.id === u)) return awsFail("NoSuchEntity", `사용자 ${u}을(를) 찾을 수 없습니다.`);
  const group: IamGroup = { id: createId("iamgroup"), name, createdAt: new Date().toISOString(), policyIds: [...new Set(input.policyIds)] };
  const members = new Set(input.userIds);
  return ok(
    withIam(project, (iam) => ({
      ...iam,
      groups: [...iam.groups, group],
      users: iam.users.map((u) => (members.has(u.id) ? { ...u, groupIds: [...u.groupIds, group.id] } : u)),
    })),
    [],
    group.id,
  );
}

export function setGroupPolicies(project: Project, groupId: string, policyIds: string[]): ActionResult {
  if (!project.services.iam.groups.some((g) => g.id === groupId)) return awsFail("NoSuchEntity", "그룹을 찾을 수 없습니다.");
  const invalid = checkPolicyIds(project, policyIds);
  if (invalid) return invalid;
  return ok(withIam(project, (iam) => ({ ...iam, groups: iam.groups.map((g) => (g.id === groupId ? { ...g, policyIds: [...new Set(policyIds)] } : g)) })));
}

export function setGroupMembers(project: Project, groupId: string, userIds: string[]): ActionResult {
  if (!project.services.iam.groups.some((g) => g.id === groupId)) return awsFail("NoSuchEntity", "그룹을 찾을 수 없습니다.");
  const members = new Set(userIds);
  return ok(
    withIam(project, (iam) => ({
      ...iam,
      users: iam.users.map((u) => {
        const has = u.groupIds.includes(groupId);
        if (members.has(u.id) && !has) return { ...u, groupIds: [...u.groupIds, groupId] };
        if (!members.has(u.id) && has) return { ...u, groupIds: u.groupIds.filter((g) => g !== groupId) };
        return u;
      }),
    })),
  );
}

export function deleteGroup(project: Project, groupId: string): ActionResult {
  const group = project.services.iam.groups.find((g) => g.id === groupId);
  if (!group) return awsFail("NoSuchEntity", "그룹을 찾을 수 없습니다.");
  const members = project.services.iam.users.filter((u) => u.groupIds.includes(groupId)).length;
  return ok(
    withIam(project, (iam) => ({
      ...iam,
      groups: iam.groups.filter((g) => g.id !== groupId),
      users: iam.users.map((u) => ({ ...u, groupIds: u.groupIds.filter((g) => g !== groupId) })),
    })),
    members ? [`사용자 ${members}명이 그룹에서 제거되었습니다.`] : [],
  );
}

// ---------------------------------------------------------------- 역할

export function createRole(project: Project, input: { name: string; description: string; trustedEntity: IamRole["trustedEntity"]; policyIds: string[] }): ActionResult {
  const name = input.name.trim();
  const invalid = checkName("역할", name, 64) ?? checkPolicyIds(project, input.policyIds);
  if (invalid) return invalid;
  const { roles } = project.services.iam;
  if (roles.some((r) => sameName(r.name, name))) return awsFail("EntityAlreadyExists", `역할 이름 ${name}이(가) 이미 있습니다.`);
  if (input.description.length > 1000) return awsFail("ValidationError", "설명은 1000자 이하여야 합니다.");
  const role: IamRole = {
    id: createId("iamrole"),
    name,
    description: input.description.trim(),
    trustedEntity: input.trustedEntity,
    createdAt: new Date().toISOString(),
    policyIds: [...new Set(input.policyIds)],
  };
  return ok(withIam(project, (iam) => ({ ...iam, roles: [...iam.roles, role] })), [], role.id);
}

export function setRolePolicies(project: Project, roleId: string, policyIds: string[]): ActionResult {
  if (!project.services.iam.roles.some((r) => r.id === roleId)) return awsFail("NoSuchEntity", "역할을 찾을 수 없습니다.");
  const invalid = checkPolicyIds(project, policyIds);
  if (invalid) return invalid;
  return ok(withIam(project, (iam) => ({ ...iam, roles: iam.roles.map((r) => (r.id === roleId ? { ...r, policyIds: [...new Set(policyIds)] } : r)) })));
}

export function instancesUsingRole(project: Project, roleId: string): ResourceOfType<"ec2">[] {
  return project.resources.filter((r): r is ResourceOfType<"ec2"> => r.type === "ec2" && r.config.iamRoleId === roleId && r.config.state !== "terminated");
}

export function deleteRole(project: Project, roleId: string): ActionResult {
  const role = project.services.iam.roles.find((r) => r.id === roleId);
  if (!role) return awsFail("NoSuchEntity", "역할을 찾을 수 없습니다.");
  const users = instancesUsingRole(project, roleId);
  if (users.length) {
    return awsFail("DeleteConflict", `역할 ${role.name}이(가) 인스턴스 ${users.map((u) => u.id).join(", ")}에 연결되어 있습니다.`, "인스턴스의 IAM 역할을 먼저 해제하세요.");
  }
  return ok(withIam(project, (iam) => ({ ...iam, roles: iam.roles.filter((r) => r.id !== roleId) })));
}

/** EC2 인스턴스에 IAM 역할(인스턴스 프로파일) 연결/해제 */
export function setInstanceRole(project: Project, instanceId: string, roleId: string | null): ActionResult {
  const ec2 = project.resources.find((r) => r.id === instanceId);
  if (!ec2 || ec2.type !== "ec2") return awsFail("InvalidInstanceID.NotFound", "인스턴스를 찾을 수 없습니다.");
  if (ec2.config.state === "terminated") return awsFail("IncorrectInstanceState", "종료된 인스턴스입니다.");
  if (roleId) {
    const role = project.services.iam.roles.find((r) => r.id === roleId);
    if (!role) return awsFail("NoSuchEntity", "역할을 찾을 수 없습니다.");
    if (role.trustedEntity !== "ec2.amazonaws.com") {
      return awsFail("InvalidParameterValue", `역할 ${role.name}의 신뢰 정책이 EC2(ec2.amazonaws.com)를 허용하지 않습니다.`, "EC2용 역할(신뢰할 수 있는 엔터티: AWS 서비스 → EC2)을 만들어 연결하세요.");
    }
  }
  return ok(
    touch({
      ...project,
      resources: project.resources.map((r) => (r.id === instanceId && r.type === "ec2" ? { ...r, config: { ...r.config, iamRoleId: roleId } } : r)),
    }),
  );
}

// ---------------------------------------------------------------- 정책

export function createPolicy(project: Project, input: { name: string; description: string; document: string }): ActionResult {
  const name = input.name.trim();
  const invalid = checkName("정책", name, 128);
  if (invalid) return invalid;
  const all = project.services.iam.policies;
  if (all.some((p) => sameName(p.name, name))) return awsFail("EntityAlreadyExists", `정책 이름 ${name}이(가) 이미 있습니다.`);
  if (managedPolicy(`aws:${name}`)) return awsFail("EntityAlreadyExists", `${name}은(는) AWS 관리형 정책 이름과 같습니다. 다른 이름을 쓰세요.`);
  const check = checkPolicyDocument(input.document, "identity");
  if (!check.ok) return awsFail("MalformedPolicyDocument", check.errors[0]);
  const now = new Date().toISOString();
  const policy: IamPolicy = { id: createId("iampolicy"), name, description: input.description.trim(), document: input.document, createdAt: now, updatedAt: now };
  return ok(withIam(project, (iam) => ({ ...iam, policies: [...iam.policies, policy] })), check.warnings, policy.id);
}

export function updatePolicyDocument(project: Project, policyId: string, document: string): ActionResult {
  if (!project.services.iam.policies.some((p) => p.id === policyId)) return awsFail("NoSuchEntity", "정책을 찾을 수 없습니다.");
  const check = checkPolicyDocument(document, "identity");
  if (!check.ok) return awsFail("MalformedPolicyDocument", check.errors[0]);
  const now = new Date().toISOString();
  return ok(withIam(project, (iam) => ({ ...iam, policies: iam.policies.map((p) => (p.id === policyId ? { ...p, document, updatedAt: now } : p)) })), check.warnings);
}

export function deletePolicy(project: Project, policyId: string): ActionResult {
  const policy = project.services.iam.policies.find((p) => p.id === policyId);
  if (!policy) return awsFail("NoSuchEntity", "정책을 찾을 수 없습니다.");
  const a = policyAttachments(project, policyId);
  const count = a.users.length + a.groups.length + a.roles.length;
  if (count) return awsFail("DeleteConflict", `정책 ${policy.name}이(가) 사용자·그룹·역할 ${count}곳에 연결되어 있습니다.`, "연결된 엔터티 탭에서 먼저 분리하세요.");
  return ok(withIam(project, (iam) => ({ ...iam, policies: iam.policies.filter((p) => p.id !== policyId) })));
}
