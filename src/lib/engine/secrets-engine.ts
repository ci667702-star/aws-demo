/**
 * 가상 Secrets Manager의 기본 계산 (이름 규칙, ARN, 버전, 삭제 예약, 가상 값).
 *
 * 이 시뮬레이터는 비밀 값을 입력받거나 저장하지 않는다.
 * 화면에 보이는 값은 보안 암호 ID·버전 ID·키 이름으로 계산한 연습용 문자열(PGSIM-…)이며, 어떤 시스템의 암호도 아니다.
 */
import { SANDBOX_ACCOUNT_ID } from "./iam-engine";
import { VIRTUAL_REGION, type Project, type Secret, type SecretVersion } from "./resource-models";

export const SECRETS_ENDPOINT_HOST = `secretsmanager.${VIRTUAL_REGION}.amazonaws.com`;
const DAY_MS = 86_400_000;

/** AWS는 보안 암호 ARN 끝에 '-' + 임의의 6자를 붙인다 */
export const secretArn = (secret: Pick<Secret, "name" | "suffix">) => `arn:aws:secretsmanager:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:secret:${secret.name}-${secret.suffix}`;

/** 아직 만들지 않은 보안 암호의 ARN 모양 (IAM 평가용) */
export const secretArnForName = (name: string) => `arn:aws:secretsmanager:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:secret:${name}-??????`;

const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]+$/;

export function validateSecretName(name: string): string | null {
  if (!name) return "보안 암호 이름을 입력하세요.";
  if (name.length > 512) return "보안 암호 이름은 512자 이하여야 합니다.";
  if (!SECRET_NAME.test(name)) return "보안 암호 이름에는 영문자, 숫자, 그리고 /_+=.@- 문자만 쓸 수 있습니다.";
  return null;
}

/** 이름이 '-' + 6자로 끝나면 ARN의 임의 접미사와 헷갈린다 (AWS 권장 사항) */
export const secretNameLooksLikeArnSuffix = (name: string) => /-[A-Za-z0-9]{6}$/.test(name);

const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function validateSecretKeys(keys: string[]): string | null {
  if (!keys.length) return "키를 하나 이상 넣으세요.";
  if (keys.length > 10) return "이 시뮬레이터에서는 키를 10개까지 넣을 수 있습니다.";
  const seen = new Set<string>();
  for (const k of keys) {
    // 키 이름 칸에 실제 자격 증명을 붙여 넣는 실수를 막는다 (값은 입력받지 않는다)
    if (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(k)) return "키 이름에 액세스 키 같은 자격 증명을 넣지 마세요. 여기에는 이름(예: api_key)만 넣고, 값은 시뮬레이터가 가상 값으로 만듭니다.";
    if (!SECRET_KEY.test(k)) return `키 '${k}'이(가) 올바르지 않습니다. 영문자나 밑줄로 시작하고 영문·숫자·밑줄·마침표·하이픈만 쓸 수 있습니다 (최대 64자).`;
    if (seen.has(k)) return `키 '${k}'이(가) 중복됩니다.`;
    seen.add(k);
  }
  return null;
}

export function findSecretByName(project: Project, nameOrArn: string): Secret | undefined {
  const text = nameOrArn.trim();
  if (!text) return undefined;
  return project.services.secretsmanager.secrets.find((s) => s.name === text || secretArn(s) === text);
}

// ---------------------------------------------------------------- 버전

export function currentVersion(secret: Secret): SecretVersion {
  return secret.versions.find((v) => v.stages.includes("AWSCURRENT")) ?? secret.versions[0];
}

export function previousVersion(secret: Secret): SecretVersion | undefined {
  return secret.versions.find((v) => v.stages.includes("AWSPREVIOUS"));
}

/** 새 버전을 맨 앞에 넣고 스테이징 레이블을 옮긴다: 새 버전 = AWSCURRENT, 직전 버전 = AWSPREVIOUS, 나머지는 레이블 없음 */
export function withNewVersion(secret: Secret, versionId: string, createdAt: string): SecretVersion[] {
  const current = currentVersion(secret);
  const older = secret.versions.map((v) => ({ ...v, stages: v.versionId === current.versionId ? (["AWSPREVIOUS"] as SecretVersion["stages"]) : ([] as SecretVersion["stages"]) }));
  // 레이블이 없는 오래된 버전은 AWS가 정리한다 (여기서는 최근 것만 남긴다)
  return [{ versionId, createdAt, stages: ["AWSCURRENT"] as SecretVersion["stages"] }, ...older].slice(0, 20);
}

// ---------------------------------------------------------------- 삭제 예약·교체

/** 삭제 예정 시각 (ms). 예약되지 않았으면 null */
export function deletionTime(secret: Secret): number | null {
  return secret.deletion ? Date.parse(secret.deletion.scheduledAt) + secret.deletion.recoveryDays * DAY_MS : null;
}

export const isPendingDeletion = (secret: Secret) => secret.deletion !== null;

/** 복구 기간이 끝나 완전히 삭제된 보안 암호인지 */
export function isPurged(secret: Secret, now: number): boolean {
  const at = deletionTime(secret);
  return at !== null && now >= at;
}

/** 지금 남아 있는(완전히 삭제되지 않은) 보안 암호 */
export const liveSecrets = (project: Project, now: number) => project.services.secretsmanager.secrets.filter((s) => !isPurged(s, now));

/** 자동 교체가 켜져 있으면 다음 교체 예정 시각 (ms). 일정에 따른 교체는 실제로 실행되지 않고 예정일만 계산한다 */
export function nextRotationTime(secret: Secret): number | null {
  if (!secret.rotation.enabled) return null;
  return Date.parse(secret.lastRotatedAt ?? secret.createdAt) + secret.rotation.days * DAY_MS;
}

// ---------------------------------------------------------------- 가상 값

function hash32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 같은 입력이면 항상 같은 연습용 문자열 (저장하지 않고 필요할 때 계산한다) */
export function virtualValue(seed: string, length = 20): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += hash32(`${seed}:${i}`).toString(36);
  return `PGSIM-${out.slice(0, length)}`;
}

export const virtualSecretValue = (secret: Pick<Secret, "id">, versionId: string, key: string) => virtualValue(`${secret.id}:${versionId}:${key}`);

/** 임의의 6자 (ARN 접미사) — 이름과 만든 시각으로 계산해 결정적으로 만든다 */
export function arnSuffix(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[hash32(`${seed}:suffix:${i}`) % alphabet.length];
  return out;
}

/**
 * GetSecretValue가 돌려주는 SecretString 모양 (가상).
 * RDS 자격 증명은 AWS 콘솔이 만드는 JSON 구조를 따르고, password만 가상 값이다.
 */
export function secretString(project: Project, secret: Secret, versionId: string): Record<string, string | number> {
  if (secret.kind === "rds") {
    const rds = project.resources.find((r) => r.id === secret.rdsId);
    const base: Record<string, string | number> = { username: secret.username, password: virtualSecretValue(secret, versionId, "password") };
    if (rds && rds.type === "rds") {
      const name = rds.name || rds.id;
      return {
        ...base,
        engine: rds.config.engine,
        host: `${name}.${hash32(rds.id).toString(36).padStart(7, "0").slice(0, 12)}.${VIRTUAL_REGION}.rds.amazonaws.com`,
        port: rds.config.port,
        dbInstanceIdentifier: name,
      };
    }
    return base;
  }
  return Object.fromEntries(secret.keys.map((k) => [k, virtualSecretValue(secret, versionId, k)]));
}
