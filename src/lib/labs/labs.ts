/**
 * Guided Lab 정의.
 * 각 단계의 완료 여부는 사용자가 버튼을 눌렀는지가 아니라 현재 프로젝트의 실제 설정,
 * 검증 결과, 시뮬레이션 결과로 판정한다.
 */
import {
  DEFAULT_INTERNET_CLIENT_IP,
  DEFAULT_INTERNET_HOST_IP,
  simulateWithTopology,
  type SimulationRequest,
  type SimulationResult,
} from "@/lib/engine/connectivity-engine";
import { cidrContainsCidr, parseIpv4, tryParseCidr, validateVpcCidr } from "@/lib/engine/cidr-utils";
import type { TargetHealth } from "@/lib/engine/alb-engine";
import type { Project, ResourceOfType } from "@/lib/engine/resource-models";
import { evaluateSecurityGroups } from "@/lib/engine/security-group-engine";
import { buildTopology, type Topology } from "@/lib/engine/topology-engine";
import { runValidationRules, createValidationContext, type ValidationFinding } from "@/lib/engine/validation-engine";
import { ProjectBuilder } from "@/lib/project/builder";
import { createEmptyProject, NACL, SG } from "@/lib/project/factory";

export interface LabContext {
  project: Project;
  topo: Topology;
  findings: ValidationFinding[];
  health: Map<string, TargetHealth[]>;
  simulate: (request: SimulationRequest) => SimulationResult;
}

export interface LabStep {
  id: string;
  title: string;
  instruction: string;
  hint: string;
  check: (ctx: LabContext) => boolean;
  /** 시뮬레이션 콘솔에서 바로 실행해 볼 요청 (현재 구성에서 만들 수 없으면 null) */
  simulation?: (ctx: LabContext) => SimulationRequest | null;
}

export interface LabDefinition {
  id: string;
  order: number;
  title: string;
  summary: string;
  level: "입문" | "초급" | "중급";
  objectives: string[];
  createStarter: () => Project;
  steps: LabStep[];
}

export interface LabProgress {
  steps: { id: string; done: boolean }[];
  completedCount: number;
  completed: boolean;
}

export function createLabContext(project: Project): LabContext {
  const topo = buildTopology(project);
  const ctx = createValidationContext(topo);
  return {
    project,
    topo,
    findings: runValidationRules(ctx),
    health: ctx.health,
    simulate: (request) => simulateWithTopology(topo, request),
  };
}

export function evaluateLab(lab: LabDefinition, ctx: LabContext): LabProgress {
  const steps = lab.steps.map((s) => {
    let done = false;
    try {
      done = s.check(ctx);
    } catch {
      done = false;
    }
    return { id: s.id, done };
  });
  const completedCount = steps.filter((s) => s.done).length;
  return { steps, completedCount, completed: completedCount === steps.length };
}

// ---------------------------------------------------------------- 공통 판정 도우미

const validVpcs = (t: Topology) => t.ofType("vpc").filter((v) => validateVpcCidr(v.config.cidr).ok);

function subnetsInVpc(t: Topology): ResourceOfType<"subnet">[] {
  return t.ofType("subnet").filter((s) => {
    const vpcCidr = t.vpcCidr(t.vpcOfSubnet(s.id));
    const cidr = tryParseCidr(s.config.cidr);
    return !!vpcCidr && !!cidr && cidrContainsCidr(vpcCidr, cidr);
  });
}

const publicSubnets = (t: Topology) => subnetsInVpc(t).filter((s) => t.classifySubnet(s.id).kind === "public");
const privateSubnets = (t: Topology) => subnetsInVpc(t).filter((s) => t.classifySubnet(s.id).kind !== "public");

function runningEc2In(t: Topology, subnets: ResourceOfType<"subnet">[]): ResourceOfType<"ec2">[] {
  const ids = new Set(subnets.map((s) => s.id));
  return t.ofType("ec2").filter((e) => e.config.state === "running" && ids.has(t.subnetOf(e.id) ?? ""));
}

