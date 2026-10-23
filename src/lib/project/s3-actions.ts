/**
 * 가상 S3 콘솔 동작. 실제 S3에 업로드하지 않으며 작은 텍스트 파일만 내용을 브라우저에 저장한다.
 */
import { createId } from "@/lib/engine/ids";
import { bucketArn, checkPolicyDocument } from "@/lib/engine/iam-engine";
import type { Project, S3Bucket, S3Object, S3ObjectVersion, Services } from "@/lib/engine/resource-models";
import {
  GLOBALLY_TAKEN_BUCKET_NAMES,
  guessContentType,
  isPublicPolicy,
  S3_TEXT_LIMIT,
  S3_VERSION_LIMIT,
  validateBucketName,
  validateObjectKey,
} from "@/lib/engine/s3-engine";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withS3(project: Project, update: (s3: Services["s3"]) => Services["s3"]): Project {
  return touch({ ...project, services: { ...project.services, s3: update(project.services.s3) } });
}

function updateBucket(project: Project, bucketId: string, update: (b: S3Bucket) => S3Bucket): Project {
  return withS3(project, (s3) => ({ ...s3, buckets: s3.buckets.map((b) => (b.id === bucketId ? update(b) : b)) }));
}

const noBucket = () => awsFail("NoSuchBucket", "버킷을 찾을 수 없습니다.");

