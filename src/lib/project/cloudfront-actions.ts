/**
 * CloudFront 콘솔 동작 (가상).
 * 배포를 만들거나 바꾸면 '배포 중(InProgress)'을 거쳐 잠시 뒤 Deployed가 된다 (lifecycle.ts).
 * 실제 엣지 로케이션이나 도메인은 만들어지지 않는다.
 */
import { invalidationMatches, isDefaultBehavior, validateInvalidationPath, validatePathPattern, withOacStatement } from "@/lib/engine/cloudfront-engine";
import { createId, hashString } from "@/lib/engine/ids";
import type { CfBehavior, CfCacheEntry, CfDistribution, CfOrigin, Project, Services } from "@/lib/engine/resource-models";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";
import { putBucketPolicy } from "./s3-actions";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withCloudFront(project: Project, update: (cf: Services["cloudfront"]) => Services["cloudfront"]): Project {
  return touch({ ...project, services: { ...project.services, cloudfront: update(project.services.cloudfront) } });
}

const replace = (p: Project, dist: CfDistribution) => withCloudFront(p, (cf) => ({ distributions: cf.distributions.map((d) => (d.id === dist.id ? dist : d)) }));

/** E로 시작하는 14자 배포 ID와 가상 도메인 (실제 CloudFront 도메인이 아니다) */
function newDistributionIdentity(): { id: string; domainName: string } {
  const seed = createId("dist");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "E";
  let domain = "d";
  for (let i = 0; i < 13; i++) {
    id += alphabet[hashString(`${seed}:id:${i}`) % alphabet.length];
    domain += alphabet[hashString(`${seed}:domain:${i}`) % alphabet.length].toLowerCase();
  }
  return { id, domainName: `${domain}.cloudfront.net` };
}

const ORIGIN_ID = /^[A-Za-z0-9._-]{1,128}$/;

export type BehaviorInput = Omit<CfBehavior, "id"> & { id?: string };

export interface DistributionInput {
  comment: string;
  enabled: boolean;
  defaultRootObject: string;
  priceClass: CfDistribution["priceClass"];
  origins: CfOrigin[];
  /** 위에서부터 평가하는 순서. 마지막은 기본 동작(경로 패턴 "*") */
  behaviors: BehaviorInput[];
}

function checkInput(project: Project, input: DistributionInput): ActionResult | null {
  if (input.comment.length > 128) return awsFail("InvalidArgument", "설명은 128자 이하여야 합니다.");
  if (!input.origins.length) return awsFail("InvalidArgument", "원본을 하나 이상 넣으세요.", "CloudFront는 콘텐츠를 가져올 원본(S3 버킷이나 로드 밸런서)이 있어야 합니다.");
  if (input.origins.length > 5) return awsFail("TooManyOrigins", "이 시뮬레이터에서는 배포 하나에 원본을 5개까지 넣을 수 있습니다.");
  const ids = new Set<string>();
  for (const o of input.origins) {
    if (!ORIGIN_ID.test(o.id)) return awsFail("InvalidArgument", `원본 이름 '${o.id}'이(가) 올바르지 않습니다. 영문·숫자·마침표·하이픈·밑줄만 쓸 수 있습니다.`);
    if (ids.has(o.id)) return awsFail("InvalidArgument", `원본 이름 '${o.id}'이(가) 중복됩니다.`);
    ids.add(o.id);
    if (o.kind === "alb") {
      if (!project.resources.some((r) => r.id === o.targetId && r.type === "alb")) return awsFail("InvalidArgument", `원본 ${o.id}: 로드 밸런서를 고르세요.`);
    } else if (!project.services.s3.buckets.some((b) => b.id === o.targetId)) {
      return awsFail("NoSuchOrigin", `원본 ${o.id}: S3 버킷을 고르세요.`, "버킷이 없다면 S3에서 먼저 만드세요.");
    }
  }
  if (!input.behaviors.length || !isDefaultBehavior(input.behaviors[input.behaviors.length - 1] as CfBehavior)) {
    return awsFail("InvalidArgument", "마지막 동작은 기본 동작(경로 패턴 *)이어야 합니다.");
  }
  if (input.behaviors.length > 10) return awsFail("TooManyCacheBehaviors", "이 시뮬레이터에서는 동작을 10개까지 넣을 수 있습니다.");
  const patterns = new Set(input.behaviors.map((b) => b.pathPattern));
  if (patterns.size !== input.behaviors.length) return awsFail("InvalidArgument", "경로 패턴이 중복됩니다. 동작마다 다른 패턴을 쓰세요.");
  for (const b of input.behaviors.slice(0, -1)) {
    if (b.pathPattern === "*") return awsFail("InvalidArgument", "경로 패턴 *는 기본 동작(맨 아래)에만 쓸 수 있습니다.");
    const bad = validatePathPattern(b.pathPattern);
    if (bad) return awsFail("InvalidArgument", bad);
  }
  for (const b of input.behaviors) {
    if (!ids.has(b.originId)) return awsFail("NoSuchOrigin", `동작 ${b.pathPattern}이(가) 가리키는 원본 '${b.originId}'이(가) 없습니다.`);
  }
  if (input.defaultRootObject.startsWith("/")) return awsFail("InvalidArgument", "기본 루트 객체는 /로 시작하지 않습니다. 예: index.html");
  if (input.defaultRootObject.length > 255) return awsFail("InvalidArgument", "기본 루트 객체는 255자 이하여야 합니다.");
  return null;
}

