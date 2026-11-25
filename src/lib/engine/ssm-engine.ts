/**
 * 가상 Systems Manager.
 * - Parameter Store: 이름 규칙, ARN, 계층 조회, SecureString의 가상 값
 * - 관리형 노드: EC2 인스턴스가 Systems Manager에 등록될 조건(SSM Agent, 인스턴스 프로파일, 엔드포인트로 나가는 길)을 설정으로 판정
 * - Session Manager: 세션을 열 수 있는지와, 정해진 몇 가지 명령의 가상 출력
 *
 * 실제 에이전트·셸·명령은 실행하지 않는다. 모든 결과는 샌드박스 설정으로 계산한 값이다.
 */
import { formatIpv4 } from "./cidr-utils";
import { simulateWithTopology } from "./connectivity-engine";
import { evaluateIam, roleArn, SANDBOX_ACCOUNT_ID } from "./iam-engine";
import { actingIdentity, actingLabel, actingPrincipal } from "./iam-session";
import { VIRTUAL_REGION, type IamRole, type Project, type ResourceOfType, type SsmParameter } from "./resource-models";
import { virtualValue } from "./secrets-engine";
import { displayName, type Topology } from "./topology-engine";

export const SSM_ENDPOINT_HOST = `ssm.${VIRTUAL_REGION}.amazonaws.com`;
/** AWS 서비스 퍼블릭 엔드포인트를 대표하는 문서용 주소 (실제 주소 아님) */
const ENDPOINT_IP = "192.0.2.90";

type Ec2 = ResourceOfType<"ec2">;

// ---------------------------------------------------------------- Parameter Store

/** /app/db → arn:…:parameter/app/db, dbhost → arn:…:parameter/dbhost */
export const parameterArn = (name: string) => `arn:aws:ssm:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:parameter/${name.replace(/^\//, "")}`;

export const PARAMETER_VALUE_LIMIT = { Standard: 4096, Advanced: 8192 } as const;

export function validateParameterName(name: string): string | null {
  if (!name) return "파라미터 이름을 입력하세요.";
  if (name.length > 1011) return "파라미터 이름은 1,011자 이하여야 합니다.";
  if (!/^[A-Za-z0-9_.\-/]+$/.test(name)) return "파라미터 이름에는 영문자, 숫자, 그리고 _ . - / 문자만 쓸 수 있습니다.";
  if (name.includes("/")) {
    if (!name.startsWith("/")) return "계층(/)을 쓰는 이름은 /로 시작해야 합니다. 예: /app/prod/db-host";
    if (name.endsWith("/") || name.includes("//")) return "이름이 /로 끝나거나 //를 포함할 수 없습니다.";
    if (name.split("/").length - 1 > 15) return "계층은 최대 15단계까지 만들 수 있습니다.";
  }
  if (/^\/?(aws|ssm)/i.test(name)) return "파라미터 이름은 aws 또는 ssm으로 시작할 수 없습니다 (AWS가 예약한 접두사).";
  return null;
}

export function validateParameterValue(type: SsmParameter["type"], tier: SsmParameter["tier"], value: string): string | null {
  if (!value) return "값을 입력하세요.";
  const limit = PARAMETER_VALUE_LIMIT[tier];
  if (value.length > limit) return `${tier === "Standard" ? "표준" : "고급"} 파라미터의 값은 ${limit.toLocaleString("ko-KR")}자(${limit / 1024}KB) 이하여야 합니다.${tier === "Standard" ? " 더 긴 값은 고급(Advanced) 계층을 쓰세요." : ""}`;
  if (type === "StringList" && value.split(",").some((v) => !v.trim())) return "StringList는 쉼표로 구분한 값 목록입니다. 빈 항목이 있습니다. 예: subnet-a,subnet-b";
  return null;
}

export function findParameterByName(project: Project, name: string): SsmParameter | undefined {
  const text = name.trim();
  if (!text) return undefined;
  return project.services.ssm.parameters.find((p) => p.name === text || parameterArn(p.name) === text);
}

