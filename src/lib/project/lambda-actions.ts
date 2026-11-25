/**
 * Lambda 콘솔 동작 (함수 만들기, 설정·코드·VPC·동시성·호출 권한 변경).
 * 실제 코드는 올리거나 실행하지 않는다. AWS가 거부하는 입력(신뢰 정책이 맞지 않는 역할, VPC 권한이 없는 역할 등)은
 * 같은 이유와 AWS 오류 코드로 거부한다. 함수 삭제는 console-actions의 deleteFunction이 맡는다.
 */
import { evaluateIam } from "@/lib/engine/iam-engine";
import { createId } from "@/lib/engine/ids";
import { validateFunctionName } from "@/lib/engine/lambda-engine";
import { LAMBDA_PERMISSION_PRINCIPALS, type ConfigOf, type LambdaCodeTemplate, type Project, type ResourceOfType } from "@/lib/engine/resource-models";
import { buildTopology } from "@/lib/engine/topology-engine";
import { addConnections, addResource, awsFail, link, removeConnections, updateConfig, type ActionResult } from "./console-actions";
import { createRole } from "./iam-actions";
import { touch } from "./mutations";

type LambdaConfig = ConfigOf<"lambda">;
type LambdaFn = ResourceOfType<"lambda">;

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

/** AWS 콘솔이 런타임마다 미리 채우는 핸들러 */
export function defaultHandler(runtime: LambdaConfig["runtime"]): string {
  if (runtime.startsWith("python")) return "lambda_function.lambda_handler";
  if (runtime.startsWith("java")) return "example.Hello::handleRequest";
  return "index.handler";
}

function findFunction(project: Project, id: string): LambdaFn | undefined {
  const r = project.resources.find((x) => x.id === id);
  return r?.type === "lambda" ? r : undefined;
}

const notFound = (id: string) => awsFail("ResourceNotFoundException", `Function not found: ${id}`, "함수를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.");

// ---------------------------------------------------------------- 검사

function checkSizing(memoryMb: number, timeoutSeconds: number): ActionResult | null {
  if (!Number.isInteger(memoryMb) || memoryMb < 128 || memoryMb > 10240) return awsFail("InvalidParameterValueException", "메모리는 128~10,240MB 사이의 정수(MB)여야 합니다.");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) return awsFail("InvalidParameterValueException", "제한 시간은 1~900초 사이의 정수여야 합니다.");
  return null;
}

/** 실행 역할: lambda.amazonaws.com을 신뢰해야 하고, VPC에 연결하면 네트워크 인터페이스를 만들 권한이 있어야 한다 (AWS가 만들 때 확인) */
function checkExecutionRole(project: Project, roleId: string | null, vpc: boolean): ActionResult | null {
  if (!roleId) return awsFail("InvalidParameterValueException", "실행 역할을 선택하세요. Lambda 함수에는 실행 역할이 꼭 필요합니다.");
  const role = project.services.iam.roles.find((r) => r.id === roleId);
  if (!role) return awsFail("InvalidParameterValueException", `역할 ${roleId}을(를) 찾을 수 없습니다.`);
  if (role.trustedEntity !== "lambda.amazonaws.com") {
    return awsFail(
      "InvalidParameterValueException",
      "The role defined for the function cannot be assumed by Lambda.",
      `역할 ${role.name}의 신뢰 정책이 lambda.amazonaws.com을 허용하지 않습니다. 'AWS 서비스 - Lambda'로 만든 역할을 고르세요.`,
    );
  }
  if (vpc && evaluateIam(project, { kind: "role", role }, "ec2:CreateNetworkInterface", "*").decision !== "allowed") {
    return awsFail(
      "InvalidParameterValueException",
      "The provided execution role does not have permissions to call CreateNetworkInterface on EC2",
      `VPC에 연결하려면 역할 ${role.name}에 AWSLambdaVPCAccessExecutionRole(네트워크 인터페이스 관리 권한)을 연결하세요.`,
    );
  }
  return null;
}