/** 원본 종류에 맞게 쓰지 않는 설정을 정리한다 */
function normalizeOrigin(o: CfOrigin): CfOrigin {
  if (o.kind === "s3") return { ...o, protocolPolicy: "https-only" };
  // S3 웹 사이트 엔드포인트는 HTTP만 지원하고, OAC를 쓸 수 없다 (버킷이 공개되어 있어야 함)
  if (o.kind === "s3-website") return { ...o, protocolPolicy: "http-only", originAccess: "public" };
  return { ...o, originAccess: "public" };
}

function originNotes(project: Project, origins: CfOrigin[]): string[] {
  const notes: string[] = [];
  for (const o of origins) {
    const bucket = project.services.s3.buckets.find((b) => b.id === o.targetId);
    if (o.kind === "s3" && o.originAccess === "oac" && bucket) notes.push(`원본 ${o.id}: 버킷 ${bucket.name}의 정책에 이 배포(OAC)의 s3:GetObject 허용이 있어야 합니다. 배포의 '원본' 탭에서 정책 문을 복사하거나 한 번에 추가할 수 있습니다.`);
    if (o.kind === "s3-website" && bucket && !bucket.website.enabled) notes.push(`원본 ${o.id}: 버킷 ${bucket.name}의 정적 웹 사이트 호스팅이 꺼져 있어 요청이 404가 됩니다.`);
  }
  return notes;
}

export function createDistribution(project: Project, input: DistributionInput, now = Date.now()): ActionResult {
  const invalid = checkInput(project, input);
  if (invalid) return invalid;
  if (project.services.cloudfront.distributions.length >= 20) return awsFail("TooManyDistributions", "이 시뮬레이터에서는 배포를 20개까지 만들 수 있습니다.");
  const { id, domainName } = newDistributionIdentity();
  const at = new Date(now).toISOString();
  const origins = input.origins.map(normalizeOrigin);
  const dist: CfDistribution = {
    id,
    domainName,
    comment: input.comment.trim(),
    enabled: input.enabled,
    state: "InProgress",
    origins,
    behaviors: input.behaviors.map((b) => ({ ...b, id: b.id ?? createId("cb") })),
    defaultRootObject: input.defaultRootObject.trim(),
    priceClass: input.priceClass,
    cache: [],
    invalidations: [],
    createdAt: at,
    updatedAt: at,
  };
  return ok(
    withCloudFront(project, (cf) => ({ distributions: [...cf.distributions, dist] })),
    [`가상 도메인 ${domainName}이(가) 만들어졌습니다 (실제로 접속되는 주소가 아닙니다). 배포가 끝나면(Deployed) 요청 테스트를 할 수 있습니다.`, ...originNotes(project, origins)],
    dist.id,
  );
}

/** UpdateDistribution: 설정을 바꾸면 다시 배포(InProgress)한다. 엣지 캐시는 그대로 남는다 (지우려면 무효화) */
export function updateDistribution(project: Project, distributionId: string, input: DistributionInput, now = Date.now()): ActionResult {
  const current = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  if (!current) return awsFail("NoSuchDistribution", "배포를 찾을 수 없습니다.");
  const invalid = checkInput(project, input);
  if (invalid) return invalid;
  const origins = input.origins.map(normalizeOrigin);
  const updated: CfDistribution = {
    ...current,
    comment: input.comment.trim(),
    enabled: input.enabled,
    state: "InProgress",
    origins,
    behaviors: input.behaviors.map((b) => ({ ...b, id: b.id ?? createId("cb") })),
    defaultRootObject: input.defaultRootObject.trim(),
    priceClass: input.priceClass,
    updatedAt: new Date(now).toISOString(),
  };
  const notes = ["변경 사항을 엣지 로케이션에 배포하는 중입니다 (가상). 이미 캐시된 응답은 그대로 남으니, 바로 바꾸려면 무효화를 만드세요.", ...originNotes(project, origins)];
  return ok(replace(project, updated), notes);
}

export function setDistributionEnabled(project: Project, distributionId: string, enabled: boolean, now = Date.now()): ActionResult {
  const current = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  if (!current) return awsFail("NoSuchDistribution", "배포를 찾을 수 없습니다.");
  if (current.enabled === enabled) return ok(project);
  return ok(replace(project, { ...current, enabled, state: "InProgress", updatedAt: new Date(now).toISOString() }), [enabled ? "배포를 활성화했습니다. 배포가 끝나면 요청을 처리합니다." : "배포를 비활성화했습니다. 비활성화가 끝나면(Deployed) 삭제할 수 있습니다."]);
}

