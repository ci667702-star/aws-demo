/**
 * 가상 S3 엔진.
 * - 버킷 이름·객체 키 규칙
 * - 퍼블릭 여부 판단 (버킷 정책 + 퍼블릭 액세스 차단)
 * - 접근 평가: 네트워크(EC2에서 S3 엔드포인트까지) → 자격 증명 → IAM 정책 + 버킷 정책 → 객체 존재
 * - 정적 웹 사이트 응답
 * 실제 S3 요청을 보내지 않으며 모든 결과는 설정값으로 계산한 가상 결과다.
 */
import { simulate, type SimulationResult } from "./connectivity-engine";
import { bucketArn, checkPolicyDocument, evaluateIam, objectArn, principalLabel, type IamDecision, type IamPrincipal, type PolicyStatement } from "./iam-engine";
import type { Project, S3Bucket, S3Object } from "./resource-models";

export const S3_REGION = "ap-northeast-2";
export const S3_REGION_LABEL = "아시아 태평양(서울) ap-northeast-2";
/** 가상 S3 엔드포인트 주소 (문서용 예시 대역 TEST-NET-1. 198.51.100.0/24는 시뮬레이터의 퍼블릭 IP 풀이라 쓰지 않는다) */
export const S3_ENDPOINT_IP = "192.0.2.80";
export const S3_ENDPOINT_HOST = `s3.${S3_REGION}.amazonaws.com`;
/** 내용을 저장하는 텍스트 파일 최대 크기 (브라우저 저장 공간 보호) */
export const S3_TEXT_LIMIT = 16 * 1024;
/** 버전 관리에서 보관하는 이전 버전 수 (시뮬레이터 제한) */
export const S3_VERSION_LIMIT = 10;

// ---------------------------------------------------------------- 이름 규칙

const RESERVED_PREFIXES = ["xn--", "sthree-", "amzn-s3-demo-"];
const RESERVED_SUFFIXES = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];

/** 범용 버킷 이름 규칙. 위반하면 이유를, 맞으면 null을 돌려준다. */
export function validateBucketName(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "버킷 이름은 3~63자여야 합니다.";
  if (!/^[a-z0-9.-]+$/.test(name)) return "버킷 이름에는 영문 소문자, 숫자, 마침표(.), 하이픈(-)만 쓸 수 있습니다. (대문자·밑줄·공백 불가)";
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return "버킷 이름은 영문 소문자나 숫자로 시작하고 끝나야 합니다.";
  if (name.includes("..")) return "마침표(.)를 연달아 쓸 수 없습니다.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return "IP 주소 형식(예: 192.168.5.4)은 버킷 이름으로 쓸 수 없습니다.";
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `"${prefix}"(으)로 시작하는 이름은 AWS가 예약해 두었습니다.`;
  const suffix = RESERVED_SUFFIXES.find((s) => name.endsWith(s));
  if (suffix) return `"${suffix}"(으)로 끝나는 이름은 AWS가 예약해 두었습니다.`;
  return null;
}

export function bucketNameWarnings(name: string): string[] {
  return name.includes(".") ? ["이름에 마침표(.)가 있으면 HTTPS 가상 호스팅 주소의 인증서가 맞지 않을 수 있어 AWS는 하이픈(-)을 권장합니다."] : [];
}

/**
 * 실제 S3에서는 모든 AWS 계정이 버킷 이름을 공유하므로 흔한 이름은 이미 누가 쓰고 있다.
 * 이를 체험하도록 몇몇 이름은 "다른 계정이 사용 중"으로 취급한다.
 */
export const GLOBALLY_TAKEN_BUCKET_NAMES = ["test", "my-bucket", "mybucket", "bucket", "example", "aws", "website", "images", "backup", "data", "logs", "static"];

export function validateObjectKey(key: string): string | null {
  if (!key) return "객체 키(이름)를 입력하세요.";
  if (new TextEncoder().encode(key).length > 1024) return "객체 키는 UTF-8 기준 1024바이트 이하여야 합니다.";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "객체 키에 제어 문자를 쓸 수 없습니다.";
  return null;
}

// ---------------------------------------------------------------- 주소

export const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
export const objectUrl = (bucket: string, key: string) => `https://${bucket}.s3.${S3_REGION}.amazonaws.com/${encodeKey(key)}`;
export const objectS3Uri = (bucket: string, key: string) => `s3://${bucket}/${key}`;
export const websiteEndpoint = (bucket: string) => `http://${bucket}.s3-website.${S3_REGION}.amazonaws.com`;

// ---------------------------------------------------------------- 퍼블릭 여부

