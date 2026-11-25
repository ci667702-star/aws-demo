/**
 * Secrets Manager 콘솔 동작 (가상).
 * 비밀 값은 입력받거나 저장하지 않는다: 보안 암호에는 키 이름과 버전만 남기고, 화면의 값은 버전으로 계산한 연습용 문자열이다.
 */
import { createId } from "@/lib/engine/ids";
import type { Project, Resource, Secret, Services } from "@/lib/engine/resource-models";
import { arnSuffix, deletionTime, isPendingDeletion, isPurged, secretNameLooksLikeArnSuffix, validateSecretKeys, validateSecretName, withNewVersion } from "@/lib/engine/secrets-engine";
import { checkSecretRotation } from "@/lib/engine/service-access";
import { buildTopology } from "@/lib/engine/topology-engine";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withSecrets(project: Project, update: (sm: Services["secretsmanager"]) => Services["secretsmanager"]): Project {
  return touch({ ...project, services: { ...project.services, secretsmanager: update(project.services.secretsmanager) } });
}

/** 복구 기간이 끝난 보안 암호를 목록에서 정리한다 (AWS가 완전히 삭제한 것) */
function purge(project: Project, now: number): Project {
  const { secrets } = project.services.secretsmanager;
  return secrets.some((s) => isPurged(s, now)) ? { ...project, services: { ...project.services, secretsmanager: { secrets: secrets.filter((s) => !isPurged(s, now)) } } } : project;
}

const versionId = () => {
  const hex = () => createId("v").split("-").pop()!;
  // AWS의 버전 ID는 UUID 모양이다
  const raw = `${hex()}${hex()}${hex()}${hex()}`.padEnd(32, "0").slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
};

const lambdaOf = (project: Project, id: string | null) => project.resources.find((r): r is Extract<Resource, { type: "lambda" }> => r.id === id && r.type === "lambda");

const DB_USERNAME = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

export interface CreateSecretInput {
  name: string;
  description: string;
  kind: Secret["kind"];
  /** kind가 rds일 때: 대상 DB와 사용자 이름 */
  rdsId?: string | null;
  username?: string;
  /** kind가 other일 때: 키 이름 목록 (값은 받지 않는다) */
  keys?: string[];
}

export function createSecret(project: Project, input: CreateSecretInput, now = Date.now()): ActionResult {
  const p = purge(project, now);
  const name = input.name.trim();
  const invalid = validateSecretName(name);
  if (invalid) return awsFail("ValidationException", invalid);
  const existing = p.services.secretsmanager.secrets.find((s) => s.name === name);
  if (existing) {
    return isPendingDeletion(existing)
      ? awsFail("InvalidRequestException", "You can't create this secret because a secret with this name is already scheduled for deletion.", "같은 이름의 보안 암호가 삭제 예약 상태입니다. 삭제를 취소해 다시 쓰거나, 복구 기간이 끝난 뒤(또는 즉시 삭제한 뒤) 만드세요.")
      : awsFail("ResourceExistsException", `The operation failed because the secret ${name} already exists.`, "보안 암호 이름은 리전 안에서 고유해야 합니다.");
  }
  if (input.description.length > 2048) return awsFail("ValidationException", "설명은 2,048자 이하여야 합니다.");
  let keys: string[];
  let rdsId: string | null = null;
  let username = "";
  const notes: string[] = [];
  if (input.kind === "rds") {
    const rds = p.resources.find((r) => r.id === input.rdsId && r.type === "rds");
    if (!rds) return awsFail("ValidationException", "자격 증명을 쓸 RDS 데이터베이스를 고르세요.", "RDS가 없다면 '다른 유형의 보안 암호'를 고르거나 RDS를 먼저 만드세요.");
    username = (input.username ?? "").trim();
    if (!DB_USERNAME.test(username)) return awsFail("ValidationException", "사용자 이름은 영문자로 시작하는 1~16자의 영문·숫자·밑줄이어야 합니다.", "여기에는 DB 사용자 이름(예: admin)만 넣습니다. 암호는 입력받지 않습니다.");
    rdsId = rds.id;
    keys = ["username", "password"];
    notes.push("암호는 입력받지 않았습니다. 연습용 가상 값(PGSIM-…)이 만들어졌으며 실제 DB 암호가 아닙니다.");
  } else {
    keys = (input.keys ?? []).map((k) => k.trim()).filter(Boolean);
    const bad = validateSecretKeys(keys);
    if (bad) return awsFail("ValidationException", bad);
    notes.push("값은 입력받지 않았습니다. 키마다 연습용 가상 값(PGSIM-…)이 만들어졌습니다.");
  }
  if (secretNameLooksLikeArnSuffix(name)) notes.push("이름이 '-'와 6자로 끝나면 ARN 끝의 임의 접미사와 헷갈릴 수 있습니다 (AWS 권장: 피하기).");
  const createdAt = new Date(now).toISOString();
  const secret: Secret = {
    id: createId("secret"),
    name,
    suffix: arnSuffix(`${name}:${createdAt}`),
    description: input.description.trim(),
    kind: input.kind,
    rdsId,
    username,
    keys,
    versions: [{ versionId: versionId(), createdAt, stages: ["AWSCURRENT"] }],
    rotation: { enabled: false, days: 30, lambdaId: null },
    lastRotatedAt: null,
    deletion: null,
    createdAt,
    updatedAt: createdAt,
  };
  return ok(withSecrets(p, (sm) => ({ secrets: [...sm.secrets, secret] })), notes, secret.id);
}