function checkVpcConfig(project: Project, subnetIds: string[], securityGroupIds: string[]): ActionResult | null {
  if (!subnetIds.length) {
    return securityGroupIds.length ? awsFail("InvalidParameterValueException", "보안 그룹만 지정할 수는 없습니다. VPC에 연결하려면 서브넷도 고르세요.") : null;
  }
  if (subnetIds.length > 16) return awsFail("InvalidParameterValueException", "서브넷은 최대 16개까지 고를 수 있습니다.");
  if (!securityGroupIds.length) return awsFail("InvalidParameterValueException", "VPC에 연결하려면 보안 그룹을 하나 이상 고르세요.");
  if (securityGroupIds.length > 5) return awsFail("InvalidParameterValueException", "보안 그룹은 최대 5개까지 고를 수 있습니다.");
  const topo = buildTopology(project);
  const vpcIds = new Set<string | null>();
  for (const id of subnetIds) {
    if (!topo.getOfType(id, "subnet")) return awsFail("InvalidParameterValueException", `서브넷 ${id}을(를) 찾을 수 없습니다.`);
    vpcIds.add(topo.vpcOfSubnet(id));
  }
  if (vpcIds.size > 1) return awsFail("InvalidParameterValueException", "서브넷은 모두 같은 VPC에 있어야 합니다.");
  const vpcId = [...vpcIds][0];
  if (!vpcId) return awsFail("InvalidParameterValueException", "서브넷이 VPC에 속해 있지 않습니다.");
  for (const id of securityGroupIds) {
    if (!topo.getOfType(id, "security-group")) return awsFail("InvalidParameterValueException", `보안 그룹 ${id}을(를) 찾을 수 없습니다.`);
    if (topo.vpcOf(id) !== vpcId) return awsFail("InvalidParameterValueException", `보안 그룹 ${topo.name(id)}은(는) 서브넷과 다른 VPC에 있습니다.`);
  }
  return null;
}

const ENV_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Lambda가 예약한 환경 변수 (설정할 수 없음) */
const RESERVED_ENV = new Set([
  "_HANDLER",
  "_X_AMZN_TRACE_ID",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_LAMBDA_RUNTIME_API",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
]);
/** 비밀 값으로 보이는 키·값. 이 시뮬레이터는 비밀을 저장하지 않는다 (Secrets Manager·Parameter Store의 ARN 참조는 허용) */
const SECRET_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_?KEY|ACCESS_?KEY|API_?KEY|CREDENTIAL)/i;
const SECRET_VALUE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SECRET_REFERENCE = /^arn:aws:(secretsmanager|ssm):/;

/** 환경 변수 검사. 문제가 없으면 null */
export function validateEnvironment(env: { key: string; value: string }[]): string | null {
  if (env.length > 50) return "환경 변수는 이 시뮬레이터에서 최대 50개까지 넣을 수 있습니다.";
  const seen = new Set<string>();
  let size = 0;
  for (const { key, value } of env) {
    if (!ENV_KEY.test(key)) return `환경 변수 키 '${key}'이(가) 올바르지 않습니다. 영문자로 시작하고 영문·숫자·밑줄(_)만 쓸 수 있습니다.`;
    if (RESERVED_ENV.has(key)) return `'${key}'은(는) Lambda가 예약한 환경 변수라 설정할 수 없습니다.`;
    if (seen.has(key)) return `환경 변수 키 '${key}'이(가) 중복됩니다.`;
    seen.add(key);
    if ((SECRET_KEY.test(key) && !SECRET_REFERENCE.test(value.trim())) || SECRET_VALUE.test(value)) {
      return `'${key}'에 비밀 값(암호·토큰·키)을 넣지 마세요. 이 시뮬레이터는 비밀 값을 저장하지 않습니다. 실제 AWS에서도 Secrets Manager·Parameter Store에 두고 ARN만 환경 변수로 넘기는 것이 권장됩니다.`;
    }
    size += key.length + value.length;
  }
  if (size > 4096) return "환경 변수의 전체 크기는 4KB를 넘을 수 없습니다.";
  return null;
}

