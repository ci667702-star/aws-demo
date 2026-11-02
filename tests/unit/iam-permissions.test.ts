import { beforeEach, describe, expect, it } from "vitest";
import { authorizeChange, requiredActions } from "@/lib/engine/iam-permissions";
import { actingIdentity } from "@/lib/engine/iam-session";
import { capabilityRow, ROLE_TEMPLATES, templateCapabilityRow, templateOwnerOf } from "@/lib/engine/iam-templates";
import type { Project } from "@/lib/engine/resource-models";
import { ProjectBuilder } from "@/lib/project/builder";
import * as aws from "@/lib/project/console-actions";
import { createEmptyProject, SG } from "@/lib/project/factory";
import * as iam from "@/lib/project/iam-actions";
import { addResource, moveResources } from "@/lib/project/mutations";
import * as s3 from "@/lib/project/s3-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { idOf, useDeterministicIds } from "../helpers";
import { seedStore } from "../ui/ui-helpers";

beforeEach(useDeterministicIds);

function must(r: aws.ActionResult): Project {
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

/** 간단한 네트워크 + 모든 학교 역할 템플릿(예시 사용자 포함) */
function schoolProject(): Project {
  const b = new ProjectBuilder("school");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const subnet = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  b.securityGroup("web-sg", vpc, { inbound: [SG.tcp(80, "0.0.0.0/0")] });
  void subnet;
  return must(iam.applyRoleTemplates(b.build(), ROLE_TEMPLATES.map((t) => t.id), { createUsers: true }));
}

function signIn(project: Project, userName: string): Project {
  const user = project.services.iam.users.find((u) => u.name === userName)!;
  return must(iam.signInAsUser(project, user.id));
}

const bucketInput = (name: string) => ({
  name,
  blockPublicAccess: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
  versioning: "Disabled" as const,
  encryption: "SSE-S3" as const,
});

function launchInput(p: Project, sgIds: string[]): aws.LaunchInstancesInput {
  return {
    name: "web-1",
    ami: "amazon-linux-2023",
    instanceType: "t3.micro",
    subnetId: idOf(p, "public-a"),
    publicIpMode: "enabled",
    securityGroupIds: sgIds,
    listenPorts: [80],
    httpResponseCode: 200,
    userData: "",
    count: 1,
  };
}

describe("필요한 IAM 작업 추론", () => {
  it("VPC를 만들면 기본 SG·NACL·라우팅 테이블이 함께 생겨도 ec2:CreateVpc만 필요하다", () => {
    const before = createEmptyProject("빈");
    const after = must(aws.createVpc(before, { name: "my-vpc", cidr: "10.0.0.0/16" }));
    expect(requiredActions(before, after).map((r) => r.action)).toEqual(["ec2:CreateVpc"]);
  });

  it("위치 이동처럼 AWS API가 없는 변경은 권한이 필요 없다", () => {
    const before = schoolProject();
    const vpc = idOf(before, "vpc");
    const r = moveResources(before, { [vpc]: { x: 500, y: 500 } });
    if (!r.ok) throw new Error(r.error);
    expect(requiredActions(before, r.project)).toEqual([]);
  });

  it("그림 빌더에서 EC2를 추가하면 ec2:RunInstances, S3 버킷은 버킷 ARN으로 평가한다", () => {
    const before = schoolProject();
    const added = addResource(before, "ec2", { x: 0, y: 0 });
    if (!added.ok) throw new Error(added.error);
    expect(requiredActions(before, added.project).map((r) => r.action)).toContain("ec2:RunInstances");
    const bucket = must(s3.createBucket(before, bucketInput("school-data")));
    expect(requiredActions(before, bucket)).toEqual([expect.objectContaining({ action: "s3:CreateBucket", resource: "arn:aws:s3:::school-data" })]);
  });
});

describe("역할별 권한 (학교 템플릿)", () => {
  it("루트 사용자는 모두 허용된다", () => {
    const p = schoolProject();
    expect(actingIdentity(p).kind).toBe("root");
    expect(authorizeChange(p, must(aws.createVpc(p, { name: "x", cidr: "10.1.0.0/16" }))).ok).toBe(true);
  });

  it("네트워크 관리자는 VPC를 만들 수 있지만 EC2를 시작할 수 없다 (UnauthorizedOperation)", () => {
    const p = signIn(schoolProject(), "net-admin");
    expect(authorizeChange(p, must(aws.createVpc(p, { name: "x", cidr: "10.1.0.0/16" }))).ok).toBe(true);
    const denied = authorizeChange(p, must(aws.launchInstances(p, launchInput(p, [idOf(p, "web-sg")]))), "RunInstances", (a) => templateOwnerOf(p, a));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error).toContain("[UnauthorizedOperation]");
    expect(denied.error).toContain("ec2:RunInstances");
    expect(denied.hint).toContain("user/net-admin is not authorized to perform: ec2:RunInstances");
    expect(denied.hint).toContain("서버 운영자");
  });

  it("서버 운영자는 기존 보안 그룹으로만 인스턴스를 시작하고, 새 보안 그룹은 만들 수 없다", () => {
    const p = signIn(schoolProject(), "server-op");
    expect(authorizeChange(p, must(aws.launchInstances(p, launchInput(p, [idOf(p, "web-sg")])))).ok).toBe(true);
    const sg = must(aws.createSecurityGroup(p, { name: "my-sg", description: "x", vpcId: idOf(p, "vpc"), inboundRules: [], outboundRules: [] }));
    const denied = authorizeChange(p, sg);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denied.action).toBe("ec2:CreateSecurityGroup");
  });

  it("서버 운영자는 School-Ec2-로 시작하는 역할만 인스턴스에 넘길 수 있다 (iam:PassRole)", () => {
    let p = schoolProject();
    p = must(iam.createRole(p, { name: "PowerfulRole", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: ["aws:AdministratorAccess"] }));
    const launched = must(aws.launchInstances(p, launchInput(p, [idOf(p, "web-sg")])));
    const instanceId = launched.resources.find((r) => r.type === "ec2")!.id;
    const asOp = signIn(launched, "server-op");
    const school = asOp.services.iam.roles.find((r) => r.name === iam.SCHOOL_EC2_ROLE_NAME)!;
    const powerful = asOp.services.iam.roles.find((r) => r.name === "PowerfulRole")!;
    expect(authorizeChange(asOp, must(iam.setInstanceRole(asOp, instanceId, school.id))).ok).toBe(true);
    const denied = authorizeChange(asOp, must(iam.setInstanceRole(asOp, instanceId, powerful.id)));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denied).toMatchObject({ action: "iam:PassRole", resource: "arn:aws:iam::123456789012:role/PowerfulRole" });
  });

  it("스토리지 담당은 school-로 시작하는 버킷만 만들 수 있다 (리소스 수준 권한)", () => {
    const p = signIn(schoolProject(), "storage-mgr");
    expect(authorizeChange(p, must(s3.createBucket(p, bucketInput("school-data")))).ok).toBe(true);
    const denied = authorizeChange(p, must(s3.createBucket(p, bucketInput("other-data"))));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("[AccessDenied]");
  });

  it("학생은 IAM 변경이 명시적 Deny로 막히고, EC2 시작은 허용된다", () => {
    const p = signIn(schoolProject(), "student01");
    const denied = authorizeChange(p, must(iam.createUser(p, { name: "hacker", groupIds: [], policyIds: [], consoleAccess: false })));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.decision.decision).toBe("explicit-deny");
      expect(denied.error).toContain("명시적 Deny");
      expect(denied.hint).toContain("with an explicit deny");
    }
    expect(authorizeChange(p, must(aws.launchInstances(p, launchInput(p, [idOf(p, "web-sg")])))).ok).toBe(true);
  });

  it("감사·읽기 전용은 아무것도 바꿀 수 없다", () => {
    const p = signIn(schoolProject(), "auditor");
    expect(authorizeChange(p, must(aws.createVpc(p, { name: "x", cidr: "10.1.0.0/16" }))).ok).toBe(false);
  });

  it("권한 표는 템플릿의 실제 정책 평가 결과와 같다", () => {
    const p = schoolProject();
    const row = (id: string) => templateCapabilityRow(p, ROLE_TEMPLATES.find((t) => t.id === id)!);
    expect(row("network-admin")).toMatchObject({ network: "allowed", firewall: "allowed", ec2: "implicit-deny", iam: "implicit-deny" });
    expect(row("storage-manager")).toMatchObject({ "s3-school": "allowed", "s3-other": "implicit-deny" });
    expect(row("student")).toMatchObject({ ec2: "allowed", iam: "explicit-deny", network: "explicit-deny", "s3-student": "allowed" });
    expect(row("instructor")).toMatchObject({ network: "allowed", iam: "allowed", rds: "allowed" });
    const student = p.services.iam.users.find((u) => u.name === "student01")!;
    expect(capabilityRow(p, { kind: "user", user: student })).toEqual(row("student"));
  });
});

