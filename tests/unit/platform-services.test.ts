import { beforeEach, describe, expect, it } from "vitest";
import { evaluateOacAccess, matchBehavior, pathPatternMatches, simulateCloudFrontRequest, withOacStatement } from "@/lib/engine/cloudfront-engine";
import { evaluateIam } from "@/lib/engine/iam-engine";
import { projectSchema, type Project } from "@/lib/engine/resource-models";
import { currentVersion, liveSecrets, previousVersion, secretArn, secretString, validateSecretKeys, validateSecretName } from "@/lib/engine/secrets-engine";
import { checkSecretRotation, evaluateParameterAccess, evaluateSecretAccess } from "@/lib/engine/service-access";
import { childPaths, managedNodeStatus, parametersByPath, parameterValue, runPortCheck, runSessionCommand, startSessionPermission, validateParameterName } from "@/lib/engine/ssm-engine";
import { buildTopology } from "@/lib/engine/topology-engine";
import * as cf from "@/lib/project/cloudfront-actions";
import * as iam from "@/lib/project/iam-actions";
import { advanceLifecycle } from "@/lib/project/lifecycle";
import * as sm from "@/lib/project/secrets-actions";
import * as ssm from "@/lib/project/ssm-actions";
import { cdnProject, lambdaProject, must, ssmNodeProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

const fnOf = (p: Project) => p.resources.find((r) => r.type === "lambda")!;
const roleOfFn = (p: Project) => {
  const fn = fnOf(p);
  return p.services.iam.roles.find((r) => fn.type === "lambda" && r.id === fn.config.roleId)!;
};

/** 실행 역할에 정책 문서 하나를 붙인다 */
function grant(p: Project, roleId: string, actions: string[], resource: string): Project {
  const created = must(iam.createPolicy(p, { name: `grant-${actions[0].replace(/[^A-Za-z]/g, "")}`, description: "", document: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: resource }] }) }));
  const role = created.project.services.iam.roles.find((r) => r.id === roleId)!;
  return must(iam.setRolePolicies(created.project, roleId, [...role.policyIds, created.createdId!])).project;
}

// ================================================================ Secrets Manager