/** 가상 ETag (내용으로 계산한 32자리 해시. 실제 MD5가 아님) */
export function virtualEtag(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${hex(h1 ^ h2)}${hex((h1 + h2) >>> 0)}`;
}

// ---------------------------------------------------------------- 버킷

export interface CreateBucketInput {
  name: string;
  blockPublicAccess: S3Bucket["blockPublicAccess"];
  versioning: "Disabled" | "Enabled";
  encryption: S3Bucket["encryption"];
}

export function createBucket(project: Project, input: CreateBucketInput): ActionResult {
  const name = input.name.trim();
  const invalid = validateBucketName(name);
  if (invalid) return awsFail("InvalidBucketName", invalid, "예: my-site-2026-kim 처럼 소문자·숫자·하이픈으로 만드세요.");
  const { buckets } = project.services.s3;
  if (buckets.some((b) => b.name === name)) return awsFail("BucketAlreadyOwnedByYou", `버킷 ${name}은(는) 이미 이 계정에 있습니다.`);
  if (GLOBALLY_TAKEN_BUCKET_NAMES.includes(name)) {
    return awsFail("BucketAlreadyExists", `버킷 이름 ${name}은(는) 다른 AWS 계정이 이미 사용 중입니다 (시뮬레이션).`, "버킷 이름은 전 세계 모든 계정에서 하나뿐이어야 합니다. 이름 뒤에 날짜나 이니셜을 붙여 보세요.");
  }
  if (buckets.length >= 100) return awsFail("TooManyBuckets", "이 시뮬레이터에서는 버킷을 100개까지 만들 수 있습니다.");
  const bucket: S3Bucket = {
    id: createId("bucket"),
    name,
    createdAt: new Date().toISOString(),
    blockPublicAccess: { ...input.blockPublicAccess },
    versioning: input.versioning,
    encryption: input.encryption,
    policy: "",
    website: { enabled: false, indexDocument: "index.html", errorDocument: "" },
    objects: [],
  };
  const notes = [];
  if (!Object.values(input.blockPublicAccess).every(Boolean)) notes.push("퍼블릭 액세스 차단 일부를 껐습니다. 버킷 정책으로 객체를 공개할 수 있으니 주의하세요.");
  return ok(withS3(project, (s3) => ({ ...s3, buckets: [...s3.buckets, bucket] })), notes, bucket.id);
}

const versionCount = (b: S3Bucket) => b.objects.reduce((n, o) => n + 1 + o.previousVersions.length, 0);

export function deleteBucket(project: Project, bucketId: string): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const n = versionCount(bucket);
  if (n) return awsFail("BucketNotEmpty", `버킷 ${bucket.name}에 객체(버전·삭제 마커 포함) ${n}개가 남아 있습니다.`, "먼저 '비우기'로 버킷을 비운 뒤 삭제하세요.");
  return ok(withS3(project, (s3) => ({ ...s3, buckets: s3.buckets.filter((b) => b.id !== bucketId) })));
}

/** 모든 객체와 버전·삭제 마커를 영구 삭제 */
export function emptyBucket(project: Project, bucketId: string): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const n = versionCount(bucket);
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, objects: [] })), [`객체·버전 ${n}개를 영구 삭제했습니다.`]);
}

export function setBlockPublicAccess(project: Project, bucketId: string, settings: S3Bucket["blockPublicAccess"]): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const notes: string[] = [];
  if (settings.restrictPublicBuckets && isPublicPolicy(checkPolicyDocument(bucket.policy || "{}", "resource").statements)) {
    notes.push("버킷 정책이 퍼블릭이지만 '퍼블릭 버킷 제한'이 켜져 있어 익명 접근은 거부됩니다.");
  }
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, blockPublicAccess: { ...settings } })), notes);
}

export function setBucketVersioning(project: Project, bucketId: string, status: "Enabled" | "Suspended"): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  if (status === "Suspended" && bucket.versioning === "Disabled") {
    return awsFail("IllegalVersioningConfigurationException", "버전 관리를 한 번도 켜지 않은 버킷은 일시 중지할 수 없습니다.");
  }
  const notes = status === "Suspended" ? ["일시 중지해도 기존 버전은 남아 있습니다. 새로 올리는 객체만 버전 ID가 null이 됩니다."] : [];
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, versioning: status })), notes);
}

export function setBucketEncryption(project: Project, bucketId: string, encryption: S3Bucket["encryption"]): ActionResult {
  if (!project.services.s3.buckets.some((b) => b.id === bucketId)) return noBucket();
  const notes = encryption === "SSE-KMS" ? ["SSE-KMS는 실제 AWS에서 KMS 요청 요금이 추가될 수 있습니다 (이 시뮬레이터에서는 요금이 없습니다)."] : [];
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, encryption })), notes);
}

/** 버킷 정책 저장. 빈 문자열이면 정책 삭제. */
export function putBucketPolicy(project: Project, bucketId: string, policy: string): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const text = policy.trim();
  if (!text) return ok(updateBucket(project, bucketId, (b) => ({ ...b, policy: "" })), ["버킷 정책을 삭제했습니다."]);
  const check = checkPolicyDocument(text, "resource");
  if (!check.ok) return awsFail("MalformedPolicy", check.errors[0]);
  const arn = bucketArn(bucket.name);
  for (const s of check.statements) {
    for (const r of s.resources) {
      if (r !== arn && !r.startsWith(`${arn}/`)) {
        return awsFail("MalformedPolicy", `Policy has invalid resource: "${r}"은(는) 이 버킷(${arn})의 리소스가 아닙니다.`, `Resource는 ${arn} 또는 ${arn}/* 형식이어야 합니다.`);
      }
    }
  }
  if (bucket.blockPublicAccess.blockPublicPolicy && isPublicPolicy(check.statements)) {
    return awsFail(
      "AccessDenied",
      "퍼블릭 액세스 차단(퍼블릭 정책 차단)이 켜져 있어 Principal \"*\"를 허용하는 정책을 저장할 수 없습니다.",
      "권한 탭에서 '퍼블릭 액세스 차단'을 먼저 끄세요. 정말 공개해야 하는 버킷(정적 웹 사이트 등)에서만 끄세요.",
    );
  }
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, policy: text })), check.warnings);
}

export function setBucketWebsite(project: Project, bucketId: string, website: S3Bucket["website"]): ActionResult {
  if (!project.services.s3.buckets.some((b) => b.id === bucketId)) return noBucket();
  const index = website.indexDocument.trim();
  if (website.enabled) {
    if (!index) return awsFail("InvalidArgument", "인덱스 문서를 입력하세요. 예: index.html");
    if (index.includes("/")) return awsFail("InvalidArgument", "인덱스 문서 이름에는 슬래시(/)를 쓸 수 없습니다.");
  }
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, website: { enabled: website.enabled, indexDocument: index || "index.html", errorDocument: website.errorDocument.trim() } })));
}

// ---------------------------------------------------------------- 객체

export interface PutObjectInput {
  key: string;
  size: number;
  contentType?: string;
  /** 텍스트 내용 (S3_TEXT_LIMIT 이하일 때만 저장) */
  text: string | null;
}