describe("자격 증명 전환", () => {
  it("콘솔 액세스가 없는 사용자는 로그인할 수 없다", () => {
    const p = must(iam.createUser(createEmptyProject("x"), { name: "cli-only", groupIds: [], policyIds: [], consoleAccess: false }));
    const r = iam.signInAsUser(p, p.services.iam.users[0].id);
    expect(r.ok).toBe(false);
  });

  it("루트는 역할로 전환할 수 없고, 권한 있는 IAM 사용자는 계정을 신뢰하는 역할로 전환할 수 있다", () => {
    let p = schoolProject();
    p = must(iam.createRole(p, { name: "OpsRole", description: "", trustedEntity: "account", policyIds: ["aws:ReadOnlyAccess"] }));
    const role = p.services.iam.roles.find((r) => r.name === "OpsRole")!;
    expect(iam.switchToRole(p, role.id).ok).toBe(false);
    const asTeacher = signIn(p, "teacher");
    const switched = must(iam.switchToRole(asTeacher, role.id));
    expect(actingIdentity(switched)).toMatchObject({ kind: "role", role: { name: "OpsRole" }, sourceUser: { name: "teacher" } });
    expect(actingIdentity(iam.switchBack(switched))).toMatchObject({ kind: "user", user: { name: "teacher" } });
    // 학생은 sts:AssumeRole 권한이 없다
    expect(iam.switchToRole(signIn(p, "student01"), role.id).ok).toBe(false);
    // EC2용 역할은 사람이 전환할 수 없다
    const ec2Role = p.services.iam.roles.find((r) => r.name === iam.SCHOOL_EC2_ROLE_NAME)!;
    expect(iam.switchToRole(asTeacher, ec2Role.id).ok).toBe(false);
  });
});

