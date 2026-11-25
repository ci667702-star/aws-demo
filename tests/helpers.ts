import { simulate, type SimulationRequest } from "@/lib/engine/connectivity-engine";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import type { LambdaCodeTemplate, Project, Resource } from "@/lib/engine/resource-models";
import { parseScheduleExpression } from "@/lib/engine/schedule-expression";
import { validateProject } from "@/lib/engine/validation-engine";
import { natInstanceScript } from "@/lib/engine/nat-instance";
import { oacPolicyStatement } from "@/lib/engine/cloudfront-engine";
import { ProjectBuilder } from "@/lib/project/builder";
import * as cf from "@/lib/project/cloudfront-actions";
import type { ActionResult } from "@/lib/project/console-actions";
import { NACL, SG } from "@/lib/project/factory";
import * as eb from "@/lib/project/eventbridge-actions";
import * as iam from "@/lib/project/iam-actions";
import { advanceLifecycle } from "@/lib/project/lifecycle";
import * as s3 from "@/lib/project/s3-actions";

export function useDeterministicIds() {
  setIdGenerator(sequentialIdGenerator());
}

export function byName(project: Project, name: string): Resource {
  const r = project.resources.find((x) => x.name === name);
  if (!r) throw new Error(`리소스 ${name} 없음`);
  return r;
}

export function idOf(project: Project, name: string): string {
  return byName(project, name).id;
}

export function ruleIds(project: Project): string[] {
  return validateProject(project).findings.map((f) => f.ruleId);
}

export function run(project: Project, request: SimulationRequest) {
  return simulate(project, request);
}

export const internet = (ip = "203.0.113.10") => ({ kind: "internet" as const, ip });
export const res = (resourceId: string, addressing?: "auto" | "private" | "public") => ({
  kind: "resource" as const,
  resourceId,
  addressing,
});

/** 퍼블릭 서브넷의 웹 서버 한 대 */
export function publicWebProject(options: { sgInbound?: ReturnType<typeof SG.tcp>[]; route?: boolean; igwAttached?: boolean; publicIp?: boolean } = {}) {
  const b = new ProjectBuilder("public-web");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const subnet = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", options.igwAttached === false ? null : vpc);
  b.routeTable("public-rt", vpc, {
    subnets: [subnet],
    routes: options.route === false ? [] : [{ destination: "0.0.0.0/0", igw }],
  });
  const sg = b.securityGroup("web-sg", vpc, { inbound: options.sgInbound ?? [SG.tcp(80, "0.0.0.0/0")] });
  b.ec2("web", subnet, { ip: "10.0.1.10", publicIp: options.publicIp === false ? "disabled" : "enabled", sgs: [sg] });
  return b.build();
}

/** 퍼블릭 서브넷(NAT 인스턴스) + 프라이빗 서브넷(EC2). 기본값은 올바르게 구성된 NAT 인스턴스 */
export function natInstanceProject(
  options: {
    sourceDestCheck?: boolean;
    script?: boolean;
    natInPrivate?: boolean;
    publicIp?: boolean;
    state?: "running" | "stopped" | "terminated";
    natSgInbound?: ReturnType<typeof SG.tcp>[];
  } = {},
) {
  const b = new ProjectBuilder("nat-instance");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  const natSg = b.securityGroup("nat-sg", vpc, {
    inbound: options.natSgInbound ?? [SG.tcp(80, "10.0.11.0/24"), SG.tcp(443, "10.0.11.0/24")],
  });
  const nat = b.ec2("nat-instance", options.natInPrivate ? priv : pub, {
    ip: options.natInPrivate ? "10.0.11.5" : "10.0.1.5",
    publicIp: options.publicIp === false ? "disabled" : "enabled",
    sgs: [natSg],
    listenPorts: [22],
    state: options.state ?? "running",
    sourceDestCheck: options.sourceDestCheck ?? false,
    userData: options.script === false ? "#!/bin/bash\ndnf install -y httpd" : (natInstanceScript("amazon-linux-2023") ?? ""),
  });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", instance: nat }] });
  const sg = b.securityGroup("worker-sg", vpc);
  b.ec2("worker", priv, { ip: "10.0.11.10", sgs: [sg] });
  return b.build();
}

/** 퍼블릭 서브넷(NAT) + 프라이빗 서브넷(EC2) */
export function privateNatProject(options: { natState?: "available" | "pending" | "failed"; natInPrivate?: boolean; privateNacl?: "ok" | "no-ephemeral" } = {}) {
  const b = new ProjectBuilder("private-nat");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  const nat = b.nat("nat", options.natInPrivate ? priv : pub, { state: options.natState ?? "available" });
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", nat }] });
  if (options.privateNacl) {
    b.networkAcl("private-nacl", vpc, {
      subnets: [priv],
      inbound:
        options.privateNacl === "ok"
          ? [NACL.allow(100, "tcp", [1024, 65535], "0.0.0.0/0")]
          : [NACL.allow(100, "tcp", 22, "10.0.0.0/16")],
      outbound: [NACL.allow(100, "tcp", 443, "0.0.0.0/0")],
    });
  }
  const sg = b.securityGroup("worker-sg", vpc);
  b.ec2("worker", priv, { ip: "10.0.11.10", sgs: [sg] });
  return b.build();
}