function editable(project: Project, secretId: string, now: number): { project: Project; secret: Secret } | ActionResult {
  const p = purge(project, now);
  const secret = p.services.secretsmanager.secrets.find((s) => s.id === secretId);
  if (!secret) return awsFail("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
  if (isPendingDeletion(secret)) {
    return awsFail("InvalidRequestException", "You can't perform this operation on the secret because it was marked for deletion.", "삭제가 예약된 보안 암호는 바꿀 수 없습니다. 먼저 '삭제 취소'로 복원하세요.");
  }
  return { project: p, secret };
}

const replace = (p: Project, secret: Secret) => withSecrets(p, (sm) => ({ secrets: sm.secrets.map((s) => (s.id === secret.id ? secret : s)) }));

export function updateSecretDescription(project: Project, secretId: string, description: string, now = Date.now()): ActionResult {
  const e = editable(project, secretId, now);
  if ("ok" in e) return e;
  if (description.length > 2048) return awsFail("ValidationException", "설명은 2,048자 이하여야 합니다.");
  return ok(replace(e.project, { ...e.secret, description: description.trim(), updatedAt: new Date(now).toISOString() }));
}

/** PutSecretValue: 새 버전을 만든다 (새 가상 값). 직전 버전은 AWSPREVIOUS가 된다. 키/값 유형이면 키 구성도 바꿀 수 있다 */
export function putSecretValue(project: Project, secretId: string, keys?: string[], now = Date.now()): ActionResult {
  const e = editable(project, secretId, now);
  if ("ok" in e) return e;
  let nextKeys = e.secret.keys;
  if (keys && e.secret.kind === "other") {
    nextKeys = keys.map((k) => k.trim()).filter(Boolean);
    const bad = validateSecretKeys(nextKeys);
    if (bad) return awsFail("ValidationException", bad);
  }
  const at = new Date(now).toISOString();
  const secret: Secret = { ...e.secret, keys: nextKeys, versions: withNewVersion(e.secret, versionId(), at), updatedAt: at };
  return ok(replace(e.project, secret), ["새 버전이 AWSCURRENT가 되고, 직전 버전은 AWSPREVIOUS로 남았습니다. 이 값을 캐시해 둔 애플리케이션은 다시 읽어야 합니다."]);
}

export interface RotationInput {
  enabled: boolean;
  days: number;
  lambdaId: string | null;
  /** 교체 함수의 리소스 기반 정책에 Secrets Manager의 호출 허용을 추가한다 */
  addPermission: boolean;
}

export function configureRotation(project: Project, secretId: string, input: RotationInput, now = Date.now()): ActionResult {
  const e = editable(project, secretId, now);
  if ("ok" in e) return e;
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) return awsFail("ValidationException", "교체 주기는 1~365일 사이의 정수여야 합니다.");
  let p = e.project;
  const notes: string[] = [];
  if (input.enabled) {
    const fn = lambdaOf(p, input.lambdaId);
    if (!fn) return awsFail("ValidationException", "교체 함수(Lambda)를 고르세요.", "Secrets Manager는 교체할 때 Lambda 함수를 호출해 새 값을 만들고 대상에 적용합니다. Lambda에서 함수를 먼저 만드세요.");
    if (input.addPermission && !fn.config.permissions.some((perm) => perm.principal === "secretsmanager.amazonaws.com")) {
      const sid = `SecretsManagerAccess-${createId("x").split("-").pop()}`;
      const resources = p.resources.map((r) => (r.id === fn.id && r.type === "lambda" ? { ...r, config: { ...r.config, permissions: [...r.config.permissions, { sid, principal: "secretsmanager.amazonaws.com" as const, sourceArn: "" }] } } : r));
      p = { ...p, resources };
      notes.push(`함수 ${fn.name || fn.id}의 리소스 기반 정책에 secretsmanager.amazonaws.com의 호출 허용을 추가했습니다 (lambda:AddPermission).`);
    }
    notes.push(`${input.days}일마다 교체하도록 설정했습니다. 이 시뮬레이터는 일정에 따라 자동으로 교체하지 않습니다 — '즉시 교체'로 확인하세요.`);
  } else {
    notes.push("자동 교체를 껐습니다.");
  }
  const secret: Secret = { ...e.secret, rotation: { enabled: input.enabled, days: input.days, lambdaId: input.enabled ? input.lambdaId : e.secret.rotation.lambdaId }, updatedAt: new Date(now).toISOString() };
  return ok(replace(p, secret), notes);
}