describe("프로젝트 스토어에서 권한 확인", () => {
  it("권한이 없으면 변경을 적용하지 않고, 실행 취소로도 권한을 우회할 수 없다", () => {
    const p = schoolProject();
    seedStore([p]);
    const store = useProjectStore.getState();
    // 루트로 VPC 하나 만들기 (기록에 남음)
    expect(store.apply(p.id, "CreateVpc", (x) => aws.createVpc(x, { name: "extra", cidr: "10.9.0.0/16" })).ok).toBe(true);
    // 감사자로 로그인 (기록에 남기지 않는 전환)
    useProjectStore.getState().updateWithoutHistory(p.id, (x) => signIn(x, "auditor"));
    const before = useProjectStore.getState().projects[p.id];
    const denied = useProjectStore.getState().apply(p.id, "CreateVpc", (x) => aws.createVpc(x, { name: "nope", cidr: "10.8.0.0/16" }));
    expect(denied.ok).toBe(false);
    expect(useProjectStore.getState().projects[p.id]).toBe(before);
    // 루트가 만든 VPC를 실행 취소하면 ec2:DeleteVpc가 필요하다 → 거부
    const undo = useProjectStore.getState().undo(p.id);
    expect(undo).toMatchObject({ ok: false, reason: "denied" });
    expect(useProjectStore.getState().projects[p.id].resources.some((r) => r.name === "extra")).toBe(true);
    // 로그인 상태는 실행 취소로 바뀌지 않는다
    expect(actingIdentity(useProjectStore.getState().projects[p.id])).toMatchObject({ kind: "user", user: { name: "auditor" } });
  });
});