function versionOf(o: S3Object): S3ObjectVersion {
  return { versionId: o.versionId, size: o.size, etag: o.etag, lastModified: o.lastModified, contentType: o.contentType, text: o.text, deleteMarker: o.deleteMarker };
}

function fromVersion(key: string, v: S3ObjectVersion, previousVersions: S3ObjectVersion[]): S3Object {
  return { key, size: v.size, contentType: v.contentType, etag: v.etag, lastModified: v.lastModified, versionId: v.versionId, text: v.text, deleteMarker: v.deleteMarker, previousVersions };
}

/** 새 현재 버전을 넣을 때 이전 버전 목록을 정리한다 (일시 중지 상태의 null 버전은 덮어씀) */
function pushHistory(bucket: S3Bucket, existing: S3Object | undefined, newVersionId: string): S3ObjectVersion[] {
  if (!existing || bucket.versioning === "Disabled") return [];
  const history = [versionOf(existing), ...existing.previousVersions].filter((v) => !(newVersionId === "null" && v.versionId === "null"));
  return history.slice(0, S3_VERSION_LIMIT);
}

export function putObject(project: Project, bucketId: string, input: PutObjectInput): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const key = input.key;
  const invalid = validateObjectKey(key);
  if (invalid) return awsFail("InvalidArgument", invalid);
  if (!Number.isFinite(input.size) || input.size < 0) return awsFail("InvalidArgument", "파일 크기가 올바르지 않습니다.");
  if (input.size > 5 * 1024 ** 3) return awsFail("EntityTooLarge", "한 번에 올릴 수 있는 객체는 5GB까지입니다. (더 큰 파일은 멀티파트 업로드 사용)");
  if (bucket.objects.length >= 500 && !bucket.objects.some((o) => o.key === key)) return awsFail("TooManyObjects", "이 시뮬레이터에서는 버킷당 객체를 500개까지 저장합니다.");
  const text = input.text !== null && input.text.length <= S3_TEXT_LIMIT ? input.text : null;
  const versionId = bucket.versioning === "Enabled" ? createId("ver") : "null";
  const existing = bucket.objects.find((o) => o.key === key);
  const object: S3Object = {
    key,
    size: Math.round(input.size),
    contentType: input.contentType || guessContentType(key),
    etag: virtualEtag(`${key}:${input.size}:${text ?? ""}`),
    lastModified: new Date().toISOString(),
    versionId,
    text,
    deleteMarker: false,
    previousVersions: pushHistory(bucket, existing, versionId),
  };
  const notes: string[] = [];
  if (input.text !== null && text === null) notes.push(`${key}: ${S3_TEXT_LIMIT / 1024}KB보다 커서 내용은 저장하지 않고 정보(크기·형식)만 기록했습니다.`);
  if (existing && !existing.deleteMarker) notes.push(bucket.versioning === "Enabled" ? `${key}: 기존 객체는 이전 버전으로 보관됩니다.` : `${key}: 같은 키의 기존 객체를 덮어썼습니다.`);
  const objects = existing ? bucket.objects.map((o) => (o.key === key ? object : o)) : [...bucket.objects, object];
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, objects })), notes);
}

/** 콘솔의 '폴더 만들기' — 이름이 /로 끝나는 0바이트 객체 */
export function createFolder(project: Project, bucketId: string, prefix: string, name: string): ActionResult {
  const clean = name.trim().replace(/\/+$/, "");
  if (!clean) return awsFail("InvalidArgument", "폴더 이름을 입력하세요.");
  if (clean.includes("/")) return awsFail("InvalidArgument", "폴더 이름에는 슬래시(/)를 쓸 수 없습니다.");
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const key = `${prefix}${clean}/`;
  if (bucket.objects.some((o) => o.key.startsWith(key) && !o.deleteMarker)) return awsFail("InvalidArgument", `폴더 ${key}이(가) 이미 있습니다.`);
  return putObject(project, bucketId, { key, size: 0, contentType: "application/x-directory", text: "" });
}