describe("Secrets Manager (가상)", () => {
  it("비밀 값은 저장하지 않고, 버전으로 계산한 가상 값만 보여 준다", () => {
    const p = must(sm.createSecret(lambdaProject(), { name: "prod/app/api", description: "", kind: "other", keys: ["api_key", "client_id"] }, Date.parse("2026-11-01T00:00:00Z")));
    const secret = p.project.services.secretsmanager.secrets[0];
    // 저장된 데이터에는 키 이름과 버전만 있고 값이 없다
    expect(JSON.stringify(p.project.services.secretsmanager)).not.toContain("PGSIM-");
    expect(secret).toMatchObject({ keys: ["api_key", "client_id"], kind: "other" });
    const value = secretString(p.project, secret, currentVersion(secret).versionId);
    expect(Object.keys(value)).toEqual(["api_key", "client_id"]);
    expect(String(value.api_key)).toMatch(/^PGSIM-/);
    // 같은 버전이면 항상 같은 값
    expect(secretString(p.project, secret, currentVersion(secret).versionId)).toEqual(value);
    expect(secretArn(secret)).toMatch(/^arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:prod\/app\/api-[A-Za-z0-9]{6}$/);
  });

  it("새 값을 저장하면 AWSCURRENT가 새 버전으로, 직전 버전은 AWSPREVIOUS로 옮겨 가고 값이 바뀐다", () => {
    let p = must(sm.createSecret(lambdaProject(), { name: "prod/app/api", description: "", kind: "other", keys: ["api_key"] })).project;
    const before = p.services.secretsmanager.secrets[0];
    p = must(sm.putSecretValue(p, before.id)).project;
    const after = p.services.secretsmanager.secrets[0];
    expect(after.versions).toHaveLength(2);
    expect(currentVersion(after).versionId).not.toBe(currentVersion(before).versionId);
    expect(previousVersion(after)?.versionId).toBe(currentVersion(before).versionId);
    expect(secretString(p, after, currentVersion(after).versionId).api_key).not.toBe(secretString(p, before, currentVersion(before).versionId).api_key);
  });

  it("이름 규칙·중복·키 이름·자격 증명처럼 보이는 키를 AWS 오류로 거부한다", () => {
    expect(validateSecretName("bad name!")).toMatch(/영문자, 숫자/);
    expect(validateSecretKeys(["AKIAIOSFODNN7EXAMPLE"])).toMatch(/자격 증명/);
    expect(validateSecretKeys(["a", "a"])).toMatch(/중복/);
    const p = must(sm.createSecret(lambdaProject(), { name: "dup", description: "", kind: "other", keys: ["k"] })).project;
    const dup = sm.createSecret(p, { name: "dup", description: "", kind: "other", keys: ["k"] });
    expect(!dup.ok && dup.error).toMatch(/^\[ResourceExistsException\]/);
    const rds = sm.createSecret(p, { name: "db", description: "", kind: "rds", rdsId: null, username: "admin" });
    expect(!rds.ok && rds.error).toMatch(/^\[ValidationException\]/);
  });

  it("삭제는 복구 기간(7~30일) 뒤에 이루어지고, 그동안 값을 읽을 수 없으며 삭제를 취소할 수 있다", () => {
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    let p = must(iam.createRole(lambdaProject(), { name: "admin", description: "", trustedEntity: "account", policyIds: ["aws:AdministratorAccess"] })).project;
    const admin = p.services.iam.roles.find((r) => r.name === "admin")!;
    p = must(sm.createSecret(p, { name: "prod/app/api", description: "", kind: "other", keys: ["k"] }, t0)).project;
    const id = p.services.secretsmanager.secrets[0].id;
    expect(sm.deleteSecret(p, id, { recoveryDays: 3 }, t0).ok).toBe(false);
    p = must(sm.deleteSecret(p, id, { recoveryDays: 7 }, t0)).project;
    // 권한이 있어도 삭제가 예약된 보안 암호는 읽을 수 없다
    expect(evaluateSecretAccess(p, buildTopology(p), id, { kind: "role", roleId: admin.id }, t0)).toMatchObject({ ok: false, code: "InvalidRequestException" });
    expect(sm.putSecretValue(p, id, undefined, t0).ok).toBe(false);
    // 복구 기간 안에는 복원할 수 있다
    expect(must(sm.restoreSecret(p, id, t0 + 6 * 86_400_000)).project.services.secretsmanager.secrets[0].deletion).toBeNull();
    // 복구 기간이 지나면 완전히 삭제되고 같은 이름으로 다시 만들 수 있다
    const later = t0 + 8 * 86_400_000;
    expect(liveSecrets(p, later)).toHaveLength(0);
    expect(sm.createSecret(p, { name: "prod/app/api", description: "", kind: "other", keys: ["k"] }, later).ok).toBe(true);
  });

  it("GetSecretValue 접근 테스트: 권한이 없으면 AccessDenied, 이 보안 암호의 ARN을 허용하면 성공, NAT 경로가 없으면 시간 초과", () => {
    let p = must(sm.createSecret(lambdaProject({ template: "secret-get" }), { name: "prod/app/api", description: "", kind: "other", keys: ["k"] })).project;
    const secret = p.services.secretsmanager.secrets[0];
    const caller = { kind: "lambda" as const, functionId: fnOf(p).id };
    const denied = evaluateSecretAccess(p, buildTopology(p), secret.id, caller);
    expect(denied).toMatchObject({ ok: false, code: "AccessDeniedException" });
    p = grant(p, roleOfFn(p).id, ["secretsmanager:GetSecretValue"], secretArn(secret));
    expect(evaluateSecretAccess(p, buildTopology(p), secret.id, caller)).toMatchObject({ ok: true, code: "OK" });
    // 격리된 서브넷(외부 경로 없음)의 함수는 엔드포인트에 닿지 않는다
    let isolated = must(sm.createSecret(lambdaProject({ template: "secret-get", placement: "isolated" }), { name: "x", description: "", kind: "other", keys: ["k"] })).project;
    const sec2 = isolated.services.secretsmanager.secrets[0];
    isolated = grant(isolated, roleOfFn(isolated).id, ["secretsmanager:GetSecretValue"], "*");
    expect(evaluateSecretAccess(isolated, buildTopology(isolated), sec2.id, { kind: "lambda", functionId: fnOf(isolated).id })).toMatchObject({ ok: false, code: "Task timed out" });
  });

  it("교체: 호출 권한·실행 역할 권한이 갖춰져야 즉시 교체가 성공하고 새 버전이 AWSCURRENT가 된다", () => {
    let p = must(sm.createSecret(lambdaProject({ template: "hello" }), { name: "prod/db", description: "", kind: "other", keys: ["password"] })).project;
    const id = p.services.secretsmanager.secrets[0].id;
    const fnId = fnOf(p).id;
    p = must(sm.configureRotation(p, id, { enabled: true, days: 30, lambdaId: fnId, addPermission: false })).project;
    let check = checkSecretRotation(p, buildTopology(p), p.services.secretsmanager.secrets[0]);
    expect(check.checks.find((c) => c.title === "함수 호출 권한")?.status).toBe("fail");
    const failed = sm.rotateSecretNow(p, id);
    expect(!failed.ok && failed.error).toMatch(/^\[RotationFailed\]/);
    p = must(sm.configureRotation(p, id, { enabled: true, days: 30, lambdaId: fnId, addPermission: true })).project;
    expect(fnOf(p).type === "lambda" && fnOf(p).config).toMatchObject({ permissions: [expect.objectContaining({ principal: "secretsmanager.amazonaws.com" })] });
    p = grant(p, roleOfFn(p).id, ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], secretArn(p.services.secretsmanager.secrets[0]));
    check = checkSecretRotation(p, buildTopology(p), p.services.secretsmanager.secrets[0]);
    expect(check.ok).toBe(true);
    const rotated = must(sm.rotateSecretNow(p, id)).project.services.secretsmanager.secrets[0];
    expect(rotated.versions.map((v) => v.stages)).toEqual([["AWSCURRENT"], ["AWSPREVIOUS"]]);
    expect(rotated.lastRotatedAt).not.toBeNull();
  });

  it("AWS 관리형 ReadOnlyAccess는 보안 암호 목록은 보지만 값(GetSecretValue)은 읽지 못한다", () => {
    let p = must(iam.createRole(lambdaProject(), { name: "auditor", description: "", trustedEntity: "account", policyIds: ["aws:ReadOnlyAccess"] })).project;
    const role = p.services.iam.roles.find((r) => r.name === "auditor")!;
    p = must(sm.createSecret(p, { name: "prod/app/api", description: "", kind: "other", keys: ["k"] })).project;
    const arn = secretArn(p.services.secretsmanager.secrets[0]);
    expect(evaluateIam(p, { kind: "role", role }, "secretsmanager:DescribeSecret", arn).decision).toBe("allowed");
    expect(evaluateIam(p, { kind: "role", role }, "secretsmanager:GetSecretValue", arn).decision).toBe("implicit-deny");
    expect(evaluateIam(p, { kind: "role", role }, "s3:GetObject", "arn:aws:s3:::b/k").decision).toBe("allowed");
  });
});

