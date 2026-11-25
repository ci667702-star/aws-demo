/**
 * 가상 Lambda 엔진.
 * 실제 코드는 실행하지 않는다. 함수 설정(실행 역할, VPC 연결, 코드 템플릿, 제한 시간)과
 * 샌드박스의 다른 리소스(IAM 정책, 라우팅·NAT, 보안 그룹, S3 버킷, RDS)로 "이 함수를 호출하면 어떻게 되는지"를 계산한다.
 * 같은 입력이면 항상 같은 결과가 나오도록 난수 대신 해시를 쓴다.
 */
import { parseIpv4 } from "./cidr-utils";
import { evaluateIam, SANDBOX_ACCOUNT_ID } from "./iam-engine";
import { checkNatInstance } from "./nat-instance";
import {
  VIRTUAL_REGION,
  type EventRule,
  type IamRole,
  type LambdaCodeTemplate,
  type Project,
  type ResourceOfType,
  type Schedule,
} from "./resource-models";
import { evaluateS3Access } from "./s3-engine";
import { countRuns, parseScheduleExpression, runsInMinute, type ParsedSchedule } from "./schedule-expression";
import { findSecretByName, isPendingDeletion, isPurged, secretArn } from "./secrets-engine";
import { findParameterByName, parameterArn } from "./ssm-engine";
import { evaluateSecurityGroups } from "./security-group-engine";
import { displayName, type Topology } from "./topology-engine";

type LambdaFn = ResourceOfType<"lambda">;

export const lambdaArn = (name: string) => `arn:aws:lambda:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:function:${name}`;
export const scheduleArn = (name: string) => `arn:aws:scheduler:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:schedule/default/${name}`;
export const ruleArn = (name: string) => `arn:aws:events:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:rule/${name}`;

/** 함수 이름 규칙: 영문자·숫자·하이픈·밑줄, 1~64자 */
export function validateFunctionName(name: string): string | null {
  if (!name) return "함수 이름을 입력하세요.";
  if (name.length > 64) return "함수 이름은 64자 이하여야 합니다.";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return "함수 이름에는 영문자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있습니다.";
  return null;
}

export const LAMBDA_TEMPLATE_INFO: Record<LambdaCodeTemplate, { label: string; description: string; needs: string; targetLabel: string | null }> = {
  hello: { label: "Hello (간단한 응답)", description: "입력 이벤트를 받아 인사말을 돌려줍니다.", needs: "권한·네트워크 없이 동작합니다.", targetLabel: null },
  "s3-list": {
    label: "S3 객체 목록 읽기",
    description: "버킷의 객체 목록을 읽습니다 (s3:ListBucket).",
    needs: "실행 역할에 s3:ListBucket 권한이 필요합니다. VPC에 연결했다면 NAT 경로도 필요합니다.",
    targetLabel: "버킷 이름",
  },
  "http-get": { label: "외부 API 호출", description: "인터넷의 HTTPS API를 호출합니다.", needs: "VPC에 연결했다면 NAT 경로가 있는 프라이빗 서브넷이 필요합니다.", targetLabel: "URL" },
  "rds-query": {
    label: "RDS 조회",
    description: "VPC 안의 RDS에 접속해 조회합니다 (SQL은 실행하지 않습니다).",
    needs: "RDS와 같은 VPC에 연결하고, 보안 그룹이 DB 포트를 허용해야 합니다.",
    targetLabel: "RDS",
  },
  "secret-get": {
    label: "Secrets Manager 보안 암호 읽기",
    description: "보안 암호의 값을 읽습니다 (secretsmanager:GetSecretValue). 암호를 코드나 환경 변수에 넣지 않는 방법입니다.",
    needs: "실행 역할에 그 보안 암호의 secretsmanager:GetSecretValue 권한이 필요합니다. VPC에 연결했다면 NAT 경로도 필요합니다.",
    targetLabel: "보안 암호 이름",
  },
  "ssm-get": {
    label: "Parameter Store 파라미터 읽기",
    description: "Systems Manager Parameter Store의 설정 값을 읽습니다 (ssm:GetParameter).",
    needs: "실행 역할에 그 파라미터의 ssm:GetParameter 권한이 필요합니다. VPC에 연결했다면 NAT 경로도 필요합니다.",
    targetLabel: "파라미터 이름",
  },
  "throw-error": { label: "오류 발생", description: "항상 오류를 던집니다 (경보·재시도 실습용).", needs: "-", targetLabel: null },
};