function publicWebServers(t: Topology): ResourceOfType<"ec2">[] {
  return runningEc2In(t, publicSubnets(t)).filter((e) => t.enisOf(e.id)[0]?.publicIp !== null);
}

function allowsInboundFromInternet(t: Topology, ownerId: string, port: number): boolean {
  const groups = t.securityGroupsOf(ownerId);
  return evaluateSecurityGroups(groups, "inbound", {
    protocol: "tcp",
    port,
    peerIp: parseIpv4(DEFAULT_INTERNET_CLIENT_IP)!,
    peerSecurityGroupIds: [],
  }).allowed;
}

function internetTo(resourceId: string, port: number): SimulationRequest {
  return {
    source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP },
    destination: { kind: "resource", resourceId, addressing: "public" },
    protocol: "tcp",
    port,
  };
}

function toInternet(resourceId: string, port = 443): SimulationRequest {
  return {
    source: { kind: "resource", resourceId },
    destination: { kind: "internet", ip: DEFAULT_INTERNET_HOST_IP },
    protocol: "tcp",
    port,
  };
}

const succeeds = (ctx: LabContext, req: SimulationRequest | null) => !!req && ctx.simulate(req).outcome === "success";
const hasRule = (ctx: LabContext, ruleId: string) => ctx.findings.some((f) => f.ruleId === ruleId);

function internetFacingAlbs(t: Topology): ResourceOfType<"alb">[] {
  return t.ofType("alb").filter((a) => a.config.scheme === "internet-facing");
}

function albRequest(t: Topology): SimulationRequest | null {
  const alb = internetFacingAlbs(t)[0];
  if (!alb) return null;
  const port = alb.config.listeners[0]?.port ?? 80;
  return {
    source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP },
    destination: { kind: "resource", resourceId: alb.id },
    protocol: "tcp",
    port,
    requestCount: 6,
  };
}

function appToDbRequest(t: Topology): SimulationRequest | null {
  const rds = t.ofType("rds")[0];
  if (!rds) return null;
  const vpc = t.vpcOf(rds.id);
  const app = t.ofType("ec2").find((e) => e.config.state === "running" && t.vpcOf(e.id) === vpc);
  if (!app) return null;
  return {
    source: { kind: "resource", resourceId: app.id },
    destination: { kind: "resource", resourceId: rds.id },
    protocol: "tcp",
    port: rds.config.port,
  };
}

// ---------------------------------------------------------------- 실습 시작 상태