export function bucketPolicyStatements(bucket: S3Bucket): PolicyStatement[] {
  if (!bucket.policy.trim()) return [];
  return checkPolicyDocument(bucket.policy, "resource").statements;
}

/** Principal "*"에게 무언가를 허용하는 문장이 있으면 퍼블릭 정책 */
export function isPublicPolicy(statements: PolicyStatement[]): boolean {
  return statements.some((s) => s.effect === "Allow" && !!s.principal?.any);
}

export function bpaAllOn(bucket: S3Bucket): boolean {
  const b = bucket.blockPublicAccess;
  return b.blockPublicAcls && b.ignorePublicAcls && b.blockPublicPolicy && b.restrictPublicBuckets;
}

export type BucketAccessKind = "public" | "can-be-public" | "not-public";

/** S3 버킷 목록의 '액세스' 열 */
export function bucketAccess(bucket: S3Bucket): { kind: BucketAccessKind; label: string; detail: string } {
  const publicPolicy = isPublicPolicy(bucketPolicyStatements(bucket));
  if (publicPolicy && !bucket.blockPublicAccess.restrictPublicBuckets) {
    return { kind: "public", label: "퍼블릭", detail: "버킷 정책이 인터넷의 누구에게나 접근을 허용합니다." };
  }
  if (bpaAllOn(bucket)) return { kind: "not-public", label: "버킷 및 객체가 퍼블릭이 아님", detail: "퍼블릭 액세스 차단 설정 4개가 모두 켜져 있습니다." };
  if (publicPolicy) return { kind: "not-public", label: "버킷 및 객체가 퍼블릭이 아님", detail: "퍼블릭 정책이 있지만 '퍼블릭 버킷 제한' 설정 때문에 적용되지 않습니다." };
  return { kind: "can-be-public", label: "객체를 퍼블릭으로 설정할 수 있음", detail: "퍼블릭 액세스 차단 일부가 꺼져 있어 정책으로 공개할 수 있습니다." };
}

// ---------------------------------------------------------------- 객체 목록

/** 삭제 마커가 아닌 현재 객체 */
export function visibleObjects(bucket: S3Bucket): S3Object[] {
  return bucket.objects.filter((o) => !o.deleteMarker);
}

export function findObject(bucket: S3Bucket, key: string): S3Object | undefined {
  return bucket.objects.find((o) => o.key === key && !o.deleteMarker);
}

/** 접두사(폴더) 한 단계의 하위 폴더와 객체 */
export function listLevel(bucket: S3Bucket, prefix: string, includeDeleted = false): { folders: string[]; objects: S3Object[] } {
  const folders = new Set<string>();
  const objects: S3Object[] = [];
  for (const o of bucket.objects) {
    if (!includeDeleted && o.deleteMarker) continue;
    if (!o.key.startsWith(prefix)) continue;
    const rest = o.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0 && slash < rest.length - 1) folders.add(prefix + rest.slice(0, slash + 1));
    else if (slash === rest.length - 1 && rest.length > 0) folders.add(prefix + rest);
    else if (rest.length > 0) objects.push(o);
  }
  return { folders: [...folders].sort(), objects: objects.sort((a, b) => a.key.localeCompare(b.key)) };
}