/** 코드 탭에 보여 줄 참고용 코드 (실행되지 않음) */
export function templateCode(template: LambdaCodeTemplate, runtime: LambdaFn["config"]["runtime"], target: string): string {
  const py = runtime.startsWith("python");
  const java = runtime.startsWith("java");
  if (java) return `// ${LAMBDA_TEMPLATE_INFO[template].label}\n// Java 코드는 표시하지 않습니다. 이 시뮬레이터는 코드를 실행하지 않고 템플릿이 하는 일로 결과를 계산합니다.`;
  switch (template) {
    case "hello":
      return py
        ? `def handler(event, context):\n    return {"statusCode": 200, "body": "Hello from Lambda!"}`
        : `export const handler = async (event) => {\n  return { statusCode: 200, body: "Hello from Lambda!" };\n};`;
    case "s3-list":
      return py
        ? `import boto3\ns3 = boto3.client("s3")\n\ndef handler(event, context):\n    res = s3.list_objects_v2(Bucket="${target || "my-bucket"}")\n    return [o["Key"] for o in res.get("Contents", [])]`
        : `import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";\nconst s3 = new S3Client({});\n\nexport const handler = async () => {\n  const res = await s3.send(new ListObjectsV2Command({ Bucket: "${target || "my-bucket"}" }));\n  return (res.Contents ?? []).map((o) => o.Key);\n};`;
    case "http-get":
      return py
        ? `import urllib.request\n\ndef handler(event, context):\n    with urllib.request.urlopen("${target || "https://example.com"}", timeout=3) as r:\n        return {"status": r.status}`
        : `export const handler = async () => {\n  const res = await fetch("${target || "https://example.com"}");\n  return { status: res.status };\n};`;
    case "rds-query":
      return py
        ? `import os, pymysql\n\ndef handler(event, context):\n    conn = pymysql.connect(host=os.environ["DB_HOST"], user=os.environ["DB_USER"], password=get_secret())\n    ...`
        : `import mysql from "mysql2/promise";\n\nexport const handler = async () => {\n  const conn = await mysql.createConnection({ host: process.env.DB_HOST /* 암호는 Secrets Manager에서 */ });\n  ...\n};`;
    case "secret-get":
      return py
        ? `import boto3\nsecrets = boto3.client("secretsmanager")\n\ndef handler(event, context):\n    res = secrets.get_secret_value(SecretId="${target || "prod/app/db"}")\n    # 값(res["SecretString"])은 로그에 남기지 않는다\n    return {"ok": True}`
        : `import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";\nconst secrets = new SecretsManagerClient({});\n\nexport const handler = async () => {\n  const res = await secrets.send(new GetSecretValueCommand({ SecretId: "${target || "prod/app/db"}" }));\n  // 값(res.SecretString)은 로그에 남기지 않는다\n  return { ok: true };\n};`;
    case "ssm-get":
      return py
        ? `import boto3\nssm = boto3.client("ssm")\n\ndef handler(event, context):\n    res = ssm.get_parameter(Name="${target || "/app/prod/db-host"}", WithDecryption=True)\n    return {"name": res["Parameter"]["Name"]}`
        : `import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";\nconst ssm = new SSMClient({});\n\nexport const handler = async () => {\n  const res = await ssm.send(new GetParameterCommand({ Name: "${target || "/app/prod/db-host"}", WithDecryption: true }));\n  return { name: res.Parameter?.Name };\n};`;
    case "throw-error":
      return py ? `def handler(event, context):\n    raise Exception("의도한 오류")` : `export const handler = async () => {\n  throw new Error("의도한 오류");\n};`;
  }
}

// ---------------------------------------------------------------- 판정

export interface InvokeCheck {
  title: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
  /** 관련 설정 항목 (설명·설정으로 이동할 때 쓴다) */
  field?: string;
}

export type InvokeOutcome = "success" | "error" | "timeout" | "throttled" | "invalid";