function checkCode(input: { virtualDurationMs: number; errorRatePercent: number; templateTarget: string }): ActionResult | null {
  if (!Number.isInteger(input.virtualDurationMs) || input.virtualDurationMs < 1 || input.virtualDurationMs > 900_000) {
    return awsFail("InvalidParameterValueException", "가상 실행 시간은 1~900,000ms 사이의 정수여야 합니다.");
  }
  if (!Number.isFinite(input.errorRatePercent) || input.errorRatePercent < 0 || input.errorRatePercent > 100) {
    return awsFail("InvalidParameterValueException", "가상 오류 비율은 0~100% 사이여야 합니다.");
  }
  if (input.templateTarget.length > 512) return awsFail("InvalidParameterValueException", "템플릿 대상은 512자 이하여야 합니다.");
  return null;
}

// ---------------------------------------------------------------- 만들기

export interface CreateFunctionInput {
  name: string;
  runtime: LambdaConfig["runtime"];
  architecture: LambdaConfig["architecture"];
  memoryMb?: number;
  timeoutSeconds?: number;
  /** 기존 실행 역할 (createRole이면 무시) */
  roleId: string | null;
  /** AWS 콘솔의 '기본 Lambda 권한을 가진 새 역할 생성' */
  createRole?: boolean;
  codeTemplate?: LambdaCodeTemplate;
  templateTarget?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
}

export function createFunction(project: Project, input: CreateFunctionInput): ActionResult {
  const name = input.name.trim();
  const nameError = validateFunctionName(name);
  if (nameError) return awsFail("InvalidParameterValueException", nameError);
  if (project.resources.some((r) => r.type === "lambda" && r.name === name)) {
    return awsFail("ResourceConflictException", `Function already exist: ${name}`, "같은 이름의 함수가 이미 있습니다. 함수 이름은 리전 안에서 고유해야 합니다.");
  }
  const memoryMb = input.memoryMb ?? 128;
  const timeoutSeconds = input.timeoutSeconds ?? 3;
  const sizing = checkSizing(memoryMb, timeoutSeconds);
  if (sizing) return sizing;
  const subnetIds = [...new Set(input.subnetIds ?? [])];
  const securityGroupIds = [...new Set(input.securityGroupIds ?? [])];
  const vpcError = checkVpcConfig(project, subnetIds, securityGroupIds);
  if (vpcError) return vpcError;

  let p = project;
  const notes: string[] = [];
  let roleId = input.roleId;
  if (input.createRole) {
    const roleName = `${name}-role-${createId("r").split("-").pop()}`.slice(0, 64);
    const policyIds = ["aws:AWSLambdaBasicExecutionRole", ...(subnetIds.length ? ["aws:AWSLambdaVPCAccessExecutionRole"] : [])];
    const r = createRole(p, { name: roleName, description: `Lambda 함수 ${name}의 실행 역할 (콘솔에서 자동 생성)`, trustedEntity: "lambda.amazonaws.com", policyIds });
    if (!r.ok) return r;
    p = r.project;
    roleId = r.createdId ?? null;
    notes.push(`실행 역할 ${roleName}을(를) 만들었습니다: CloudWatch Logs 쓰기${subnetIds.length ? "와 VPC 네트워크 인터페이스 관리" : ""} 권한만 있습니다. 다른 서비스(S3 등)를 쓰려면 권한을 더 연결하세요.`);
  }
  const roleError = checkExecutionRole(p, roleId, subnetIds.length > 0);
  if (roleError) return roleError;

  const added = addResource(
    p,
    "lambda",
    name,
    {
      runtime: input.runtime,
      handler: defaultHandler(input.runtime),
      architecture: input.architecture,
      memoryMb,
      timeoutSeconds,
      roleId,
      codeTemplate: input.codeTemplate ?? "hello",
      templateTarget: input.templateTarget?.trim() ?? "",
      virtualDurationMs: 120,
      errorRatePercent: 0,
      environment: [],
      reservedConcurrency: null,
      permissions: [],
    },
    subnetIds[0] ?? null,
  );
  p = addConnections(added.project, [
    ...subnetIds.map((id) => link("lambda-subnet", added.resource.id, id)),
    ...securityGroupIds.map((id) => link("lambda-security-group", added.resource.id, id)),
  ]);
  notes.push(
    subnetIds.length
      ? "함수를 VPC에 연결했습니다. 퍼블릭 IP를 받지 않으므로 인터넷·AWS 퍼블릭 API에 닿으려면 서브넷에 NAT 경로가 필요합니다."
      : "함수는 VPC 밖(AWS가 관리하는 네트워크)에서 실행됩니다. 코드는 실행되지 않고, 테스트 탭에서 호출 결과를 계산해 볼 수 있습니다.",
  );
  return ok(touch(p), notes, added.resource.id);
}