/** DeleteDistribution: 먼저 비활성화하고 그 변경이 배포된 뒤에만 삭제할 수 있다 */
export function deleteDistribution(project: Project, distributionId: string): ActionResult {
  const current = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  if (!current) return awsFail("NoSuchDistribution", "배포를 찾을 수 없습니다.");
  if (current.enabled) return awsFail("DistributionNotDisabled", "The distribution you are trying to delete has not been disabled.", "배포를 먼저 비활성화하세요. 비활성화가 끝난 뒤(Deployed) 삭제할 수 있습니다.");
  if (current.state !== "Deployed") return awsFail("PreconditionFailed", "배포 상태가 아직 InProgress입니다.", "비활성화가 엣지에 배포될 때까지 몇 초 기다린 뒤 다시 삭제하세요.");
  return ok(withCloudFront(project, (cf) => ({ distributions: cf.distributions.filter((d) => d.id !== distributionId) })), ["원본(S3 버킷·로드 밸런서)과 버킷 정책의 OAC 허용 문은 그대로 남습니다."]);
}

/** CreateInvalidation: 경로와 일치하는 캐시를 지운다. 다음 요청은 원본에서 다시 가져온다 */
export function createInvalidation(project: Project, distributionId: string, paths: string[], now = Date.now()): ActionResult {
  const current = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  if (!current) return awsFail("NoSuchDistribution", "배포를 찾을 수 없습니다.");
  const list = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (!list.length) return awsFail("InvalidArgument", "무효화할 경로를 하나 이상 넣으세요. 예: /index.html 또는 /*");
  if (list.length > 20) return awsFail("TooManyInvalidationsInProgress", "이 시뮬레이터에서는 한 번에 경로를 20개까지 넣을 수 있습니다.");
  for (const p of list) {
    const bad = validateInvalidationPath(p);
    if (bad) return awsFail("InvalidArgument", bad);
  }
  const removed = current.cache.filter((c) => list.some((p) => invalidationMatches(p, c.path)));
  const invalidation = { id: `I${createId("inv").split("-").pop()!.toUpperCase()}`, paths: list, createdAt: new Date(now).toISOString() };
  const updated: CfDistribution = {
    ...current,
    cache: current.cache.filter((c) => !removed.includes(c)),
    invalidations: [invalidation, ...current.invalidations].slice(0, 20),
    updatedAt: new Date(now).toISOString(),
  };
  return ok(replace(project, updated), [
    removed.length ? `엣지 캐시에서 ${removed.length}개 경로(${removed.map((c) => c.path).join(", ")})를 지웠습니다. 다음 요청은 원본에서 다시 가져옵니다.` : "지금 캐시된 응답 중 이 경로와 일치하는 것은 없습니다 (다음 요청은 어차피 원본으로 갑니다).",
    "실제 AWS에서는 무효화가 모든 엣지에 퍼지는 데 보통 몇 분이 걸리고, 매달 일정 경로 수를 넘으면 요금이 붙습니다. 파일 이름에 버전을 넣는 방법(예: app.v2.js)이 더 권장됩니다.",
  ]);
}

/** 요청 테스트가 채운 엣지 캐시를 기록한다 (AWS API가 아니라 시뮬레이터의 상태 — 실행 취소 기록 없이 저장) */
export function recordCacheEntry(project: Project, distributionId: string, entry: CfCacheEntry): Project | null {
  const current = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  if (!current) return null;
  const cache = [entry, ...current.cache.filter((c) => c.path !== entry.path)].slice(0, 60);
  return { ...project, services: { ...project.services, cloudfront: { distributions: project.services.cloudfront.distributions.map((d) => (d.id === distributionId ? { ...d, cache } : d)) } } };
}

/** 원본 버킷의 정책에 이 배포(OAC)의 읽기 허용 문을 추가한다 (콘솔의 '정책 복사' 후 버킷 정책에 붙여 넣는 것과 같다) */
export function addOacBucketPolicy(project: Project, distributionId: string, originId: string): ActionResult {
  const dist = project.services.cloudfront.distributions.find((d) => d.id === distributionId);
  const origin = dist?.origins.find((o) => o.id === originId);
  if (!dist || !origin) return awsFail("NoSuchOrigin", "원본을 찾을 수 없습니다.");
  if (origin.kind !== "s3" || origin.originAccess !== "oac") return awsFail("InvalidArgument", "OAC를 쓰는 S3 버킷 원본에만 적용할 수 있습니다.");
  const bucket = project.services.s3.buckets.find((b) => b.id === origin.targetId);
  if (!bucket) return awsFail("NoSuchBucket", "원본 버킷이 없습니다.");
  const result = putBucketPolicy(project, bucket.id, withOacStatement(bucket.policy, bucket.name, dist.id));
  if (!result.ok) return result;
  return ok(result.project, [`버킷 ${bucket.name}의 정책에 이 배포의 s3:GetObject 허용(AWS:SourceArn 조건 포함)을 추가했습니다. 버킷은 계속 비공개입니다.`]);
}