export function bucketSize(bucket: S3Bucket): { objects: number; bytes: number } {
  const visible = visibleObjects(bucket);
  return { objects: visible.length, bytes: visible.reduce((s, o) => s + o.size, 0) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function guessContentType(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

export const isTextType = (contentType: string) => contentType.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(contentType);

// ---------------------------------------------------------------- 접근 평가

export type S3Caller = { kind: "anonymous" } | { kind: "user"; userId: string } | { kind: "role"; roleId: string } | { kind: "instance"; instanceId: string };

export interface S3AccessRequest {
  bucketId: string;
  /** 객체 작업이면 키, 버킷 작업이면 null */
  key: string | null;
  /** 예: s3:GetObject */
  action: string;
  caller: S3Caller;
}

export interface S3AccessStep {
  title: string;
  status: "pass" | "fail" | "info" | "warn";
  detail: string;
  link?: { label: string; path: string };
}

export interface S3AccessResult {
  ok: boolean;
  /** 0이면 연결 자체가 안 됨 */
  httpStatus: number;
  code: string;
  summary: string;
  steps: S3AccessStep[];
  principal: IamPrincipal | null;
  decision: IamDecision | null;
  network: SimulationResult | null;
}

/** S3 리소스 ARN에 해당하는 버킷의 리소스 기반 정책 */
export function s3ResourcePolicyFor(project: Project, resource: string): { bucket: S3Bucket; resourcePolicy: { label: string; statements: PolicyStatement[] }; restrictPublic: boolean } | null {
  const m = /^arn:aws:s3:::([^/]+)(\/.*)?$/.exec(resource);
  if (!m) return null;
  const bucket = project.services.s3.buckets.find((b) => b.name === m[1]);
  if (!bucket) return null;
  return { bucket, resourcePolicy: { label: `버킷 정책 (${bucket.name})`, statements: bucketPolicyStatements(bucket) }, restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets };
}

const OBJECT_ACTIONS = new Set(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);

export function evaluateS3Access(project: Project, request: S3AccessRequest): S3AccessResult {
  const steps: S3AccessStep[] = [];
  const fail = (httpStatus: number, code: string, summary: string, extra: Partial<S3AccessResult> = {}): S3AccessResult => ({
    ok: false,
    httpStatus,
    code,
    summary,
    steps,
    principal: null,
    decision: null,
    network: null,
    ...extra,
  });
  const bucket = project.services.s3.buckets.find((b) => b.id === request.bucketId);
  if (!bucket) {
    steps.push({ title: "버킷 확인", status: "fail", detail: "버킷이 없습니다." });
    return fail(404, "NoSuchBucket", "버킷이 없습니다.");
  }
  const objectAction = OBJECT_ACTIONS.has(request.action);
  const key = request.key ?? "";
  if (objectAction && !key) {
    steps.push({ title: "요청 확인", status: "fail", detail: "객체 작업에는 객체 키가 필요합니다." });
    return fail(400, "InvalidRequest", "객체 키를 입력하세요.");
  }
  const resource = objectAction ? objectArn(bucket.name, key) : bucketArn(bucket.name);

  // 1. 어디서 요청하는가 (네트워크)
  let principal: IamPrincipal;
  let network: SimulationResult | null = null;
  const caller = request.caller;
  if (caller.kind === "instance") {
    const inst = project.resources.find((r) => r.id === caller.instanceId);
    if (!inst || inst.type !== "ec2") {
      steps.push({ title: "요청하는 서버", status: "fail", detail: "인스턴스를 찾을 수 없습니다." });
      return fail(0, "InstanceNotFound", "인스턴스를 찾을 수 없습니다.");
    }
    network = simulate(project, { source: { kind: "resource", resourceId: inst.id }, destination: { kind: "internet", ip: S3_ENDPOINT_IP }, protocol: "tcp", port: 443 });
    if (network.outcome !== "success") {
      const fixes = network.failure?.fixes ?? [];
      steps.push({
        title: `네트워크: ${inst.id} → S3 엔드포인트(${S3_ENDPOINT_HOST}:443)`,
        status: "fail",
        detail: `${network.failure?.reason ?? network.summary}${fixes.length ? ` 해결 방법: ${fixes[0]}` : ""} (프라이빗 서브넷이라면 NAT 게이트웨이가 필요합니다. 실제 AWS에서는 S3 게이트웨이 VPC 엔드포인트도 쓸 수 있지만 이 시뮬레이터는 지원하지 않습니다.)`,
        link: { label: "Reachability Analyzer에서 자세히 보기", path: "/vpc/reachability/create" },
      });
      return fail(0, "ConnectTimeout", "서버에서 S3까지 네트워크로 연결되지 않아 요청이 시간 초과됩니다.", { network });
    }
    steps.push({ title: `네트워크: ${inst.id} → S3 엔드포인트(${S3_ENDPOINT_HOST}:443)`, status: "pass", detail: "라우팅·보안 그룹·NACL을 통과해 S3의 퍼블릭 엔드포인트에 연결됩니다." });
    const role = project.services.iam.roles.find((r) => r.id === inst.config.iamRoleId);
    if (role) {
      principal = { kind: "role", role };
      steps.push({ title: "자격 증명", status: "pass", detail: `인스턴스에 연결된 역할 ${role.name}의 임시 자격 증명으로 요청에 서명합니다 (액세스 키를 서버에 저장하지 않음).` });
    } else {
      principal = { kind: "anonymous" };
      steps.push({
        title: "자격 증명",
        status: "warn",
        detail: "인스턴스에 IAM 역할이 없어 서명되지 않은(익명) 요청으로 보냅니다. 비공개 버킷이면 거부됩니다.",
        link: { label: "IAM 역할 연결", path: `/ec2/instances/${inst.id}/iam-role` },
      });
    }
  } else if (caller.kind === "user") {
    const user = project.services.iam.users.find((u) => u.id === caller.userId);
    if (!user) {
      steps.push({ title: "자격 증명", status: "fail", detail: "IAM 사용자를 찾을 수 없습니다." });
      return fail(403, "InvalidAccessKeyId", "IAM 사용자를 찾을 수 없습니다.");
    }
    steps.push({ title: "네트워크", status: "info", detail: "인터넷(노트북 등)에서 S3 퍼블릭 엔드포인트로 요청한다고 가정합니다." });
    const active = user.accessKeys.find((k) => k.status === "Active");
    if (!active) {
      steps.push({
        title: "자격 증명",
        status: "fail",
        detail: `${user.name}에게 활성 액세스 키가 없어 프로그램(CLI·SDK)이 요청에 서명할 수 없습니다.`,
        link: { label: "액세스 키 만들기", path: `/iam/users/${user.id}/create-access-key` },
      });
      return fail(403, "InvalidAccessKeyId", "사용할 수 있는 액세스 키가 없습니다.");
    }
    principal = { kind: "user", user };
    steps.push({ title: "자격 증명", status: "pass", detail: `${user.name}의 액세스 키 ${active.id}(가상)로 요청에 서명합니다.` });
  } else if (caller.kind === "role") {
    const role = project.services.iam.roles.find((r) => r.id === caller.roleId);
    if (!role) {
      steps.push({ title: "자격 증명", status: "fail", detail: "역할을 찾을 수 없습니다." });
      return fail(403, "AccessDenied", "역할을 찾을 수 없습니다.");
    }
    principal = { kind: "role", role };
    steps.push({ title: "자격 증명", status: "pass", detail: `역할 ${role.name}의 임시 자격 증명으로 요청한다고 가정합니다.` });
  } else {
    principal = { kind: "anonymous" };
    steps.push({ title: "네트워크", status: "info", detail: "인터넷의 브라우저에서 S3 퍼블릭 엔드포인트로 요청합니다." });
    steps.push({ title: "자격 증명", status: "info", detail: "서명하지 않은(익명) 요청입니다. 버킷 정책이 Principal \"*\"에게 허용해야만 성공합니다." });
  }

  // 2. 권한 평가 (IAM 정책 + 버킷 정책 + 퍼블릭 액세스 차단)
  const statements = bucketPolicyStatements(bucket);
  const decision = evaluateIam(project, principal, request.action, resource, {
    resourcePolicy: statements.length ? { label: `버킷 정책 (${bucket.name})`, statements } : null,
    restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets,
  });
  steps.push({
    title: `권한: ${principalLabel(principal)} → ${request.action} → ${resource}`,
    status: decision.decision === "allowed" ? "pass" : "fail",
    detail: decision.explanation.join(" "),
    link: decision.decision === "allowed" ? undefined : principal.kind === "anonymous" ? { label: "버킷 권한 탭", path: `/s3/buckets/${bucket.id}?tab=permissions` } : { label: "정책 시뮬레이터", path: "/iam/simulator" },
  });
  if (decision.decision !== "allowed") {
    return fail(403, "AccessDenied", decision.decision === "explicit-deny" ? "명시적 Deny 때문에 거부되었습니다." : "허용하는 정책이 없어 거부되었습니다.", { principal, decision, network });
  }

  // 3. 대상 확인
  if (request.action === "s3:GetObject" || request.action === "s3:DeleteObject") {
    const obj = findObject(bucket, key);
    if (!obj) {
      if (request.action === "s3:DeleteObject") {
        steps.push({ title: "객체 확인", status: "info", detail: "해당 키의 객체가 없지만 S3는 삭제 요청에 성공(204)으로 응답합니다." });
        return { ok: true, httpStatus: 204, code: "NoContent", summary: "삭제 요청 성공 (객체는 원래 없었음)", steps, principal, decision, network };
      }
      const canList = evaluateIam(project, principal, "s3:ListBucket", bucketArn(bucket.name), {
        resourcePolicy: statements.length ? { label: "버킷 정책", statements } : null,
        restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets,
      });
      if (canList.decision !== "allowed") {
        steps.push({ title: "객체 확인", status: "fail", detail: "객체가 없습니다. s3:ListBucket 권한이 없으면 S3는 객체 존재 여부를 숨기려고 404 대신 403을 돌려줍니다." });
        return fail(403, "AccessDenied", "객체가 없고 ListBucket 권한도 없어 403으로 응답합니다.", { principal, decision, network });
      }
      steps.push({ title: "객체 확인", status: "fail", detail: `버킷에 "${key}" 키의 객체가 없습니다.` });
      return fail(404, "NoSuchKey", "객체가 없습니다.", { principal, decision, network });
    }
    if (request.action === "s3:DeleteObject") {
      steps.push({ title: "객체 확인", status: "pass", detail: "시험 평가이므로 실제로 삭제하지는 않습니다." });
      return { ok: true, httpStatus: 204, code: "NoContent", summary: "삭제할 수 있습니다 (204 No Content).", steps, principal, decision, network };
    }
    steps.push({ title: "객체 확인", status: "pass", detail: `${obj.key} (${formatBytes(obj.size)}, ${obj.contentType})` });
    return { ok: true, httpStatus: 200, code: "OK", summary: "객체를 읽을 수 있습니다 (200 OK).", steps, principal, decision, network };
  }
  if (request.action === "s3:PutObject") steps.push({ title: "업로드", status: "pass", detail: "시험 평가이므로 실제로 객체를 올리지는 않습니다." });
  if (request.action === "s3:ListBucket") steps.push({ title: "목록", status: "pass", detail: `객체 ${visibleObjects(bucket).length}개를 나열할 수 있습니다.` });
  return { ok: true, httpStatus: 200, code: "OK", summary: "요청이 허용됩니다 (200 OK).", steps, principal, decision, network };
}

// ---------------------------------------------------------------- 정적 웹 사이트

export interface WebsiteResponse {
  status: number;
  code: string;
  key: string | null;
  contentType: string;
  /** 저장된 텍스트 내용 (없으면 null) */
  body: string | null;
  /** 리디렉션 위치 */
  location?: string;
  explanation: string[];
}

export function websiteRequest(project: Project, bucketId: string, rawPath: string): WebsiteResponse {
  const bucket = project.services.s3.buckets.find((b) => b.id === bucketId);
  const none = (status: number, code: string, explanation: string[]): WebsiteResponse => ({ status, code, key: null, contentType: "text/html", body: null, explanation });
  if (!bucket) return none(404, "NoSuchBucket", ["버킷이 없습니다."]);
  if (!bucket.website.enabled) return none(404, "NoSuchWebsiteConfiguration", ["이 버킷은 정적 웹 사이트 호스팅이 꺼져 있습니다. 속성 탭에서 켜세요."]);
  let path = rawPath.trim().replace(/^\/+/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // 잘못된 인코딩은 그대로 사용
  }
  const index = bucket.website.indexDocument || "index.html";
  const key = path === "" || path.endsWith("/") ? `${path}${index}` : path;
  const statements = bucketPolicyStatements(bucket);
  const access = (k: string) =>
    evaluateIam(project, { kind: "anonymous" }, "s3:GetObject", objectArn(bucket.name, k), {
      resourcePolicy: statements.length ? { label: "버킷 정책", statements } : null,
      restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets,
    });
  const explanation = [`요청 경로 /${path} → 객체 키 "${key}"`];
  const decision = access(key);
  if (decision.decision !== "allowed") {
    explanation.push(...decision.explanation);
    explanation.push("웹 사이트 방문자는 익명 사용자이므로 버킷 정책으로 s3:GetObject를 Principal \"*\"에게 허용해야 하고, 퍼블릭 액세스 차단을 꺼야 합니다.");
    return none(403, "AccessDenied", explanation);
  }
  const obj = findObject(bucket, key);
  if (obj) return { status: 200, code: "OK", key, contentType: obj.contentType, body: obj.text, explanation: [...explanation, "객체를 찾아 그대로 돌려줍니다."] };
  if (path && !path.endsWith("/") && findObject(bucket, `${path}/${index}`)) {
    return { status: 302, code: "Found", key: null, contentType: "text/html", body: null, location: `/${path}/`, explanation: [...explanation, `"${path}/" 폴더에 인덱스 문서가 있어 /${path}/(으)로 리디렉션합니다.`] };
  }
  const errorDoc = bucket.website.errorDocument;
  if (errorDoc) {
    const err = findObject(bucket, errorDoc);
    if (err && access(errorDoc).decision === "allowed") {
      return { status: 404, code: "NoSuchKey", key: errorDoc, contentType: err.contentType, body: err.text, explanation: [...explanation, `객체가 없어 오류 문서 "${errorDoc}"를 404 상태로 돌려줍니다.`] };
    }
    explanation.push(`오류 문서 "${errorDoc}"도 없거나 읽을 수 없습니다.`);
  }
  return none(404, "NoSuchKey", [...explanation, "해당 키의 객체가 없습니다."]);
}