/**
 * 객체 삭제.
 * - versionId 없음: 버전 관리가 켜져 있으면 삭제 마커를 만들고(복구 가능), 꺼져 있으면 영구 삭제
 * - versionId 있음: 그 버전을 영구 삭제 (삭제 마커를 지우면 이전 버전이 되살아남)
 */
export function deleteObject(project: Project, bucketId: string, key: string, versionId?: string): ActionResult {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  if (!bucket) return noBucket();
  const existing = bucket.objects.find((o) => o.key === key);
  if (!existing) return awsFail("NoSuchKey", `객체 ${key}을(를) 찾을 수 없습니다.`);
  let replacement: S3Object | null;
  const notes: string[] = [];
  if (versionId === undefined) {
    if (bucket.versioning === "Disabled") {
      replacement = null;
      notes.push(`${key}을(를) 영구 삭제했습니다.`);
    } else {
      if (existing.deleteMarker) return ok(project, [`${key}은(는) 이미 삭제 마커가 있습니다.`]);
      const markerId = bucket.versioning === "Enabled" ? createId("ver") : "null";
      replacement = {
        ...fromVersion(key, { versionId: markerId, size: 0, etag: "", lastModified: new Date().toISOString(), contentType: "", text: null, deleteMarker: true }, pushHistory(bucket, existing, markerId)),
      };
      notes.push(`${key}에 삭제 마커를 추가했습니다. '버전 표시'에서 삭제 마커를 지우면 복구됩니다.`);
    }
  } else if (existing.versionId === versionId) {
    const [next, ...rest] = existing.previousVersions;
    replacement = next ? fromVersion(key, next, rest) : null;
    notes.push(existing.deleteMarker ? `삭제 마커를 지워 ${key}을(를) 복구했습니다.` : `${key}의 버전 ${versionId}을(를) 영구 삭제했습니다.`);
  } else {
    if (!existing.previousVersions.some((v) => v.versionId === versionId)) return awsFail("NoSuchVersion", `버전 ${versionId}을(를) 찾을 수 없습니다.`);
    replacement = { ...existing, previousVersions: existing.previousVersions.filter((v) => v.versionId !== versionId) };
    notes.push(`${key}의 이전 버전 ${versionId}을(를) 영구 삭제했습니다.`);
  }
  const objects = replacement ? bucket.objects.map((o) => (o.key === key ? replacement : o)) : bucket.objects.filter((o) => o.key !== key);
  return ok(updateBucket(project, bucketId, (b) => ({ ...b, objects })), notes);
}

/** 접두사(폴더) 아래 객체 전체 삭제 */
export function deleteObjects(project: Project, bucketId: string, keys: string[]): ActionResult {
  let p = project;
  const notes: string[] = [];
  for (const key of keys) {
    const bucket = p.services.s3.buckets.find((b) => b.id === bucketId);
    const targets = bucket?.objects.filter((o) => (key.endsWith("/") ? o.key.startsWith(key) : o.key === key) && !o.deleteMarker).map((o) => o.key) ?? [];
    for (const k of targets) {
      const r = deleteObject(p, bucketId, k);
      if (!r.ok) return r;
      p = r.project;
    }
    notes.push(key.endsWith("/") ? `폴더 ${key}의 객체 ${targets.length}개를 삭제했습니다.` : `${key}을(를) 삭제했습니다.`);
  }
  const bucket = p.services.s3.buckets.find((b) => b.id === bucketId);
  if (bucket && bucket.versioning !== "Disabled") notes.push("버전 관리가 켜져 있어 삭제 마커만 추가되었습니다. 이전 버전은 남아 있습니다.");
  return ok(p, notes);
}