/** 기존 함수에 기본 실행 역할을 만들어 연결한다 (로그 쓰기, VPC에 연결되어 있으면 네트워크 인터페이스 권한 추가) */
export function createExecutionRoleFor(project: Project, functionId: string): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  const vpc = buildTopology(project).lambdaSubnets(fn.id).length > 0;
  const name = fn.name || fn.id;
  const roleName = `${name}-role-${createId("r").split("-").pop()}`.slice(0, 64);
  const r = createRole(project, {
    name: roleName,
    description: `Lambda 함수 ${name}의 실행 역할`,
    trustedEntity: "lambda.amazonaws.com",
    policyIds: ["aws:AWSLambdaBasicExecutionRole", ...(vpc ? ["aws:AWSLambdaVPCAccessExecutionRole"] : [])],
  });
  if (!r.ok) return r;
  return ok(touch(updateConfig<"lambda">(r.project, fn.id, { roleId: r.createdId ?? null })), [`실행 역할 ${roleName}을(를) 만들어 연결했습니다 (로그 쓰기${vpc ? " + VPC 네트워크 인터페이스" : ""} 권한).`], r.createdId);
}

// ---------------------------------------------------------------- 변경

export type FunctionConfigurationPatch = Partial<Pick<LambdaConfig, "runtime" | "handler" | "architecture" | "memoryMb" | "timeoutSeconds" | "roleId" | "environment">>;

/** UpdateFunctionConfiguration: 일반 설정·실행 역할·환경 변수 */
export function updateFunctionConfiguration(project: Project, functionId: string, patch: FunctionConfigurationPatch): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  const next = { ...fn.config, ...patch };
  const sizing = checkSizing(next.memoryMb, next.timeoutSeconds);
  if (sizing) return sizing;
  const handler = next.handler.trim();
  if (!handler || handler.length > 128) return awsFail("InvalidParameterValueException", "핸들러는 1~128자여야 합니다.");
  if (patch.roleId !== undefined && patch.roleId !== fn.config.roleId) {
    const roleError = checkExecutionRole(project, patch.roleId, buildTopology(project).lambdaSubnets(fn.id).length > 0);
    if (roleError) return roleError;
  }
  const env = (patch.environment ?? fn.config.environment).map((e) => ({ key: e.key.trim(), value: e.value }));
  const envError = validateEnvironment(env);
  if (envError) return awsFail("InvalidParameterValueException", envError);
  return ok(touch(updateConfig<"lambda">(project, fn.id, { ...patch, handler, environment: env })));
}

export type FunctionCodePatch = Partial<Pick<LambdaConfig, "codeTemplate" | "templateTarget" | "virtualDurationMs" | "errorRatePercent">>;

/** UpdateFunctionCode에 해당: 가상 코드 템플릿과 가상 실행 값 */
export function updateFunctionCode(project: Project, functionId: string, patch: FunctionCodePatch): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  const next = { ...fn.config, ...patch, templateTarget: (patch.templateTarget ?? fn.config.templateTarget).trim() };
  const codeError = checkCode(next);
  if (codeError) return codeError;
  return ok(touch(updateConfig<"lambda">(project, fn.id, { ...patch, templateTarget: next.templateTarget })), ["새 코드를 배포했습니다 (가상). 다음 호출부터 적용됩니다."]);
}