// ================================================================ Systems Manager

const ec2Of = (p: Project, id: string) => buildTopology(p).getOfType(id, "ec2")!;

describe("Systems Manager Parameter Store (가상)", () => {
  it("String은 값을 보관하고, SecureString은 값을 입력받지 않으며, 덮어쓰면 버전과 기록이 남는다", () => {
    let p = must(ssm.putParameter(lambdaProject(), { name: "/my-app/prod/db-host", description: "", type: "String", tier: "Standard", value: "db.internal.example", overwrite: false })).project;
    p = must(ssm.putParameter(p, { name: "/my-app/prod/api-token", description: "", type: "SecureString", tier: "Standard", value: "should-not-be-stored", overwrite: false })).project;
    const [host, token] = p.services.ssm.parameters;
    expect(host.value).toBe("db.internal.example");
    expect(token.value).toBeNull();
    expect(JSON.stringify(p)).not.toContain("should-not-be-stored");
    expect(parameterValue(token, false)).not.toMatch(/^PGSIM-/);
    expect(parameterValue(token, true)).toMatch(/^PGSIM-/);
    const dup = ssm.putParameter(p, { name: "/my-app/prod/db-host", description: "", type: "String", tier: "Standard", value: "x", overwrite: false });
    expect(!dup.ok && dup.error).toMatch(/^\[ParameterAlreadyExists\]/);
    p = must(ssm.putParameter(p, { name: "/my-app/prod/db-host", description: "", type: "String", tier: "Standard", value: "db2.internal.example", overwrite: true })).project;
    const updated = p.services.ssm.parameters[0];
    expect(updated).toMatchObject({ version: 2, value: "db2.internal.example" });
    expect(updated.history[0]).toMatchObject({ version: 1, value: "db.internal.example" });
  });

  it("비밀처럼 보이는 String·예약 접두사·잘못된 계층 이름·고급→표준 변경을 거부한다", () => {
    const base = lambdaProject();
    const secretish = ssm.putParameter(base, { name: "/my-app/db-password", description: "", type: "String", tier: "Standard", value: "hunter2", overwrite: false });
    expect(!secretish.ok && secretish.error).toMatch(/^\[SimulatorSafetyRule\]/);
    expect(validateParameterName("/aws/reserved")).toMatch(/aws 또는 ssm/);
    expect(validateParameterName("my-app/prod/x")).toMatch(/\/로 시작/);
    let p = must(ssm.putParameter(base, { name: "/big", description: "", type: "String", tier: "Advanced", value: "v", overwrite: false })).project;
    const down = ssm.putParameter(p, { name: "/big", description: "", type: "String", tier: "Standard", value: "v", overwrite: true });
    expect(!down.ok && down.error).toMatch(/advanced-parameter tier/);
    p = must(ssm.putParameter(p, { name: "/big", description: "", type: "String", tier: "Advanced", value: "v2", overwrite: true })).project;
    expect(p.services.ssm.parameters[0].version).toBe(2);
  });

  it("GetParametersByPath: 경로 바로 아래만, --recursive면 하위 경로까지", () => {
    let p = lambdaProject();
    for (const name of ["/app/prod/db-host", "/app/prod/cache/host", "/app/dev/db-host", "/other"]) p = must(ssm.putParameter(p, { name, description: "", type: "String", tier: "Standard", value: "v", overwrite: false })).project;
    const params = p.services.ssm.parameters;
    expect(parametersByPath(params, "/app/prod", false).map((x) => x.name)).toEqual(["/app/prod/db-host"]);
    expect(parametersByPath(params, "/app/prod", true).map((x) => x.name)).toEqual(["/app/prod/cache/host", "/app/prod/db-host"]);
    expect(childPaths(params, "/app")).toEqual(["/app/dev", "/app/prod"]);
  });

  it("GetParameter 접근 테스트: 실행 역할이 그 경로를 허용해야 읽고, SecureString은 WithDecryption이 없으면 경고한다", () => {
    let p = must(ssm.putParameter(lambdaProject({ template: "ssm-get" }), { name: "/my-app/prod/key", description: "", type: "SecureString", tier: "Standard", value: "", overwrite: false })).project;
    const param = p.services.ssm.parameters[0];
    const caller = { kind: "lambda" as const, functionId: fnOf(p).id };
    expect(evaluateParameterAccess(p, buildTopology(p), param.id, caller, true)).toMatchObject({ ok: false, code: "AccessDeniedException" });
    p = grant(p, roleOfFn(p).id, ["ssm:GetParameter"], "arn:aws:ssm:ap-northeast-2:123456789012:parameter/my-app/prod/*");
    expect(evaluateParameterAccess(p, buildTopology(p), param.id, caller, true).ok).toBe(true);
    expect(evaluateParameterAccess(p, buildTopology(p), param.id, caller, false).steps.some((s) => s.status === "warn" && /WithDecryption/.test(s.detail))).toBe(true);
  });
});

