import { beforeEach, describe, expect, it } from "vitest";
import { analyzeResource, type AnalysisInput } from "@/lib/docs/resource-analysis";
import { analyzeService } from "@/lib/docs/service-analysis";
import { MINUTE } from "@/lib/engine/cloudwatch-engine";
import { computeAllTargetHealth } from "@/lib/engine/connectivity-engine";
import type { Project } from "@/lib/engine/resource-models";
import { evaluateS3Access } from "@/lib/engine/s3-engine";
import { buildTopology } from "@/lib/engine/topology-engine";
import { createValidationContext, runValidationRules } from "@/lib/engine/validation-engine";
import { ProjectBuilder } from "@/lib/project/builder";
import * as aws from "@/lib/project/console-actions";
import * as cw from "@/lib/project/cloudwatch-actions";
import { SG } from "@/lib/project/factory";
import * as iam from "@/lib/project/iam-actions";
import { deleteResources } from "@/lib/project/mutations";
import * as s3 from "@/lib/project/s3-actions";
import { createThreeTierSample } from "@/lib/project/samples";
import { idOf, natInstanceProject, publicWebProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

/** 콘솔·빌더가 쓰는 analyzeProject와 같은 입력을 만든다 */
function inputOf(project: Project): AnalysisInput {
  const topology = buildTopology(project);
  const ctx = createValidationContext(topology);
  const findings = runValidationRules(ctx);
  const findingsByResource = new Map<string, typeof findings>();
  for (const f of findings) for (const id of f.resourceIds) findingsByResource.set(id, [...(findingsByResource.get(id) ?? []), f]);
  return { project, topology, health: computeAllTargetHealth(topology), findingsByResource };
}

function must(r: aws.ActionResult): { project: Project; id: string } {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}

describe("네트워크 리소스 분석", () => {
  it("서브넷은 이름이 아니라 라우팅으로 판정한다", () => {
    const b = new ProjectBuilder("naming");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const subnet = b.subnet("public-looking-subnet", vpc, "10.0.1.0/24", "ap-northeast-2a");
    b.igw("igw", vpc);
    const a = analyzeResource(inputOf(b.build()), subnet)!;
    expect(a.headline.text).toContain("프라이빗");
    expect(a.checks.some((c) => c.detail.includes("이름이 아니라 라우팅"))).toBe(true);
    expect(a.checks.find((c) => c.title.includes("VPC 범위 안"))?.tone).toBe("ok");
  });

  it("VPC에 연결되지 않은 IGW와 그 IGW로 향하는 블랙홀 경로를 찾는다", () => {
    const b = new ProjectBuilder("blackhole");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const igw = b.igw("igw", null);
    const rt = b.routeTable("rt", vpc, { subnets: [s], routes: [{ destination: "0.0.0.0/0", igw }] });
    const input = inputOf(b.build());
    expect(analyzeResource(input, igw)!.checks[0]).toMatchObject({ tone: "error", field: "vpc" });
    expect(analyzeResource(input, rt)!.checks.some((c) => c.tone === "error" && c.title.includes("블랙홀"))).toBe(true);
  });

  it("없는 리소스는 null", () => {
    expect(analyzeResource(inputOf(publicWebProject()), "nope")).toBeNull();
  });
});

describe("EC2 분석은 실제 시뮬레이션 결과를 쓰고 설정 변경에 따라 바뀐다", () => {
  it("보안 그룹 규칙을 지우면 인터넷 접속 검사가 실패로 바뀐다", () => {
    let p = publicWebProject();
    p = { ...p, resources: p.resources.map((r) => (r.type === "ec2" ? { ...r, config: { ...r.config, state: "running" as const, listenPorts: [80] } } : r)) };
    const web = idOf(p, "web");
    const ok = analyzeResource(inputOf(p), web)!;
    const inbound = ok.checks.find((c) => c.title.startsWith("인터넷 → 이 인스턴스"))!;
    expect(inbound.tone).toBe("ok");
    expect(inbound.request?.port).toBe(80);
    // 대상 그룹에 등록되지 않았으면 등록되었다고 표시하지 않는다
    expect(ok.relations.find((r) => r.label === "대상 그룹 등록")?.items).toEqual([]);

    const sgId = idOf(p, "web-sg");
    const blocked = { ...p, resources: p.resources.map((r) => (r.id === sgId && r.type === "security-group" ? { ...r, config: { ...r.config, inboundRules: [] } } : r)) };
    const after = analyzeResource(inputOf(blocked), web)!.checks.find((c) => c.title.startsWith("인터넷 → 이 인스턴스"))!;
    expect(after.tone).toBe("error");
    expect(after.detail).toContain("보안 그룹");
  });
});

describe("ALB·대상 그룹 분석", () => {
  it("리스너·대상·헬스 상태를 보여 주고, 리스너를 지우면 오류가 된다", () => {
    const p = createThreeTierSample();
    const albId = idOf(p, "web-alb");
    const a = analyzeResource(inputOf(p), albId)!;
    expect(a.relations.find((r) => r.label === "리스너와 기본 작업")!.items[0].name).toBe("HTTP:80");
    expect(a.relations.find((r) => r.label.startsWith("대상"))!.items.length).toBe(2);
    expect(a.checks.some((c) => c.title.startsWith("인터넷 → 이 ALB") && c.tone === "ok")).toBe(true);

    const alb = p.resources.find((r) => r.id === albId);
    const listenerId = alb?.type === "alb" ? alb.config.listeners[0].id : "";
    const noListener = must(aws.deleteListener(p, albId, listenerId)).project;
    const b = analyzeResource(inputOf(noListener), albId)!;
    expect(b.checks.some((c) => c.tone === "error" && c.title === "리스너 없음")).toBe(true);
  });

  it("대상을 등록 해제하면 대상 그룹 분석이 '등록된 대상 없음'이 된다", () => {
    const p = createThreeTierSample();
    const tgId = idOf(p, "web-tg");
    const removed = deleteResources(p, [idOf(p, "app-1"), idOf(p, "app-2")]);
    if (!removed.ok) throw new Error(removed.error);
    const a = analyzeResource(inputOf(removed.project), tgId)!;
    expect(a.checks.some((c) => c.tone === "error" && c.title === "등록된 대상 없음")).toBe(true);
    expect(a.headline.tone).toBe("error");
  });
});

describe("서비스 분석 (S3·IAM·CloudWatch)", () => {
  it("S3 익명 접근 판정은 evaluateS3Access와 같고, 읽을 수 있는 IAM 역할을 보여 준다", () => {
    let p = createThreeTierSample();
    const bucket = must(s3.createBucket(p, { name: "site-2026", blockPublicAccess: { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false }, versioning: "Disabled", encryption: "SSE-S3" }));
    p = must(s3.putObject(bucket.project, bucket.id, { key: "index.html", size: 10, text: "<h1>hi</h1>" })).project;
    p = must(s3.putBucketPolicy(p, bucket.id, JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::site-2026/*" }] }))).project;
    p = must(iam.createRole(p, { name: "reader", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: ["aws:AmazonS3ReadOnlyAccess"] })).project;
    const a = analyzeService(inputOf(p), "s3", { itemId: bucket.id });
    const expected = evaluateS3Access(p, { bucketId: bucket.id, key: "index.html", action: "s3:GetObject", caller: { kind: "anonymous" } });
    const check = a.checks[0];
    expect(check.tone).toBe(expected.ok ? "warn" : "ok");
    expect(check.detail).toContain(String(expected.httpStatus));
    expect(a.relations[0].items.some((i) => i.name === "역할 reader")).toBe(true);
    expect(a.headline.text).toContain("퍼블릭");
  });

  it("IAM 정책 항목은 적용 대상과 Allow/Deny 문장을 보여 준다", () => {
    let p = createThreeTierSample();
    const pol = must(iam.createPolicy(p, { name: "DenyDelete", description: "", document: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:DeleteObject", Resource: "*" }] }) }));
    p = must(iam.createUser(pol.project, { name: "dev", groupIds: [], policyIds: [pol.id], consoleAccess: false })).project;
    const a = analyzeService(inputOf(p), "iam", { itemId: pol.id });
    expect(a.relations[0].items.map((i) => i.name)).toEqual(["사용자 dev"]);
    expect(a.facts[0]).toMatchObject({ field: "effect" });
    expect(a.facts[0].value).toContain("s3:DeleteObject");
  });

  it("CloudWatch 경보 분석은 가상 측정값과 임계값으로 상태와 이유를 설명한다", () => {
    const NOW = Date.parse("2026-01-01T12:00:00Z");
    let p = publicWebProject();
    p = { ...p, resources: p.resources.map((r) => (r.type === "ec2" ? { ...r, config: { ...r.config, state: "running" as const, listenPorts: [80] } } : r)) };
    const web = idOf(p, "web");
    p = must(cw.createLoadTest(p, { name: "spike", targetId: web, port: 80, requestsPerMinute: 3000, durationMinutes: 60, startOffsetMinutes: -30 }, NOW)).project;
    const alarm = must(
      cw.createAlarm(p, { name: "cpu", description: "", metric: { namespace: "AWS/EC2", metricName: "CPUUtilization", resourceId: web, stat: "Average" }, period: 60, comparison: "GreaterThanThreshold", threshold: 70, evaluationPeriods: 1, datapointsToAlarm: 1, treatMissingData: "missing", notify: true }),
    );
    p = { ...alarm.project, services: { ...alarm.project.services, cloudwatch: { ...alarm.project.services.cloudwatch, alarms: alarm.project.services.cloudwatch.alarms.map((a) => ({ ...a, createdAt: new Date(NOW - 20 * MINUTE).toISOString() })) } } };
    const a = analyzeService(inputOf(p), "cloudwatch", { itemId: alarm.id, now: NOW });
    expect(a.headline.tone).toBe("error");
    expect(a.checks[0].title).toBe("현재 상태: ALARM");
    expect(a.checks[0].detail).toContain("임계값");

    // 보안 그룹이 막혀 부하가 도달하지 않으면 경고
    const sgId = idOf(p, "web-sg");
    const blocked = { ...p, resources: p.resources.map((r) => (r.id === sgId && r.type === "security-group" ? { ...r, config: { ...r.config, inboundRules: [SG.tcp(22, "10.0.0.0/16")] } } : r)) };
    const overview = analyzeService(inputOf(blocked), "cloudwatch", { now: NOW });
    expect(overview.checks.some((c) => c.title.includes("도달하지 못함"))).toBe(true);
  });
});

describe("NAT 인스턴스 설명", () => {
  it("경로 대상 인스턴스의 현재 상태가 설정 변경에 따라 바뀐다", () => {
    const p = natInstanceProject({ sourceDestCheck: true });
    const nat = idOf(p, "nat-instance");
    const before = analyzeResource(inputOf(p), nat)!;
    expect(before.headline.text).toContain("NAT 인스턴스");
    expect(before.checks).toContainEqual(expect.objectContaining({ tone: "error", field: "sourceDestCheck" }));
    expect(before.facts).toContainEqual(expect.objectContaining({ label: "소스/대상 확인", value: "켜짐 (기본값)" }));
    const rt = analyzeResource(inputOf(p), idOf(p, "private-rt"))!;
    expect(rt.checks.some((c) => c.tone === "error" && c.title.includes("NAT 인스턴스 준비 안 됨"))).toBe(true);

    const after = analyzeResource(inputOf(must(aws.changeSourceDestCheck(p, nat, false)).project), nat)!;
    expect(after.checks).toContainEqual(expect.objectContaining({ tone: "ok", title: "NAT 인스턴스로 동작" }));
    expect(after.facts).toContainEqual(expect.objectContaining({ label: "소스/대상 확인", value: "중지됨" }));
  });
});
