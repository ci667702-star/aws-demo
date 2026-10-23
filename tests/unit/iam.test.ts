import { beforeEach, describe, expect, it } from "vitest";
import { actionMatches, checkPolicyDocument, evaluateIam, resourceMatches, trustPolicyDocument, objectArn } from "@/lib/engine/iam-engine";
import type { Project } from "@/lib/engine/resource-models";
import * as iam from "@/lib/project/iam-actions";
import * as aws from "@/lib/project/console-actions";
import { createEmptyProject } from "@/lib/project/factory";
import { useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function must(r: aws.ActionResult): { project: Project; id: string } {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}
const err = (r: aws.ActionResult) => {
  if (r.ok) throw new Error("성공하면 안 됩니다");
  return r.error;
};
const user = (p: Project, id: string) => p.services.iam.users.find((u) => u.id === id)!;

describe("정책 문서 검사", () => {
  it("문법 오류와 필수 요소를 알려 준다", () => {
    expect(checkPolicyDocument("{ not json", "identity").errors[0]).toContain("JSON 문법 오류");
    expect(checkPolicyDocument('{"Version":"2012-10-17"}', "identity").errors[0]).toContain("Statement");
    const noEffect = checkPolicyDocument('{"Version":"2012-10-17","Statement":[{"Action":"s3:*","Resource":"*"}]}', "identity");
    expect(noEffect.errors.join()).toContain("Effect");
    const badAction = checkPolicyDocument('{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"GetObject","Resource":"*"}]}', "identity");
    expect(badAction.errors.join()).toContain("서비스:작업");
  });

  it("자격 증명 정책에는 Principal을, 리소스 정책에는 Principal 누락을 오류로 본다", () => {
    const withPrincipal = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"*"}]}';
    expect(checkPolicyDocument(withPrincipal, "identity").ok).toBe(false);
    expect(checkPolicyDocument(withPrincipal, "resource").ok).toBe(true);
    const noPrincipal = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}';
    expect(checkPolicyDocument(noPrincipal, "resource").errors.join()).toContain("Principal");
  });

  it("와일드카드 일치: 작업은 대소문자 무시, ARN은 구분", () => {
    expect(actionMatches("s3:Get*", "s3:getobject")).toBe(true);
    expect(actionMatches("s3:Get*", "s3:PutObject")).toBe(false);
    expect(actionMatches("*:List*", "iam:ListUsers")).toBe(true);
    expect(resourceMatches("arn:aws:s3:::bucket/*", "arn:aws:s3:::bucket/a/b.txt")).toBe(true);
    expect(resourceMatches("arn:aws:s3:::bucket/*", "arn:aws:s3:::bucket")).toBe(false);
    expect(resourceMatches("arn:aws:s3:::Bucket/*", "arn:aws:s3:::bucket/x")).toBe(false);
  });
});