/** SecureString의 연습용 가상 값 (이름·버전으로 계산, 저장하지 않음) */
export const virtualParameterValue = (param: Pick<SsmParameter, "id">, version: number) => virtualValue(`${param.id}:v${version}`);

/** 화면·API 응답에 보일 값. SecureString은 복호화하지 않으면 가려진 값으로 나온다 */
export function parameterValue(param: SsmParameter, withDecryption: boolean): string {
  if (param.type !== "SecureString") return param.value ?? "";
  return withDecryption ? virtualParameterValue(param, param.version) : "AQICAHh…(암호화된 값)";
}

/** GetParametersByPath: 경로 아래의 파라미터. recursive가 아니면 바로 아래 단계만 */
export function parametersByPath(parameters: SsmParameter[], path: string, recursive: boolean): SsmParameter[] {
  const base = path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
  return parameters
    .filter((p) => {
      if (!p.name.startsWith(base)) return false;
      return recursive || !p.name.slice(base.length).includes("/");
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 계층 탐색용: 경로 바로 아래의 하위 경로(폴더) 이름 */
export function childPaths(parameters: SsmParameter[], path: string): string[] {
  const base = path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
  const out = new Set<string>();
  for (const p of parameters) {
    if (!p.name.startsWith(base)) continue;
    const rest = p.name.slice(base.length);
    const i = rest.indexOf("/");
    if (i > 0) out.add(`${base}${rest.slice(0, i)}`);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- 관리형 노드

export interface NodeCheck {
  id: "state" | "agent" | "profile" | "network" | "inbound";
  title: string;
  status: "pass" | "fail" | "info";
  detail: string;
  fix?: string;
  link?: { label: string; path: string };
}

export interface ManagedNodeStatus {
  /** Systems Manager에 등록되어 세션·명령을 받을 수 있는 상태인지 */
  managed: boolean;
  checks: NodeCheck[];
  role: IamRole | null;
}

/** 인스턴스가 Systems Manager와 통신하려면 인스턴스 프로파일 역할에 필요한 권한 (AmazonSSMManagedInstanceCore의 핵심) */
export const SSM_AGENT_ACTIONS = [
  "ssm:UpdateInstanceInformation",
  "ssmmessages:CreateControlChannel",
  "ssmmessages:CreateDataChannel",
  "ssmmessages:OpenControlChannel",
  "ssmmessages:OpenDataChannel",
] as const;

const AMI_AGENT: Record<Ec2["config"]["ami"], string> = {
  "amazon-linux-2023": "Amazon Linux 2023 AMI에는 SSM Agent가 미리 설치되어 있습니다.",
  "ubuntu-24.04": "Ubuntu Server AMI에는 SSM Agent가 미리 설치되어 있습니다 (snap 패키지).",
  "windows-server-2022": "Windows Server 2022 AMI에는 SSM Agent가 미리 설치되어 있습니다.",
};

/**
 * EC2 인스턴스가 Systems Manager의 관리형 노드가 되는 조건을 판정한다.
 * 조건: 실행 중 + SSM Agent + 인스턴스 프로파일 권한 + Systems Manager 엔드포인트(HTTPS 443)로 나가는 길.
 * 인바운드 포트는 필요 없다 (에이전트가 밖으로 연결을 맺고 그 연결로 세션을 받는다).
 */
export function managedNodeStatus(project: Project, topo: Topology, inst: Ec2): ManagedNodeStatus {
  const checks: NodeCheck[] = [];
  const name = displayName(inst);
  const running = inst.config.state === "running";
  checks.push(
    running
      ? { id: "state", title: "인스턴스 상태", status: "pass", detail: "실행 중(Running)입니다." }
      : { id: "state", title: "인스턴스 상태", status: "fail", detail: `${inst.config.state} 상태입니다. 실행 중인 인스턴스만 Systems Manager와 통신합니다.`, fix: "인스턴스를 시작하세요.", link: { label: "인스턴스", path: `/ec2/instances/${inst.id}` } },
  );
  checks.push({ id: "agent", title: "SSM Agent", status: "pass", detail: `${AMI_AGENT[inst.config.ami]} (이 시뮬레이터는 에이전트를 실행하지 않고 AMI로 판단합니다)` });

  const role = project.services.iam.roles.find((r) => r.id === inst.config.iamRoleId) ?? null;
  if (!role) {
    checks.push({
      id: "profile",
      title: "인스턴스 프로파일 (IAM 역할)",
      status: "fail",
      detail: "인스턴스에 IAM 역할이 없어 SSM Agent가 Systems Manager에 자신을 등록할 수 없습니다.",
      fix: "ec2.amazonaws.com을 신뢰하고 AmazonSSMManagedInstanceCore 정책이 연결된 역할을 만들어 인스턴스에 연결하세요.",
      link: { label: "IAM 역할 수정", path: `/ec2/instances/${inst.id}/iam-role` },
    });
  } else {
    const missing = SSM_AGENT_ACTIONS.filter((a) => evaluateIam(project, { kind: "role", role }, a, "*").decision !== "allowed");
    if (role.trustedEntity !== "ec2.amazonaws.com") {
      checks.push({ id: "profile", title: "인스턴스 프로파일 (IAM 역할)", status: "fail", detail: `역할 ${role.name}의 신뢰 정책이 ec2.amazonaws.com을 허용하지 않습니다.`, fix: "'AWS 서비스 - EC2'로 만든 역할을 연결하세요.", link: { label: "IAM 역할 수정", path: `/ec2/instances/${inst.id}/iam-role` } });
    } else if (missing.length) {
      checks.push({
        id: "profile",
        title: "인스턴스 프로파일 (IAM 역할)",
        status: "fail",
        detail: `역할 ${role.name}에 Systems Manager와 통신하는 권한이 없습니다: ${missing.join(", ")}`,
        fix: "역할에 AmazonSSMManagedInstanceCore 관리형 정책을 연결하세요.",
        link: { label: `역할 ${role.name}`, path: `/iam/roles/${role.id}` },
      });
    } else {
      checks.push({ id: "profile", title: "인스턴스 프로파일 (IAM 역할)", status: "pass", detail: `역할 ${role.name}이(가) Systems Manager와 통신하는 권한(AmazonSSMManagedInstanceCore에 해당)을 허용합니다.` });
    }
  }

  if (running) {
    const net = simulateWithTopology(topo, { source: { kind: "resource", resourceId: inst.id }, destination: { kind: "internet", ip: ENDPOINT_IP }, protocol: "tcp", port: 443 });
    if (net.outcome === "success") {
      checks.push({ id: "network", title: `네트워크: ${name} → Systems Manager 엔드포인트(HTTPS 443)`, status: "pass", detail: "라우팅·보안 그룹·네트워크 ACL을 통과해 Systems Manager의 퍼블릭 엔드포인트로 나갈 수 있습니다." });
    } else {
      checks.push({
        id: "network",
        title: `네트워크: ${name} → Systems Manager 엔드포인트(HTTPS 443)`,
        status: "fail",
        detail: `${net.failure?.reason ?? net.summary} SSM Agent는 밖으로 HTTPS(443) 연결을 맺어야 합니다.`,
        fix: "퍼블릭 서브넷이면 퍼블릭 IP와 인터넷 게이트웨이 경로를, 프라이빗 서브넷이면 NAT 게이트웨이(또는 NAT 인스턴스) 경로를 준비하고, 보안 그룹 아웃바운드에 HTTPS(443)를 허용하세요. 실제 AWS에서는 VPC 인터페이스 엔드포인트(ssm, ssmmessages, ec2messages)로도 닿을 수 있지만 이 시뮬레이터는 지원하지 않습니다.",
        link: { label: "Reachability Analyzer에서 확인", path: "/vpc/reachability/create" },
      });
    }
  } else {
    checks.push({ id: "network", title: "네트워크: Systems Manager 엔드포인트(HTTPS 443)", status: "fail", detail: "인스턴스가 실행 중이 아니라 확인하지 않았습니다." });
  }
  checks.push({
    id: "inbound",
    title: "인바운드 규칙",
    status: "info",
    detail: "Session Manager는 인바운드 포트가 필요 없습니다. 에이전트가 밖으로 맺은 연결로 세션을 받으므로, SSH(22)를 열거나 배스천 호스트·키 페어를 둘 필요가 없습니다.",
  });
  return { managed: checks.every((c) => c.status !== "fail"), checks, role };
}

export const instanceArn = (id: string) => `arn:aws:ec2:${VIRTUAL_REGION}:${SANDBOX_ACCOUNT_ID}:instance/${id}`;

/** 지금 작업하는 자격 증명(가상 로그인)이 이 인스턴스에 세션을 열 수 있는지 (ssm:StartSession) */
export function startSessionPermission(project: Project, inst: Ec2): { ok: boolean; who: string; reason: string } {
  const identity = actingIdentity(project);
  const principal = actingPrincipal(identity);
  const who = actingLabel(identity);
  if (!principal) return { ok: true, who, reason: "루트 사용자는 모든 작업이 허용됩니다 (실제 운영에서는 루트 대신 IAM 사용자·역할을 쓰세요)." };
  const decision = evaluateIam(project, principal, "ssm:StartSession", instanceArn(inst.id));
  return decision.decision === "allowed"
    ? { ok: true, who, reason: `${who}에게 ssm:StartSession이 허용되어 있습니다.` }
    : { ok: false, who, reason: `${who}에게 ${instanceArn(inst.id)}에 대한 ssm:StartSession 권한이 없습니다. ${decision.explanation[decision.explanation.length - 1] ?? ""}` };
}

// ---------------------------------------------------------------- Session Manager의 가상 명령

export interface SessionCommand {
  id: string;
  /** 화면에 보일 명령 */
  command: string;
  /** 무엇을 확인하는 명령인지 */
  purpose: string;
}

export function sessionCommands(inst: Ec2): SessionCommand[] {
  const windows = inst.config.ami === "windows-server-2022";
  return [
    { id: "whoami", command: "whoami", purpose: "어떤 OS 사용자로 접속했는지" },
    { id: "hostname", command: windows ? "hostname" : "hostname -f", purpose: "인스턴스의 프라이빗 DNS 이름" },
    { id: "identity", command: "aws sts get-caller-identity", purpose: "서버 안의 AWS CLI가 어떤 자격 증명을 쓰는지 (인스턴스 프로파일)" },
    { id: "local-http", command: windows ? "curl.exe -s -o NUL -w \"%{http_code}\" http://localhost" : "curl -s -o /dev/null -w \"%{http_code}\" http://localhost", purpose: "이 서버의 웹 서비스(80)가 응답하는지" },
    { id: "internet", command: windows ? "curl.exe -sI https://aws.amazon.com" : "curl -sI https://aws.amazon.com | head -n 1", purpose: "이 서버에서 인터넷(HTTPS)으로 나갈 수 있는지" },
  ];
}

export interface SessionOutput {
  command: string;
  /** 가상 출력 (명령을 실제로 실행하지 않고 설정으로 계산) */
  lines: string[];
  ok: boolean;
  /** 왜 이런 출력인지 */
  why: string;
}

const privateIpOf = (topo: Topology, inst: Ec2) => {
  const ip = topo.enisOf(inst.id)[0]?.privateIp;
  return ip !== null && ip !== undefined ? formatIpv4(ip) : inst.config.privateIp;
};

/** 정해진 명령의 가상 출력 */
export function runSessionCommand(project: Project, topo: Topology, inst: Ec2, commandId: string): SessionOutput | null {
  const cmd = sessionCommands(inst).find((c) => c.id === commandId);
  if (!cmd) return null;
  const windows = inst.config.ami === "windows-server-2022";
  const ip = privateIpOf(topo, inst);
  switch (commandId) {
    case "whoami":
      return { command: cmd.command, lines: [windows ? `${inst.id.toUpperCase()}\\ssm-user` : "ssm-user"], ok: true, why: "Session Manager는 기본으로 ssm-user 계정으로 셸을 엽니다 (SSH 키로 로그인하는 ec2-user가 아님)." };
    case "hostname":
      return { command: cmd.command, lines: [`ip-${ip.replace(/\./g, "-")}.${VIRTUAL_REGION}.compute.internal`], ok: true, why: `프라이빗 IP ${ip}에서 만들어지는 프라이빗 DNS 이름입니다.` };
    case "identity": {
      const role = project.services.iam.roles.find((r) => r.id === inst.config.iamRoleId);
      if (!role) return { command: cmd.command, lines: ["Unable to locate credentials. You can configure credentials by running \"aws configure\"."], ok: false, why: "인스턴스에 IAM 역할이 없어 서버 안의 CLI가 쓸 자격 증명이 없습니다." };
      return {
        command: cmd.command,
        lines: ["{", `    "UserId": "AROAEXAMPLEID:${inst.id}",`, `    "Account": "${SANDBOX_ACCOUNT_ID}",`, `    "Arn": "${roleArn(role.name).replace(":iam::", ":sts::").replace(":role/", ":assumed-role/")}/${inst.id}"`, "}"],
        ok: true,
        why: `인스턴스 프로파일의 역할 ${role.name}을(를) 맡은 임시 자격 증명입니다. 서버에 액세스 키를 저장하지 않았습니다.`,
      };
    }
    case "local-http":
      if (inst.config.listenPorts.includes(80)) return { command: cmd.command, lines: [String(inst.config.httpResponseCode)], ok: inst.config.httpResponseCode < 500, why: `이 인스턴스는 80 포트에서 HTTP ${inst.config.httpResponseCode}을(를) 응답한다고 설정되어 있습니다 (가상 서비스).` };
      return { command: cmd.command, lines: ["000", "curl: (7) Failed to connect to localhost port 80: Connection refused"], ok: false, why: "이 인스턴스의 가상 서비스 포트에 80이 없습니다 (사용자 데이터에서 웹 서버를 설치하지 않음)." };
    default: {
      const net = simulateWithTopology(topo, { source: { kind: "resource", resourceId: inst.id }, destination: { kind: "internet", ip: "203.0.113.200" }, protocol: "tcp", port: 443 });
      if (net.outcome === "success") return { command: cmd.command, lines: ["HTTP/2 200"], ok: true, why: "라우팅(IGW 또는 NAT)·보안 그룹·네트워크 ACL을 통과해 인터넷으로 나갈 수 있습니다." };
      return { command: cmd.command, lines: ["curl: (28) Failed to connect to aws.amazon.com port 443: Connection timed out"], ok: false, why: net.failure?.reason ?? net.summary };
    }
  }
}

export interface PortCheckOutput extends SessionOutput {
  targetId: string;
  port: number;
}

/** 세션 안에서 다른 리소스의 포트가 열려 있는지 확인하는 명령(nc)의 가상 출력 — 배스천 없이 프라이빗 DB 연결을 점검할 때 쓴다 */
export function runPortCheck(topo: Topology, inst: Ec2, targetId: string, port: number): PortCheckOutput {
  const target = topo.get(targetId);
  const command = `nc -zv ${target ? displayName(target) : targetId} ${port}`;
  if (!target) return { command, targetId, port, lines: ["nc: 대상을 찾을 수 없습니다"], ok: false, why: "대상 리소스가 없습니다." };
  const result = simulateWithTopology(topo, { source: { kind: "resource", resourceId: inst.id }, destination: { kind: "resource", resourceId: target.id }, protocol: "tcp", port });
  if (result.outcome === "success") return { command, targetId, port, lines: [`Connection to ${displayName(target)} ${port} port [tcp/*] succeeded!`], ok: true, why: result.summary };
  return { command, targetId, port, lines: [`nc: connect to ${displayName(target)} port ${port} (tcp) timed out: Operation now in progress`], ok: false, why: result.failure?.reason ?? result.summary };
}