/** VPC 연결 (서브넷·보안 그룹). 둘 다 비우면 VPC 연결을 해제한다 */
export function setFunctionVpc(project: Project, functionId: string, input: { subnetIds: string[]; securityGroupIds: string[] }): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  const subnetIds = [...new Set(input.subnetIds)];
  const securityGroupIds = [...new Set(input.securityGroupIds)];
  const vpcError = checkVpcConfig(project, subnetIds, securityGroupIds);
  if (vpcError) return vpcError;
  if (subnetIds.length) {
    const roleError = checkExecutionRole(project, fn.config.roleId, true);
    if (roleError) return roleError;
  }
  const wasAttached = buildTopology(project).lambdaSubnets(fn.id).length > 0;
  let p = removeConnections(project, (c) => c.sourceResourceId === fn.id && (c.relationType === "lambda-subnet" || c.relationType === "lambda-security-group"));
  p = addConnections(p, [
    ...subnetIds.map((id) => link("lambda-subnet", fn.id, id)),
    ...securityGroupIds.map((id) => link("lambda-security-group", fn.id, id)),
  ]);
  const notes = subnetIds.length
    ? ["VPC 연결을 저장했습니다. 이 서브넷에서 인터넷에 나가려면 NAT 경로가 필요합니다 (퍼블릭 IP 없음)."]
    : wasAttached
      ? ["VPC 연결을 해제했습니다. 이제 VPC 안의 프라이빗 리소스(RDS 등)에는 닿지 않습니다."]
      : [];
  return ok(touch(p), notes);
}

/** 예약 동시성: null이면 해제(DeleteFunctionConcurrency), 0이면 모든 호출 제한 */
export function setReservedConcurrency(project: Project, functionId: string, value: number | null): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000)) return awsFail("InvalidParameterValueException", "예약 동시성은 0~1000 사이의 정수여야 합니다.");
  const notes = value === 0 ? ["예약 동시성이 0이라 모든 호출이 제한(throttle)됩니다. 함수를 잠시 멈출 때 쓰는 설정입니다."] : [];
  return ok(touch(updateConfig<"lambda">(project, fn.id, { reservedConcurrency: value })), notes);
}

const SID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** lambda:AddPermission: 리소스 기반 정책에 호출 허용 추가 */
export function addFunctionPermission(project: Project, functionId: string, input: { sid: string; principal: LambdaConfig["permissions"][number]["principal"]; sourceArn: string }): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  const sid = input.sid.trim();
  if (!SID_PATTERN.test(sid)) return awsFail("InvalidParameterValueException", "문 ID(Statement ID)는 1~100자의 영문·숫자·하이픈·밑줄이어야 합니다.");
  if (fn.config.permissions.some((p) => p.sid === sid)) return awsFail("ResourceConflictException", `The statement id (${sid}) provided already exists. Please provide a new statement id, or remove the existing statement.`);
  if (!(LAMBDA_PERMISSION_PRINCIPALS as readonly string[]).includes(input.principal)) return awsFail("InvalidParameterValueException", "지원하지 않는 주체입니다.");
  const sourceArn = input.sourceArn.trim();
  if (sourceArn && !sourceArn.startsWith("arn:aws:")) return awsFail("InvalidParameterValueException", "소스 ARN은 arn:aws:로 시작해야 합니다.");
  const notes = sourceArn ? [] : [`소스 ARN이 없어 ${input.principal}의 모든 리소스가 이 함수를 호출할 수 있습니다. 특정 규칙·버킷의 ARN을 지정하는 것이 안전합니다.`];
  return ok(touch(updateConfig<"lambda">(project, fn.id, { permissions: [...fn.config.permissions, { sid, principal: input.principal, sourceArn }] })), notes);
}

/** lambda:RemovePermission */
export function removeFunctionPermission(project: Project, functionId: string, sid: string): ActionResult {
  const fn = findFunction(project, functionId);
  if (!fn) return notFound(functionId);
  if (!fn.config.permissions.some((p) => p.sid === sid)) return awsFail("ResourceNotFoundException", `문 ID ${sid}을(를) 찾을 수 없습니다.`);
  return ok(touch(updateConfig<"lambda">(project, fn.id, { permissions: fn.config.permissions.filter((p) => p.sid !== sid) })));
}
