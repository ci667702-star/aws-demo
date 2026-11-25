/**
 * 가상 CloudFront 엔진.
 * 뷰어의 요청 하나가 배포를 거치면 어떻게 되는지 설정으로 계산한다:
 *   뷰어 프로토콜 정책 → 캐시 동작(경로 패턴) 선택 → 허용 메서드 → 엣지 캐시 확인 → 원본 요청(S3 · S3 웹 사이트 · ALB) → 캐시에 저장
 * 실제 HTTP 요청이나 엣지 로케이션은 없다. 가상 도메인(dxxxx.cloudfront.net)도 실제로 접속되는 주소가 아니다.
 */
import { DEFAULT_INTERNET_CLIENT_IP, simulateWithTopology } from "./connectivity-engine";
import { actionMatches, bucketArn, objectArn, resourceMatches, SANDBOX_ACCOUNT_ID } from "./iam-engine";
import type { CfBehavior, CfCacheEntry, CfDistribution, CfOrigin, Project, S3Bucket } from "./resource-models";
import { evaluateS3Access, findObject, websiteEndpoint, websiteRequest } from "./s3-engine";
import { displayName, type Topology } from "./topology-engine";

export const CLOUDFRONT_SERVICE = "cloudfront.amazonaws.com";
export const distributionArn = (id: string) => `arn:aws:cloudfront::${SANDBOX_ACCOUNT_ID}:distribution/${id}`;

/** 캐시 정책별 기본 TTL (초). 원본의 Cache-Control 헤더는 모델링하지 않는다 */
export const CACHE_POLICY_INFO: Record<CfBehavior["cachePolicy"], { label: string; ttlSeconds: number; description: string }> = {
  CachingOptimized: { label: "CachingOptimized (권장: 정적 콘텐츠)", ttlSeconds: 86_400, description: "기본 TTL 24시간. 같은 경로의 요청은 TTL 동안 원본에 가지 않고 엣지 캐시에서 응답합니다." },
  CachingDisabled: { label: "CachingDisabled (동적 콘텐츠·API)", ttlSeconds: 0, description: "캐시하지 않고 모든 요청을 원본으로 보냅니다." },
};

/** 원본의 오류 응답(4xx·5xx)을 캐시하는 기본 시간 (초) */
export const ERROR_CACHING_TTL = 10;

export const VIEWER_POLICY_LABEL: Record<CfBehavior["viewerProtocolPolicy"], string> = {
  "allow-all": "HTTP and HTTPS",
  "redirect-to-https": "Redirect HTTP to HTTPS",
  "https-only": "HTTPS only",
};

export const ALLOWED_METHODS_LABEL: Record<CfBehavior["allowedMethods"], string> = {
  GET_HEAD: "GET, HEAD",
  GET_HEAD_OPTIONS: "GET, HEAD, OPTIONS",
  ALL: "GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE",
};

const METHODS: Record<CfBehavior["allowedMethods"], string[]> = {
  GET_HEAD: ["GET", "HEAD"],
  GET_HEAD_OPTIONS: ["GET", "HEAD", "OPTIONS"],
  ALL: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
};

export const HTTP_METHODS = METHODS.ALL;

// ---------------------------------------------------------------- 경로 패턴