describe("Systems Manager 관리형 노드·Session Manager (가상)", () => {
  it("인스턴스 프로파일(AmazonSSMManagedInstanceCore)과 NAT 경로가 있으면 관리형 노드가 된다", () => {
    const { p, app } = ssmNodeProject();
    const status = managedNodeStatus(p, buildTopology(p), ec2Of(p, app));
    expect(status.managed).toBe(true);
    expect(status.checks.find((c) => c.id === "inbound")?.status).toBe("info");
  });

  it("역할이 없거나, 권한이 없거나, 엔드포인트로 나가는 경로가 없으면 이유와 함께 연결되지 않는다", () => {
    const none = ssmNodeProject({ role: "none" });
    expect(managedNodeStatus(none.p, buildTopology(none.p), ec2Of(none.p, none.app)).checks.find((c) => c.id === "profile")).toMatchObject({ status: "fail" });
    const empty = ssmNodeProject({ role: "empty" });
    expect(managedNodeStatus(empty.p, buildTopology(empty.p), ec2Of(empty.p, empty.app)).checks.find((c) => c.id === "profile")?.detail).toMatch(/ssm:UpdateInstanceInformation/);
    const isolated = ssmNodeProject({ route: "none" });
    const status = managedNodeStatus(isolated.p, buildTopology(isolated.p), ec2Of(isolated.p, isolated.app));
    expect(status.managed).toBe(false);
    expect(status.checks.find((c) => c.id === "network")).toMatchObject({ status: "fail" });
  });

  it("세션: 루트는 ssm:StartSession이 허용되고, 권한 없는 IAM 사용자는 막힌다. 가상 명령은 설정으로 결과를 계산한다", () => {
    const { p, app, db } = ssmNodeProject();
    const inst = ec2Of(p, app);
    expect(startSessionPermission(p, inst).ok).toBe(true);
    let signed = must(iam.createUser(p, { name: "student01", groupIds: [], policyIds: [], consoleAccess: true })).project;
    signed = must(iam.signInAsUser(signed, signed.services.iam.users[0].id)).project;
    expect(startSessionPermission(signed, inst)).toMatchObject({ ok: false });
    const topo = buildTopology(p);
    expect(runSessionCommand(p, topo, inst, "whoami")?.lines).toEqual(["ssm-user"]);
    expect(runSessionCommand(p, topo, inst, "identity")?.lines.join("\n")).toMatch(/assumed-role\/app-ssm-role\//);
    expect(runSessionCommand(p, topo, inst, "internet")?.ok).toBe(true);
    expect(runPortCheck(topo, inst, db, 3306).ok).toBe(true);
    expect(runPortCheck(topo, inst, db, 5432).ok).toBe(false);
  });
});

// ================================================================ CloudFront

const distOf = (p: Project, id: string) => p.services.cloudfront.distributions.find((d) => d.id === id)!;

describe("CloudFront (가상)", () => {
  it("배포는 InProgress로 만들어지고 수명 주기가 지나면 Deployed가 된다. 배포 중에는 요청을 계산하지 않는다", () => {
    const p = cdnProject().p;
    const created = must(cf.createDistribution(p, { comment: "", enabled: true, defaultRootObject: "", priceClass: "PriceClass_100", origins: p.services.cloudfront.distributions[0].origins, behaviors: [{ pathPattern: "*", originId: "site-origin", viewerProtocolPolicy: "https-only", allowedMethods: "GET_HEAD", cachePolicy: "CachingDisabled" }] }));
    const dist = distOf(created.project, created.createdId!);
    expect(dist.state).toBe("InProgress");
    expect(dist.domainName).toMatch(/^d[a-z0-9]{13}\.cloudfront\.net$/);
    expect(simulateCloudFrontRequest(created.project, buildTopology(created.project), dist, { protocol: "https", method: "GET", path: "/" }).status).toBe(0);
  });

  it("OAC: 버킷 정책이 없으면 403, 정책을 추가하면 200(Miss) → 캐시 저장 후 Hit → 무효화하면 다시 Miss", () => {
    const blocked = cdnProject({ policy: "none" });
    const denied = simulateCloudFrontRequest(blocked.p, buildTopology(blocked.p), distOf(blocked.p, blocked.distId), { protocol: "https", method: "GET", path: "/" });
    expect(denied).toMatchObject({ status: 403, xCache: "Error from cloudfront" });
    expect(denied.steps.some((s) => s.status === "fail" && s.field === "originAccess")).toBe(true);

    const { p: base, distId } = cdnProject();
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const first = simulateCloudFrontRequest(base, buildTopology(base), distOf(base, distId), { protocol: "https", method: "GET", path: "/" }, t0);
    expect(first).toMatchObject({ status: 200, xCache: "Miss from cloudfront", originRequested: true, preview: "<h1>v1</h1>" });
    let p = cf.recordCacheEntry(base, distId, first.store!)!;
    const second = simulateCloudFrontRequest(p, buildTopology(p), distOf(p, distId), { protocol: "https", method: "GET", path: "/" }, t0 + 60_000);
    expect(second).toMatchObject({ status: 200, xCache: "Hit from cloudfront", ageSeconds: 60, originRequested: false });
    p = must(cf.createInvalidation(p, distId, ["/*"], t0 + 61_000)).project;
    expect(distOf(p, distId).cache).toHaveLength(0);
    expect(simulateCloudFrontRequest(p, buildTopology(p), distOf(p, distId), { protocol: "https", method: "GET", path: "/" }, t0 + 62_000).xCache).toBe("Miss from cloudfront");
  });

  it("기본 루트 객체가 없으면 / 요청이 403, HTTP는 HTTPS로 301 리디렉션, 허용하지 않은 메서드는 403", () => {
    const noRoot = cdnProject({ defaultRootObject: "" });
    const root = simulateCloudFrontRequest(noRoot.p, buildTopology(noRoot.p), distOf(noRoot.p, noRoot.distId), { protocol: "https", method: "GET", path: "/" });
    expect(root.status).toBe(403);
    expect(root.steps.find((s) => s.status === "fail")?.field).toBe("defaultRootObject");
    const { p, distId } = cdnProject();
    const dist = distOf(p, distId);
    const http = simulateCloudFrontRequest(p, buildTopology(p), dist, { protocol: "http", method: "GET", path: "/index.html" });
    expect(http).toMatchObject({ status: 301, location: `https://${dist.domainName}/index.html` });
    expect(simulateCloudFrontRequest(p, buildTopology(p), dist, { protocol: "https", method: "POST", path: "/index.html" }).status).toBe(403);
  });

  it("경로 패턴: 위에서부터 처음 일치하는 동작, 없으면 기본 동작(*)", () => {
    expect(pathPatternMatches("/api/*", "/api/users")).toBe(true);
    expect(pathPatternMatches("*.jpg", "/images/a.jpg")).toBe(true);
    expect(pathPatternMatches("/api/*", "/apix")).toBe(false);
    const { p, distId } = cdnProject();
    const updated = must(
      cf.updateDistribution(p, distId, {
        ...distOf(p, distId),
        behaviors: [
          { pathPattern: "/api/*", originId: "site-origin", viewerProtocolPolicy: "https-only", allowedMethods: "ALL", cachePolicy: "CachingDisabled" },
          ...distOf(p, distId).behaviors,
        ],
      }),
    ).project;
    const dist = distOf(updated, distId);
    expect(dist.state).toBe("InProgress");
    expect(matchBehavior(dist, "/api/users").pathPattern).toBe("/api/*");
    expect(matchBehavior(dist, "/index.html").pathPattern).toBe("*");
    const bad = cf.updateDistribution(p, distId, { ...distOf(p, distId), behaviors: [{ pathPattern: "/x", originId: "site-origin", viewerProtocolPolicy: "https-only", allowedMethods: "ALL", cachePolicy: "CachingDisabled" }] });
    expect(!bad.ok && bad.error).toMatch(/기본 동작/);
  });

  it("OAC 버킷 정책 평가: AWS:SourceArn이 다른 배포면 거부, 조건이 없으면 허용하지만 범위가 넓다", () => {
    const other = cdnProject({ policy: "other-dist" });
    const bucket = (p: Project, id: string) => p.services.s3.buckets.find((b) => b.id === id)!;
    expect(evaluateOacAccess(bucket(other.p, other.bucketId), other.distId, "s3:GetObject", "arn:aws:s3:::site-bucket/index.html")).toMatchObject({ allowed: false, scoped: true });
    const unscoped = cdnProject({ policy: "unscoped" });
    expect(evaluateOacAccess(bucket(unscoped.p, unscoped.bucketId), unscoped.distId, "s3:GetObject", "arn:aws:s3:::site-bucket/index.html")).toMatchObject({ allowed: true, scoped: false });
    // 이미 같은 배포의 문이 있으면 다시 넣지 않는다
    const scoped = cdnProject();
    const policy = bucket(scoped.p, scoped.bucketId).policy;
    expect(withOacStatement(policy, "site-bucket", scoped.distId)).toBe(JSON.stringify(JSON.parse(policy), null, 2));
  });

  it("삭제: 활성 배포는 DistributionNotDisabled, 비활성화가 배포된 뒤에만 삭제된다", () => {
    const { p, distId } = cdnProject();
    expect(cf.deleteDistribution(p, distId)).toMatchObject({ ok: false, error: expect.stringMatching(/^\[DistributionNotDisabled\]/) });
    const disabled = must(cf.setDistributionEnabled(p, distId, false)).project;
    expect(cf.deleteDistribution(disabled, distId)).toMatchObject({ ok: false, error: expect.stringMatching(/^\[PreconditionFailed\]/) });
    const deployed = advanceLifecycle(disabled, distId, "InProgress", "Deployed")!;
    expect(must(cf.deleteDistribution(deployed, distId)).project.services.cloudfront.distributions).toHaveLength(0);
  });
});

describe("저장 형식", () => {
  it("새 서비스가 없는 예전 프로젝트도 빈 목록으로 읽는다", () => {
    const p = lambdaProject();
    const { secretsmanager, ssm: _ssm, cloudfront, ...oldServices } = p.services;
    void secretsmanager;
    void _ssm;
    void cloudfront;
    const parsed = projectSchema.parse({ ...p, services: oldServices });
    expect(parsed.services.secretsmanager.secrets).toEqual([]);
    expect(parsed.services.ssm.parameters).toEqual([]);
    expect(parsed.services.cloudfront.distributions).toEqual([]);
  });
});