export interface InvokeAnalysis {
  outcome: InvokeOutcome;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number;
  checks: InvokeCheck[];
  role: IamRole | null;
  /** 로그를 CloudWatch Logs에 쓸 수 있는지 */
  canWriteLogs: boolean;
  /** 성공했을 때 코드가 돌려주는 값 (JSON) */
  response: string | null;
}

function hash32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

const INTERNET_HOST = parseIpv4("203.0.113.200")!;

const allowed = (project: Project, role: IamRole, action: string, resource: string) => evaluateIam(project, { kind: "role", role }, action, resource).decision === "allowed";

/** VPC에 연결한 함수가 인터넷(퍼블릭 엔드포인트 포함)으로 나갈 수 있는지: 서브넷마다 NAT 경로가 있어야 한다 */
export function internetPath(topo: Topology, fn: LambdaFn): { ok: boolean; partial: boolean; detail: string } {
  const subnets = topo.lambdaSubnets(fn.id);
  if (!subnets.length) return { ok: true, partial: false, detail: "VPC 밖에서 실행되어 AWS가 관리하는 네트워크로 인터넷에 나갑니다." };
  const problems: string[] = [];
  for (const s of subnets) {
    const cls = topo.classifySubnet(s.id);
    const name = displayName(s);
    if (cls.kind === "public") {
      problems.push(`${name}은(는) 퍼블릭 서브넷이지만 Lambda는 퍼블릭 IP를 받지 않아 인터넷 게이트웨이로 나갈 수 없습니다.`);
    } else if (cls.kind !== "private-nat" || !cls.route) {
      problems.push(`${name}에는 VPC 밖으로 나가는 경로(NAT)가 없습니다.`);
    } else if (cls.route.targetKind === "nat-gateway") {
      const nat = topo.getOfType(cls.route.targetId, "nat-gateway");
      const natSubnet = nat ? topo.subnetOf(nat.id) : null;
      if (!nat || nat.config.state !== "available") problems.push(`${name}의 NAT 게이트웨이가 사용 가능 상태가 아닙니다.`);
      else if (!natSubnet || topo.classifySubnet(natSubnet).kind !== "public") problems.push(`${name}의 NAT 게이트웨이가 퍼블릭 서브넷에 있지 않습니다.`);
    } else if (cls.route.targetKind === "instance") {
      const inst = topo.getOfType(cls.route.targetId, "ec2");
      const check = inst ? checkNatInstance(topo, inst) : null;
      if (!check?.ok) problems.push(`${name}이(가) 쓰는 NAT 인스턴스가 NAT로 동작하지 않습니다.`);
    }
  }
  if (problems.length === subnets.length) return { ok: false, partial: false, detail: problems.join(" ") };
  if (problems.length) return { ok: true, partial: true, detail: `일부 서브넷만 NAT 경로가 있습니다: ${problems.join(" ")} Lambda는 서브넷을 골라 쓰므로 호출이 가끔 시간 초과될 수 있습니다.` };
  return { ok: true, partial: false, detail: "모든 서브넷에 NAT 경로가 있어 인터넷으로 나갈 수 있습니다." };
}