// ---------------------------------------------------------------- Lambda · EventBridge

function mustProject(r: { ok: true; project: Project } | { ok: false; error: string }): Project {
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

/**
 * 퍼블릭(IGW)·프라이빗(NAT, 2AZ)·격리 서브넷 + RDS + S3 버킷(data-bucket) + Lambda 함수 fn.
 * 기본값은 올바른 VPC Lambda: 프라이빗 서브넷 2AZ, 보안 그룹, VPC 실행 역할, RDS 조회 코드.
 */
export function lambdaProject(
  options: {
    role?: "vpc" | "basic" | "ec2" | "no-logs" | "none";
    placement?: "private" | "public" | "isolated" | "one-az" | "none";
    sg?: boolean;
    template?: LambdaCodeTemplate;
    duration?: number;
    timeout?: number;
    concurrency?: number | null;
    s3Read?: boolean;
    dbInbound?: boolean;
  } = {},
): Project {
  const b = new ProjectBuilder("lambda");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const privA = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const privC = b.subnet("private-c", vpc, "10.0.12.0/24", "ap-northeast-2c");
  const iso = b.subnet("isolated-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  const nat = b.nat("nat", pub);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [privA, privC], routes: [{ destination: "0.0.0.0/0", nat }] });
  b.routeTable("isolated-rt", vpc, { subnets: [iso] });
  const fnSg = b.securityGroup("fn-sg", vpc);
  const dbSg = b.securityGroup("db-sg", vpc, { inbound: options.dbInbound === false ? [] : [SG.tcp(3306, { sg: fnSg })] });
  const group = b.dbSubnetGroup("db-group", [privA, privC]);
  const db = b.rds("db", { subnetGroup: group, sgs: [dbSg] });
  const subnets = { private: [privA, privC], public: [pub], isolated: [iso], "one-az": [privA], none: [] as string[] }[options.placement ?? "private"];
  const template = options.template ?? "rds-query";
  const fn = b.lambda("fn", {
    subnets,
    sgs: subnets.length && options.sg !== false ? [fnSg] : [],
    codeTemplate: template,
    templateTarget: template === "rds-query" ? db : template === "s3-list" ? "data-bucket" : template === "http-get" ? "https://example.com/health" : "",
    virtualDurationMs: options.duration ?? 120,
    timeoutSeconds: options.timeout ?? 3,
    reservedConcurrency: options.concurrency ?? null,
  });
  let p = mustProject(
    s3.createBucket(b.build(), {
      name: "data-bucket",
      blockPublicAccess: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
      versioning: "Disabled",
      encryption: "SSE-S3",
    }),
  );
  const role = options.role ?? "vpc";
  if (role !== "none") {
    const policyIds = {
      vpc: ["aws:AWSLambdaBasicExecutionRole", "aws:AWSLambdaVPCAccessExecutionRole"],
      basic: ["aws:AWSLambdaBasicExecutionRole"],
      ec2: ["aws:AWSLambdaVPCAccessExecutionRole"],
      "no-logs": [] as string[],
    }[role];
    const r = iam.createRole(p, {
      name: "fn-role",
      description: "",
      trustedEntity: role === "ec2" ? "ec2.amazonaws.com" : "lambda.amazonaws.com",
      policyIds: [...policyIds, ...(options.s3Read ? ["aws:AmazonS3ReadOnlyAccess"] : [])],
    });
    if (!r.ok) throw new Error(r.error);
    p = { ...r.project, resources: r.project.resources.map((x) => (x.id === fn && x.type === "lambda" ? { ...x, config: { ...x.config, roleId: r.createdId ?? null } } : x)) };
  }
  return p;
}

/** VPC 밖 Lambda(fn, hello) + Scheduler 일정(every-5) + 선택적으로 규칙(ec2-stopped) */
export function scheduledLambdaProject(options: { scheduleRole?: "auto" | "no-invoke"; expression?: string; rule?: "with-permission" | "no-permission" | "no-target" } = {}): Project {
  let p = lambdaProject({ placement: "none", role: "basic", template: "hello" });
  const fnId = p.resources.find((r) => r.type === "lambda")!.id;
  let roleId: string | null = null;
  if (options.scheduleRole === "no-invoke") {
    const r = iam.createRole(p, { name: "scheduler-empty", description: "", trustedEntity: "scheduler.amazonaws.com", policyIds: [] });
    if (!r.ok) throw new Error(r.error);
    p = r.project;
    roleId = r.createdId ?? null;
  }
  const valid = !options.expression || parseScheduleExpression(options.expression).ok;
  p = mustProject(
    eb.createSchedule(p, {
      name: "every-5",
      description: "",
      expression: valid && options.expression ? options.expression : "rate(5 minutes)",
      timezone: "Asia/Seoul",
      flexibleWindowMinutes: 0,
      state: "ENABLED",
      targetLambdaId: fnId,
      roleId,
      createRole: roleId === null,
      input: "{}",
      retryAttempts: 185,
    }),
  );
  if (!valid) {
    // 콘솔은 잘못된 표현식을 거부하므로, 가져온 프로젝트처럼 데이터를 직접 바꾼다
    p = { ...p, services: { ...p.services, eventbridge: { ...p.services.eventbridge, schedules: p.services.eventbridge.schedules.map((s) => ({ ...s, expression: options.expression! })) } } };
  }
  if (options.rule) {
    p = mustProject(
      eb.createRule(p, {
        name: "ec2-stopped",
        description: "",
        eventPattern: JSON.stringify({ source: ["aws.ec2"], detail: { state: ["stopped"] } }),
        state: "ENABLED",
        targetLambdaIds: options.rule === "no-target" ? [] : [fnId],
        addPermissions: options.rule === "with-permission",
      }),
    );
  }
  return p;
}

// ---------------------------------------------------------------- Secrets Manager · Systems Manager · CloudFront

export function must(r: ActionResult): Extract<ActionResult, { ok: true }> {
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** 함수 fn의 코드 대상(templateTarget)을 바꾼다 */
export function setFunctionTarget(p: Project, target: string): Project {
  return { ...p, resources: p.resources.map((r) => (r.type === "lambda" ? { ...r, config: { ...r.config, templateTarget: target } } : r)) };
}

/** 퍼블릭(IGW·NAT) + 프라이빗 서브넷의 app 인스턴스와 db-host(3306). 역할과 경로를 바꿔 관리형 노드 조건을 시험한다 */
export function ssmNodeProject(options: { route?: "nat" | "none"; role?: "ssm" | "empty" | "none"; ssh?: boolean } = {}) {
  const b = new ProjectBuilder("ssm");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  const nat = b.nat("nat", pub);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: options.route === "none" ? [] : [{ destination: "0.0.0.0/0", nat }] });
  const sg = b.securityGroup("app-sg", vpc, { inbound: options.ssh ? [SG.tcp(22, "0.0.0.0/0")] : [] });
  const dbSg = b.securityGroup("db-sg", vpc, { inbound: [SG.tcp(3306, { sg })] });
  const app = b.ec2("app", priv, { ip: "10.0.11.10", sgs: [sg] });
  const db = b.ec2("db-host", priv, { ip: "10.0.11.20", sgs: [dbSg], listenPorts: [3306] });
  let p = b.build();
  if (options.role !== "none") {
    const r = must(iam.createRole(p, { name: "app-ssm-role", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: options.role === "empty" ? [] : ["aws:AmazonSSMManagedInstanceCore"] }));
    p = must(iam.setInstanceRole(r.project, app, r.createdId!)).project;
  }
  return { p, app, db };
}

/**
 * 비공개 버킷 site-bucket(index.html) + 그 버킷을 원본으로 하는 배포. 배포는 Deployed 상태로 돌려준다.
 * policy: oac = 콘솔의 '버킷 정책에 추가', none = 정책 없음, unscoped = AWS:SourceArn 조건 없음, other-dist = 다른 배포의 ARN
 */
export function cdnProject(
  options: {
    defaultRootObject?: string;
    policy?: "oac" | "none" | "unscoped" | "other-dist";
    originAccess?: "oac" | "public";
    viewerProtocolPolicy?: "allow-all" | "redirect-to-https" | "https-only";
  } = {},
) {
  let p = must(
    s3.createBucket(lambdaProject(), {
      name: "site-bucket",
      blockPublicAccess: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
      versioning: "Disabled",
      encryption: "SSE-S3",
    }),
  ).project;
  const bucket = p.services.s3.buckets.find((b) => b.name === "site-bucket")!;
  p = must(s3.putObject(p, bucket.id, { key: "index.html", size: 20, contentType: "text/html", text: "<h1>v1</h1>" })).project;
  const access = options.originAccess ?? "oac";
  const created = must(
    cf.createDistribution(p, {
      comment: "site",
      enabled: true,
      defaultRootObject: options.defaultRootObject ?? "index.html",
      priceClass: "PriceClass_All",
      origins: [{ id: "site-origin", kind: "s3", targetId: bucket.id, originAccess: access, protocolPolicy: "https-only" }],
      behaviors: [{ pathPattern: "*", originId: "site-origin", viewerProtocolPolicy: options.viewerProtocolPolicy ?? "redirect-to-https", allowedMethods: "GET_HEAD", cachePolicy: "CachingOptimized" }],
    }),
  );
  const distId = created.createdId!;
  p = advanceLifecycle(created.project, distId, "InProgress", "Deployed")!;
  const policy = options.policy ?? (access === "oac" ? "oac" : "none");
  if (policy === "oac") p = must(cf.addOacBucketPolicy(p, distId, "site-origin")).project;
  if (policy === "unscoped" || policy === "other-dist") {
    const statement = oacPolicyStatement(bucket.name, policy === "other-dist" ? "EOTHERDIST00001" : distId);
    const doc = { Version: "2012-10-17", Statement: [policy === "unscoped" ? { ...statement, Condition: undefined } : statement] };
    p = must(s3.putBucketPolicy(p, bucket.id, JSON.stringify(doc))).project;
  }
  return { p, distId, bucketId: bucket.id };
}
