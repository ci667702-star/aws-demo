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
  /** 이 단계를 진행할 콘솔 화면 (해시 경로, 예: "/vpc/vpcs/create") */
  consolePath?: string;
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

// ---------------------------------------------------------------- 콘솔 작업 판정 도우미

/** Reachability Analyzer에서 분석한 경로 중 조건에 맞고, 기록된 결과와 현재 구성의 결과가 모두 기대값인 것이 있는지 */
function analyzedPath(ctx: LabContext, predicate: (request: SimulationRequest) => boolean, outcome: "success" | "failure" = "success"): boolean {
  return ctx.project.networkPaths.some((p) => p.lastAnalysis?.outcome === outcome && predicate(p.request) && ctx.simulate(p.request).outcome === outcome);
}

function destinationIs(request: SimulationRequest, type: "ec2" | "alb" | "rds", t: Topology): boolean {
  return request.destination.kind === "resource" && t.get(request.destination.resourceId)?.type === type;
}

function destinationId(request: SimulationRequest): string | null {
  return request.destination.kind === "resource" ? request.destination.resourceId : null;
}

const userSecurityGroups = (t: Topology) => t.ofType("security-group").filter((g) => !g.config.isDefault);

function allowsFromInternet(sg: ResourceOfType<"security-group">, port: number): boolean {
  return evaluateSecurityGroups([sg], "inbound", { protocol: "tcp", port, peerIp: parseIpv4(DEFAULT_INTERNET_CLIENT_IP)!, peerSecurityGroupIds: [] }).allowed;
}

const servesPort = (e: ResourceOfType<"ec2">, port: number) => e.config.listenPorts.includes(port);

function privateNatServers(t: Topology): ResourceOfType<"ec2">[] {
  return runningEc2In(t, subnetsInVpc(t).filter((s) => t.classifySubnet(s.id).kind === "private-nat"));
}

const azCount = (subnets: ResourceOfType<"subnet">[]) => new Set(subnets.map((s) => s.config.availabilityZone)).size;

function subnetsOfInstances(t: Topology, instances: ResourceOfType<"ec2">[]): ResourceOfType<"subnet">[] {
  return instances.map((e) => t.getOfType(t.subnetOf(e.id), "subnet")).filter((s): s is ResourceOfType<"subnet"> => !!s);
}

// ---------------------------------------------------------------- 실습 시작 상태

/** 의도적으로 여러 보안 오류가 들어 있는 아키텍처 (문제 해결 실습이므로 미리 구성한다) */
export function createLab5Starter(): Project {
  const b = new ProjectBuilder("Lab 5 · 보안 오류 해결", { awsDefaults: true, labId: "lab-5-security" });
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
  const tg = b.targetGroup("shop-tg", { port: 80, vpc, targets: [app1, app2] });
  b.alb("shop-alb", { subnets: [pubA, pubC], sgs: [albSg], listeners: [{ port: 80, targetGroup: tg }] });
  const dbGroup = b.dbSubnetGroup("shop-db-subnets", [dbA, dbC]);
  b.rds("shop-db", { subnetGroup: dbGroup, sgs: [dbSg] });
  return b.build();
}

const emptyStarter = (name: string, labId: string) => () => createEmptyProject(name, { labId });

// ---------------------------------------------------------------- 실습 정의

