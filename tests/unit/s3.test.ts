import { beforeEach, describe, expect, it } from "vitest";
import { bucketAccess, evaluateS3Access, listLevel, validateBucketName, visibleObjects, websiteRequest } from "@/lib/engine/s3-engine";
import type { Project } from "@/lib/engine/resource-models";
import type { ActionResult } from "@/lib/project/console-actions";
import { createEmptyProject } from "@/lib/project/factory";
import * as iam from "@/lib/project/iam-actions";
import * as s3 from "@/lib/project/s3-actions";
import { idOf, privateNatProject, publicWebProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function must(r: ActionResult): { project: Project; id: string } {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}
const err = (r: ActionResult) => {
  if (r.ok) throw new Error("성공하면 안 됩니다");
  return r.error;
};
const ALL_BLOCKED = { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true };
const NONE_BLOCKED = { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false };
const bucketOf = (p: Project, id: string) => p.services.s3.buckets.find((b) => b.id === id)!;
const publicRead = (name: string) =>
  JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${name}/*` }] });

function bucket(p: Project, name = "site-2026-kim", options: Partial<s3.CreateBucketInput> = {}) {
  return must(s3.createBucket(p, { name, blockPublicAccess: ALL_BLOCKED, versioning: "Disabled", encryption: "SSE-S3", ...options }));
}

describe("버킷 이름 규칙", () => {
  it("AWS 규칙을 검사한다", () => {
    expect(validateBucketName("My_Bucket")).toContain("소문자");
    expect(validateBucketName("ab")).toContain("3~63");
    expect(validateBucketName("192.168.5.4")).toContain("IP 주소");
    expect(validateBucketName("xn--abc")).toContain("예약");
    expect(validateBucketName("a..b")).toContain("연달아");
    expect(validateBucketName("-abc")).toContain("시작");
    expect(validateBucketName("good-name-123")).toBeNull();
  });

  it("중복 이름과 다른 계정이 쓰는 이름을 구분한다", () => {
    const a = bucket(createEmptyProject("s3"));
    expect(err(s3.createBucket(a.project, { name: "site-2026-kim", blockPublicAccess: ALL_BLOCKED, versioning: "Disabled", encryption: "SSE-S3" }))).toContain("[BucketAlreadyOwnedByYou]");
    expect(err(s3.createBucket(a.project, { name: "test", blockPublicAccess: ALL_BLOCKED, versioning: "Disabled", encryption: "SSE-S3" }))).toContain("[BucketAlreadyExists]");
  });
});

describe("버킷 정책과 퍼블릭 액세스 차단", () => {
  it("퍼블릭 정책은 차단이 켜져 있으면 저장되지 않고, 끄면 저장되어 퍼블릭이 된다", () => {
    const b = bucket(createEmptyProject("s3"));
    expect(err(s3.putBucketPolicy(b.project, b.id, publicRead("site-2026-kim")))).toContain("[AccessDenied]");
    expect(bucketAccess(bucketOf(b.project, b.id)).kind).toBe("not-public");
    const opened = must(s3.setBlockPublicAccess(b.project, b.id, NONE_BLOCKED)).project;
    expect(bucketAccess(bucketOf(opened, b.id)).kind).toBe("can-be-public");
    const published = must(s3.putBucketPolicy(opened, b.id, publicRead("site-2026-kim"))).project;
    expect(bucketAccess(bucketOf(published, b.id)).kind).toBe("public");
  });

  it("다른 버킷을 가리키는 Resource나 Principal 없는 문장은 MalformedPolicy", () => {
    const b = bucket(createEmptyProject("s3"), "site-2026-kim", { blockPublicAccess: NONE_BLOCKED });
    expect(err(s3.putBucketPolicy(b.project, b.id, publicRead("other-bucket")))).toContain("invalid resource");
    const noPrincipal = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::site-2026-kim/*" }] });
    expect(err(s3.putBucketPolicy(b.project, b.id, noPrincipal))).toContain("[MalformedPolicy]");
  });
});

describe("객체와 버전 관리", () => {
  it("버전 관리가 켜진 버킷은 덮어쓰기와 삭제를 되돌릴 수 있다", () => {
    const b = bucket(createEmptyProject("s3"), "versioned-2026", { versioning: "Enabled" });
    let p = must(s3.putObject(b.project, b.id, { key: "docs/a.txt", size: 2, text: "v1" })).project;
    p = must(s3.putObject(p, b.id, { key: "docs/a.txt", size: 2, text: "v2" })).project;
    expect(bucketOf(p, b.id).objects[0].previousVersions).toHaveLength(1);
    p = must(s3.deleteObject(p, b.id, "docs/a.txt")).project;
    expect(visibleObjects(bucketOf(p, b.id))).toHaveLength(0);
    const marker = bucketOf(p, b.id).objects[0];
    expect(marker.deleteMarker).toBe(true);
    p = must(s3.deleteObject(p, b.id, "docs/a.txt", marker.versionId)).project;
    expect(visibleObjects(bucketOf(p, b.id))[0].text).toBe("v2");
    expect(listLevel(bucketOf(p, b.id), "").folders).toEqual(["docs/"]);
  });

  it("버전 관리가 꺼진 버킷은 덮어쓰고 영구 삭제하며, 비어 있지 않은 버킷은 삭제할 수 없다", () => {
    const b = bucket(createEmptyProject("s3"));
    let p = must(s3.putObject(b.project, b.id, { key: "a.txt", size: 1, text: "1" })).project;
    p = must(s3.putObject(p, b.id, { key: "a.txt", size: 1, text: "2" })).project;
    expect(bucketOf(p, b.id).objects[0].previousVersions).toHaveLength(0);
    expect(err(s3.deleteBucket(p, b.id))).toContain("[BucketNotEmpty]");
    expect(err(s3.setBucketVersioning(p, b.id, "Suspended"))).toContain("IllegalVersioning");
    p = must(s3.emptyBucket(p, b.id)).project;
    expect(must(s3.deleteBucket(p, b.id)).project.services.s3.buckets).toHaveLength(0);
  });
});

describe("S3 접근 평가", () => {
  function site() {
    const b = bucket(createEmptyProject("s3"), "site-2026-kim", { blockPublicAccess: NONE_BLOCKED });
    let p = must(s3.putObject(b.project, b.id, { key: "index.html", size: 20, text: "<h1>hello</h1>" })).project;
    p = must(s3.putObject(p, b.id, { key: "error.html", size: 20, text: "<h1>404</h1>" })).project;
    return { project: p, bucketId: b.id };
  }

  it("익명 요청은 퍼블릭 정책이 있을 때만 허용되고, 퍼블릭 버킷 제한이 켜지면 다시 거부된다", () => {
    const s = site();
    const anon = { bucketId: s.bucketId, key: "index.html", action: "s3:GetObject", caller: { kind: "anonymous" as const } };
    expect(evaluateS3Access(s.project, anon).httpStatus).toBe(403);
    const pub = must(s3.putBucketPolicy(s.project, s.bucketId, publicRead("site-2026-kim"))).project;
    expect(evaluateS3Access(pub, anon).httpStatus).toBe(200);
    // ListBucket이 없으면 없는 키도 403
    expect(evaluateS3Access(pub, { ...anon, key: "missing.html" }).httpStatus).toBe(403);
    const restricted = must(s3.setBlockPublicAccess(pub, s.bucketId, { ...NONE_BLOCKED, restrictPublicBuckets: true })).project;
    expect(evaluateS3Access(restricted, anon).httpStatus).toBe(403);
  });

  it("IAM 사용자는 활성 액세스 키와 권한이 있어야 하고, ListBucket이 있으면 없는 키는 404", () => {
    const s = site();
    const u = must(iam.createUser(s.project, { name: "dev", groupIds: [], policyIds: ["aws:AmazonS3ReadOnlyAccess"], consoleAccess: false }));
    const req = { bucketId: s.bucketId, key: "index.html", action: "s3:GetObject", caller: { kind: "user" as const, userId: u.id } };
    expect(evaluateS3Access(u.project, req).code).toBe("InvalidAccessKeyId");
    const k = iam.createAccessKey(u.project, u.id, { useCase: "cli", description: "" });
    if (!k.ok) throw new Error(k.error);
    expect(evaluateS3Access(k.project, req).httpStatus).toBe(200);
    expect(evaluateS3Access(k.project, { ...req, key: "nope.txt" }).httpStatus).toBe(404);
    expect(evaluateS3Access(k.project, { ...req, action: "s3:PutObject" }).httpStatus).toBe(403);
  });

  it("EC2는 S3까지 네트워크 경로와 역할이 필요하다", () => {
    let p = publicWebProject({ sgInbound: [] });
    const b = bucket(p, "app-data-2026");
    p = must(s3.putObject(b.project, b.id, { key: "config.json", size: 2, text: "{}" })).project;
    const role = must(iam.createRole(p, { name: "web-role", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: ["aws:AmazonS3ReadOnlyAccess"] }));
    const web = idOf(role.project, "web");
    const req = { bucketId: b.id, key: "config.json", action: "s3:GetObject", caller: { kind: "instance" as const, instanceId: web } };
    const anonymous = evaluateS3Access(role.project, req);
    expect(anonymous.httpStatus).toBe(403);
    expect(anonymous.steps.some((s) => s.title === "자격 증명" && s.status === "warn")).toBe(true);
    const withRole = must(iam.setInstanceRole(role.project, web, role.id)).project;
    expect(evaluateS3Access(withRole, req).httpStatus).toBe(200);

    // 프라이빗 서브넷 + NAT 없음 → 연결 실패
    const priv = privateNatProject({ natState: "failed" });
    const b2 = bucket(priv, "app-data-2027");
    const res = evaluateS3Access(b2.project, { ...req, bucketId: b2.id, caller: { kind: "instance", instanceId: idOf(b2.project, "worker") } });
    expect(res.httpStatus).toBe(0);
    expect(res.code).toBe("ConnectTimeout");
  });

  it("정적 웹 사이트는 인덱스·오류 문서와 공개 정책을 따른다", () => {
    const s = site();
    expect(websiteRequest(s.project, s.bucketId, "/").code).toBe("NoSuchWebsiteConfiguration");
    let p = must(s3.setBucketWebsite(s.project, s.bucketId, { enabled: true, indexDocument: "index.html", errorDocument: "error.html" })).project;
    expect(websiteRequest(p, s.bucketId, "/").status).toBe(403);
    p = must(s3.putBucketPolicy(p, s.bucketId, publicRead("site-2026-kim"))).project;
    const home = websiteRequest(p, s.bucketId, "/");
    expect(home).toMatchObject({ status: 200, key: "index.html", body: "<h1>hello</h1>" });
    expect(websiteRequest(p, s.bucketId, "/missing")).toMatchObject({ status: 404, key: "error.html" });
  });
});