/** 함수를 한 번 호출하면 어떻게 되는지 판정한다 (로그·응답 없이 결과와 근거만) */
export function analyzeInvocation(project: Project, topo: Topology, fn: LambdaFn): InvokeAnalysis {
  const c = fn.config;
  const checks: InvokeCheck[] = [];
  const timeoutMs = c.timeoutSeconds * 1000;
  const role = project.services.iam.roles.find((r) => r.id === c.roleId) ?? null;
  const result = (outcome: InvokeOutcome, errorType: string | null, errorMessage: string | null, durationMs: number, canWriteLogs: boolean, response: string | null = null): InvokeAnalysis => ({
    outcome,
    errorType,
    errorMessage,
    durationMs,
    checks,
    role,
    canWriteLogs,
    response,
  });

  // 1. 실행 역할
  if (!role) {
    checks.push({ title: "실행 역할", status: "fail", detail: "실행 역할이 없습니다. Lambda는 실행 역할의 임시 자격 증명으로만 실행됩니다.", field: "roleId" });
    return result("invalid", "InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.", 0, false);
  }
  if (role.trustedEntity !== "lambda.amazonaws.com") {
    checks.push({ title: "실행 역할", status: "fail", detail: `역할 ${role.name}의 신뢰 정책이 lambda.amazonaws.com을 허용하지 않아 Lambda가 이 역할을 맡을 수 없습니다.`, field: "roleId" });
    return result("invalid", "InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.", 0, false);
  }
  checks.push({ title: "실행 역할", status: "pass", detail: `역할 ${role.name}을(를) 맡아 임시 자격 증명으로 실행합니다 (액세스 키를 코드에 넣지 않음).`, field: "roleId" });
  const canWriteLogs = allowed(project, role, "logs:CreateLogStream", "*") && allowed(project, role, "logs:PutLogEvents", "*");
  checks.push(
    canWriteLogs
      ? { title: "로그 권한", status: "pass", detail: "실행 로그를 CloudWatch Logs에 씁니다.", field: "roleId" }
      : { title: "로그 권한", status: "warn", detail: "역할에 CloudWatch Logs 권한(logs:CreateLogStream, logs:PutLogEvents)이 없어 함수는 실행되지만 로그가 남지 않습니다. AWSLambdaBasicExecutionRole을 연결하세요.", field: "roleId" },
  );

  // 2. VPC 연결
  const subnets = topo.lambdaSubnets(fn.id);
  const sgs = topo.securityGroupsOf(fn.id);
  if (subnets.length) {
    if (!sgs.length) {
      checks.push({ title: "VPC 연결", status: "fail", detail: "VPC에 연결하려면 보안 그룹이 하나 이상 필요합니다.", field: "securityGroups" });
      return result("invalid", "InvalidParameterValueException", "SecurityGroupIds are required when SubnetIds are specified.", 0, canWriteLogs);
    }
    if (!allowed(project, role, "ec2:CreateNetworkInterface", "*")) {
      checks.push({
        title: "VPC 연결",
        status: "fail",
        detail: `실행 역할에 ec2:CreateNetworkInterface 권한이 없어 서브넷에 네트워크 인터페이스를 만들 수 없습니다. AWSLambdaVPCAccessExecutionRole을 연결하세요.`,
        field: "roleId",
      });
      return result("invalid", "InvalidParameterValueException", "The provided execution role does not have permissions to call CreateNetworkInterface on EC2", 0, canWriteLogs);
    }
    checks.push({ title: "VPC 연결", status: "pass", detail: `서브넷 ${subnets.map((s) => displayName(s)).join(", ")}에 네트워크 인터페이스를 두고 실행합니다 (퍼블릭 IP 없음).`, field: "subnets" });
  } else {
    checks.push({ title: "VPC 연결", status: "info", detail: "VPC에 연결하지 않아 AWS가 관리하는 네트워크에서 실행됩니다. 인터넷과 AWS 퍼블릭 API에는 닿지만, VPC 안의 프라이빗 리소스(RDS 등)에는 닿지 않습니다.", field: "subnets" });
  }

  // 3. 동시성
  if (c.reservedConcurrency === 0) {
    checks.push({ title: "동시성", status: "fail", detail: "예약 동시성이 0이라 모든 호출이 제한(throttle)됩니다. 함수를 잠시 멈출 때 쓰는 설정입니다.", field: "reservedConcurrency" });
    return result("throttled", "TooManyRequestsException", "Rate Exceeded.", 0, canWriteLogs);
  }

  // 4. 코드가 하는 일
  const needInternet = (what: string): InvokeAnalysis | null => {
    const path = internetPath(topo, fn);
    if (!path.ok) {
      checks.push({ title: `네트워크: ${what}`, status: "fail", detail: `${path.detail} 연결을 기다리다 제한 시간이 지나 중단됩니다.`, field: "subnets" });
      return result("timeout", "Task timed out", `Task timed out after ${c.timeoutSeconds.toFixed(2)} seconds`, timeoutMs, canWriteLogs);
    }
    if (subnets.length) {
      const out = evaluateSecurityGroups(sgs, "outbound", { protocol: "tcp", port: 443, peerIp: INTERNET_HOST, peerSecurityGroupIds: [] });
      if (!out.allowed) {
        checks.push({ title: `네트워크: ${what}`, status: "fail", detail: "보안 그룹 아웃바운드 규칙이 HTTPS(443)를 허용하지 않아 연결을 기다리다 시간 초과됩니다.", field: "securityGroups" });
        return result("timeout", "Task timed out", `Task timed out after ${c.timeoutSeconds.toFixed(2)} seconds`, timeoutMs, canWriteLogs);
      }
    }
    checks.push({ title: `네트워크: ${what}`, status: path.partial ? "warn" : "pass", detail: path.detail, field: "subnets" });
    return null;
  };

  let response: string | null = null;
  switch (c.codeTemplate) {
    case "hello":
      checks.push({ title: "코드", status: "pass", detail: "입력을 받아 인사말을 돌려줍니다.", field: "codeTemplate" });
      response = JSON.stringify({ statusCode: 200, body: "Hello from Lambda!" });
      break;
    case "s3-list": {
      const bucket = project.services.s3.buckets.find((b) => b.name === c.templateTarget.trim());
      if (!bucket) {
        checks.push({ title: "S3 버킷", status: "fail", detail: c.templateTarget.trim() ? `버킷 ${c.templateTarget}이(가) 없습니다.` : "읽을 버킷 이름을 입력하세요.", field: "templateTarget" });
        return result("error", "NoSuchBucket", "The specified bucket does not exist", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      const net = needInternet("S3 퍼블릭 엔드포인트");
      if (net) return net;
      const access = evaluateS3Access(project, { bucketId: bucket.id, key: null, action: "s3:ListBucket", caller: { kind: "role", roleId: role.id } });
      if (!access.ok) {
        checks.push({ title: "S3 권한 (s3:ListBucket)", status: "fail", detail: `${access.summary} 실행 역할 ${role.name}에 이 버킷의 s3:ListBucket 권한을 주세요.`, field: "roleId" });
        return result(
          "error",
          "AccessDenied",
          `User: arn:aws:sts::${SANDBOX_ACCOUNT_ID}:assumed-role/${role.name}/${fn.name || fn.id} is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::${bucket.name}"`,
          Math.min(c.virtualDurationMs, timeoutMs),
          canWriteLogs,
        );
      }
      checks.push({ title: "S3 권한 (s3:ListBucket)", status: "pass", detail: `버킷 ${bucket.name}의 객체 목록을 읽을 수 있습니다.`, field: "roleId" });
      response = JSON.stringify(bucket.objects.filter((o) => !o.deleteMarker).slice(0, 5).map((o) => o.key));
      break;
    }
    case "http-get": {
      const net = needInternet(c.templateTarget.trim() || "외부 API");
      if (net) return net;
      response = JSON.stringify({ status: 200 });
      break;
    }
    case "rds-query": {
      const rds = topo.getOfType(c.templateTarget, "rds");
      if (!rds) {
        checks.push({ title: "RDS", status: "fail", detail: "접속할 RDS를 고르세요.", field: "templateTarget" });
        return result("error", "Error", "DB 대상이 없습니다.", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      const rdsVpc = topo.vpcOf(rds.id);
      if (!subnets.length || !subnets.some((s) => topo.vpcOfSubnet(s.id) === rdsVpc)) {
        checks.push({
          title: `네트워크: ${displayName(rds)}`,
          status: "fail",
          detail: subnets.length ? "함수가 RDS와 다른 VPC에 연결되어 있어 닿지 않습니다." : "VPC에 연결하지 않은 함수는 VPC 안의 RDS에 닿지 않습니다. RDS와 같은 VPC의 서브넷에 연결하세요.",
          field: "subnets",
        });
        return result("timeout", "Task timed out", `Task timed out after ${c.timeoutSeconds.toFixed(2)} seconds`, timeoutMs, canWriteLogs);
      }
      if (rds.config.state !== "available") {
        checks.push({ title: `RDS 상태`, status: "fail", detail: `${displayName(rds)}이(가) ${rds.config.state} 상태라 연결을 받지 않습니다.`, field: "templateTarget" });
        return result("error", "Error", "connect ECONNREFUSED", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      const rdsIp = topo.enisOf(rds.id)[0]?.privateIp ?? null;
      const myIp = parseIpv4(topo.suggestPrivateIp(subnets[0].id) ?? "");
      const port = rds.config.port;
      const out = rdsIp !== null ? evaluateSecurityGroups(sgs, "outbound", { protocol: "tcp", port, peerIp: rdsIp, peerSecurityGroupIds: topo.securityGroupsOf(rds.id).map((g) => g.id) }) : null;
      const inbound = myIp !== null ? evaluateSecurityGroups(topo.securityGroupsOf(rds.id), "inbound", { protocol: "tcp", port, peerIp: myIp, peerSecurityGroupIds: sgs.map((g) => g.id) }) : null;
      if (!out?.allowed || !inbound?.allowed) {
        checks.push({
          title: `보안 그룹: ${displayName(rds)}:${port}`,
          status: "fail",
          detail: !out?.allowed
            ? `함수 보안 그룹의 아웃바운드가 TCP ${port}을(를) 허용하지 않습니다.`
            : `RDS 보안 그룹이 함수에서 오는 TCP ${port}을(를) 허용하지 않습니다. 인바운드 규칙에 함수의 보안 그룹을 소스로 추가하세요.`,
          field: "securityGroups",
        });
        return result("timeout", "Task timed out", `Task timed out after ${c.timeoutSeconds.toFixed(2)} seconds`, timeoutMs, canWriteLogs);
      }
      checks.push({ title: `보안 그룹: ${displayName(rds)}:${port}`, status: "pass", detail: "함수에서 RDS의 DB 포트까지 보안 그룹이 허용합니다 (SQL은 실행하지 않음).", field: "securityGroups" });
      response = JSON.stringify({ rows: 3 });
      break;
    }
    case "secret-get": {
      const name = c.templateTarget.trim();
      const secret = findSecretByName(project, name);
      if (!secret || isPurged(secret, Date.now())) {
        checks.push({ title: "보안 암호", status: "fail", detail: name ? `보안 암호 ${name}이(가) 없습니다.` : "읽을 보안 암호 이름을 입력하세요.", field: "templateTarget" });
        return result("error", "ResourceNotFoundException", "Secrets Manager can't find the specified secret.", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      const net = needInternet("Secrets Manager 엔드포인트");
      if (net) return net;
      const arn = secretArn(secret);
      if (!allowed(project, role, "secretsmanager:GetSecretValue", arn)) {
        checks.push({ title: "보안 암호 권한 (secretsmanager:GetSecretValue)", status: "fail", detail: `실행 역할 ${role.name}에 보안 암호 ${secret.name}의 secretsmanager:GetSecretValue 권한이 없습니다. 이 보안 암호의 ARN만 허용하는 정책을 연결하세요 (최소 권한).`, field: "roleId" });
        return result(
          "error",
          "AccessDeniedException",
          `User: arn:aws:sts::${SANDBOX_ACCOUNT_ID}:assumed-role/${role.name}/${fn.name || fn.id} is not authorized to perform: secretsmanager:GetSecretValue on resource: ${arn} because no identity-based policy allows the secretsmanager:GetSecretValue action`,
          Math.min(c.virtualDurationMs, timeoutMs),
          canWriteLogs,
        );
      }
      if (isPendingDeletion(secret)) {
        checks.push({ title: "보안 암호 상태", status: "fail", detail: `보안 암호 ${secret.name}은(는) 삭제가 예약되어 값을 읽을 수 없습니다. 복구 기간 안에 삭제를 취소하세요.`, field: "templateTarget" });
        return result("error", "InvalidRequestException", "You can't perform this operation on the secret because it was marked for deletion.", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      checks.push({ title: "보안 암호 권한 (secretsmanager:GetSecretValue)", status: "pass", detail: `보안 암호 ${secret.name}의 값을 읽을 수 있습니다 (값은 응답·로그에 남기지 않음).`, field: "roleId" });
      response = JSON.stringify({ ok: true, keys: secret.kind === "rds" ? ["username", "password", "engine", "host", "port", "dbInstanceIdentifier"] : secret.keys });
      break;
    }
    case "ssm-get": {
      const name = c.templateTarget.trim();
      const param = findParameterByName(project, name);
      if (!param) {
        checks.push({ title: "파라미터", status: "fail", detail: name ? `파라미터 ${name}이(가) 없습니다.` : "읽을 파라미터 이름을 입력하세요.", field: "templateTarget" });
        return result("error", "ParameterNotFound", "An error occurred (ParameterNotFound) when calling the GetParameter operation", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
      }
      const net = needInternet("Systems Manager 엔드포인트");
      if (net) return net;
      const arn = parameterArn(param.name);
      if (!allowed(project, role, "ssm:GetParameter", arn)) {
        checks.push({ title: "파라미터 권한 (ssm:GetParameter)", status: "fail", detail: `실행 역할 ${role.name}에 파라미터 ${param.name}의 ssm:GetParameter 권한이 없습니다. 이 파라미터(또는 경로)의 ARN만 허용하는 정책을 연결하세요.`, field: "roleId" });
        return result(
          "error",
          "AccessDeniedException",
          `User: arn:aws:sts::${SANDBOX_ACCOUNT_ID}:assumed-role/${role.name}/${fn.name || fn.id} is not authorized to perform: ssm:GetParameter on resource: ${arn} because no identity-based policy allows the ssm:GetParameter action`,
          Math.min(c.virtualDurationMs, timeoutMs),
          canWriteLogs,
        );
      }
      checks.push({ title: "파라미터 권한 (ssm:GetParameter)", status: "pass", detail: `파라미터 ${param.name} (${param.type}, 버전 ${param.version})을 읽을 수 있습니다.`, field: "roleId" });
      response = JSON.stringify({ name: param.name, type: param.type, version: param.version });
      break;
    }
    case "throw-error":
      checks.push({ title: "코드", status: "fail", detail: "코드가 오류를 던졌습니다 (오류 발생 템플릿).", field: "codeTemplate" });
      return result("error", "Error", "의도한 오류", Math.min(c.virtualDurationMs, timeoutMs), canWriteLogs);
  }

  // 5. 제한 시간
  if (c.virtualDurationMs > timeoutMs) {
    checks.push({ title: "제한 시간", status: "fail", detail: `가상 실행 시간 ${c.virtualDurationMs}ms가 제한 시간 ${c.timeoutSeconds}초보다 길어 중단됩니다.`, field: "timeoutSeconds" });
    return result("timeout", "Task timed out", `Task timed out after ${c.timeoutSeconds.toFixed(2)} seconds`, timeoutMs, canWriteLogs);
  }
  checks.push({ title: "제한 시간", status: "pass", detail: `${c.virtualDurationMs}ms 만에 끝나 제한 시간 ${c.timeoutSeconds}초 안입니다.`, field: "timeoutSeconds" });
  return result("success", null, null, c.virtualDurationMs, canWriteLogs, response);
}

export interface InvokeResult extends InvokeAnalysis {
  requestId: string;
  billedMs: number;
  memoryUsedMb: number;
  logs: string[];
}

/** 테스트 호출: 판정에 가상 응답과 CloudWatch Logs 형식의 로그를 붙인다 */
export function invokeLambda(project: Project, topo: Topology, fn: LambdaFn, eventText = "{}"): InvokeResult {
  const a = analyzeInvocation(project, topo, fn);
  const h = hash32(`${fn.id}:${eventText}`);
  const requestId = `${(h >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${(hash32(fn.id) >>> 0).toString(16).padStart(12, "0")}`;
  const billedMs = Math.max(1, Math.ceil(a.durationMs));
  const memoryUsedMb = Math.min(fn.config.memoryMb, 58 + (h % 24));
  const response = a.outcome === "success" ? a.response : a.errorType ? JSON.stringify({ errorType: a.errorType, errorMessage: a.errorMessage }) : null;
  const logs: string[] = [];
  if (a.outcome !== "invalid" && a.outcome !== "throttled") {
    logs.push(`START RequestId: ${requestId} Version: $LATEST`);
    if (fn.config.codeTemplate === "hello") logs.push(`INFO 받은 이벤트: ${eventText.replace(/\s+/g, " ").slice(0, 200)}`);
    if (a.outcome === "error") logs.push(`ERROR Invoke Error ${JSON.stringify({ errorType: a.errorType, errorMessage: a.errorMessage })}`);
    if (a.outcome === "timeout") logs.push(`Task timed out after ${fn.config.timeoutSeconds.toFixed(2)} seconds`);
    logs.push(`END RequestId: ${requestId}`);
    logs.push(`REPORT RequestId: ${requestId} Duration: ${a.durationMs.toFixed(2)} ms Billed Duration: ${billedMs} ms Memory Size: ${fn.config.memoryMb} MB Max Memory Used: ${memoryUsedMb} MB`);
  }
  return { ...a, requestId, billedMs, memoryUsedMb, response, logs };
}

// ---------------------------------------------------------------- 트리거 (EventBridge)

export interface TriggerStatus {
  ok: boolean;
  reason: string;
}

/** Scheduler 일정이 대상 함수를 호출할 수 있는지: 실행 역할이 scheduler.amazonaws.com을 신뢰하고 lambda:InvokeFunction을 허용해야 한다 */
export function scheduleCanInvoke(project: Project, schedule: Schedule, fn: LambdaFn | undefined): TriggerStatus {
  if (!fn) return { ok: false, reason: "대상 Lambda 함수가 없습니다 (삭제되었을 수 있습니다)." };
  const role = project.services.iam.roles.find((r) => r.id === schedule.roleId);
  if (!role) return { ok: false, reason: "일정의 실행 역할이 없습니다. Scheduler는 이 역할로 대상을 호출합니다." };
  if (role.trustedEntity !== "scheduler.amazonaws.com") return { ok: false, reason: `역할 ${role.name}이(가) scheduler.amazonaws.com을 신뢰하지 않아 Scheduler가 이 역할을 맡을 수 없습니다.` };
  if (!allowed(project, role, "lambda:InvokeFunction", lambdaArn(fn.name || fn.id))) {
    return { ok: false, reason: `역할 ${role.name}에 함수 ${fn.name || fn.id}에 대한 lambda:InvokeFunction 권한이 없습니다.` };
  }
  return { ok: true, reason: `역할 ${role.name}로 함수를 호출합니다.` };
}

/** EventBridge 규칙이 대상 함수를 호출할 수 있는지: 함수의 리소스 기반 정책이 events.amazonaws.com을 허용해야 한다 */
export function ruleCanInvoke(rule: EventRule, fn: LambdaFn | undefined): TriggerStatus {
  if (!fn) return { ok: false, reason: "대상 Lambda 함수가 없습니다 (삭제되었을 수 있습니다)." };
  const arn = ruleArn(rule.name);
  const permitted = fn.config.permissions.some((p) => p.principal === "events.amazonaws.com" && (!p.sourceArn || p.sourceArn === arn));
  return permitted
    ? { ok: true, reason: "함수의 리소스 기반 정책이 이 규칙(events.amazonaws.com)의 호출을 허용합니다." }
    : { ok: false, reason: `함수 ${fn.name || fn.id}의 리소스 기반 정책에 이 규칙(events.amazonaws.com)의 호출 허용이 없습니다. 콘솔에서 대상을 추가하면 자동으로 들어갑니다.` };
}

export interface ScheduleRun {
  schedule: Schedule;
  parsed: ParsedSchedule;
  anchor: number;
}

/** 이 함수를 호출하는(활성·호출 가능) 일정 */
export function deliverableSchedules(project: Project, fn: LambdaFn): ScheduleRun[] {
  return project.services.eventbridge.schedules.flatMap((s) => {
    if (s.targetLambdaId !== fn.id || s.state !== "ENABLED") return [];
    const parsed = parseScheduleExpression(s.expression);
    if (!parsed.ok || !scheduleCanInvoke(project, s, fn).ok) return [];
    return [{ schedule: s, parsed: parsed.value, anchor: Date.parse(s.createdAt) }];
  });
}

/** 이 분(1970년부터의 분)에 일정이 함수를 호출하는 횟수 */
export function scheduledInvocationsInMinute(runs: ScheduleRun[], minute: number): number {
  return runs.reduce((n, r) => n + runsInMinute(r.parsed, r.schedule.timezone, r.anchor, minute), 0);
}

/** 앞으로 한 달(730시간) 동안 일정이 함수를 호출하는 횟수 (가상 비용 계산용) */
export function monthlyScheduledInvocations(project: Project, fn: LambdaFn, now = Date.now(), hours = 730): number {
  return deliverableSchedules(project, fn).reduce((n, r) => n + countRuns(r.parsed, r.schedule.timezone, r.anchor, now, now + hours * 3_600_000), 0);
}