describe("IAM 평가", () => {
  function setup() {
    let p = createEmptyProject("iam");
    const policy = must(
      iam.createPolicy(p, {
        name: "DenyDelete",
        description: "",
        document: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:DeleteObject", Resource: "*" }] }),
      }),
    );
    p = policy.project;
    const group = must(iam.createGroup(p, { name: "readers", policyIds: ["aws:AmazonS3ReadOnlyAccess"], userIds: [] }));
    p = group.project;
    const u = must(iam.createUser(p, { name: "alice", groupIds: [group.id], policyIds: ["aws:AmazonS3FullAccess", policy.id], consoleAccess: false }));
    return { project: u.project, userId: u.id, groupId: group.id, policyId: policy.id };
  }

  it("그룹 정책으로 허용되고, 명시적 Deny가 Allow보다 우선한다", () => {
    const s = setup();
    const alice = { kind: "user" as const, user: user(s.project, s.userId) };
    expect(evaluateIam(s.project, alice, "s3:GetObject", objectArn("b", "k")).decision).toBe("allowed");
    const del = evaluateIam(s.project, alice, "s3:DeleteObject", objectArn("b", "k"));
    expect(del.decision).toBe("explicit-deny");
    expect(del.matched.some((m) => m.statement.effect === "Allow")).toBe(true);
    expect(evaluateIam(s.project, alice, "ec2:RunInstances", "*").decision).toBe("implicit-deny");
  });

  it("익명 사용자는 리소스 정책의 Principal \"*\"로만 허용되고, 퍼블릭 버킷 제한이 켜져 있으면 거부된다", () => {
    const s = setup();
    const statements = checkPolicyDocument(
      JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::site/*" }] }),
      "resource",
    ).statements;
    const anon = { kind: "anonymous" as const };
    expect(evaluateIam(s.project, anon, "s3:GetObject", objectArn("site", "index.html"), { resourcePolicy: { label: "버킷 정책", statements } }).decision).toBe("allowed");
    expect(evaluateIam(s.project, anon, "s3:GetObject", objectArn("site", "index.html"), { resourcePolicy: { label: "버킷 정책", statements }, restrictPublic: true }).decision).toBe(
      "implicit-deny",
    );
  });

  it("역할 신뢰 정책 문서를 만든다", () => {
    expect(JSON.parse(trustPolicyDocument({ trustedEntity: "ec2.amazonaws.com" })).Statement[0].Principal).toEqual({ Service: "ec2.amazonaws.com" });
  });
});

describe("IAM 동작", () => {
  it("사용자 이름 규칙과 중복(대소문자 무시)을 검사한다", () => {
    const p = createEmptyProject("iam");
    expect(err(iam.createUser(p, { name: "bad name", groupIds: [], policyIds: [], consoleAccess: false }))).toContain("[ValidationError]");
    const a = must(iam.createUser(p, { name: "Alice", groupIds: [], policyIds: [], consoleAccess: false }));
    expect(err(iam.createUser(a.project, { name: "alice", groupIds: [], policyIds: [], consoleAccess: false }))).toContain("[EntityAlreadyExists]");
    expect(err(iam.createUser(p, { name: "bob", groupIds: [], policyIds: ["aws:NoSuchPolicy"], consoleAccess: false }))).toContain("[NoSuchEntity]");
  });

  it("가상 액세스 키는 사용자당 2개까지이고, 비밀 키는 저장하지 않으며, 활성 키는 바로 삭제할 수 없다", () => {
    const a = must(iam.createUser(createEmptyProject("iam"), { name: "ci-bot", groupIds: [], policyIds: [], consoleAccess: false }));
    const k1 = iam.createAccessKey(a.project, a.id, { useCase: "cli", description: "로컬 CLI" });
    if (!k1.ok) throw new Error(k1.error);
    expect(k1.accessKeyId).toMatch(/^PGSIM[A-Z2-7]{15}$/);
    expect(k1.secretAccessKey).toMatch(/^SIMULATED.{31}$/);
    const stored = user(k1.project, a.id).accessKeys[0];
    expect(stored).toMatchObject({ id: k1.accessKeyId, secretHint: k1.secretAccessKey.slice(-4), status: "Active" });
    expect(JSON.stringify(k1.project)).not.toContain(k1.secretAccessKey);
    const k2 = iam.createAccessKey(k1.project, a.id, { useCase: "cli", description: "" });
    if (!k2.ok) throw new Error(k2.error);
    const k3 = iam.createAccessKey(k2.project, a.id, { useCase: "cli", description: "" });
    expect(k3.ok).toBe(false);
    expect(err(iam.deleteAccessKey(k2.project, a.id, k1.accessKeyId))).toContain("활성");
    const inactive = must(iam.setAccessKeyStatus(k2.project, a.id, k1.accessKeyId, "Inactive")).project;
    expect(user(must(iam.deleteAccessKey(inactive, a.id, k1.accessKeyId)).project, a.id).accessKeys).toHaveLength(1);
  });

  it("연결된 정책은 삭제할 수 없고, EC2에는 EC2를 신뢰하는 역할만 연결된다", () => {
    let p = createEmptyProject("iam");
    const pol = must(iam.createPolicy(p, { name: "S3Read", description: "", document: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:Get*", Resource: "*" }] }) }));
    const lambdaRole = must(iam.createRole(pol.project, { name: "lambda-role", description: "", trustedEntity: "lambda.amazonaws.com", policyIds: [pol.id] }));
    const ec2Role = must(iam.createRole(lambdaRole.project, { name: "web-role", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: [pol.id] }));
    p = ec2Role.project;
    expect(err(iam.deletePolicy(p, pol.id))).toContain("[DeleteConflict]");
    const vpc = must(aws.createVpc(p, { name: "v", cidr: "10.0.0.0/16" }));
    const sub = must(aws.createSubnet(vpc.project, { vpcId: vpc.id, name: "s", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" }));
    const sg = vpc.project.resources.find((r) => r.type === "security-group")!.id;
    const ec2 = must(
      aws.launchInstances(sub.project, { name: "w", ami: "amazon-linux-2023", instanceType: "t3.micro", subnetId: sub.id, publicIpMode: "disabled", securityGroupIds: [sg], listenPorts: [22], httpResponseCode: 200, userData: "", count: 1 }),
    );
    expect(err(iam.setInstanceRole(ec2.project, ec2.id, lambdaRole.id))).toContain("신뢰 정책");
    const attached = must(iam.setInstanceRole(ec2.project, ec2.id, ec2Role.id)).project;
    expect(err(iam.deleteRole(attached, ec2Role.id))).toContain("[DeleteConflict]");
  });
});