function lab2Starter(): Project {
  const b = new ProjectBuilder("Lab 2 · 프라이빗 EC2와 NAT Gateway", { labId: "lab-2-private-nat" });
  const vpc = b.vpc("lab-vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const igw = b.igw("lab-igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  return b.build();
}

function webTierBase(name: string, labId: string) {
  const b = new ProjectBuilder(name, { labId });
  const vpc = b.vpc("lab-vpc", "10.0.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const pubC = b.subnet("public-c", vpc, "10.0.2.0/24", "ap-northeast-2c");
  const appA = b.subnet("app-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const appC = b.subnet("app-c", vpc, "10.0.12.0/24", "ap-northeast-2c");
  const igw = b.igw("lab-igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pubA, pubC], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("app-rt", vpc, { subnets: [appA, appC] });
  const appSg = b.securityGroup("app-sg", vpc, { description: "애플리케이션 서버" });
  const app1 = b.ec2("app-1", appA, { ip: "10.0.11.10", sgs: [appSg], listenPorts: [80] });
  const app2 = b.ec2("app-2", appC, { ip: "10.0.12.10", sgs: [appSg], listenPorts: [80] });
  return { b, vpc, pubA, pubC, appA, appC, igw, appSg, app1, app2 };
}

function lab3Starter(): Project {
  return webTierBase("Lab 3 · ALB와 EC2", "lab-3-alb").b.build();
}

function lab4Starter(): Project {
  const base = webTierBase("Lab 4 · RDS 연결", "lab-4-rds");
  const { b, vpc } = base;
  b.subnet("db-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  b.subnet("db-c", vpc, "10.0.22.0/24", "ap-northeast-2c");
  return b.build();
}

/** 의도적으로 여러 보안 오류가 들어 있는 아키텍처 */
export function createLab5Starter(): Project {
  const b = new ProjectBuilder("Lab 5 · 보안 오류 해결", { labId: "lab-5-security" });
  const vpc = b.vpc("shop-vpc", "10.0.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const pubC = b.subnet("public-c", vpc, "10.0.2.0/24", "ap-northeast-2c");
  const appA = b.subnet("app-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const appC = b.subnet("app-c", vpc, "10.0.12.0/24", "ap-northeast-2c");
  const dbA = b.subnet("db-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  const dbC = b.subnet("db-c", vpc, "10.0.22.0/24", "ap-northeast-2c");
  const igw = b.igw("shop-igw", vpc);
  const nat = b.nat("nat-a", pubA);
  b.routeTable("public-rt", vpc, { subnets: [pubA, pubC], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("app-rt", vpc, { subnets: [appA, appC], routes: [{ destination: "0.0.0.0/0", nat }] });
  b.routeTable("db-rt", vpc, { subnets: [dbA, dbC] });
  // 문제 1: 퍼블릭 NACL이 응답용 임시 포트를 허용하지 않음
  b.networkAcl("public-nacl", vpc, {
    subnets: [pubA, pubC],
    inbound: [NACL.allow(100, "tcp", 80, "0.0.0.0/0"), NACL.allow(110, "tcp", [1024, 65535], "0.0.0.0/0"), NACL.allow(120, "all", null, "10.0.0.0/16")],
    outbound: [NACL.allow(100, "tcp", 80, "0.0.0.0/0"), NACL.allow(110, "tcp", 443, "0.0.0.0/0"), NACL.allow(120, "all", null, "10.0.0.0/16")],
  });
  // 문제 2: ALB 보안 그룹에 리스너 포트(80) 규칙이 없음
  const albSg = b.securityGroup("alb-sg", vpc, { description: "ALB", inbound: [SG.tcp(443, "0.0.0.0/0", "HTTPS")] });
  // 문제 3: 앱 보안 그룹이 SSH를 전체 공개하고, ALB의 80 포트는 허용하지 않음
  const appSg = b.securityGroup("app-sg", vpc, {
    description: "앱 서버",
    inbound: [SG.tcp(22, "0.0.0.0/0", "SSH (임시)"), SG.tcp(8080, { sg: albSg }, "잘못된 포트")],
  });
  // 문제 4: DB 보안 그룹이 MySQL을 전체 공개
  const dbSg = b.securityGroup("db-sg", vpc, { description: "DB", inbound: [SG.tcp(3306, "0.0.0.0/0", "MySQL")] });
  const app1 = b.ec2("app-1", appA, { ip: "10.0.11.10", sgs: [appSg], listenPorts: [22, 80] });
  const app2 = b.ec2("app-2", appC, { ip: "10.0.12.10", sgs: [appSg], listenPorts: [22, 80] });
  const tg = b.targetGroup("shop-tg", { port: 80, targets: [app1, app2] });
  b.alb("shop-alb", { subnets: [pubA, pubC], sgs: [albSg], listeners: [{ port: 80, targetGroup: tg }] });
  const dbGroup = b.dbSubnetGroup("shop-db-subnets", [dbA, dbC]);
  b.rds("shop-db", { subnetGroup: dbGroup, sgs: [dbSg] });
  return b.build();
}

// ---------------------------------------------------------------- 실습 정의

export const LABS: LabDefinition[] = [
  {
    id: "lab-1-public-ec2",
    order: 1,
    title: "Public EC2 구성",
    level: "입문",
    summary: "VPC부터 시작해 인터넷에서 접속 가능한 웹 서버(EC2)를 구성합니다.",
    objectives: ["VPC와 서브넷의 관계 이해", "Internet Gateway와 라우팅 테이블로 퍼블릭 서브넷 만들기", "보안 그룹으로 HTTP 허용"],
    createStarter: () => createEmptyProject("Lab 1 · Public EC2 구성", { labId: "lab-1-public-ec2" }),
    steps: [
      {
        id: "vpc",
        title: "VPC 생성",
        instruction: "팔레트에서 VPC를 추가하고 CIDR을 10.0.0.0/16처럼 /16~/28 범위로 지정하세요.",
        hint: "VPC를 선택하면 오른쪽 설정 패널에서 CIDR을 바꿀 수 있습니다.",
        check: ({ topo }) => validVpcs(topo).length > 0,
      },
      {
        id: "subnet",
        title: "Subnet 생성",
        instruction: "서브넷을 추가해 VPC와 연결하고, VPC 범위 안의 CIDR(예: 10.0.1.0/24)을 지정하세요.",
        hint: "VPC 노드의 연결점을 서브넷으로 드래그하거나, 서브넷 설정의 VPC 선택 상자를 사용하세요.",
        check: ({ topo }) => subnetsInVpc(topo).length > 0,
      },
      {
        id: "igw",
        title: "Internet Gateway 생성 및 연결",
        instruction: "Internet Gateway를 추가하고 VPC에 연결(Attach)하세요.",
        hint: "VPC와 IGW를 연결선으로 이으면 됩니다. VPC당 IGW는 하나입니다.",
        check: ({ topo }) => validVpcs(topo).some((v) => !!topo.igwOfVpc(v.id)),
      },
      {
        id: "route",
        title: "Route Table 구성",
        instruction: "라우팅 테이블을 VPC에 추가하고 0.0.0.0/0 → Internet Gateway 경로를 만든 뒤 서브넷과 연결하세요.",
        hint: "라우팅 테이블 → IGW 연결선은 기본 경로(0.0.0.0/0)가 됩니다. 라우팅 테이블 → 서브넷 연결선은 Association입니다.",
        check: ({ topo }) => publicSubnets(topo).length > 0,
      },
      {
        id: "ec2",
        title: "EC2 배치",
        instruction: "퍼블릭 서브넷에 EC2를 배치하고 퍼블릭 IPv4 자동 할당을 활성화하세요.",
        hint: "EC2 설정에서 '퍼블릭 IPv4'를 '활성화'로 바꾸거나, 서브넷의 '퍼블릭 IPv4 자동 할당'을 켜세요.",
        check: ({ topo }) => publicWebServers(topo).length > 0,
      },
      {
        id: "sg",
        title: "Security Group 설정",
        instruction: "보안 그룹을 만들어 EC2에 연결하고 인바운드 TCP 80을 0.0.0.0/0에서 허용하세요.",
        hint: "보안 그룹은 VPC에 속해야 하고, EC2와 연결선으로 연결합니다.",
        check: ({ topo }) => publicWebServers(topo).some((e) => allowsInboundFromInternet(topo, e.id, 80)),
      },
      {
        id: "simulate",
        title: "통신 시뮬레이션",
        instruction: "시뮬레이션 콘솔에서 '인터넷 → EC2(퍼블릭 IP) TCP 80' 요청을 실행해 성공하는지 확인하세요.",
        hint: "실패하면 로그에서 어느 단계(라우팅/보안 그룹/NACL)에서 막혔는지 확인하세요.",
        check: (ctx) => publicWebServers(ctx.topo).some((e) => succeeds(ctx, internetTo(e.id, 80))),
        simulation: ({ topo }) => {
          const e = publicWebServers(topo)[0] ?? topo.ofType("ec2")[0];
          return e ? internetTo(e.id, 80) : null;
        },
      },
    ],
  },
  {
    id: "lab-2-private-nat",
    order: 2,
    title: "Private EC2 구성",
    level: "초급",
    summary: "프라이빗 서브넷의 EC2가 NAT Gateway를 통해서만 외부로 나가도록 구성하고 퍼블릭 서브넷과 비교합니다.",
    objectives: ["퍼블릭/프라이빗 서브넷의 차이는 라우팅으로 결정됨", "NAT Gateway의 위치와 경로", "외부 → 내부 접근이 차단되는 이유"],
    createStarter: lab2Starter,
    steps: [
      {
        id: "private-subnet",
        title: "Private Subnet 추가",
        instruction: "같은 VPC에 두 번째 서브넷(예: 10.0.11.0/24)을 추가하세요. IGW 경로가 없는 서브넷은 프라이빗입니다.",
        hint: "새 서브넷을 VPC와 연결하고 public-rt와는 연결하지 마세요.",
        check: ({ topo }) => publicSubnets(topo).length > 0 && privateSubnets(topo).length > 0,
      },
      {
        id: "nat",
        title: "NAT Gateway 추가",
        instruction: "NAT Gateway를 추가하고 퍼블릭 서브넷에 배치하세요.",
        hint: "NAT는 IGW 경로가 있는 퍼블릭 서브넷에 있어야 합니다.",
        check: ({ topo }) =>
          topo.ofType("nat-gateway").some((n) => {
            const s = topo.subnetOf(n.id);
            return n.config.state === "available" && !!s && topo.classifySubnet(s).kind === "public";
          }),
      },
      {
        id: "private-route",
        title: "프라이빗 라우팅 구성",
        instruction: "새 라우팅 테이블에 0.0.0.0/0 → NAT Gateway 경로를 만들고 프라이빗 서브넷과 연결하세요.",
        hint: "라우팅 테이블을 VPC에 추가 → NAT와 연결(경로) → 프라이빗 서브넷과 연결(Association).",
        check: ({ topo }) => subnetsInVpc(topo).some((s) => topo.classifySubnet(s.id).kind === "private-nat"),
      },
      {
        id: "private-ec2",
        title: "프라이빗 EC2 배치",
        instruction: "프라이빗 서브넷에 퍼블릭 IP 없는 EC2를 배치하고 보안 그룹을 연결하세요.",
        hint: "EC2 설정에서 퍼블릭 IPv4를 '비활성화'로 두세요. 기본 보안 그룹은 아웃바운드를 모두 허용합니다.",
        check: ({ topo }) =>
          runningEc2In(topo, subnetsInVpc(topo).filter((s) => topo.classifySubnet(s.id).kind === "private-nat")).some(
            (e) => topo.enisOf(e.id)[0]?.publicIp === null && topo.securityGroupsOf(e.id).length > 0,
          ),
      },
      {
        id: "egress",
        title: "외부 통신 확인 (NAT 경유)",
        instruction: "시뮬레이션 콘솔에서 '프라이빗 EC2 → 인터넷 호스트 TCP 443'을 실행하고 NAT Gateway를 거치는 경로를 확인하세요.",
        hint: "로그에서 NAT의 주소 변환(SNAT)과 NAT 서브넷의 IGW 경로 단계를 찾아보세요.",
        check: (ctx) => {
          const subnets = subnetsInVpc(ctx.topo).filter((s) => ctx.topo.classifySubnet(s.id).kind === "private-nat");
          return runningEc2In(ctx.topo, subnets).some((e) => {
            const r = ctx.simulate(toInternet(e.id));
            return r.outcome === "success" && r.path.some((h) => h.resourceId && ctx.topo.get(h.resourceId)?.type === "nat-gateway");
          });
        },
        simulation: ({ topo }) => {
          const subnets = subnetsInVpc(topo).filter((s) => topo.classifySubnet(s.id).kind === "private-nat");
          const e = runningEc2In(topo, subnets)[0];
          return e ? toInternet(e.id) : null;
        },
      },
      {
        id: "compare",
        title: "외부 → 내부 결과 비교",
        instruction: "'인터넷 → 프라이빗 EC2' 요청이 실패하는지 확인하세요. 퍼블릭 IP와 IGW 경로가 없으므로 외부에서 시작된 연결은 들어올 수 없습니다.",
        hint: "프라이빗 EC2에는 퍼블릭 IP가 없어 목적지 주소 단계에서 실패합니다. NAT는 아웃바운드 전용입니다.",
        check: (ctx) => {
          const subnets = subnetsInVpc(ctx.topo).filter((s) => ctx.topo.classifySubnet(s.id).kind === "private-nat");
          const servers = runningEc2In(ctx.topo, subnets);
          return servers.length > 0 && servers.every((e) => ctx.simulate(internetTo(e.id, 80)).outcome === "failure");
        },
        simulation: ({ topo }) => {
          const subnets = subnetsInVpc(topo).filter((s) => topo.classifySubnet(s.id).kind === "private-nat");
          const e = runningEc2In(topo, subnets)[0];
          return e ? internetTo(e.id, 80) : null;
        },
      },
    ],
  },
  {
    id: "lab-3-alb",
    order: 3,
    title: "ALB와 EC2 구성",
    level: "초급",
    summary: "프라이빗 서브넷의 EC2 두 대 앞에 internet-facing ALB를 두고 요청 분산을 확인합니다.",
    objectives: ["ALB 서브넷과 가용 영역 요구 사항", "리스너 → 대상 그룹 → 대상", "보안 그룹 참조 규칙과 헬스 체크"],
    createStarter: lab3Starter,
    steps: [
      {
        id: "alb",
        title: "ALB 생성",
        instruction: "ALB를 추가하고 서로 다른 가용 영역의 퍼블릭 서브넷 2개(public-a, public-c)와 연결하세요. Scheme은 internet-facing입니다.",
        hint: "ALB는 가용 영역당 하나의 서브넷만 연결할 수 있습니다.",
        check: ({ topo }) =>
          internetFacingAlbs(topo).some((a) => {
            const subs = topo.albSubnets(a.id);
            return new Set(subs.map((s) => s.config.availabilityZone)).size >= 2 && subs.every((s) => topo.classifySubnet(s.id).kind === "public");
          }),
      },
      {
        id: "alb-sg",
        title: "ALB 보안 그룹",
        instruction: "ALB용 보안 그룹을 만들어 인바운드 TCP 80을 0.0.0.0/0에서 허용하고 ALB에 연결하세요.",
        hint: "보안 그룹을 VPC에 연결한 뒤, ALB와 보안 그룹을 연결합니다.",
        check: ({ topo }) => internetFacingAlbs(topo).some((a) => allowsInboundFromInternet(topo, a.id, 80)),
      },
      {
        id: "listener",
        title: "Listener 설정",
        instruction: "ALB에 HTTP:80 리스너가 있는지 확인하세요 (새 ALB에는 기본으로 생성됩니다).",
        hint: "ALB 설정 패널의 '리스너' 섹션에서 추가/삭제할 수 있습니다.",
        check: ({ topo }) => internetFacingAlbs(topo).some((a) => a.config.listeners.some((l) => l.port === 80)),
      },
      {
        id: "tg",
        title: "Target Group 구성",
        instruction: "대상 그룹(HTTP:80)을 만들고 ALB와 연결해 리스너가 대상 그룹으로 전달하도록 하세요.",
        hint: "ALB → Target Group 연결선을 만들면 비어 있는 리스너에 자동으로 지정됩니다.",
        check: ({ topo }) => internetFacingAlbs(topo).some((a) => topo.listenersOf(a.id).some((b) => b.listener.port === 80 && b.targetGroupId)),
      },
      {
        id: "register",
        title: "EC2 등록",
        instruction: "대상 그룹에 app-1, app-2를 등록하세요.",
        hint: "Target Group → EC2 연결선이 대상 등록입니다.",
        check: ({ topo }) => topo.ofType("target-group").some((tg) => topo.targetGroupTargets(tg.id).length >= 2),
      },
      {
        id: "healthy",
        title: "대상 상태 Healthy 만들기",
        instruction: "app-sg 인바운드에 TCP 80을 ALB 보안 그룹에서 허용하는 규칙(SG 참조)을 추가해 두 대상이 모두 Healthy가 되게 하세요.",
        hint: "검증 센터의 ELB-005 항목이 차단 원인을 알려줍니다. 출발지로 CIDR 대신 ALB 보안 그룹을 선택하세요.",
        check: ({ topo, health }) =>
          topo.ofType("target-group").some((tg) => {
            const h = health.get(tg.id) ?? [];
            return topo.targetGroupAlbs(tg.id).length > 0 && h.filter((x) => x.state === "healthy").length >= 2;
          }),
      },
      {
        id: "distribute",
        title: "가상 요청 분산 확인",
        instruction: "시뮬레이션 콘솔에서 '인터넷 → ALB'를 요청 수 6으로 실행해 두 EC2에 번갈아 전달되는지 확인하세요.",
        hint: "결과의 '요청 분산' 표에서 대상별 요청 수를 확인할 수 있습니다.",
        check: (ctx) => {
          const req = albRequest(ctx.topo);
          if (!req) return false;
          const r = ctx.simulate(req);
          return r.outcome === "success" && (r.distribution?.filter((d) => d.successes > 0).length ?? 0) >= 2;
        },
        simulation: ({ topo }) => albRequest(topo),
      },
    ],
  },
  {
    id: "lab-4-rds",
    order: 4,
    title: "RDS 연결",
    level: "중급",
    summary: "애플리케이션 서버에서만 접근할 수 있는 비공개 RDS를 구성하고 가상 연결을 검사합니다.",
    objectives: ["DB 서브넷 그룹 요구 사항(2개 AZ)", "보안 그룹 참조로 최소 권한 구성", "Publicly Accessible과 네트워크 경로의 관계"],
    createStarter: lab4Starter,
    steps: [
      {
        id: "dbsg",
        title: "DB Subnet Group 구성",
        instruction: "DB 서브넷 그룹을 만들고 db-a, db-c(서로 다른 AZ의 프라이빗 서브넷)를 추가하세요.",
        hint: "DB Subnet Group → Subnet 연결선을 두 번 만드세요.",
        check: ({ topo }) =>
          topo.ofType("db-subnet-group").some((g) => {
            const subs = topo.dbSubnetGroupSubnets(g.id);
            return subs.length >= 2 && new Set(subs.map((s) => s.config.availabilityZone)).size >= 2 && subs.every((s) => topo.classifySubnet(s.id).kind !== "public");
          }),
      },
      {
        id: "rds",
        title: "RDS 생성",
        instruction: "RDS(MySQL)를 추가하고 DB 서브넷 그룹과 연결하세요. Publicly Accessible은 끈 상태로 두세요.",
        hint: "RDS → DB Subnet Group 연결선은 배치 관계입니다.",
        check: ({ topo }) => topo.ofType("rds").some((r) => !!topo.dbSubnetGroupOf(r.id) && !r.config.publiclyAccessible),
      },
      {
        id: "db-sg",
        title: "DB 보안 그룹 규칙",
        instruction: "DB용 보안 그룹을 만들어 RDS에 연결하고, 인바운드 TCP 3306을 app-sg(보안 그룹 참조)에서만 허용하세요.",
        hint: "규칙의 출발지 유형을 '보안 그룹'으로 선택하세요.",
        check: ({ topo }) =>
          topo.ofType("rds").some((r) =>
            topo.securityGroupsOf(r.id).some((sg) =>
              sg.config.inboundRules.some(
                (rule) =>
                  rule.peer.kind === "security-group" &&
                  (rule.protocol === "all" || (rule.protocol === "tcp" && rule.fromPort <= r.config.port && rule.toPort >= r.config.port)),
              ),
            ),
          ),
      },
      {
        id: "connect",
        title: "애플리케이션 → DB 연결 검사",
        instruction: "시뮬레이션 콘솔에서 'app-1 → RDS TCP 3306'을 실행해 성공하는지 확인하세요. (실제 SQL은 실행되지 않습니다)",
        hint: "실패하면 DNS 확인(VPC 설정), 경로, 보안 그룹 단계를 확인하세요.",
        check: (ctx) => succeeds(ctx, appToDbRequest(ctx.topo)),
        simulation: ({ topo }) => appToDbRequest(topo),
      },
      {
        id: "private",
        title: "외부 노출 없음 확인",
        instruction: "인터넷에서 DB에 접근할 수 없고, DB 보안 그룹에 0.0.0.0/0 허용 규칙이 없는지 확인하세요.",
        hint: "검증 센터에 RDS-006/RDS-007 경고가 없어야 합니다.",
        check: (ctx) => {
          const rds = ctx.topo.ofType("rds");
          return (
            rds.length > 0 &&
            !hasRule(ctx, "RDS-006") &&
            !hasRule(ctx, "RDS-007") &&
            rds.every((r) => ctx.simulate(internetTo(r.id, r.config.port)).outcome !== "success")
          );
        },
      },
    ],
  },
  {
    id: "lab-5-security",
    order: 5,
    title: "보안 오류 해결",
    level: "중급",
    summary: "일부러 잘못된 규칙이 들어 있는 쇼핑몰 아키텍처입니다. 검증 센터와 시뮬레이션 로그로 문제를 직접 찾아 고치세요.",
    objectives: ["검증 결과에서 원인 찾기", "보안 위험(경고)과 통신 실패(오류) 구분", "NACL 응답 트래픽(임시 포트) 이해"],
    createStarter: createLab5Starter,
    steps: [
      {
        id: "ssh",
        title: "문제 1: 관리 포트 노출",
        instruction: "검증 센터에서 보안 경고를 찾아 관리용 포트가 인터넷 전체에 열려 있지 않게 고치세요.",
        hint: "SEC-002: app-sg의 SSH(22) 규칙 출발지를 관리자 대역(예: 203.0.113.0/24)으로 바꾸거나 삭제하세요.",
        check: (ctx) => !hasRule(ctx, "SEC-002"),
      },
      {
        id: "db-exposure",
        title: "문제 2: DB 과다 허용",
        instruction: "데이터베이스 보안 그룹의 과도한 허용 규칙을 고치세요. 애플리케이션 서버는 계속 DB에 연결할 수 있어야 합니다.",
        hint: "RDS-006/SEC-003: db-sg의 3306 규칙 출발지를 app-sg(보안 그룹 참조)로 바꾸세요.",
        check: (ctx) => !hasRule(ctx, "RDS-006") && !hasRule(ctx, "SEC-003") && succeeds(ctx, appToDbRequest(ctx.topo)),
        simulation: ({ topo }) => appToDbRequest(topo),
      },
      {
        id: "targets",
        title: "문제 3: 비정상 대상",
        instruction: "대상 그룹의 두 EC2가 모두 Healthy가 되도록 고치세요.",
        hint: "ELB-005: app-sg가 ALB에서 오는 대상 포트(80)를 허용하지 않습니다. 8080 규칙을 80으로 바꾸세요.",
        check: ({ topo, health }) =>
          topo.ofType("target-group").some((tg) => (health.get(tg.id) ?? []).filter((h) => h.state === "healthy").length >= 2),
      },
      {
        id: "alb-port",
        title: "문제 4: ALB 접근 불가",
        instruction: "인터넷에서 ALB 리스너(HTTP:80)로 요청이 들어오도록 고치세요.",
        hint: "ELB-009: alb-sg 인바운드에 TCP 80 ← 0.0.0.0/0 규칙이 없습니다.",
        check: ({ topo }) => internetFacingAlbs(topo).some((a) => allowsInboundFromInternet(topo, a.id, 80)),
      },
      {
        id: "nacl",
        title: "문제 5: 응답이 돌아오지 않음",
        instruction: "요청은 ALB에 도착하지만 응답이 클라이언트로 돌아가지 못합니다. 원인을 찾아 고치세요.",
        hint: "SEC-010: public-nacl 아웃바운드에 TCP 1024-65535 → 0.0.0.0/0 ALLOW 규칙을 추가하세요 (NACL은 상태 비저장형).",
        check: (ctx) => !ctx.findings.some((f) => f.ruleId === "SEC-010" && f.severity === "warning"),
      },
      {
        id: "verify",
        title: "최종 확인",
        instruction: "검증 센터에 오류(Error)가 없고 '인터넷 → ALB' 요청이 성공하는지 확인하세요.",
        hint: "시뮬레이션 콘솔에서 결과를 확인하고, 남은 오류가 있으면 검증 센터의 '리소스로 이동'을 사용하세요.",
        check: (ctx) => !ctx.findings.some((f) => f.severity === "error") && succeeds(ctx, albRequest(ctx.topo)),
        simulation: ({ topo }) => albRequest(topo),
      },
    ],
  },
];

export function labById(id: string | null | undefined): LabDefinition | undefined {
  return LABS.find((l) => l.id === id);
}