/** RotateSecret: 교체 함수가 성공할 조건을 확인하고, 통과하면 새 버전을 만든다 */
export function rotateSecretNow(project: Project, secretId: string, now = Date.now()): ActionResult {
  const e = editable(project, secretId, now);
  if ("ok" in e) return e;
  if (!e.secret.rotation.lambdaId) {
    return awsFail("InvalidRequestException", "No Lambda rotation function ARN is associated with this secret.", "교체 구성에서 교체 함수를 먼저 지정하세요.");
  }
  const check = checkSecretRotation(e.project, buildTopology(e.project), e.secret);
  if (!check.ok) {
    const failed = check.checks.find((c) => c.status === "fail")!;
    return awsFail("RotationFailed", `교체에 실패했습니다 — ${failed.title}: ${failed.detail}`, "실제 AWS에서는 RotateSecret 호출 자체는 받아들여지고, 교체 함수가 실패하면 AWSPENDING 버전이 남은 채 값은 바뀌지 않습니다. 원인을 고친 뒤 다시 교체하세요.");
  }
  const at = new Date(now).toISOString();
  const secret: Secret = { ...e.secret, versions: withNewVersion(e.secret, versionId(), at), lastRotatedAt: at, updatedAt: at };
  return ok(replace(e.project, secret), ["교체 함수가 새 값을 만들어 적용했다고 가정하고 새 버전을 AWSCURRENT로 올렸습니다. 직전 값은 AWSPREVIOUS로 남아 잠시 동안 되돌릴 수 있습니다."]);
}

/** DeleteSecret: 복구 기간(7~30일)을 두고 삭제를 예약한다. force는 AWS CLI의 --force-delete-without-recovery */
export function deleteSecret(project: Project, secretId: string, options: { recoveryDays: number; force?: boolean }, now = Date.now()): ActionResult {
  const p = purge(project, now);
  const secret = p.services.secretsmanager.secrets.find((s) => s.id === secretId);
  if (!secret) return awsFail("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
  const users = p.resources.filter((r) => r.type === "lambda" && r.config.codeTemplate === "secret-get" && r.config.templateTarget.trim() === secret.name);
  const warn = users.length ? [`이 보안 암호를 읽는 함수가 있습니다: ${users.map((r) => r.name || r.id).join(", ")}. 삭제하면 그 함수가 실패합니다.`] : [];
  if (options.force) {
    return ok(withSecrets(p, (sm) => ({ secrets: sm.secrets.filter((s) => s.id !== secretId) })), [...warn, "복구 기간 없이 즉시 삭제했습니다. 되돌릴 수 없습니다 (AWS CLI의 --force-delete-without-recovery에 해당)."]);
  }
  if (!Number.isInteger(options.recoveryDays) || options.recoveryDays < 7 || options.recoveryDays > 30) return awsFail("InvalidParameterException", "복구 기간은 7~30일 사이여야 합니다.");
  if (isPendingDeletion(secret)) return awsFail("InvalidRequestException", "이미 삭제가 예약된 보안 암호입니다.");
  const updated: Secret = { ...secret, deletion: { scheduledAt: new Date(now).toISOString(), recoveryDays: options.recoveryDays }, updatedAt: new Date(now).toISOString() };
  const at = new Date(deletionTime(updated)!).toLocaleDateString("ko-KR");
  return ok(replace(p, updated), [...warn, `${options.recoveryDays}일 뒤(${at})에 완전히 삭제됩니다. 그 전에는 값을 읽을 수 없지만 '삭제 취소'로 복원할 수 있습니다.`]);
}

export function restoreSecret(project: Project, secretId: string, now = Date.now()): ActionResult {
  const p = purge(project, now);
  const secret = p.services.secretsmanager.secrets.find((s) => s.id === secretId);
  if (!secret) return awsFail("ResourceNotFoundException", "Secrets Manager can't find the specified secret.", "복구 기간이 끝나 완전히 삭제되었을 수 있습니다.");
  if (!isPendingDeletion(secret)) return ok(p);
  return ok(replace(p, { ...secret, deletion: null, updatedAt: new Date(now).toISOString() }), ["삭제를 취소했습니다. 보안 암호를 다시 읽을 수 있습니다."]);
}
