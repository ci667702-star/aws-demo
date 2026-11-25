import { beforeEach, describe, expect, it } from "vitest";
import { buildMetricModel, metricSeries, MINUTE } from "@/lib/engine/cloudwatch-engine";
import { estimateCost } from "@/lib/engine/cost-engine";
import { authorizeChange, requiredActions } from "@/lib/engine/iam-permissions";
import { ROLE_TEMPLATES } from "@/lib/engine/iam-templates";
import { analyzeInvocation, invokeLambda, monthlyScheduledInvocations, scheduleCanInvoke } from "@/lib/engine/lambda-engine";
import type { MetricRef, Project, ResourceOfType } from "@/lib/engine/resource-models";
import { buildTopology } from "@/lib/engine/topology-engine";
import { validateProject } from "@/lib/engine/validation-engine";
import { analyzeResource } from "@/lib/docs/resource-analysis";
import { analyzeProject } from "@/components/console/analysis-context";
import * as aws from "@/lib/project/console-actions";
import * as eb from "@/lib/project/eventbridge-actions";
import * as iam from "@/lib/project/iam-actions";
import * as lambda from "@/lib/project/lambda-actions";
import { createServerlessSample } from "@/lib/project/samples";
import { idOf, lambdaProject, scheduledLambdaProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function must(r: aws.ActionResult): Project {
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

const fnOf = (p: Project, name = "fn") => p.resources.find((r): r is ResourceOfType<"lambda"> => r.type === "lambda" && r.name === name)!;
const call = (p: Project, name = "fn") => analyzeInvocation(p, buildTopology(p), fnOf(p, name));
const failDetail = (p: Project, name = "fn") => call(p, name).checks.find((c) => c.status === "fail")?.detail ?? "";

describe("Lambda 호출 판정 (가상 실행)", () => {
  it("올바른 VPC Lambda는 같은 VPC의 RDS에 접속해 성공한다", () => {
    const r = call(lambdaProject());
    expect(r.outcome).toBe("success");
    expect(r.checks.map((c) => c.status)).not.toContain("fail");
  });

  it("실행 역할이 없거나 Lambda를 신뢰하지 않는 역할이면 실행할 수 없다", () => {
    expect(call(lambdaProject({ role: "none" })).outcome).toBe("invalid");
    const ec2Role = call(lambdaProject({ role: "ec2" }));
    expect(ec2Role.outcome).toBe("invalid");
    expect(ec2Role.errorMessage).toContain("cannot be assumed by Lambda");
  });

  it("VPC에 연결했는데 보안 그룹이나 네트워크 인터페이스 권한이 없으면 실행할 수 없다", () => {
    expect(call(lambdaProject({ sg: false })).errorMessage).toContain("SecurityGroupIds");
    expect(call(lambdaProject({ role: "basic" })).errorMessage).toContain("CreateNetworkInterface");
  });

  it("퍼블릭 서브넷의 Lambda는 퍼블릭 IP가 없어 외부 호출이 시간 초과되고, NAT 경로나 VPC 밖이면 성공한다", () => {
    const pub = lambdaProject({ placement: "public", template: "http-get" });
    expect(call(pub).outcome).toBe("timeout");
    expect(failDetail(pub)).toContain("퍼블릭 IP");
    expect(call(lambdaProject({ placement: "isolated", template: "http-get" })).outcome).toBe("timeout");
    expect(call(lambdaProject({ placement: "private", template: "http-get" })).outcome).toBe("success");
    expect(call(lambdaProject({ placement: "none", role: "basic", template: "http-get" })).outcome).toBe("success");
  });

  it("RDS 조회는 같은 VPC와 보안 그룹 허용이 필요하다", () => {
    expect(failDetail(lambdaProject({ placement: "none", role: "basic" }))).toContain("VPC에 연결하지 않은 함수");
    const blocked = lambdaProject({ dbInbound: false });
    expect(call(blocked).outcome).toBe("timeout");
    expect(failDetail(blocked)).toContain("인바운드 규칙에 함수의 보안 그룹");
  });

  it("S3 템플릿은 실행 역할의 s3:ListBucket 권한으로 판정한다", () => {
    const denied = call(lambdaProject({ placement: "none", role: "basic", template: "s3-list" }));
    expect(denied).toMatchObject({ outcome: "error", errorType: "AccessDenied" });
    expect(call(lambdaProject({ placement: "none", role: "basic", template: "s3-list", s3Read: true })).outcome).toBe("success");
  });

  it("예약 동시성 0이면 제한되고, 가상 실행 시간이 제한 시간보다 길면 제한 시간에서 끊긴다", () => {
    expect(call(lambdaProject({ concurrency: 0 })).outcome).toBe("throttled");
    const slow = call(lambdaProject({ duration: 5000, timeout: 3 }));
    expect(slow).toMatchObject({ outcome: "timeout", durationMs: 3000 });
  });

  it("테스트 호출은 REPORT 로그와 청구 시간을 돌려주고, 실행되지 않으면 로그가 없다", () => {
    const p = lambdaProject();
    const result = invokeLambda(p, buildTopology(p), fnOf(p), "{}");
    expect(result.logs[0]).toMatch(/^START RequestId: /);
    expect(result.logs.at(-1)).toMatch(/^REPORT RequestId: .* Billed Duration: 120 ms Memory Size: 128 MB/);
    const throttled = lambdaProject({ concurrency: 0 });
    expect(invokeLambda(throttled, buildTopology(throttled), fnOf(throttled)).logs).toEqual([]);
  });
});

describe("Lambda 콘솔 동작", () => {
  it("'새 역할 생성'으로 만들면 로그(+VPC) 권한만 있는 실행 역할이 생기고 호출이 성공한다", () => {
    const p = lambdaProject();
    const after = must(
      lambda.createFunction(p, {
        name: "report",
        runtime: "python3.13",
        architecture: "arm64",
        roleId: null,
        createRole: true,
        codeTemplate: "rds-query",
        templateTarget: idOf(p, "db"),
        subnetIds: [idOf(p, "private-a"), idOf(p, "private-c")],
        securityGroupIds: [idOf(p, "fn-sg")],
      }),
    );
    const fn = fnOf(after, "report");
    const role = after.services.iam.roles.find((r) => r.id === fn.config.roleId)!;
    expect(role.trustedEntity).toBe("lambda.amazonaws.com");
    expect(role.policyIds).toEqual(["aws:AWSLambdaBasicExecutionRole", "aws:AWSLambdaVPCAccessExecutionRole"]);
    expect(fn.config.handler).toBe("lambda_function.lambda_handler");
    expect(call(after, "report").outcome).toBe("success");
  });

  it("AWS가 거부하는 입력은 같은 이유로 거부한다", () => {
    const p = lambdaProject();
    const base = { runtime: "nodejs22.x" as const, architecture: "x86_64" as const, roleId: null, createRole: true };
    expect(lambda.createFunction(p, { ...base, name: "fn" })).toMatchObject({ ok: false, error: expect.stringContaining("[ResourceConflictException]") });
    expect(lambda.createFunction(p, { ...base, name: "bad name" }).ok).toBe(false);
    expect(lambda.createFunction(p, { ...base, name: "x", memoryMb: 64 }).ok).toBe(false);
    expect(lambda.createFunction(p, { ...base, name: "x", subnetIds: [idOf(p, "private-a")] })).toMatchObject({ ok: false, error: expect.stringContaining("보안 그룹") });

    const withEc2Role = must(iam.createRole(p, { name: "ec2-role", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: [] }));
    const ec2RoleId = withEc2Role.services.iam.roles.find((r) => r.name === "ec2-role")!.id;
    expect(lambda.createFunction(withEc2Role, { ...base, createRole: false, roleId: ec2RoleId, name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("cannot be assumed by Lambda") });

    const withBasic = must(iam.createRole(p, { name: "basic", description: "", trustedEntity: "lambda.amazonaws.com", policyIds: ["aws:AWSLambdaBasicExecutionRole"] }));
    const basicId = withBasic.services.iam.roles.find((r) => r.name === "basic")!.id;
    expect(
      lambda.createFunction(withBasic, { ...base, createRole: false, roleId: basicId, name: "x", subnetIds: [idOf(p, "private-a")], securityGroupIds: [idOf(p, "fn-sg")] }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("CreateNetworkInterface") });
  });

  it("환경 변수에 비밀 값은 넣을 수 없고, Secrets Manager ARN 참조는 허용한다", () => {
    const p = lambdaProject();
    const id = fnOf(p).id;
    expect(lambda.updateFunctionConfiguration(p, id, { environment: [{ key: "DB_PASSWORD", value: "hunter2" }] }).ok).toBe(false);
    expect(lambda.updateFunctionConfiguration(p, id, { environment: [{ key: "KEY", value: "AKIAIOSFODNN7EXAMPLE" }] }).ok).toBe(false);
    expect(lambda.updateFunctionConfiguration(p, id, { environment: [{ key: "AWS_REGION", value: "x" }] }).ok).toBe(false);
    const saved = lambda.updateFunctionConfiguration(p, id, {
      environment: [
        { key: "DB_SECRET_ARN", value: "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:db" },
        { key: "STAGE", value: "dev" },
      ],
    });
    expect(saved.ok).toBe(true);
  });

  it("VPC에 연결한 함수가 쓰는 서브넷은 지울 수 없고, VPC 연결을 해제하면 지울 수 있다", () => {
    const p = lambdaProject({ placement: "isolated" });
    const subnet = idOf(p, "isolated-a");
    expect(aws.deleteSubnet(p, subnet)).toMatchObject({ ok: false, error: expect.stringContaining("[DependencyViolation]") });
    const detached = must(lambda.setFunctionVpc(p, fnOf(p).id, { subnetIds: [], securityGroupIds: [] }));
    expect(buildTopology(detached).lambdaSubnets(fnOf(p).id)).toEqual([]);
    expect(aws.deleteSubnet(detached, subnet).ok).toBe(true);
  });

  it("쉬운 모드의 '기본 실행 역할 만들기'는 VPC 연결 여부에 맞는 권한을 준다", () => {
    const p = lambdaProject({ role: "none" });
    const after = must(lambda.createExecutionRoleFor(p, fnOf(p).id));
    const role = after.services.iam.roles.find((r) => r.id === fnOf(after).config.roleId)!;
    expect(role.policyIds).toContain("aws:AWSLambdaVPCAccessExecutionRole");
    expect(call(after).outcome).toBe("success");
  });
});

describe("가상 비용과 CloudWatch 지표", () => {
  const rateProject = (overrides: Parameters<typeof lambdaProject>[0] = {}) => {
    const p = lambdaProject({ placement: "none", role: "basic", template: "hello", ...overrides });
    return must(
      eb.createSchedule(p, {
        name: "every-5",
        description: "",
        expression: "rate(5 minutes)",
        timezone: "Asia/Seoul",
        flexibleWindowMinutes: 0,
        state: "ENABLED",
        targetLambdaId: fnOf(p).id,
        roleId: null,
        createRole: true,
        input: "{}",
        retryAttempts: 185,
      }),
    );
  };

  it("5분마다 호출하는 일정은 730시간에 8,760번으로 계산해 요청·GB-초·Scheduler 요금을 낸다", () => {
    const p = rateProject();
    const now = Date.parse(p.services.eventbridge.schedules[0].createdAt) + 86_400_000;
    expect(monthlyScheduledInvocations(p, fnOf(p), now)).toBe(8760);
    const report = estimateCost(p, undefined, now);
    const line = report.lines.find((l) => l.resourceType === "lambda")!;
    expect(line.items.map((i) => i.quantity)).toEqual([8760, 8760, 131.4]);
    expect(report.notes.join(" ")).toContain("프리 티어");
  });

  it("호출하는 일정이 없으면 Lambda 비용이 없다고 안내한다", () => {
    const report = estimateCost(lambdaProject());
    expect(report.lines.find((l) => l.resourceType === "lambda")).toMatchObject({ subtotal: 0, note: expect.stringContaining("활성 일정이 없어") });
  });

  it("일정이 호출하는 분에만 지표가 있고, 동시성 0이면 Throttles로 기록한다", () => {
    const series = (p: Project, metricName: string) => {
      const createdAt = Date.parse(p.services.eventbridge.schedules[0].createdAt);
      const ref: MetricRef = { namespace: "AWS/Lambda", metricName, resourceId: fnOf(p).id, stat: "Sum" };
      return metricSeries(buildMetricModel(p), ref, 60, createdAt, createdAt + 11 * MINUTE)
        .filter((d) => d.value !== null)
        .map((d) => d.value);
    };
    const ok = rateProject();
    expect(series(ok, "Invocations")).toEqual([1, 1]);
    expect(series(ok, "Errors")).toEqual([0, 0]);
    const throttled = rateProject({ concurrency: 0 });
    expect(series(throttled, "Invocations")).toEqual([0, 0]);
    expect(series(throttled, "Throttles")).toEqual([1, 1]);
  });
});

describe("Lambda·EventBridge IAM 권한", () => {
  it("함수를 만들려면 lambda:CreateFunction과 실행 역할에 대한 iam:PassRole이 필요하다", () => {
    const before = lambdaProject();
    const after = must(lambda.createFunction(before, { name: "f2", runtime: "nodejs22.x", architecture: "x86_64", roleId: fnOf(before).config.roleId }));
    expect(requiredActions(before, after).map((a) => a.action)).toEqual(expect.arrayContaining(["lambda:CreateFunction", "iam:PassRole"]));
  });

  it("일정에는 scheduler:CreateSchedule, 규칙에는 events:PutRule·PutTargets와 lambda:AddPermission이 필요하다", () => {
    const before = lambdaProject({ placement: "none", role: "basic", template: "hello" });
    const scheduled = scheduledLambdaProject();
    expect(requiredActions(before, scheduled).map((a) => a.action)).toEqual(expect.arrayContaining(["scheduler:CreateSchedule", "iam:CreateRole", "iam:CreatePolicy", "iam:PassRole"]));
    const ruled = must(
      eb.createRule(scheduled, { name: "r1", description: "", eventPattern: '{"source": ["school.app"]}', state: "ENABLED", targetLambdaIds: [fnOf(scheduled).id], addPermissions: true }),
    );
    expect(requiredActions(scheduled, ruled).map((a) => a.action)).toEqual(expect.arrayContaining(["events:PutRule", "events:PutTargets", "lambda:AddPermission"]));
  });

  it("서버 운영자는 School-Lambda-·School-Scheduler- 역할로만 함수·일정을 만들고, 새 실행 역할은 만들 수 없다", () => {
    const school = must(iam.applyRoleTemplates(lambdaProject(), ROLE_TEMPLATES.map((t) => t.id), { createUsers: true }));
    const op = must(iam.signInAsUser(school, school.services.iam.users.find((u) => u.name === "server-op")!.id));
    const lambdaRole = op.services.iam.roles.find((r) => r.name === iam.SCHOOL_LAMBDA_ROLE_NAME)!;
    const schedulerRole = op.services.iam.roles.find((r) => r.name === iam.SCHOOL_SCHEDULER_ROLE_NAME)!;

    const created = must(lambda.createFunction(op, { name: "op-fn", runtime: "nodejs22.x", architecture: "x86_64", roleId: lambdaRole.id }));
    expect(authorizeChange(op, created).ok).toBe(true);
    const denied = authorizeChange(op, must(lambda.createFunction(op, { name: "op-fn2", runtime: "nodejs22.x", architecture: "x86_64", roleId: null, createRole: true })));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(["iam:CreateRole", "iam:PassRole"]).toContain(denied.denied.action);

    const scheduled = must(
      eb.createSchedule(created, {
        name: "op-schedule",
        description: "",
        expression: "cron(0 9 ? * MON-FRI *)",
        timezone: "Asia/Seoul",
        flexibleWindowMinutes: 0,
        state: "ENABLED",
        targetLambdaId: fnOf(created, "op-fn").id,
        roleId: schedulerRole.id,
        input: "{}",
        retryAttempts: 185,
      }),
    );
    expect(authorizeChange(created, scheduled).ok).toBe(true);
    expect(scheduleCanInvoke(scheduled, scheduled.services.eventbridge.schedules[0], fnOf(scheduled, "op-fn")).ok).toBe(true);
  });
});

describe("서버리스 샘플과 구성 분석", () => {
  it("샘플은 오류·경고 없이 모든 함수가 성공하고, 모든 일정이 함수를 호출할 수 있다", () => {
    const p = createServerlessSample();
    expect(validateProject(p).findings.filter((f) => f.severity !== "info").map((f) => `${f.ruleId}: ${f.cause}`)).toEqual([]);
    const topo = buildTopology(p);
    for (const fn of topo.ofType("lambda")) expect(analyzeInvocation(p, topo, fn).outcome, fn.name).toBe("success");
    for (const s of p.services.eventbridge.schedules) expect(scheduleCanInvoke(p, s, topo.getOfType(s.targetLambdaId, "lambda") ?? undefined).ok, s.name).toBe(true);
  });

  it("함수 분석은 실행 역할·VPC·트리거를 실제 설정대로 보여 준다", () => {
    const p = scheduledLambdaProject();
    const a = analyzeResource(analyzeProject(p), fnOf(p).id)!;
    expect(a.headline.text).toContain("VPC 밖");
    expect(a.headline.tone).toBe("ok");
    expect(a.relations.find((r) => r.label === "트리거 (EventBridge)")?.items.map((i) => i.name)).toEqual(["일정 every-5"]);
    expect(a.relations.find((r) => r.label === "실행 역할")?.items[0]?.name).toBe("fn-role");
  });
});