export const LABS: LabDefinition[] = [
  {
    id: "lab-1-public-ec2",
    order: 1,
    title: "Public EC2 구성",
    level: "입문",
    summary: "빈 샌드박스에서 VPC부터 직접 만들어 인터넷에서 접속 가능한 웹 서버(EC2)를 구성합니다.",
    objectives: ["VPC와 서브넷의 관계 이해", "인터넷 게이트웨이와 라우팅 테이블로 퍼블릭 서브넷 만들기", "보안 그룹으로 HTTP 허용", "Reachability Analyzer로 경로 확인"],
    createStarter: emptyStarter("Lab 1 · Public EC2 구성", "lab-1-public-ec2"),
    steps: [
      {
        id: "vpc",
        title: "VPC 생성",
        instruction: "VPC 콘솔에서 VPC 생성을 선택하고 IPv4 CIDR을 직접 입력하세요 (예: 10.0.0.0/16).",
        hint: "CIDR 크기는 /16 ~ /28이어야 합니다. 기본 라우팅 테이블, 기본 네트워크 ACL, 기본 보안 그룹은 AWS처럼 자동으로 함께 생깁니다.",
        consolePath: "/vpc/vpcs/create",
        check: ({ topo }) => validVpcs(topo).length > 0,
      },
      {
        id: "subnet",
        title: "서브넷 생성",
        instruction: "서브넷 생성에서 방금 만든 VPC를 고르고, VPC 범위 안의 CIDR(예: 10.0.1.0/24)과 가용 영역을 지정하세요.",
        hint: "서브넷 CIDR은 VPC CIDR 안에 있어야 하고 다른 서브넷과 겹치면 안 됩니다.",
        consolePath: "/vpc/subnets/create",
        check: ({ topo }) => subnetsInVpc(topo).length > 0,
      },
      {
        id: "igw",
        title: "인터넷 게이트웨이 생성 및 연결",
        instruction: "인터넷 게이트웨이를 만든 뒤 작업 → VPC에 연결을 선택하세요.",
        hint: "새 인터넷 게이트웨이는 Detached 상태입니다. VPC 하나에 하나만 연결할 수 있습니다.",
        consolePath: "/vpc/igws/create",
        check: ({ topo }) => validVpcs(topo).some((v) => !!topo.igwOfVpc(v.id)),
      },
      {
        id: "route",
        title: "라우팅 테이블 구성",
        instruction: "라우팅 테이블의 라우팅 편집에서 0.0.0.0/0 → 인터넷 게이트웨이 경로를 추가하고, 서브넷 연결 편집으로 서브넷과 연결하세요.",
        hint: "새 라우팅 테이블을 만들어도 되고 기본 라우팅 테이블을 편집해도 됩니다. 서브넷이 퍼블릭인지는 이 경로로 결정됩니다.",
        consolePath: "/vpc/route-tables",
        check: ({ topo }) => publicSubnets(topo).length > 0,
      },
      {
        id: "sg",
        title: "보안 그룹 생성",
        instruction: "보안 그룹을 만들고 인바운드 규칙에 유형 HTTP(TCP 80), 소스 Anywhere-IPv4(0.0.0.0/0)를 추가하세요.",
        hint: "인스턴스 시작 마법사에서 '보안 그룹 생성 → 인터넷에서 HTTP 트래픽 허용'을 선택해도 됩니다.",
        consolePath: "/vpc/security-groups/create",
        check: ({ topo }) => userSecurityGroups(topo).some((g) => allowsFromInternet(g, 80)),
      },
      {
        id: "ec2",
        title: "웹 서버 인스턴스 시작",
        instruction: "인스턴스 시작에서 퍼블릭 서브넷을 고르고, 퍼블릭 IP 자동 할당을 활성화하고, 보안 그룹을 연결하고, 고급 세부 정보의 사용자 데이터에서 '웹 서버 설치'를 선택하세요.",
        hint: "인스턴스는 Pending을 거쳐 Running이 됩니다. 사용자 데이터 없이 시작하면 80 포트가 응답하지 않습니다.",
        consolePath: "/ec2/instances/launch",
        check: ({ topo }) => publicWebServers(topo).some((e) => servesPort(e, 80) && allowsInboundFromInternet(topo, e.id, 80)),
      },
      {
        id: "analyze",
        title: "Reachability Analyzer로 확인",
        instruction: "경로 생성 및 분석에서 소스 '인터넷', 대상 '인스턴스', TCP 80으로 분석해 '도달 가능'이 나오는지 확인하세요.",
        hint: "실패하면 분석 단계에서 어느 구성 요소(라우팅, 네트워크 ACL, 보안 그룹, 서비스 포트)에서 막혔는지 확인하세요.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) => analyzedPath(ctx, (r) => r.source.kind === "internet" && destinationIs(r, "ec2", ctx.topo) && r.port === 80),
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
    title: "Private EC2와 NAT 게이트웨이",
    level: "초급",
    summary: "프라이빗 서브넷의 EC2가 NAT 게이트웨이를 통해서만 외부로 나가도록 구성하고, 외부에서는 들어올 수 없는 것을 확인합니다.",
    objectives: ["퍼블릭/프라이빗 서브넷의 차이는 라우팅으로 결정됨", "NAT 게이트웨이의 위치(퍼블릭 서브넷)와 탄력적 IP", "외부 → 내부 접근이 차단되는 이유"],
    createStarter: emptyStarter("Lab 2 · 프라이빗 EC2와 NAT 게이트웨이", "lab-2-private-nat"),
    steps: [
      {
        id: "public-network",
        title: "퍼블릭 네트워크 준비",
        instruction: "VPC, 퍼블릭 서브넷, 인터넷 게이트웨이(연결), 0.0.0.0/0 → IGW 경로를 직접 구성하세요. (Lab 1의 1~4단계와 같습니다)",
        hint: "NAT 게이트웨이는 퍼블릭 서브넷에 있어야 인터넷으로 나갈 수 있습니다.",
        consolePath: "/vpc/vpcs",
        check: ({ topo }) => publicSubnets(topo).length > 0,
      },
      {
        id: "private-subnet",
        title: "프라이빗 서브넷 추가",
        instruction: "같은 VPC에 두 번째 서브넷(예: 10.0.11.0/24)을 만드세요. 이 서브넷은 IGW 경로가 있는 라우팅 테이블과 연결하지 않습니다.",
        hint: "명시적 연결이 없으면 기본(main) 라우팅 테이블을 사용합니다. 기본 테이블에 IGW 경로를 넣었다면 별도 테이블을 쓰세요.",
        consolePath: "/vpc/subnets/create",
        check: ({ topo }) => publicSubnets(topo).length > 0 && privateSubnets(topo).length > 0,
      },
      {
        id: "eip",
        title: "탄력적 IP 할당",
        instruction: "탄력적 IP 주소를 하나 할당하세요. 퍼블릭 NAT 게이트웨이에 필요합니다.",
        hint: "주소는 가상 대역(198.51.100.0/24)에서 할당됩니다.",
        consolePath: "/vpc/eips/allocate",
        check: ({ topo }) => topo.ofType("elastic-ip").length > 0,
      },
      {
        id: "nat",
        title: "NAT 게이트웨이 생성",
        instruction: "퍼블릭 서브넷에 NAT 게이트웨이를 만들고 탄력적 IP를 지정하세요. Available이 될 때까지 기다립니다.",
        hint: "VPC에 인터넷 게이트웨이가 연결되어 있지 않으면 [Gateway.NotAttached] 오류가 납니다.",
        consolePath: "/vpc/nat-gateways/create",
        check: ({ topo }) =>
          topo.ofType("nat-gateway").some((n) => {
            const s = topo.subnetOf(n.id);
            return n.config.state === "available" && !!s && topo.classifySubnet(s).kind === "public" && !!topo.elasticIpOf(n.id);
          }),
      },
      {
        id: "private-route",
        title: "프라이빗 라우팅 구성",
        instruction: "새 라우팅 테이블을 만들어 0.0.0.0/0 → NAT 게이트웨이 경로를 추가하고 프라이빗 서브넷과 연결하세요.",
        hint: "라우팅 테이블 생성 → 라우팅 편집(대상: NAT 게이트웨이) → 서브넷 연결 편집.",
        consolePath: "/vpc/route-tables/create",
        check: ({ topo }) => subnetsInVpc(topo).some((s) => topo.classifySubnet(s.id).kind === "private-nat"),
      },
      {
        id: "private-ec2",
        title: "프라이빗 인스턴스 시작",
        instruction: "프라이빗 서브넷에 퍼블릭 IP 자동 할당을 '비활성화'한 인스턴스를 시작하세요.",
        hint: "보안 그룹은 아웃바운드를 모두 허용하는 기본 규칙이면 충분합니다.",
        consolePath: "/ec2/instances/launch",
        check: ({ topo }) => privateNatServers(topo).some((e) => topo.enisOf(e.id)[0]?.publicIp === null && topo.securityGroupsOf(e.id).length > 0),
      },
      {
        id: "egress",
        title: "외부 통신 확인 (NAT 경유)",
        instruction: "Reachability Analyzer에서 소스 '프라이빗 인스턴스', 대상 '인터넷', TCP 443을 분석해 '도달 가능'과 NAT 게이트웨이를 거치는 경로를 확인하세요.",
        hint: "분석 단계에서 NAT의 주소 변환(SNAT)과 NAT 서브넷의 IGW 경로를 찾아보세요.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) =>
          analyzedPath(ctx, (r) => {
            if (r.source.kind !== "resource" || r.destination.kind !== "internet") return false;
            const sourceId = r.source.resourceId;
            if (!privateNatServers(ctx.topo).some((e) => e.id === sourceId)) return false;
            return ctx.simulate(r).path.some((h) => !!h.resourceId && ctx.topo.get(h.resourceId)?.type === "nat-gateway");
          }),
        simulation: ({ topo }) => {
          const e = privateNatServers(topo)[0];
          return e ? toInternet(e.id) : null;
        },
      },
      {
        id: "compare",
        title: "외부 → 내부 결과 비교",
        instruction: "소스 '인터넷', 대상 '프라이빗 인스턴스', TCP 80 경로를 분석해 '도달 불가'가 나오는지 확인하세요. 퍼블릭 IP가 없고 NAT는 아웃바운드 전용이기 때문입니다.",
        hint: "결과의 막힌 지점 설명을 읽어 보세요.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) =>
          analyzedPath(
            ctx,
            (r) => r.source.kind === "internet" && privateNatServers(ctx.topo).some((e) => e.id === destinationId(r)),
            "failure",
          ),
        simulation: ({ topo }) => {
          const e = privateNatServers(topo)[0];
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
    summary: "두 가용 영역의 웹 서버 앞에 internet-facing Application Load Balancer를 두고 요청 분산과 헬스 체크를 확인합니다.",
    objectives: ["ALB 서브넷과 가용 영역 요구 사항", "리스너 → 대상 그룹 → 대상", "보안 그룹 참조 규칙과 헬스 체크"],
    createStarter: emptyStarter("Lab 3 · ALB와 EC2", "lab-3-alb"),
    steps: [
      {
        id: "network",
        title: "두 가용 영역의 퍼블릭 서브넷",
        instruction: "VPC와 인터넷 게이트웨이를 구성하고, 서로 다른 가용 영역에 퍼블릭 서브넷 2개(예: 2a, 2c)를 만드세요.",
        hint: "ALB는 서로 다른 AZ의 서브넷이 2개 이상 필요합니다. 두 서브넷 모두 IGW 경로가 있는 라우팅 테이블과 연결하세요.",
        consolePath: "/vpc/subnets/create",
        check: ({ topo }) => azCount(publicSubnets(topo)) >= 2,
      },
      {
        id: "servers",
        title: "웹 서버 2대 시작",
        instruction: "서로 다른 가용 영역에 웹 서버 인스턴스 2대를 시작하세요 (사용자 데이터: 웹 서버 설치). 프라이빗 서브넷에 두고 퍼블릭 IP 없이 ALB로만 받는 구성을 권장합니다.",
        hint: "프라이빗 서브넷을 따로 만들거나, 연습용으로 퍼블릭 서브넷을 써도 됩니다.",
        consolePath: "/ec2/instances/launch",
        check: ({ topo }) => azCount(subnetsOfInstances(topo, topo.ofType("ec2").filter((e) => e.config.state === "running" && servesPort(e, 80)))) >= 2,
      },
      {
        id: "alb-sg",
        title: "ALB 보안 그룹",
        instruction: "ALB용 보안 그룹을 만들고 인바운드 HTTP(80)를 Anywhere-IPv4에서 허용하세요.",
        hint: "인스턴스용 보안 그룹과 분리해 두면 다음 단계에서 '보안 그룹 참조' 규칙을 만들 수 있습니다.",
        consolePath: "/vpc/security-groups/create",
        check: ({ topo }) => userSecurityGroups(topo).some((g) => allowsFromInternet(g, 80)),
      },
      {
        id: "tg",
        title: "대상 그룹 생성 및 대상 등록",
        instruction: "대상 그룹(인스턴스, HTTP:80)을 만들고 2단계에서 웹 서버 2대를 등록하세요.",
        hint: "대상은 대상 그룹과 같은 VPC에 있어야 합니다.",
        consolePath: "/ec2/target-groups/create",
        check: ({ topo }) => topo.ofType("target-group").some((tg) => topo.targetGroupTargets(tg.id).length >= 2),
      },
      {
        id: "alb",
        title: "Application Load Balancer 생성",
        instruction: "인터넷 경계 ALB를 만들고 두 퍼블릭 서브넷, ALB 보안 그룹, 리스너 HTTP:80 → 대상 그룹을 지정하세요. Active가 될 때까지 기다립니다.",
        hint: "로드 밸런서 생성 → Application Load Balancer. 리스너의 기본 작업에서 대상 그룹을 선택해야 합니다.",
        consolePath: "/ec2/load-balancers/select-type",
        check: ({ topo }) =>
          internetFacingAlbs(topo).some((a) => {
            const subs = topo.albSubnets(a.id);
            return (
              a.config.state === "active" &&
              azCount(subs) >= 2 &&
              subs.every((s) => topo.classifySubnet(s.id).kind === "public") &&
              allowsInboundFromInternet(topo, a.id, 80) &&
              topo.listenersOf(a.id).some((b) => b.listener.port === 80 && !!b.targetGroupId)
            );
          }),
      },
      {
        id: "healthy",
        title: "대상을 Healthy로 만들기",
        instruction: "웹 서버의 보안 그룹 인바운드에 HTTP(80)를 소스 유형 '보안 그룹' → ALB 보안 그룹으로 허용해 두 대상이 모두 healthy가 되게 하세요.",
        hint: "대상 그룹의 대상 탭에서 상태 세부 정보를 확인하세요. 구성 검사의 ELB-005 항목도 원인을 알려 줍니다.",
        consolePath: "/ec2/target-groups",
        check: ({ topo, health }) =>
          topo.ofType("target-group").some((tg) => topo.targetGroupAlbs(tg.id).length > 0 && (health.get(tg.id) ?? []).filter((x) => x.state === "healthy").length >= 2),
      },
      {
        id: "distribute",
        title: "요청 분산 확인",
        instruction: "Reachability Analyzer에서 소스 '인터넷', 대상 '로드 밸런서', TCP 80, 요청 수 6으로 분석해 두 인스턴스에 요청이 나뉘는지 확인하세요.",
        hint: "분석 결과의 '대상 분산' 표에서 대상별 요청 수를 볼 수 있습니다.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) =>
          analyzedPath(ctx, (r) => {
            if (!(r.source.kind === "internet" && destinationIs(r, "alb", ctx.topo))) return false;
            const result = ctx.simulate({ ...r, requestCount: Math.max(r.requestCount ?? 1, 6) });
            return (result.distribution?.filter((d) => d.successes > 0).length ?? 0) >= 2;
          }),
        simulation: ({ topo }) => albRequest(topo),
      },
    ],
  },
  {
    id: "lab-4-rds",
    order: 4,
    title: "RDS 연결",
    level: "중급",
    summary: "애플리케이션 서버에서만 접근할 수 있는 비공개 RDS를 구성하고 가상 연결을 분석합니다.",
    objectives: ["DB 서브넷 그룹 요구 사항(2개 AZ)", "보안 그룹 참조로 최소 권한 구성", "퍼블릭 액세스와 네트워크 경로의 관계"],
    createStarter: emptyStarter("Lab 4 · RDS 연결", "lab-4-rds"),
    steps: [
      {
        id: "app",
        title: "애플리케이션 서버 준비",
        instruction: "VPC와 서브넷을 만들고, 직접 만든 보안 그룹을 연결한 애플리케이션 서버 인스턴스를 하나 시작하세요.",
        hint: "이 실습에서는 앱 서버가 인터넷과 통신할 필요가 없습니다.",
        consolePath: "/ec2/instances/launch",
        check: ({ topo }) => topo.ofType("ec2").some((e) => e.config.state === "running" && topo.securityGroupsOf(e.id).some((g) => !g.config.isDefault)),
      },
      {
        id: "db-subnets",
        title: "DB용 프라이빗 서브넷 2개",
        instruction: "같은 VPC의 서로 다른 가용 영역에 DB용 서브넷 2개를 만드세요. IGW 경로가 없는 프라이빗 서브넷이어야 합니다.",
        hint: "예: 10.0.21.0/24(2a), 10.0.22.0/24(2c).",
        consolePath: "/vpc/subnets/create",
        check: ({ topo }) => azCount(privateSubnets(topo)) >= 2,
      },
      {
        id: "dbsg",
        title: "DB 서브넷 그룹 생성",
        instruction: "RDS 콘솔의 서브넷 그룹에서 두 프라이빗 서브넷으로 DB 서브넷 그룹을 만드세요.",
        hint: "가용 영역을 먼저 고른 뒤 서브넷을 선택합니다.",
        consolePath: "/rds/subnet-groups/create",
        check: ({ topo }) =>
          topo.ofType("db-subnet-group").some((g) => {
            const subs = topo.dbSubnetGroupSubnets(g.id);
            return subs.length >= 2 && azCount(subs) >= 2 && subs.every((s) => topo.classifySubnet(s.id).kind !== "public");
          }),
      },
      {
        id: "db-sg",
        title: "DB 보안 그룹",
        instruction: "DB용 보안 그룹을 만들고 인바운드 MYSQL/Aurora(3306)를 소스 유형 '보안 그룹' → 앱 서버의 보안 그룹으로 허용하세요.",
        hint: "CIDR 대신 보안 그룹을 참조하면 앱 서버 IP가 바뀌어도 규칙을 고칠 필요가 없습니다.",
        consolePath: "/vpc/security-groups/create",
        check: ({ topo }) =>
          userSecurityGroups(topo).some((g) =>
            g.config.inboundRules.some((r) => r.peer.kind === "security-group" && (r.protocol === "all" || (r.protocol === "tcp" && r.fromPort <= 3306 && r.toPort >= 3306))),
          ),
      },
      {
        id: "rds",
        title: "데이터베이스 생성",
        instruction: "MySQL 데이터베이스를 만드세요. DB 서브넷 그룹과 DB 보안 그룹을 고르고 퍼블릭 액세스는 '아니요'로 둡니다. '사용 가능'이 될 때까지 기다립니다.",
        hint: "이 시뮬레이터는 마스터 암호를 받지 않습니다.",
        consolePath: "/rds/databases/create",
        check: ({ topo }) =>
          topo
            .ofType("rds")
            .some(
              (r) =>
                r.config.state === "available" &&
                !r.config.publiclyAccessible &&
                !!topo.dbSubnetGroupOf(r.id) &&
                topo.securityGroupsOf(r.id).some((sg) => sg.config.inboundRules.some((rule) => rule.peer.kind === "security-group")),
            ),
      },
      {
        id: "connect",
        title: "앱 → DB 연결 분석",
        instruction: "Reachability Analyzer에서 소스 '앱 서버 인스턴스', 대상 'RDS DB 인스턴스', TCP 3306을 분석해 '도달 가능'을 확인하세요. (실제 SQL은 실행되지 않습니다)",
        hint: "실패하면 DNS 확인(VPC 설정), 라우팅, 보안 그룹 단계를 확인하세요.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) => analyzedPath(ctx, (r) => r.source.kind === "resource" && ctx.topo.get(r.source.resourceId)?.type === "ec2" && destinationIs(r, "rds", ctx.topo)),
        simulation: ({ topo }) => appToDbRequest(topo),
      },
      {
        id: "private",
        title: "외부 노출 없음 확인",
        instruction: "인터넷에서 DB에 접근할 수 없고, DB 보안 그룹에 0.0.0.0/0 허용 규칙이 없는지 확인하세요.",
        hint: "구성 검사에 RDS-006/RDS-007 항목이 없어야 합니다.",
        consolePath: "/checks",
        check: (ctx) => {
          const rds = ctx.topo.ofType("rds");
          return rds.length > 0 && !hasRule(ctx, "RDS-006") && !hasRule(ctx, "RDS-007") && rds.every((r) => ctx.simulate(internetTo(r.id, r.config.port)).outcome !== "success");
        },
      },
    ],
  },
  {
    id: "lab-5-security",
    order: 5,
    title: "보안 오류 해결",
    level: "중급",
    summary: "일부러 잘못된 규칙이 들어 있는 쇼핑몰 아키텍처입니다. 구성 검사와 Reachability Analyzer로 문제를 직접 찾아 고치세요.",
    objectives: ["구성 검사 결과에서 원인 찾기", "보안 위험(경고)과 통신 실패(오류) 구분", "네트워크 ACL 응답 트래픽(임시 포트) 이해"],
    createStarter: createLab5Starter,
    steps: [
      {
        id: "ssh",
        title: "문제 1: 관리 포트 노출",
        instruction: "구성 검사에서 보안 경고를 찾아 관리용 포트가 인터넷 전체에 열려 있지 않게 고치세요.",
        hint: "SEC-002: 보안 그룹 app-sg → 인바운드 규칙 편집에서 SSH(22) 규칙의 소스를 관리자 대역(예: 203.0.113.0/24)으로 바꾸거나 삭제하세요.",
        consolePath: "/checks",
        check: (ctx) => !hasRule(ctx, "SEC-002"),
      },
      {
        id: "db-exposure",
        title: "문제 2: DB 과다 허용",
        instruction: "데이터베이스 보안 그룹의 과도한 허용 규칙을 고치세요. 애플리케이션 서버는 계속 DB에 연결할 수 있어야 합니다.",
        hint: "RDS-006/SEC-003: db-sg의 3306 규칙 소스를 '보안 그룹' → app-sg로 바꾸세요.",
        consolePath: "/vpc/security-groups",
        check: (ctx) => !hasRule(ctx, "RDS-006") && !hasRule(ctx, "SEC-003") && succeeds(ctx, appToDbRequest(ctx.topo)),
        simulation: ({ topo }) => appToDbRequest(topo),
      },
      {
        id: "targets",
        title: "문제 3: 비정상 대상",
        instruction: "대상 그룹 shop-tg의 두 인스턴스가 모두 healthy가 되도록 고치세요.",
        hint: "ELB-005: app-sg가 ALB에서 오는 대상 포트(80)를 허용하지 않습니다. 8080 규칙을 80으로 바꾸세요.",
        consolePath: "/ec2/target-groups",
        check: ({ topo, health }) => topo.ofType("target-group").some((tg) => (health.get(tg.id) ?? []).filter((h) => h.state === "healthy").length >= 2),
      },
      {
        id: "alb-port",
        title: "문제 4: ALB 접근 불가",
        instruction: "인터넷에서 ALB 리스너(HTTP:80)로 요청이 들어오도록 고치세요.",
        hint: "ELB-009: alb-sg 인바운드에 HTTP(80) ← Anywhere-IPv4 규칙이 없습니다.",
        consolePath: "/vpc/security-groups",
        check: ({ topo }) => internetFacingAlbs(topo).some((a) => allowsInboundFromInternet(topo, a.id, 80)),
      },
      {
        id: "nacl",
        title: "문제 5: 응답이 돌아오지 않음",
        instruction: "요청은 ALB에 도착하지만 응답이 클라이언트로 돌아가지 못합니다. 원인을 찾아 고치세요.",
        hint: "SEC-010: 네트워크 ACL public-nacl의 아웃바운드에 사용자 지정 TCP 1024-65535 → 0.0.0.0/0 허용 규칙을 추가하세요 (네트워크 ACL은 상태 비저장).",
        consolePath: "/vpc/network-acls",
        check: (ctx) => !ctx.findings.some((f) => f.ruleId === "SEC-010" && f.severity === "warning"),
      },
      {
        id: "verify",
        title: "최종 확인",
        instruction: "구성 검사에 오류가 없고, Reachability Analyzer에서 '인터넷 → 로드 밸런서 TCP 80' 분석이 '도달 가능'인지 확인하세요.",
        hint: "남은 오류가 있으면 구성 검사의 관련 리소스 링크로 이동해 고치세요.",
        consolePath: "/vpc/reachability/create",
        check: (ctx) => !ctx.findings.some((f) => f.severity === "error") && analyzedPath(ctx, (r) => r.source.kind === "internet" && destinationIs(r, "alb", ctx.topo)),
        simulation: ({ topo }) => albRequest(topo),
      },
    ],
  },
];

/** 쉬운 모드(그림 빌더)에서 보여 줄 단계 안내. 판정 기준은 두 모드가 같다. */
const EASY_INSTRUCTIONS: Record<string, Record<string, string>> = {
  "lab-1-public-ec2": {
    vpc: "왼쪽 팔레트에서 VPC를 클릭하거나 캔버스로 끌어다 놓으세요. 오른쪽 설정 패널에서 CIDR(예: 10.0.0.0/16)을 확인·수정할 수 있습니다.",
    subnet: "서브넷을 VPC 영역 위에 놓으세요(자동으로 VPC에 연결됩니다). 서브넷 CIDR이 VPC 범위 안에 있어야 합니다.",
    igw: "Internet Gateway를 추가하고 VPC와 선으로 연결하세요. 노드 아래쪽 점을 다른 노드의 위쪽 점으로 끌면 연결됩니다.",
    route: "Route Table을 추가해 VPC와 연결한 뒤, Route Table → Internet Gateway를 이어 0.0.0.0/0 경로를 만들고, Route Table → 서브넷을 이어 서로 연결하세요.",
    sg: "Security Group을 추가해 VPC와 연결하고, 설정 패널의 인바운드 규칙에 TCP 80 ← 0.0.0.0/0을 추가하세요.",
    ec2: "EC2를 퍼블릭 서브넷 위에 놓고, 설정 패널에서 퍼블릭 IPv4를 '활성화'로 바꾸고, 가상 서비스 포트에 80이 있는지 확인한 뒤 보안 그룹과 선으로 연결하세요.",
    analyze: "아래 '시뮬레이션' 탭에서 출발지 '인터넷', 목적지 EC2, TCP 80으로 실행해 성공하는지 확인하세요.",
  },
  "lab-2-private-nat": {
    "public-network": "VPC, 서브넷, Internet Gateway, Route Table(0.0.0.0/0 → IGW)로 퍼블릭 서브넷을 먼저 만드세요.",
    "private-subnet": "같은 VPC에 두 번째 서브넷을 추가하세요. IGW 경로가 있는 Route Table과는 연결하지 않습니다.",
    eip: "팔레트에서 Elastic IP를 추가하세요.",
    nat: "NAT Gateway를 퍼블릭 서브넷 위에 놓고, Elastic IP → NAT Gateway를 선으로 연결하세요. 상태가 Available인지 확인하세요.",
    "private-route": "새 Route Table을 추가해 NAT Gateway와 연결(0.0.0.0/0)하고 프라이빗 서브넷과 연결하세요.",
    "private-ec2": "EC2를 프라이빗 서브넷에 놓고 퍼블릭 IPv4를 '비활성화'로 두세요. 보안 그룹도 연결합니다.",
    egress: "시뮬레이션 탭에서 출발지 '프라이빗 EC2', 목적지 '인터넷', TCP 443을 실행해 NAT를 거치는 경로를 확인하세요.",
    compare: "시뮬레이션 탭에서 출발지 '인터넷', 목적지 '프라이빗 EC2', TCP 80을 실행해 실패하는지 확인하세요.",
  },
  "lab-3-alb": {
    network: "VPC와 Internet Gateway를 만들고, 서로 다른 가용 영역(2a, 2c)에 퍼블릭 서브넷 2개를 만들어 IGW 경로가 있는 Route Table과 연결하세요.",
    servers: "EC2 두 대를 서로 다른 가용 영역의 서브넷에 놓으세요. 가상 서비스 포트에 80이 있어야 합니다.",
    "alb-sg": "ALB용 Security Group을 추가해 인바운드 TCP 80 ← 0.0.0.0/0 규칙을 넣으세요.",
    tg: "Target Group을 추가하고 Target Group → EC2 두 대를 선으로 이어 대상으로 등록하세요.",
    alb: "ALB를 추가해 두 퍼블릭 서브넷, ALB 보안 그룹과 연결하고, ALB → Target Group을 이어 리스너가 요청을 전달하게 하세요.",
    healthy: "웹 서버 보안 그룹의 인바운드에 TCP 80 ← ALB 보안 그룹(보안 그룹 참조) 규칙을 추가하세요.",
    distribute: "시뮬레이션 탭에서 '인터넷 → ALB'를 요청 수 6으로 실행해 두 EC2에 나뉘는지 확인하세요.",
  },
  "lab-4-rds": {
    app: "VPC와 서브넷을 만들고, 직접 만든 보안 그룹을 연결한 EC2(앱 서버)를 배치하세요.",
    "db-subnets": "서로 다른 가용 영역에 DB용 서브넷 2개를 추가하세요. IGW 경로는 연결하지 않습니다.",
    dbsg: "DB Subnet Group을 추가해 두 DB 서브넷과 선으로 연결하세요.",
    "db-sg": "DB용 Security Group의 인바운드에 TCP 3306 ← 앱 서버 보안 그룹(보안 그룹 참조)을 추가하세요.",
    rds: "RDS를 추가해 DB Subnet Group과 DB 보안 그룹에 연결하세요. Publicly Accessible은 끈 상태로 둡니다.",
    connect: "시뮬레이션 탭에서 출발지 앱 EC2, 목적지 RDS, TCP 3306을 실행하세요.",
    private: "검증 탭에 RDS-006/RDS-007 항목이 없는지 확인하세요.",
  },
  "lab-5-security": {
    ssh: "검증 탭의 SEC-002 항목을 누르면 app-sg로 이동합니다. 설정 패널에서 SSH(22) 규칙의 출발지를 좁히거나 삭제하세요.",
    "db-exposure": "db-sg의 3306 규칙 출발지를 0.0.0.0/0 대신 app-sg(보안 그룹 참조)로 바꾸세요.",
    targets: "app-sg의 8080 규칙을 80으로 바꿔 ALB의 헬스 체크와 요청이 들어오게 하세요.",
    "alb-port": "alb-sg 인바운드에 TCP 80 ← 0.0.0.0/0 규칙을 추가하세요.",
    nacl: "public-nacl의 아웃바운드에 TCP 1024-65535 → 0.0.0.0/0 허용 규칙을 추가하세요 (NACL은 응답도 따로 허용해야 합니다).",
    verify: "검증 탭에 오류가 없고, 시뮬레이션 탭의 '인터넷 → ALB' 요청이 성공하는지 확인하세요.",
  },
};

export function easyInstruction(labId: string, step: LabStep): string {
  return EASY_INSTRUCTIONS[labId]?.[step.id] ?? step.instruction;
}

export function labById(id: string | null | undefined): LabDefinition | undefined {
  return LABS.find((l) => l.id === id);
}