const PATH_PATTERN = /^[A-Za-z0-9_\-.*$/~"'@:+&?]+$/;

export function validatePathPattern(pattern: string): string | null {
  if (!pattern) return "경로 패턴을 입력하세요. 예: /api/*";
  if (pattern.length > 255) return "경로 패턴은 255자 이하여야 합니다.";
  if (!PATH_PATTERN.test(pattern)) return "경로 패턴에 쓸 수 없는 문자가 있습니다. 영문·숫자와 _ - . * $ / ~ \" ' @ : + & ? 만 쓸 수 있습니다.";
  return null;
}

const escapeRegex = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** 경로 패턴 일치: *는 0개 이상, ?는 정확히 1개 문자. 대소문자를 구분하고, 맨 앞의 /는 있어도 없어도 같다 */
export function pathPatternMatches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  const p = pattern.replace(/^\//, "");
  const target = path.replace(/^\//, "");
  return new RegExp(`^${escapeRegex(p).replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(target);
}

export const isDefaultBehavior = (b: CfBehavior) => b.pathPattern === "*";

/** 요청 경로에 적용되는 캐시 동작: 위에서부터 처음 일치하는 동작, 없으면 기본 동작(*) */
export function matchBehavior(dist: CfDistribution, path: string): CfBehavior {
  const ordered = dist.behaviors.filter((b) => !isDefaultBehavior(b));
  return ordered.find((b) => pathPatternMatches(b.pathPattern, path)) ?? dist.behaviors.find(isDefaultBehavior) ?? dist.behaviors[dist.behaviors.length - 1];
}

// ---------------------------------------------------------------- 무효화

export function validateInvalidationPath(path: string): string | null {
  if (!path.startsWith("/")) return `무효화 경로는 /로 시작해야 합니다: ${path}`;
  if (path.length > 255) return "무효화 경로는 255자 이하여야 합니다.";
  const star = path.indexOf("*");
  if (star >= 0 && star !== path.length - 1) return `와일드카드 *는 경로의 맨 끝에만 쓸 수 있습니다: ${path}`;
  return null;
}

export function invalidationMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

// ---------------------------------------------------------------- OAC (원본 액세스 제어)

/** OAC를 쓰는 배포가 버킷의 객체를 읽도록 허용하는 버킷 정책 문 (AWS 콘솔이 '정책 복사'로 주는 것과 같은 모양) */
export function oacPolicyStatement(bucketName: string, distributionId: string) {
  return {
    Sid: "AllowCloudFrontServicePrincipalReadOnly",
    Effect: "Allow",
    Principal: { Service: CLOUDFRONT_SERVICE },
    Action: "s3:GetObject",
    Resource: `arn:aws:s3:::${bucketName}/*`,
    Condition: { StringEquals: { "AWS:SourceArn": distributionArn(distributionId) } },
  };
}

/** 기존 버킷 정책에 OAC 허용 문을 더한 정책 JSON (같은 배포의 문이 이미 있으면 그대로) */
export function withOacStatement(policyText: string, bucketName: string, distributionId: string): string {
  const statement = oacPolicyStatement(bucketName, distributionId);
  let doc: { Version?: string; Statement?: unknown };
  try {
    doc = policyText.trim() ? (JSON.parse(policyText) as typeof doc) : {};
  } catch {
    doc = {};
  }
  const existing = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
  const already = existing.some((s) => JSON.stringify((s as { Condition?: unknown }).Condition ?? null).includes(distributionArn(distributionId)));
  return JSON.stringify({ Version: doc.Version ?? "2012-10-17", Statement: already ? existing : [...existing, statement] }, null, 2);
}

const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

interface RawStatement {
  Effect?: unknown;
  Principal?: unknown;
  Action?: unknown;
  Resource?: unknown;
  Condition?: unknown;
}

function rawStatements(bucket: S3Bucket): RawStatement[] {
  if (!bucket.policy.trim()) return [];
  try {
    const doc = JSON.parse(bucket.policy) as { Statement?: unknown };
    return asList(doc.Statement).filter((s): s is RawStatement => typeof s === "object" && s !== null);
  } catch {
    return [];
  }
}

/** 문이 CloudFront 서비스 주체에 적용되는지: Principal "*" 또는 Service에 cloudfront.amazonaws.com */
function appliesToCloudFront(principal: unknown): boolean {
  if (principal === "*") return true;
  if (typeof principal !== "object" || principal === null) return false;
  const p = principal as { Service?: unknown; AWS?: unknown };
  return asList(p.Service).includes(CLOUDFRONT_SERVICE) || asList(p.AWS).includes("*");
}

/** Condition에서 AWS:SourceArn 값들을 꺼낸다 (조건 키는 대소문자를 구분하지 않는다). 그 키가 없으면 null */
function sourceArns(condition: unknown): string[] | null {
  if (typeof condition !== "object" || condition === null) return null;
  const found: string[] = [];
  let seen = false;
  for (const block of Object.values(condition as Record<string, unknown>)) {
    if (typeof block !== "object" || block === null) continue;
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (key.toLowerCase() !== "aws:sourcearn") continue;
      seen = true;
      for (const v of asList(value)) if (typeof v === "string") found.push(v);
    }
  }
  return seen ? found : null;
}

export interface OacDecision {
  allowed: boolean;
  /** 이 배포만 허용하도록 범위를 좁혔는지 (AWS:SourceArn 조건) */
  scoped: boolean;
  detail: string;
}

/**
 * OAC로 서명한 CloudFront의 요청을 버킷 정책이 허용하는지.
 * 일반 정책 평가와 달리 여기서는 AWS:SourceArn 조건을 실제로 확인한다 (OAC의 핵심이므로).
 */
export function evaluateOacAccess(bucket: S3Bucket, distributionId: string, action: string, resource: string): OacDecision {
  const arn = distributionArn(distributionId);
  const matching = rawStatements(bucket).filter(
    (s) =>
      appliesToCloudFront(s.Principal) &&
      asList(s.Action).some((a) => typeof a === "string" && actionMatches(a, action)) &&
      asList(s.Resource).some((r) => typeof r === "string" && resourceMatches(r, resource)),
  );
  const conditionOk = (s: RawStatement) => {
    const arns = sourceArns(s.Condition);
    return arns === null || arns.some((a) => resourceMatches(a, arn));
  };
  if (matching.some((s) => s.Effect === "Deny" && conditionOk(s))) return { allowed: false, scoped: false, detail: "버킷 정책에 이 요청을 거부하는 명시적 Deny 문이 있습니다." };
  const allows = matching.filter((s) => s.Effect === "Allow");
  if (!allows.length) return { allowed: false, scoped: false, detail: `버킷 정책에 ${CLOUDFRONT_SERVICE}에게 ${action}을(를) 허용하는 문이 없습니다.` };
  const ok = allows.filter(conditionOk);
  if (!ok.length) return { allowed: false, scoped: true, detail: `버킷 정책의 AWS:SourceArn 조건이 다른 배포를 가리킵니다. 이 배포의 ARN(${arn})을 넣어야 합니다.` };
  const scoped = ok.every((s) => sourceArns(s.Condition) !== null);
  return {
    allowed: true,
    scoped,
    detail: scoped
      ? "버킷 정책이 이 배포(AWS:SourceArn)의 CloudFront 요청만 허용합니다."
      : "버킷 정책이 CloudFront의 요청을 허용하지만 AWS:SourceArn 조건이 없어, 다른 계정의 배포도 이 버킷을 읽을 수 있습니다 (혼동된 대리자 문제).",
  };
}

// ---------------------------------------------------------------- 요청 시뮬레이션

export interface CfStep {
  title: string;
  status: "pass" | "fail" | "info" | "warn";
  detail: string;
  /** 관련 설정 항목 (설명 데이터의 설정 키) */
  field?: string;
}

export type XCache = "Hit from cloudfront" | "Miss from cloudfront" | "RefreshHit from cloudfront" | "Error from cloudfront" | "Redirect from cloudfront";

export interface CfRequest {
  protocol: "http" | "https";
  method: string;
  path: string;
}

export interface CfResponse {
  /** 응답 상태. 응답 자체가 없으면 0 */
  status: number;
  statusText: string;
  xCache: XCache | null;
  ageSeconds: number | null;
  location: string | null;
  contentType: string | null;
  /** 본문 앞부분 (가상) */
  preview: string | null;
  etag: string | null;
  steps: CfStep[];
  behavior: CfBehavior | null;
  origin: CfOrigin | null;
  /** 원본에 요청을 보냈는지 (캐시에서 응답하면 false) */
  originRequested: boolean;
  /** 이 응답을 엣지 캐시에 넣는다면 그 항목 (요청 테스트 화면이 저장한다) */
  store: CfCacheEntry | null;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
const statusText = (status: number) => STATUS_TEXT[status] ?? "";

interface OriginResponse {
  status: number;
  etag: string;
  contentType: string | null;
  preview: string | null;
  location?: string | null;
}

const previewOf = (text: string | null | undefined) => (text ? text.slice(0, 300) : null);

/** S3 버킷(REST 엔드포인트) 원본 */
function fetchS3(project: Project, dist: CfDistribution, origin: CfOrigin, key: string, steps: CfStep[]): OriginResponse {
  const bucket = project.services.s3.buckets.find((b) => b.id === origin.targetId);
  if (!bucket) {
    steps.push({ title: "원본: S3 버킷", status: "fail", detail: "원본 버킷이 삭제되었습니다. CloudFront가 원본을 찾지 못합니다.", field: "origin" });
    return { status: 404, etag: "", contentType: "application/xml", preview: "<Error><Code>NoSuchBucket</Code></Error>" };
  }
  const title = `원본: s3://${bucket.name}/${key}`;
  if (!key) {
    steps.push({
      title,
      status: "fail",
      detail: "루트(/) 요청인데 기본 루트 객체가 없어 S3에 빈 키를 요청했습니다. S3는 버킷 목록 조회로 처리해 접근을 거부합니다. 배포 설정에서 기본 루트 객체(예: index.html)를 지정하세요.",
      field: "defaultRootObject",
    });
    return { status: 403, etag: "", contentType: "application/xml", preview: "<Error><Code>AccessDenied</Code></Error>" };
  }
  const obj = findObject(bucket, key);
  if (origin.originAccess === "oac") {
    const read = evaluateOacAccess(bucket, dist.id, "s3:GetObject", objectArn(bucket.name, key));
    if (!read.allowed) {
      steps.push({ title, status: "fail", detail: `${read.detail} CloudFront는 OAC로 서명한 요청을 보내지만 S3가 거부합니다. 배포의 원본 탭에서 정책 문을 복사해 버킷 정책에 넣으세요.`, field: "originAccess" });
      return { status: 403, etag: "", contentType: "application/xml", preview: "<Error><Code>AccessDenied</Code></Error>" };
    }
    if (!obj) {
      const list = evaluateOacAccess(bucket, dist.id, "s3:ListBucket", bucketArn(bucket.name));
      steps.push({
        title,
        status: "fail",
        detail: list.allowed
          ? `버킷에 "${key}" 객체가 없습니다 (404).`
          : `버킷에 "${key}" 객체가 없습니다. CloudFront(OAC)에는 s3:ListBucket 권한이 없어, S3는 객체가 있는지 숨기려고 404 대신 403(AccessDenied)을 돌려줍니다.`,
        field: "origin",
      });
      return list.allowed ? { status: 404, etag: "", contentType: "application/xml", preview: "<Error><Code>NoSuchKey</Code></Error>" } : { status: 403, etag: "", contentType: "application/xml", preview: "<Error><Code>AccessDenied</Code></Error>" };
    }
    steps.push({ title, status: read.scoped ? "pass" : "warn", detail: `${read.detail} 버킷은 비공개로 두고 CloudFront를 통해서만 읽게 하는 구성입니다.`, field: "originAccess" });
    return { status: 200, etag: obj.etag, contentType: obj.contentType, preview: previewOf(obj.text) };
  }
  const access = evaluateS3Access(project, { bucketId: bucket.id, key, action: "s3:GetObject", caller: { kind: "anonymous" } });
  if (!access.ok) {
    steps.push({
      title,
      status: "fail",
      detail: `원본 액세스가 '퍼블릭'이라 CloudFront가 서명하지 않은(익명) 요청을 보내는데, S3가 ${access.httpStatus} ${access.code}(으)로 응답합니다. ${access.summary} 버킷을 공개하는 대신 OAC를 쓰는 것이 권장됩니다.`,
      field: "originAccess",
    });
    return { status: access.httpStatus || 403, etag: "", contentType: "application/xml", preview: `<Error><Code>${access.code}</Code></Error>` };
  }
  steps.push({ title, status: "warn", detail: "버킷이 공개되어 있어 익명 요청으로 읽습니다. 이 경우 CloudFront를 거치지 않고 S3 주소로도 누구나 읽을 수 있습니다. OAC로 바꾸고 버킷을 비공개로 두는 것이 권장됩니다.", field: "originAccess" });
  return { status: 200, etag: obj?.etag ?? "", contentType: obj?.contentType ?? null, preview: previewOf(obj?.text) };
}

/** S3 정적 웹 사이트 엔드포인트 원본 (HTTP만, 버킷이 공개되어 있어야 한다) */
function fetchS3Website(project: Project, origin: CfOrigin, path: string, steps: CfStep[]): OriginResponse {
  const bucket = project.services.s3.buckets.find((b) => b.id === origin.targetId);
  if (!bucket) {
    steps.push({ title: "원본: S3 웹 사이트 엔드포인트", status: "fail", detail: "원본 버킷이 삭제되었습니다.", field: "origin" });
    return { status: 404, etag: "", contentType: "text/html", preview: null };
  }
  const site = websiteRequest(project, bucket.id, path);
  const obj = site.key ? findObject(bucket, site.key) : undefined;
  steps.push({
    title: `원본: ${websiteEndpoint(bucket.name)}${path}`,
    status: site.status === 200 ? "pass" : site.status === 302 ? "info" : "fail",
    detail: `S3 웹 사이트 엔드포인트가 ${site.status} ${site.code}(으)로 응답합니다. ${site.explanation.join(" ")}${site.status === 200 ? " 웹 사이트 엔드포인트는 하위 폴더의 인덱스 문서와 오류 문서를 처리해 주지만, HTTP만 지원하고 버킷을 공개해야 합니다." : ""}`,
    field: "origin",
  });
  return { status: site.status, etag: obj?.etag ?? "", contentType: site.contentType, preview: previewOf(site.body), location: site.location ?? null };
}

/** ALB 원본: CloudFront는 인터넷에서 ALB로 접속한다 (인터넷 경계 ALB만 닿는다) */
function fetchAlb(topo: Topology, origin: CfOrigin, request: CfRequest, path: string, steps: CfStep[]): OriginResponse {
  const alb = topo.getOfType(origin.targetId, "alb");
  if (!alb) {
    steps.push({ title: "원본: 로드 밸런서", status: "fail", detail: "원본 로드 밸런서가 삭제되었습니다.", field: "origin" });
    return { status: 502, etag: "", contentType: "text/html", preview: null };
  }
  const name = displayName(alb);
  const https = origin.protocolPolicy === "https-only" || (origin.protocolPolicy === "match-viewer" && request.protocol === "https");
  const port = https ? 443 : 80;
  const title = `원본: ${https ? "https" : "http"}://${name}${path}`;
  if (alb.config.scheme === "internal") {
    steps.push({ title, status: "fail", detail: `${name}은(는) 내부(internal) 로드 밸런서라 인터넷에서 접속하는 CloudFront가 닿을 수 없습니다. 인터넷 경계(internet-facing) ALB를 원본으로 쓰세요. (프라이빗 ALB에 연결하는 VPC 원본은 이 시뮬레이터가 지원하지 않습니다)`, field: "origin" });
    return { status: 504, etag: "", contentType: "text/html", preview: null };
  }
  if (alb.config.state !== "active") {
    steps.push({ title, status: "fail", detail: `${name}이(가) 아직 프로비저닝 중이라 연결을 받지 않습니다.`, field: "origin" });
    return { status: 502, etag: "", contentType: "text/html", preview: null };
  }
  const result = simulateWithTopology(topo, { source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP }, destination: { kind: "resource", resourceId: alb.id }, protocol: "tcp", port, httpPath: path });
  if (result.outcome === "success") {
    if (result.fixedResponse) {
      steps.push({ title, status: "pass", detail: `ALB의 리스너 규칙이 고정 응답 ${result.fixedResponse.statusCode}을(를) 돌려줍니다.`, field: "origin" });
      return { status: result.fixedResponse.statusCode, etag: "", contentType: result.fixedResponse.contentType, preview: previewOf(result.fixedResponse.body) };
    }
    const target = result.selectedTargetId ? topo.getOfType(result.selectedTargetId, "ec2") : null;
    const status = target?.config.httpResponseCode ?? 200;
    steps.push({ title, status: status < 400 ? "pass" : "fail", detail: `ALB가 요청을 ${target ? displayName(target) : "대상"}(으)로 전달했고 대상이 HTTP ${status}(으)로 응답합니다 (가상 응답).`, field: "origin" });
    return { status, etag: "", contentType: "text/html", preview: status < 400 ? `(${target ? displayName(target) : "대상"}의 가상 응답)` : null };
  }
  const reached = result.failure && (result.failure.category === "target" || result.failure.category === "service");
  steps.push({
    title,
    status: "fail",
    detail: reached
      ? `ALB까지는 닿지만 요청을 처리할 정상 대상이 없어 ALB가 503을 돌려줍니다: ${result.failure?.reason ?? result.summary}`
      : `CloudFront가 ALB의 ${port} 포트에 연결하지 못합니다: ${result.failure?.reason ?? result.summary} (ALB 보안 그룹이 인터넷에서 오는 ${port} 포트를 허용하고, 그 포트의 리스너가 있어야 합니다)`,
    field: reached ? "origin" : "originProtocolPolicy",
  });
  return { status: reached ? 503 : 504, etag: "", contentType: "text/html", preview: null };
}

function normalizePath(raw: string): string {
  const path = raw.trim().split("?")[0].split("#")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

/** 뷰어 요청 하나를 배포에 보냈을 때의 가상 응답과 근거 */
export function simulateCloudFrontRequest(project: Project, topo: Topology, dist: CfDistribution, request: CfRequest, now = Date.now()): CfResponse {
  const steps: CfStep[] = [];
  const path = normalizePath(request.path);
  const method = request.method.toUpperCase();
  const base = { ageSeconds: null, location: null, contentType: null, preview: null, etag: null, behavior: null, origin: null, originRequested: false, store: null } as const;
  const none = (title: string, detail: string, field?: string): CfResponse => {
    steps.push({ title, status: "fail", detail, field });
    return { ...base, status: 0, statusText: "응답 없음", xCache: null, steps };
  };

  if (!dist.enabled) return none("배포 상태", "비활성화된 배포는 요청을 처리하지 않습니다. 배포를 활성화하세요.", "distributionState");
  if (dist.state !== "Deployed") return none("배포 상태", "변경 사항을 엣지 로케이션에 배포하는 중(InProgress)입니다. 이 시뮬레이터는 배포가 끝난 뒤(Deployed)에 요청을 계산합니다. 몇 초 뒤 다시 시도하세요.", "distributionState");
  steps.push({ title: "배포", status: "pass", detail: `https://${dist.domainName} (가상 도메인) — 가장 가까운 엣지 로케이션이 요청을 받는다고 가정합니다.`, field: "domainName" });

  // 1. 캐시 동작 선택
  const behavior = matchBehavior(dist, path);
  const others = dist.behaviors.filter((b) => !isDefaultBehavior(b));
  steps.push({
    title: `캐시 동작: ${isDefaultBehavior(behavior) ? "기본 동작 (*)" : behavior.pathPattern}`,
    status: "info",
    detail: isDefaultBehavior(behavior)
      ? others.length
        ? `경로 ${path}이(가) 다른 동작(${others.map((b) => b.pathPattern).join(", ")})과 일치하지 않아 기본 동작을 씁니다.`
        : "동작이 하나뿐이라 기본 동작을 씁니다."
      : `경로 ${path}이(가) 패턴 ${behavior.pathPattern}과(와) 일치합니다. 동작은 위에서부터 처음 일치하는 것을 씁니다.`,
    field: "pathPattern",
  });
  const origin = dist.origins.find((o) => o.id === behavior.originId) ?? null;

  // 2. 뷰어 프로토콜 정책
  if (request.protocol === "http" && behavior.viewerProtocolPolicy === "redirect-to-https") {
    steps.push({ title: "뷰어 프로토콜 정책", status: "info", detail: "HTTP 요청을 HTTPS로 리디렉션합니다 (301). 브라우저는 같은 경로를 HTTPS로 다시 요청합니다.", field: "viewerProtocolPolicy" });
    return { ...base, status: 301, statusText: statusText(301), xCache: "Redirect from cloudfront", location: `https://${dist.domainName}${path}`, steps, behavior, origin };
  }
  if (request.protocol === "http" && behavior.viewerProtocolPolicy === "https-only") {
    steps.push({ title: "뷰어 프로토콜 정책", status: "fail", detail: "이 동작은 HTTPS만 허용합니다. HTTP 요청은 403으로 거부됩니다.", field: "viewerProtocolPolicy" });
    return { ...base, status: 403, statusText: statusText(403), xCache: "Error from cloudfront", steps, behavior, origin };
  }
  steps.push({ title: "뷰어 프로토콜 정책", status: request.protocol === "http" ? "warn" : "pass", detail: request.protocol === "http" ? "HTTP 요청을 그대로 허용합니다 (암호화되지 않음). 'Redirect HTTP to HTTPS'가 권장됩니다." : `HTTPS 요청입니다 (${VIEWER_POLICY_LABEL[behavior.viewerProtocolPolicy]}). 기본 도메인은 CloudFront 인증서(*.cloudfront.net)를 씁니다.`, field: "viewerProtocolPolicy" });

  // 3. 허용 메서드
  if (!METHODS[behavior.allowedMethods].includes(method)) {
    steps.push({ title: "허용된 HTTP 메서드", status: "fail", detail: `이 동작은 ${ALLOWED_METHODS_LABEL[behavior.allowedMethods]}만 허용합니다. ${method} 요청은 원본에 보내지 않고 403으로 거부합니다.`, field: "allowedMethods" });
    return { ...base, status: 403, statusText: statusText(403), xCache: "Error from cloudfront", steps, behavior, origin };
  }
  if (!origin) {
    steps.push({ title: "원본", status: "fail", detail: `동작이 가리키는 원본 ${behavior.originId}이(가) 배포에 없습니다.`, field: "origin" });
    return { ...base, status: 502, statusText: statusText(502), xCache: "Error from cloudfront", steps, behavior, origin };
  }

  // 4. 엣지 캐시
  const cacheable = method === "GET" || method === "HEAD";
  const policy = CACHE_POLICY_INFO[behavior.cachePolicy];
  const entry = cacheable ? dist.cache.find((c) => c.path === path) : undefined;
  const entryAge = entry ? Math.max(0, Math.floor((now - Date.parse(entry.cachedAt)) / 1000)) : 0;
  if (entry && policy.ttlSeconds > 0 && entryAge < entry.ttlSeconds) {
    steps.push({
      title: "엣지 캐시",
      status: "pass",
      detail: `${entryAge}초 전에 캐시한 응답이 있어 원본에 가지 않고 바로 응답합니다 (TTL ${entry.ttlSeconds.toLocaleString("ko-KR")}초). 그사이 원본의 내용이 바뀌었어도 캐시된 내용이 나갑니다 — 바로 반영하려면 무효화를 만드세요.`,
      field: "cachePolicy",
    });
    return { ...base, status: entry.status, statusText: statusText(entry.status), xCache: entry.status >= 400 ? "Error from cloudfront" : "Hit from cloudfront", ageSeconds: entryAge, preview: entry.preview, etag: entry.etag || null, steps, behavior, origin };
  }
  steps.push({
    title: "엣지 캐시",
    status: "info",
    detail: !cacheable
      ? `${method} 요청은 캐시하지 않고 원본으로 보냅니다.`
      : policy.ttlSeconds === 0
        ? "캐시 정책이 CachingDisabled라 항상 원본으로 보냅니다."
        : entry
          ? `캐시한 응답의 TTL(${entry.ttlSeconds.toLocaleString("ko-KR")}초)이 지나 원본에 다시 확인합니다.`
          : "이 경로는 캐시에 없어 원본으로 보냅니다 (캐시 누락).",
    field: "cachePolicy",
  });

  // 5. 원본 요청
  let originPath = path;
  if (path === "/" && dist.defaultRootObject) {
    originPath = `/${dist.defaultRootObject.replace(/^\//, "")}`;
    steps.push({ title: "기본 루트 객체", status: "info", detail: `루트(/) 요청이라 ${originPath}(으)로 바꿔 원본에 요청합니다. 하위 폴더(예: /blog/)에는 적용되지 않습니다.`, field: "defaultRootObject" });
  }
  let res: OriginResponse;
  if (origin.kind === "s3") res = fetchS3(project, dist, origin, decodeKey(originPath), steps);
  else if (origin.kind === "s3-website") res = fetchS3Website(project, origin, originPath, steps);
  else res = fetchAlb(topo, origin, request, originPath, steps);

  // 6. 캐시에 저장
  const refreshed = !!entry && res.status === 200 && !!res.etag && res.etag === entry.etag;
  const ttl = !cacheable || policy.ttlSeconds === 0 ? 0 : res.status >= 400 ? ERROR_CACHING_TTL : res.status === 200 ? policy.ttlSeconds : 0;
  const store: CfCacheEntry | null = ttl > 0 ? { path, status: res.status, etag: res.etag, preview: res.preview, cachedAt: new Date(now).toISOString(), ttlSeconds: ttl } : null;
  if (store) {
    steps.push({
      title: "캐시에 저장",
      status: "info",
      detail: res.status >= 400 ? `오류 응답도 ${ERROR_CACHING_TTL}초 동안 캐시합니다 (원본을 고친 직후 잠깐 같은 오류가 보일 수 있습니다).` : `응답을 엣지 캐시에 ${ttl.toLocaleString("ko-KR")}초 동안 저장합니다. 다음 요청부터는 캐시에서 응답합니다.`,
      field: "cachePolicy",
    });
  }
  const xCache: XCache = res.status >= 400 ? "Error from cloudfront" : refreshed ? "RefreshHit from cloudfront" : "Miss from cloudfront";
  return {
    status: res.status,
    statusText: statusText(res.status),
    xCache,
    ageSeconds: null,
    location: res.location ?? null,
    contentType: res.contentType,
    preview: res.preview,
    etag: res.etag || null,
    steps,
    behavior,
    origin,
    originRequested: true,
    store,
  };
}

function decodeKey(path: string): string {
  const key = path.replace(/^\/+/, "");
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** 원본이 가리키는 대상의 이름 (표시용) */
export function originTargetName(project: Project, origin: CfOrigin): string {
  if (origin.kind === "alb") {
    const alb = project.resources.find((r) => r.id === origin.targetId);
    return alb ? displayName(alb) : `${origin.targetId} (삭제됨)`;
  }
  const bucket = project.services.s3.buckets.find((b) => b.id === origin.targetId);
  return bucket ? bucket.name : "(삭제된 버킷)";
}

export const ORIGIN_KIND_LABEL: Record<CfOrigin["kind"], string> = {
  s3: "S3 버킷 (REST 엔드포인트)",
  "s3-website": "S3 정적 웹 사이트 엔드포인트",
  alb: "Application Load Balancer",
};

/** 배포마다 원본에 닿는지 한 번씩 확인한 요약 (목록·검증용): 기본 동작의 루트(/) 요청 결과 */
export function distributionHealth(project: Project, topo: Topology, dist: CfDistribution): { ok: boolean; status: number; detail: string } {
  const res = simulateCloudFrontRequest(project, topo, { ...dist, enabled: true, state: "Deployed", cache: [] }, { protocol: "https", method: "GET", path: "/" }, Date.now());
  const failed = res.steps.filter((s) => s.status === "fail");
  return { ok: res.status > 0 && res.status < 400, status: res.status, detail: failed.length ? failed[failed.length - 1].detail : `루트(/) 요청이 ${res.status} ${res.statusText}(으)로 응답합니다.` };
}
