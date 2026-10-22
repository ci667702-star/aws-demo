/**
 * 종단 간 통신 가능성 분석.
 *
 * 출발지와 목적지가 주어지면 다음 순서로 가상 패킷의 이동을 계산한다.
 *  1. 출발지/목적지 존재 및 상태 확인, 목적지 주소 결정(가상 DNS 포함)
 *  2. 출발지 보안 그룹 아웃바운드 → 서브넷 라우팅 테이블(Longest Prefix Match)
 *  3. 서브넷 경계의 Network ACL (상태 비저장, 요청/응답 각각 평가)
 *  4. Internet Gateway(1:1 주소 변환) / NAT Gateway(SNAT) 경로
 *  5. 목적지 보안 그룹 인바운드 (상태 저장 — 응답은 자동 허용)
 *  6. 목적지 서비스(가상 EC2 서비스 포트, RDS 포트, ALB 리스너 → 대상 그룹 → 대상)
 *  7. 응답 경로 (NACL 재평가, 응답 라우팅)
 *
 * 실제 패킷이나 HTTP 요청을 보내지 않으며, 모든 결과는 입력 설정으로부터 결정적으로 계산된다.
 */
import {
  computeTargetHealth,
  pickRoundRobin,
  routableTargets,
  TARGET_STATE_LABEL,
  type ProbeArgs,
  type ProbeResult,
  type TargetHealth,
} from "./alb-engine";
import { awsReservedReason, formatIpv4, isPublicRoutableIp, parseIpv4, tryParseCidr, cidrContainsIp } from "./cidr-utils";
import { evaluateNacl } from "./network-acl-engine";
import { RESOURCE_TYPE_INFO, type Project } from "./resource-models";
import { selectRoute } from "./route-engine";
import { describeSgRule, evaluateSecurityGroups, type Direction, type PacketProtocol } from "./security-group-engine";
import {
  SimulationHalt,
  SimulationLog,
  type FailureInfo,
  type PathHop,
  type SimStep,
} from "./simulation-log";
import { buildTopology, Topology, VIRTUAL_PUBLIC_POOL, type EffectiveRoute, type Eni } from "./topology-engine";

export type EndpointSpec =
  | { kind: "internet"; ip: string }
  | { kind: "resource"; resourceId: string; addressing?: "auto" | "private" | "public" };

export interface SimulationRequest {
  source: EndpointSpec;
  destination: EndpointSpec;
  protocol: PacketProtocol;
  /** 목적지 포트 (ICMP는 무시) */
  port: number;
  /** 응답 트래픽이 사용하는 임시 포트 (기본 50000) */
  ephemeralPort?: number;
  /** ALB 목적지일 때 분산 확인을 위한 요청 수 (기본 1) */
  requestCount?: number;
}

export type SimulationOutcome = "success" | "failure" | "invalid-request" | "engine-error";

export interface DistributionEntry {
  targetId: string;
  targetName: string;
  requests: number;
  successes: number;
}

export interface SimulationResult {
  outcome: SimulationOutcome;
  summary: string;
  request: SimulationRequest;
  sourceLabel: string;
  destinationLabel: string;
  steps: SimStep[];
  path: PathHop[];
  failure: FailureInfo | null;
  distribution: DistributionEntry[] | null;
  /** 단일 요청에서 ALB가 선택한 대상 */
  selectedTargetId: string | null;
  assumptions: string[];
  truncated: boolean;
  errorMessage?: string;
}

export const DEFAULT_EPHEMERAL_PORT = 50000;
export const DEFAULT_INTERNET_CLIENT_IP = "203.0.113.10";
export const DEFAULT_INTERNET_HOST_IP = "203.0.113.200";
export const MAX_REQUEST_COUNT = 100;

export const SIMULATION_ASSUMPTIONS = [
  "실제 패킷이나 HTTP/SQL 요청을 보내지 않습니다. 모든 결과는 설정값으로부터 계산한 가상 결과입니다.",
  "IPv4만 지원합니다. IPv6, VPC 피어링, Transit Gateway, VPN, VPC 엔드포인트, 프리픽스 목록은 구현되지 않았습니다.",
  "서브넷에 명시적으로 연결된 NACL이 없으면 VPC 기본 NACL(모든 트래픽 허용)을 사용한다고 가정합니다.",
  "서브넷에 명시적으로 연결된 라우팅 테이블이 없으면 VPC의 기본(main) 라우팅 테이블을 사용하며, 지정된 기본 테이블이 없으면 local 경로만 있다고 가정합니다.",
  "응답 트래픽의 임시 포트는 하나의 값으로 단순화합니다. 실제 클라이언트·NAT·ALB는 1024-65535 범위의 포트를 사용할 수 있습니다.",
  "인터넷의 가상 외부 호스트는 요청한 포트에서 응답한다고 가정합니다.",
  "EC2는 설정된 '가상 서비스 포트'에서만 응답한다고 가정합니다. 실제 운영체제나 프로세스는 실행되지 않습니다.",
  "ALB는 교차 영역 로드 밸런싱이 켜져 있고 라운드 로빈으로 대상을 선택한다고 가정합니다. 리스너 규칙(경로 기반 라우팅)은 지원하지 않습니다.",
];

const CONCEPT = {
  sg: "보안 그룹은 네트워크 인터페이스 단위의 상태 저장형(Stateful) 방화벽입니다. 허용 규칙만 있으며 일치하는 규칙이 없으면 거부됩니다. 허용된 연결의 응답은 규칙과 관계없이 자동으로 허용됩니다.",
  nacl: "Network ACL은 서브넷 경계의 상태 비저장형(Stateless) 방화벽입니다. 규칙 번호가 낮은 순서로 평가해 처음 일치한 규칙(허용/거부)을 적용하며, 요청과 응답을 따로 평가하므로 응답이 쓰는 임시 포트(1024-65535)도 허용해야 합니다.",
  route: "라우팅 테이블은 목적지 IP를 포함하는 경로 중 가장 구체적인(접두사가 가장 긴) 경로를 사용합니다. VPC CIDR에 대한 local 경로는 항상 존재합니다.",
  igw: "인터넷 게이트웨이는 VPC에 연결(Attach)되어 있어야 하며, 퍼블릭 IPv4 주소가 있는 인터페이스에 대해 사설 IP ↔ 퍼블릭 IP 1:1 변환을 수행합니다. 라우팅 테이블에 IGW로 향하는 경로가 있는 서브넷이 퍼블릭 서브넷입니다.",
  nat: "NAT 게이트웨이는 프라이빗 서브넷 리소스의 아웃바운드 연결을 자신의 Elastic IP로 변환(SNAT)합니다. NAT는 퍼블릭 서브넷에 있어야 하며 외부에서 시작된 인바운드 연결은 받지 않습니다.",
  alb: "ALB는 리스너(프로토콜:포트)로 요청을 받고, 리스너의 기본 작업에 따라 대상 그룹의 정상(Healthy) 대상 중 하나로 요청을 전달합니다.",
  dns: "VPC의 DNS 확인(enableDnsSupport)이 켜져 있어야 VPC 안에서 Amazon 제공 DNS로 ALB/RDS 엔드포인트 이름을 해석할 수 있습니다.",
  state: "인스턴스는 Running 상태일 때만 요청을 처리합니다. Stopped 상태에서는 퍼블릭 IP도 해제되며, Terminated 인스턴스는 다시 시작할 수 없습니다.",
};

interface Packet {
  protocol: PacketProtocol;
  port: number | null;
  ephemeralPort: number;
}

interface Ctx {
  topo: Topology;
  log: SimulationLog;
  requestIndex: number;
  healthCache: Map<string, TargetHealth[]>;
  selectedTargetId: string | null;
  ephemeralPort: number;
}

type Origin = { kind: "internet"; ip: number } | { kind: "eni"; eni: Eni };

const ip = (n: number | null | undefined) => (n === null || n === undefined ? "(없음)" : formatIpv4(n));
const protoLabel = (p: Packet) => (p.protocol === "icmp" ? "ICMP" : `${p.protocol.toUpperCase()} ${p.port}`);
const responsePort = (p: Packet) => (p.protocol === "icmp" ? null : p.ephemeralPort);

function inPhase<T>(ctx: Ctx, phase: "request" | "service" | "response", fn: () => T): T {
  return ctx.log.withSegment(ctx.log.segment, phase, fn);
}

// ---------------------------------------------------------------- 공통 검사

function checkSecurityGroups(
  ctx: Ctx,
  eni: Eni,
  direction: Direction,
  peerIp: number,
  peerSecurityGroupIds: string[],
  pkt: Packet,
): void {
  if (eni.securityGroupIds === null) return;
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const groups = eni.securityGroupIds
    .map((id) => topo.getOfType(id, "security-group"))
    .filter((g): g is NonNullable<typeof g> => !!g);
  const dirLabel = direction === "inbound" ? "인바운드" : "아웃바운드";
  if (groups.length === 0) {
    log.fail({
      kind: "security-group",
      category: "security-group",
      title: `${eni.label}에 연결된 보안 그룹이 없음`,
      reason: `${eni.label}에 보안 그룹이 연결되어 있지 않아 ${dirLabel} 트래픽을 허용할 규칙이 없습니다.`,
      detail: "시뮬레이터는 보안 그룹이 없는 인터페이스의 트래픽을 모두 거부합니다. (실제 AWS에서는 인터페이스에 항상 하나 이상의 보안 그룹이 연결됩니다.)",
      resourceIds: [eni.ownerId],
      fixes: [`${eni.label}을(를) 같은 VPC의 보안 그룹과 연결하세요.`],
      concept: CONCEPT.sg,
    });
  }
  const decision = evaluateSecurityGroups(groups, direction, {
    protocol: pkt.protocol,
    port: pkt.port,
    peerIp,
    peerSecurityGroupIds,
  });
  const rules = decision.evaluations.map((e) => ({
    label: `${e.securityGroupName}: ${describeSgRule(e.rule, (id) => topo.name(id))}`,
    note: e.note,
    matched: e.matches,
    decisive: e === decision.matched,
  }));
  const groupNames = groups.map((g) => g.name).join(", ");
  const peerWord = direction === "inbound" ? "출발지" : "목적지";
  if (decision.allowed) {
    log.pass({
      kind: "security-group",
      title: `보안 그룹 ${dirLabel} 허용 — ${eni.label}`,
      detail: `${protoLabel(pkt)}, ${peerWord} ${ip(peerIp)} → 규칙 "${rules.find((r) => r.decisive)?.label}"과(와) 일치`,
      resourceIds: [...groups.map((g) => g.id), eni.ownerId],
      rules,
      concept: CONCEPT.sg,
    });
    return;
  }
  const fix =
    direction === "inbound"
      ? `${groupNames}의 인바운드 규칙에 ${protoLabel(pkt)} 허용 규칙을 추가하세요 (출발지: ${ip(peerIp)}를 포함하는 CIDR${peerSecurityGroupIds.length ? " 또는 출발지의 보안 그룹" : ""}).`
      : `${groupNames}의 아웃바운드 규칙에 ${protoLabel(pkt)} (목적지 ${ip(peerIp)}) 허용 규칙을 추가하세요.`;
  log.fail({
    kind: "security-group",
    category: "security-group",
    title: `보안 그룹 ${dirLabel} 거부 — ${eni.label}`,
    reason: `${eni.label}의 보안 그룹(${groupNames})에 ${protoLabel(pkt)} ${peerWord} ${ip(peerIp)}을(를) 허용하는 ${dirLabel} 규칙이 없습니다.`,
    detail: rules.length ? "일치하는 허용 규칙이 없어 암묵적으로 거부되었습니다." : `${dirLabel} 규칙이 하나도 없습니다.`,
    resourceIds: [...groups.map((g) => g.id), eni.ownerId],
    rules,
    fixes: [fix],
    concept: CONCEPT.sg,
  });
}

function checkNacl(
  ctx: Ctx,
  subnetId: string,
  direction: Direction,
  peerIp: number,
  protocol: PacketProtocol,
  port: number | null,
  purpose: string,
  isResponse: boolean,
): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const nacl = topo.naclOf(subnetId);
  const rules = nacl ? (direction === "inbound" ? nacl.config.inboundRules : nacl.config.outboundRules) : "default";
  const decision = evaluateNacl(rules, direction, { protocol, port, peerIp });
  const naclLabel = nacl ? topo.label(nacl.id) : "기본 NACL (모두 허용, 가정)";
  const dirLabel = direction === "inbound" ? "인바운드" : "아웃바운드";
  const portText = protocol === "icmp" ? "ICMP" : `${protocol.toUpperCase()} ${port}`;
  const rows = decision.evaluations.map((e) => ({
    label: e.label,
    note: e.note,
    matched: e.matches,
    decisive: e.matches,
  }));
  const subject = `${naclLabel} ${dirLabel} — 서브넷 ${topo.name(subnetId)}`;
  const detail = `${purpose}: ${portText}, 상대 ${ip(peerIp)}`;
  if (decision.allowed) {
    log.pass({
      kind: "network-acl",
      title: `NACL ${dirLabel} 허용 — ${topo.name(subnetId)}`,
      detail: `${detail} (${naclLabel})`,
      resourceIds: [nacl?.id, subnetId],
      rules: rows,
      concept: CONCEPT.nacl,
    });
    return;
  }
  const deciding = decision.decidingRule ? `규칙 #${decision.decidingRule.ruleNumber} DENY` : "마지막 * 규칙(기본 거부)";
  const fixes = [
    isResponse
      ? `${naclLabel}의 ${dirLabel} 규칙에 응답용 임시 포트(예: ${protocol === "icmp" ? "ICMP" : `${protocol.toUpperCase()} 1024-65535`}) 허용 규칙을 추가하세요. NACL은 상태 비저장형이라 응답도 별도로 허용해야 합니다.`
      : `${naclLabel}의 ${dirLabel} 규칙에 ${portText} (상대 ${ip(peerIp)} 포함 CIDR) 허용 규칙을, 차단하는 규칙보다 낮은 번호로 추가하세요.`,
  ];
  if (decision.decidingRule) {
    fixes.push(`또는 규칙 #${decision.decidingRule.ruleNumber}(DENY)의 범위를 조정하거나 삭제하세요.`);
  }
  log.fail({
    kind: "network-acl",
    category: "network-acl",
    title: `NACL ${dirLabel} 거부 — ${topo.name(subnetId)}${isResponse ? " (응답)" : ""}`,
    reason: `${subject}에서 ${portText}(상대 ${ip(peerIp)}) 트래픽이 ${deciding}에 의해 차단되었습니다.${isResponse ? " 요청은 통과했지만 응답이 막혔습니다." : ""}`,
    detail,
    resourceIds: [nacl?.id, subnetId],
    rules: rows,
    fixes,
    concept: CONCEPT.nacl,
  });
}

function sgStatefulNote(ctx: Ctx, eni: Eni): void {
  if (eni.securityGroupIds === null || eni.securityGroupIds.length === 0) return;
  ctx.log.info({
    kind: "security-group",
    title: `보안 그룹은 상태 저장형 — ${eni.label}의 응답 자동 허용`,
    detail: "허용된 요청에 대한 응답 트래픽은 보안 그룹 규칙을 다시 평가하지 않습니다. (NACL과의 차이)",
    resourceIds: eni.securityGroupIds,
    concept: CONCEPT.sg,
  });
}

function lookupRoute(ctx: Ctx, eni: Eni, destination: number): EffectiveRoute {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  if (!eni.subnetId) {
    log.fail({
      kind: "route",
      category: "configuration",
      title: `${eni.label}이(가) 서브넷에 배치되지 않음`,
      resourceIds: [eni.ownerId],
      fixes: [`${eni.label}을(를) 서브넷과 연결하세요.`],
    });
  }
  const routing = topo.subnetRouting(eni.subnetId);
  const decision = selectRoute(routing.routes, destination);
  const tableId =
    routing.table.kind === "explicit" || routing.table.kind === "main" ? routing.table.routeTableId : null;
  const rules = decision.evaluations.map((e) => ({
    label: `${e.route.destinationCidr} → ${topo.routeTargetLabel(e.route)}`,
    note: e.note,
    matched: e.matches,
    decisive: e.route === decision.route,
  }));
  const tableLabel = topo.routeTableLabel(routing.table);
  if (!decision.route) {
    log.fail({
      kind: "route",
      category: "routing",
      title: `${ip(destination)}(으)로 향하는 경로 없음 — ${topo.name(eni.subnetId)}`,
      reason: `서브넷 ${topo.name(eni.subnetId)}의 라우팅 테이블(${tableLabel})에 ${ip(destination)}을(를) 포함하는 경로가 없습니다.`,
      detail: `라우팅 테이블: ${tableLabel}`,
      resourceIds: [tableId, eni.subnetId],
      rules,
      fixes: isPublicRoutableIp(destination)
        ? [
            "퍼블릭 서브넷: 라우팅 테이블에 0.0.0.0/0 → Internet Gateway 경로를 추가하세요 (IGW는 VPC에 연결되어 있어야 함).",
            "프라이빗 서브넷: 퍼블릭 서브넷에 NAT Gateway를 두고 0.0.0.0/0 → NAT Gateway 경로를 추가하세요.",
          ]
        : ["목적지가 다른 VPC의 사설 주소라면 퍼블릭 IP나 ALB를 사용하세요. (VPC 피어링은 이 시뮬레이터에서 지원하지 않습니다.)"],
      concept: CONCEPT.route,
    });
  }
  const route = decision.route;
  log.pass({
    kind: "route",
    title: `라우팅 결정 — ${topo.name(eni.subnetId)}: ${route.destinationCidr} → ${topo.routeTargetLabel(route)}`,
    detail: `${ip(destination)}에 대해 ${tableLabel}에서 가장 구체적인 경로(/${route.cidr?.prefix})를 선택했습니다.`,
    resourceIds: [tableId, eni.subnetId, route.targetId],
    connectionIds: [route.connectionId],
    rules,
    concept: CONCEPT.route,
  });
  return route;
}

// ---------------------------------------------------------------- 전달 경로

function transmit(ctx: Ctx, origin: Origin, destination: number, pkt: Packet, segment: string): void {
  ctx.log.withSegment(segment, "request", () => {
    if (origin.kind === "internet") {
      ctx.log.hop(null, `인터넷 ${ip(origin.ip)}`, "internet");
      deliverOnInternet(ctx, origin.ip, destination, pkt);
    } else {
      fromEni(ctx, origin.eni, destination, pkt);
    }
  });
}

function fromEni(ctx: Ctx, src: Eni, destination: number, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  if (src.privateIp === null) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `${src.label}에 사설 IP가 없음`,
      reason: `${src.label}의 서브넷 CIDR이 올바르지 않거나 사용할 수 있는 주소가 없어 사설 IP를 결정할 수 없습니다.`,
      resourceIds: [src.ownerId, src.subnetId],
      fixes: ["서브넷의 CIDR 설정을 확인하세요."],
    });
  }
  // SG 참조 규칙을 위해 VPC 내부 목적지 인터페이스를 미리 확인한다 (로그 없음).
  let peerSgs: string[] = [];
  if (src.subnetId && src.vpcId) {
    const quick = selectRoute(topo.subnetRouting(src.subnetId).routes, destination);
    if (quick.route?.targetKind === "local") {
      peerSgs = topo.eniByPrivateIp(src.vpcId, destination)?.securityGroupIds ?? [];
    }
  }
  if (src.ownerType !== "alb") {
    log.hop(src.ownerId, src.label);
    if (src.subnetId) log.hop(src.subnetId, `Subnet ${topo.name(src.subnetId)}`);
  }
  checkSecurityGroups(ctx, src, "outbound", destination, peerSgs, pkt);
  const route = lookupRoute(ctx, src, destination);
  if (route.targetKind === "local") deliverLocal(ctx, src, destination, pkt);
  else if (route.targetKind === "internet-gateway") egressViaIgw(ctx, src, route, destination, pkt);
  else egressViaNat(ctx, src, route, destination, pkt);
}

function deliverLocal(ctx: Ctx, src: Eni, destination: number, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const dst = src.vpcId ? topo.eniByPrivateIp(src.vpcId, destination) : undefined;
  if (!dst) {
    log.fail({
      kind: "route",
      category: "routing",
      title: `VPC 안에 ${ip(destination)}을(를) 사용하는 리소스가 없음`,
      reason: `local 경로로 전달했지만 VPC ${topo.name(src.vpcId)}에서 ${ip(destination)} 주소를 가진 가상 인터페이스를 찾지 못했습니다.`,
      resourceIds: [src.vpcId],
      fixes: ["목적지 리소스의 사설 IP와 서브넷 배치를 확인하세요."],
    });
  }
  const crossing = src.subnetId !== dst.subnetId;
  log.pass({
    kind: "route",
    title: `VPC 내부 전달 (local): ${src.label} → ${dst.label}`,
    detail: crossing ? "서로 다른 서브넷 사이의 통신이므로 양쪽 서브넷의 NACL을 평가합니다." : "같은 서브넷 내부 통신입니다.",
    resourceIds: [src.ownerId, dst.ownerId],
  });
  if (crossing && src.subnetId && dst.subnetId) {
    checkNacl(ctx, src.subnetId, "outbound", destination, pkt.protocol, pkt.port, "요청이 출발지 서브넷을 나감", false);
    log.hop(dst.subnetId, `Subnet ${topo.name(dst.subnetId)}`);
    checkNacl(ctx, dst.subnetId, "inbound", src.privateIp!, pkt.protocol, pkt.port, "요청이 목적지 서브넷으로 들어옴", false);
  } else {
    log.info({
      kind: "network-acl",
      title: "같은 서브넷 내부 통신 — NACL 평가 생략",
      detail: "Network ACL은 서브넷 경계를 넘는 트래픽에만 적용됩니다.",
      resourceIds: [dst.subnetId],
      concept: CONCEPT.nacl,
    });
  }
  checkSecurityGroups(ctx, dst, "inbound", src.privateIp!, src.securityGroupIds ?? [], pkt);
  log.hop(dst.ownerId, dst.label);
  inPhase(ctx, "service", () => serve(ctx, dst, pkt));
  inPhase(ctx, "response", () => {
    sgStatefulNote(ctx, dst);
    if (crossing && src.subnetId && dst.subnetId) {
      checkNacl(ctx, dst.subnetId, "outbound", src.privateIp!, pkt.protocol, responsePort(pkt), "응답이 목적지 서브넷을 나감 (임시 포트)", true);
      checkNacl(ctx, src.subnetId, "inbound", destination, pkt.protocol, responsePort(pkt), "응답이 출발지 서브넷으로 들어옴 (임시 포트)", true);
    }
    log.pass({
      kind: "service",
      title: `응답 도착 — ${src.label}`,
      detail: `${dst.label}의 응답이 ${src.label}(${ip(src.privateIp)})에 도착했습니다.`,
      resourceIds: [src.ownerId],
    });
  });
}

function requireAttachedIgw(ctx: Ctx, igwId: string | null, vpcId: string | null, purpose: string) {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const igw = topo.getOfType(igwId, "internet-gateway");
  if (!igw) {
    log.fail({
      kind: "gateway",
      category: "gateway",
      title: "경로의 Internet Gateway가 존재하지 않음 (블랙홀)",
      reason: `${purpose} 경로가 존재하지 않는 Internet Gateway를 가리킵니다.`,
      resourceIds: [vpcId],
      fixes: ["라우팅 테이블의 경로 대상을 VPC에 연결된 Internet Gateway로 수정하세요."],
      concept: CONCEPT.igw,
    });
  }
  if (!topo.igwAttachedTo(igw.id, vpcId)) {
    const attached = topo.vpcOfIgw(igw.id);
    log.fail({
      kind: "gateway",
      category: "gateway",
      title: `${topo.label(igw.id)}이(가) 이 VPC에 연결되지 않음 (블랙홀 경로)`,
      reason: attached
        ? `${topo.label(igw.id)}은(는) 다른 VPC(${topo.name(attached)})에 연결되어 있어 이 VPC의 트래픽을 처리할 수 없습니다.`
        : `${topo.label(igw.id)}이(가) 어떤 VPC에도 연결(Attach)되어 있지 않아 경로가 블랙홀 상태입니다.`,
      resourceIds: [igw.id, vpcId],
      fixes: [`${topo.label(igw.id)}을(를) VPC ${topo.name(vpcId)}에 연결하세요.`],
      concept: CONCEPT.igw,
    });
  }
  return igw;
}

function egressViaIgw(ctx: Ctx, src: Eni, route: EffectiveRoute, destination: number, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const igw = requireAttachedIgw(ctx, route.targetId, src.vpcId, "인터넷");
  if (src.publicIp === null) {
    log.fail({
      kind: "gateway",
      category: "configuration",
      title: `${src.label}에 퍼블릭 IPv4 주소가 없음`,
      reason: `${src.label}에 퍼블릭 IP가 없어 Internet Gateway가 주소 변환을 할 수 없습니다. IGW 경로가 있어도 인터넷과 통신할 수 없습니다.`,
      resourceIds: [src.ownerId, igw.id],
      fixes: [
        "EC2 설정에서 퍼블릭 IPv4 자동 할당을 활성화하거나 서브넷의 퍼블릭 IP 자동 할당을 켜세요.",
        "인스턴스를 프라이빗하게 유지하려면 프라이빗 서브넷 + NAT Gateway 경로를 사용하세요.",
      ],
      concept: CONCEPT.igw,
    });
  }
  checkNacl(ctx, src.subnetId!, "outbound", destination, pkt.protocol, pkt.port, "요청이 서브넷을 나가 IGW로 향함", false);
  log.pass({
    kind: "gateway",
    title: `${topo.label(igw.id)} 통과 — 출발지 주소 변환`,
    detail: `출발지 ${ip(src.privateIp)} → ${ip(src.publicIp)} (가상 퍼블릭 IP, 1:1 NAT)`,
    resourceIds: [igw.id],
    concept: CONCEPT.igw,
  });
  log.hop(igw.id, topo.label(igw.id));
  deliverOnInternet(ctx, src.publicIp, destination, pkt);
  inPhase(ctx, "response", () => {
    log.pass({
      kind: "gateway",
      title: `${topo.label(igw.id)} — 응답 주소 변환`,
      detail: `목적지 ${ip(src.publicIp)} → ${ip(src.privateIp)}`,
      resourceIds: [igw.id],
    });
    checkNacl(ctx, src.subnetId!, "inbound", destination, pkt.protocol, responsePort(pkt), "응답이 서브넷으로 들어옴 (임시 포트)", true);
    sgStatefulNote(ctx, src);
    log.pass({ kind: "service", title: `응답 도착 — ${src.label}`, detail: "인터넷에서 돌아온 응답이 출발지에 도착했습니다.", resourceIds: [src.ownerId] });
  });
}

function egressViaNat(ctx: Ctx, src: Eni, route: EffectiveRoute, destination: number, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const nat = topo.getOfType(route.targetId, "nat-gateway");
  if (!nat) {
    log.fail({
      kind: "nat",
      category: "routing",
      title: "경로의 NAT Gateway가 존재하지 않음 (블랙홀)",
      resourceIds: [src.subnetId],
      fixes: ["라우팅 테이블의 경로 대상을 존재하는 NAT Gateway로 수정하세요."],
      concept: CONCEPT.nat,
    });
  }
  const natEni = topo.enisOf(nat.id)[0];
  if (!natEni?.subnetId) {
    log.fail({
      kind: "nat",
      category: "configuration",
      title: `${topo.label(nat.id)}이(가) 서브넷에 배치되지 않음`,
      resourceIds: [nat.id],
      fixes: [`${topo.label(nat.id)}을(를) 퍼블릭 서브넷에 배치하세요.`],
      concept: CONCEPT.nat,
    });
  }
  if (natEni.vpcId !== src.vpcId) {
    log.fail({
      kind: "nat",
      category: "routing",
      title: `${topo.label(nat.id)}이(가) 다른 VPC에 있음`,
      reason: "라우팅 테이블의 NAT Gateway 대상은 같은 VPC에 있어야 합니다.",
      resourceIds: [nat.id],
      fixes: ["같은 VPC의 퍼블릭 서브넷에 있는 NAT Gateway를 경로 대상으로 지정하세요."],
      concept: CONCEPT.nat,
    });
  }
  if (nat.config.state !== "available") {
    log.fail({
      kind: "nat",
      category: "state",
      title: `${topo.label(nat.id)} 상태가 ${nat.config.state}`,
      reason: `NAT Gateway가 Available 상태가 아니어서(${nat.config.state}) 트래픽을 처리할 수 없습니다.`,
      resourceIds: [nat.id],
      fixes: ["NAT Gateway 상태를 Available로 변경하세요."],
      concept: CONCEPT.nat,
    });
  }
  const crossing = src.subnetId !== natEni.subnetId;
  if (crossing) {
    checkNacl(ctx, src.subnetId!, "outbound", destination, pkt.protocol, pkt.port, "요청이 서브넷을 나가 NAT로 향함", false);
    log.hop(natEni.subnetId, `Subnet ${topo.name(natEni.subnetId)}`);
    checkNacl(ctx, natEni.subnetId, "inbound", src.privateIp!, pkt.protocol, pkt.port, "요청이 NAT 서브넷으로 들어옴", false);
  }
  log.hop(nat.id, topo.label(nat.id));
  log.pass({
    kind: "nat",
    title: `${topo.label(nat.id)} — 출발지 주소 변환 (SNAT)`,
    detail: `출발지 ${ip(src.privateIp)} → ${ip(natEni.publicIp)} (가상 Elastic IP)`,
    resourceIds: [nat.id],
    concept: CONCEPT.nat,
  });
  const natRoute = lookupRoute(ctx, natEni, destination);
  if (natRoute.targetKind !== "internet-gateway") {
    log.fail({
      kind: "nat",
      category: "routing",
      title: `NAT Gateway 서브넷(${topo.name(natEni.subnetId)})에 IGW 경로가 없음`,
      reason:
        natRoute.targetKind === "nat-gateway"
          ? `NAT Gateway가 있는 서브넷의 경로가 다시 NAT Gateway를 가리켜 트래픽이 인터넷으로 나갈 수 없습니다 (경로 루프).`
          : `NAT Gateway가 있는 서브넷의 라우팅이 ${natRoute.destinationCidr} → ${topo.routeTargetLabel(natRoute)}입니다. NAT Gateway는 IGW 경로가 있는 퍼블릭 서브넷에 있어야 합니다.`,
      resourceIds: [nat.id, natEni.subnetId],
      fixes: ["NAT Gateway를 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷에 배치하세요."],
      concept: CONCEPT.nat,
    });
  }
  const igw = requireAttachedIgw(ctx, natRoute.targetId, natEni.vpcId, "NAT 서브넷의 인터넷");
  checkNacl(ctx, natEni.subnetId, "outbound", destination, pkt.protocol, pkt.port, "NAT에서 IGW로 서브넷을 나감", false);
  log.pass({
    kind: "gateway",
    title: `${topo.label(igw.id)} 통과`,
    detail: `NAT의 Elastic IP ${ip(natEni.publicIp)}로 인터넷에 전달됩니다.`,
    resourceIds: [igw.id],
  });
  log.hop(igw.id, topo.label(igw.id));
  if (natEni.publicIp === null) {
    log.fail({ kind: "nat", category: "configuration", title: "NAT Gateway에 가상 Elastic IP가 없음", resourceIds: [nat.id] });
  }
  deliverOnInternet(ctx, natEni.publicIp, destination, pkt);
  inPhase(ctx, "response", () => {
    checkNacl(ctx, natEni.subnetId!, "inbound", destination, pkt.protocol, responsePort(pkt), "응답이 NAT 서브넷으로 들어옴 (임시 포트)", true);
    log.pass({
      kind: "nat",
      title: `${topo.label(nat.id)} — 응답 주소 복원`,
      detail: `목적지 ${ip(natEni.publicIp)} → ${ip(src.privateIp)} (연결 추적 정보 사용)`,
      resourceIds: [nat.id],
    });
    if (crossing) {
      checkNacl(ctx, natEni.subnetId!, "outbound", src.privateIp!, pkt.protocol, responsePort(pkt), "응답이 NAT 서브넷을 나감", true);
      checkNacl(ctx, src.subnetId!, "inbound", destination, pkt.protocol, responsePort(pkt), "응답이 출발지 서브넷으로 들어옴", true);
    }
    sgStatefulNote(ctx, src);
    log.pass({ kind: "service", title: `응답 도착 — ${src.label}`, detail: "NAT Gateway를 거쳐 응답이 도착했습니다.", resourceIds: [src.ownerId] });
  });
}

function deliverOnInternet(ctx: Ctx, from: number, destination: number, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const owner = topo.eniByPublicIp(destination);
  if (owner) {
    log.info({
      kind: "gateway",
      title: "가상 인터넷 구간",
      detail: `${ip(from)} → ${ip(destination)} (프로젝트 내 리소스 ${owner.label}의 가상 퍼블릭 IP)`,
      resourceIds: [owner.ownerId],
    });
    log.hop(null, "인터넷", "internet");
    ingressFromInternet(ctx, from, owner, pkt);
    return;
  }
  if (!isPublicRoutableIp(destination)) {
    log.fail({
      kind: "route",
      category: "routing",
      title: `${ip(destination)}은(는) 인터넷에서 라우팅되지 않는 사설/예약 주소`,
      reason: `${ip(destination)}은(는) 사설 또는 예약된 주소라서 인터넷을 통해 전달할 수 없습니다.`,
      resourceIds: [],
      fixes: [
        "같은 VPC 안이라면 사설 IP와 local 경로로 통신하세요.",
        "internal ALB나 Publicly Accessible이 꺼진 RDS는 인터넷에서 접근할 수 없습니다.",
        "다른 VPC의 리소스라면 퍼블릭 IP나 internet-facing ALB를 사용하세요. (VPC 피어링은 미지원)",
      ],
      concept: CONCEPT.route,
    });
  }
  const pool = tryParseCidr(VIRTUAL_PUBLIC_POOL)!;
  if (cidrContainsIp(pool, destination)) {
    log.fail({
      kind: "route",
      category: "routing",
      title: `가상 퍼블릭 IP ${ip(destination)}을(를) 사용하는 리소스가 없음`,
      reason: `${ip(destination)}은(는) 시뮬레이터의 가상 퍼블릭 IP 대역이지만 현재 이 주소를 가진 리소스가 없습니다.`,
      resourceIds: [],
      fixes: ["목적지 리소스의 퍼블릭 IP 설정과 상태(Running)를 확인하세요."],
    });
  }
  log.hop(null, `인터넷 호스트 ${ip(destination)}`, "internet");
  inPhase(ctx, "service", () => {
    log.pass({
      kind: "service",
      title: `가상 외부 호스트 ${ip(destination)}가 응답 (가정)`,
      detail: `인터넷의 외부 호스트는 ${protoLabel(pkt)} 요청에 응답한다고 가정합니다. 실제 인터넷 연결은 시도하지 않습니다.`,
    });
  });
}

function ingressFromInternet(ctx: Ctx, from: number, dst: Eni, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const igw = dst.vpcId ? topo.igwOfVpc(dst.vpcId) : undefined;
  if (!igw) {
    log.fail({
      kind: "gateway",
      category: "gateway",
      title: `${dst.vpcId ? `VPC ${topo.name(dst.vpcId)}` : "목적지"}에 Internet Gateway가 연결되지 않음`,
      reason: "VPC에 Internet Gateway가 없으면 인터넷에서 들어오는 트래픽을 받을 수 없습니다.",
      resourceIds: [dst.vpcId, dst.ownerId],
      fixes: ["Internet Gateway를 만들고 VPC에 연결(Attach)하세요."],
      concept: CONCEPT.igw,
    });
  }
  log.hop(igw.id, topo.label(igw.id));
  if (dst.ownerType === "nat-gateway") {
    log.fail({
      kind: "nat",
      category: "service",
      title: "NAT Gateway는 인터넷에서 시작된 연결을 받지 않음",
      reason: "NAT Gateway는 아웃바운드 연결 전용입니다. 외부에서 시작된 인바운드 연결은 거부됩니다.",
      resourceIds: [dst.ownerId],
      fixes: ["외부에 서비스를 공개하려면 퍼블릭 서브넷의 EC2나 internet-facing ALB를 사용하세요."],
      concept: CONCEPT.nat,
    });
  }
  log.pass({
    kind: "gateway",
    title: `${topo.label(igw.id)} — 목적지 주소 변환`,
    detail: `목적지 ${ip(dst.publicIp)} → ${dst.label} ${ip(dst.privateIp)}`,
    resourceIds: [igw.id],
    concept: CONCEPT.igw,
  });
  if (!dst.subnetId) {
    log.fail({ kind: "route", category: "configuration", title: `${dst.label}이(가) 서브넷에 없음`, resourceIds: [dst.ownerId] });
  }
  log.hop(dst.subnetId, `Subnet ${topo.name(dst.subnetId)}`);
  checkNacl(ctx, dst.subnetId, "inbound", from, pkt.protocol, pkt.port, "인터넷에서 온 요청이 서브넷으로 들어옴", false);
  checkSecurityGroups(ctx, dst, "inbound", from, [], pkt);
  log.hop(dst.ownerId, dst.label);
  inPhase(ctx, "service", () => serve(ctx, dst, pkt));
  inPhase(ctx, "response", () => {
    sgStatefulNote(ctx, dst);
    const back = lookupRoute(ctx, dst, from);
    if (back.targetKind === "nat-gateway") {
      log.fail({
        kind: "route",
        category: "routing",
        title: "응답이 NAT Gateway로 향함 (비대칭 라우팅)",
        reason: `요청은 IGW로 들어왔지만 서브넷 ${topo.name(dst.subnetId)}의 응답 경로가 NAT Gateway를 가리킵니다. 응답의 출발지 주소가 달라져 연결이 성립하지 않습니다.`,
        resourceIds: [dst.subnetId, back.targetId],
        fixes: [
          "인터넷에 직접 노출할 리소스는 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷에 배치하세요.",
          "프라이빗 서브넷의 서비스는 퍼블릭 서브넷의 ALB를 통해 노출하세요.",
        ],
        concept: CONCEPT.igw,
      });
    }
    if (back.targetKind === "local") {
      log.fail({
        kind: "route",
        category: "routing",
        title: "응답 경로가 local로 결정됨",
        reason: `클라이언트 주소 ${ip(from)}이(가) VPC CIDR 범위 안에 있어 응답이 인터넷으로 나갈 수 없습니다.`,
        resourceIds: [dst.subnetId],
        fixes: ["인터넷 클라이언트 IP는 VPC CIDR과 겹치지 않는 공인 주소여야 합니다."],
      });
    }
    requireAttachedIgw(ctx, back.targetId, dst.vpcId, "응답");
    checkNacl(ctx, dst.subnetId!, "outbound", from, pkt.protocol, responsePort(pkt), "응답이 서브넷을 나감 (임시 포트)", true);
    log.pass({
      kind: "gateway",
      title: `${topo.label(igw.id)} — 응답 출발지 주소 변환`,
      detail: `${ip(dst.privateIp)} → ${ip(dst.publicIp)}`,
      resourceIds: [igw.id],
    });
    log.pass({ kind: "service", title: `응답이 인터넷의 ${ip(from)}(으)로 반환됨`, detail: "", resourceIds: [igw.id] });
  });
}

// ---------------------------------------------------------------- 목적지 서비스

function serve(ctx: Ctx, eni: Eni, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const owner = topo.get(eni.ownerId);
  if (!owner) {
    log.fail({ kind: "service", category: "configuration", title: "목적지 리소스를 찾을 수 없음", resourceIds: [] });
  }
  if (owner.type === "ec2") {
    if (owner.config.state !== "running") {
      log.fail({
        kind: "state",
        category: "state",
        title: `${topo.label(owner.id)} 상태: ${owner.config.state}`,
        reason: `${topo.label(owner.id)}이(가) Running 상태가 아니어서(${owner.config.state}) 요청을 처리할 수 없습니다.`,
        resourceIds: [owner.id],
        fixes:
          owner.config.state === "terminated"
            ? ["종료된 인스턴스는 다시 시작할 수 없습니다. 새 인스턴스를 만드세요."]
            : ["EC2 설정에서 인스턴스를 시작(Running)하세요."],
        concept: CONCEPT.state,
      });
    }
    if (pkt.protocol === "icmp") {
      log.pass({ kind: "service", title: `${topo.label(owner.id)} ICMP Echo 응답 (가정)`, resourceIds: [owner.id] });
      return;
    }
    if (pkt.port === null || !owner.config.listenPorts.includes(pkt.port)) {
      log.fail({
        kind: "service",
        category: "service",
        title: `${topo.label(owner.id)}의 포트 ${pkt.port}에서 대기 중인 가상 서비스 없음`,
        reason: `네트워크 경로는 열려 있지만 ${topo.label(owner.id)}의 가상 서비스 포트(${owner.config.listenPorts.join(", ") || "없음"})에 ${pkt.port}이(가) 없어 연결이 거부됩니다 (가상).`,
        resourceIds: [owner.id],
        fixes: [`EC2 설정의 "가상 서비스 포트"에 ${pkt.port}을(를) 추가하거나 올바른 포트로 요청하세요.`],
      });
    }
    log.pass({
      kind: "service",
      title: `${topo.label(owner.id)}가 포트 ${pkt.port}에서 응답 (가상)`,
      detail: `가상 애플리케이션 응답 코드: HTTP ${owner.config.httpResponseCode} (HTTP 요청인 경우). 실제 프로세스는 실행되지 않습니다.`,
      resourceIds: [owner.id],
    });
    return;
  }
  if (owner.type === "rds") {
    if (owner.config.state !== "available") {
      log.fail({
        kind: "state",
        category: "state",
        title: `${topo.label(owner.id)} 상태: ${owner.config.state}`,
        reason: `RDS 인스턴스가 Available 상태가 아니어서 연결을 받을 수 없습니다.`,
        resourceIds: [owner.id],
        fixes: ["RDS 설정에서 상태를 Available로 변경(시작)하세요."],
      });
    }
    if (pkt.protocol !== "tcp" || pkt.port !== owner.config.port) {
      log.fail({
        kind: "service",
        category: "service",
        title: `RDS는 TCP ${owner.config.port}에서만 연결을 받음`,
        reason: `${topo.label(owner.id)}은(는) ${owner.config.engine === "mysql" ? "MySQL" : "PostgreSQL"} 포트 TCP ${owner.config.port}에서 대기합니다. 요청(${protoLabel(pkt)})은 거부됩니다.`,
        resourceIds: [owner.id],
        fixes: [`TCP ${owner.config.port}로 연결하세요.`],
      });
    }
    log.pass({
      kind: "service",
      title: `DB 포트 TCP ${owner.config.port} 연결 가능 (가상)`,
      detail: "네트워크와 포트 접근 가능 여부만 검사했습니다. 실제 데이터베이스 인증이나 SQL 쿼리는 실행하지 않습니다.",
      resourceIds: [owner.id],
    });
    return;
  }
  if (owner.type === "alb") {
    serveAlb(ctx, eni, pkt);
    return;
  }
  log.fail({
    kind: "service",
    category: "service",
    title: `${RESOURCE_TYPE_INFO[owner.type].label}은(는) 요청을 처리하는 대상이 아님`,
    resourceIds: [owner.id],
  });
}

function healthFor(ctx: Ctx, tgId: string): TargetHealth[] {
  let health = ctx.healthCache.get(tgId);
  if (!health) {
    health = computeTargetHealth(ctx.topo, tgId, (args) => runHealthProbe(ctx.topo, args, ctx.ephemeralPort));
    ctx.healthCache.set(tgId, health);
  }
  return health;
}

function serveAlb(ctx: Ctx, nodeEni: Eni, pkt: Packet): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  const alb = topo.getOfType(nodeEni.ownerId, "alb")!;
  if (pkt.protocol !== "tcp") {
    log.fail({
      kind: "listener",
      category: "listener",
      title: "ALB는 TCP 기반 HTTP/HTTPS 리스너만 처리",
      reason: `ALB는 ${protoLabel(pkt)} 요청을 처리하지 않습니다.`,
      resourceIds: [alb.id],
      fixes: ["TCP와 리스너 포트(예: 80)로 요청하세요."],
      concept: CONCEPT.alb,
    });
  }
  const bindings = topo.listenersOf(alb.id);
  const listenerRows = bindings.map((b) => ({
    label: `${b.listener.protocol}:${b.listener.port} → ${b.targetGroupId ? topo.name(b.targetGroupId) : "(대상 그룹 없음)"}`,
    note: b.listener.port === pkt.port ? "포트 일치" : "포트 불일치",
    matched: b.listener.port === pkt.port,
    decisive: b.listener.port === pkt.port,
  }));
  if (!bindings.length) {
    log.fail({
      kind: "listener",
      category: "listener",
      title: `${topo.label(alb.id)}에 리스너가 없음`,
      reason: "ALB에 리스너가 없어 어떤 포트의 연결도 받을 수 없습니다.",
      resourceIds: [alb.id],
      fixes: ["ALB 설정에서 리스너(예: HTTP:80)를 추가하고 대상 그룹으로 전달하도록 설정하세요."],
      concept: CONCEPT.alb,
    });
  }
  const binding = bindings.find((b) => b.listener.port === pkt.port);
  if (!binding) {
    log.fail({
      kind: "listener",
      category: "listener",
      title: `포트 ${pkt.port}에 리스너가 없음`,
      reason: `${topo.label(alb.id)}에는 포트 ${pkt.port}의 리스너가 없습니다. 정의된 리스너: ${bindings.map((b) => `${b.listener.protocol}:${b.listener.port}`).join(", ")}`,
      resourceIds: [alb.id],
      rules: listenerRows,
      fixes: [`포트 ${pkt.port} 리스너를 추가하거나 기존 리스너 포트로 요청하세요.`],
      concept: CONCEPT.alb,
    });
  }
  log.pass({
    kind: "listener",
    title: `리스너 ${binding.listener.protocol}:${binding.listener.port} 일치`,
    detail: binding.listener.protocol === "HTTPS" ? "HTTPS 리스너: TLS 인증서와 암호화는 시뮬레이션하지 않습니다." : "",
    resourceIds: [alb.id],
    connectionIds: [binding.connectionId],
    rules: listenerRows,
    concept: CONCEPT.alb,
  });
  if (!binding.targetGroupId) {
    log.fail({
      kind: "listener",
      category: "listener",
      title: "리스너의 기본 작업에 대상 그룹이 없음",
      reason: `리스너 ${binding.listener.protocol}:${binding.listener.port}이(가) 요청을 전달할 대상 그룹이 지정되지 않았습니다.`,
      resourceIds: [alb.id],
      fixes: ["캔버스에서 ALB → Target Group 연결을 만들거나 ALB 설정에서 리스너의 대상 그룹을 선택하세요."],
      concept: CONCEPT.alb,
    });
  }
  const tg = topo.getOfType(binding.targetGroupId, "target-group")!;
  log.hop(tg.id, topo.label(tg.id));
  const health = healthFor(ctx, tg.id);
  const healthRows = health.map((h) => ({
    label: `${h.targetName}: ${TARGET_STATE_LABEL[h.state]}`,
    note: h.reasonCode ? `${h.reasonCode} — ${h.reason}` : h.reason,
    matched: h.state === "healthy",
  }));
  if (!health.length) {
    log.fail({
      kind: "target",
      category: "target",
      title: `${topo.label(tg.id)}에 등록된 대상이 없음 (HTTP 503, 가상)`,
      reason: `대상 그룹 ${tg.name}에 등록된 EC2가 없어 ALB가 503 Service Unavailable을 반환합니다 (가상).`,
      resourceIds: [tg.id, alb.id],
      fixes: ["대상 그룹에 EC2를 등록하세요 (캔버스에서 Target Group → EC2 연결)."],
      concept: CONCEPT.alb,
    });
  }
  const { targets, failOpen } = routableTargets(health);
  if (!targets.length) {
    log.fail({
      kind: "target",
      category: "target",
      title: "요청을 받을 수 있는 대상이 없음 (HTTP 503, 가상)",
      reason: `대상 그룹 ${tg.name}의 모든 대상이 사용 불가(Unused/Initial) 상태입니다: ${health.map((h) => `${h.targetName}(${h.reason})`).join("; ")}`,
      resourceIds: [tg.id, ...health.map((h) => h.targetId)],
      rules: healthRows,
      fixes: ["대상 인스턴스를 Running 상태로 만들고, ALB가 대상의 가용 영역 서브넷에도 배치되었는지 확인하세요."],
      concept: CONCEPT.alb,
    });
  }
  if (failOpen) {
    log.warn({
      kind: "target",
      title: "정상 대상이 없음 — fail-open으로 비정상 대상에 전달",
      detail: "AWS ALB는 대상 그룹에 정상 대상이 하나도 없으면 모든 비정상 대상에 요청을 전달합니다. 헬스 체크가 실패한 원인 때문에 요청도 실패할 가능성이 큽니다.",
      resourceIds: [tg.id],
      rules: healthRows,
      concept: CONCEPT.alb,
    });
  }
  const chosen = pickRoundRobin(targets, ctx.requestIndex)!;
  ctx.selectedTargetId = chosen.targetId;
  log.pass({
    kind: "target",
    title: `대상 선택: ${chosen.targetName} (라운드 로빈, 요청 #${ctx.requestIndex + 1})`,
    detail: `사용 가능한 대상 ${targets.length}개 중 ${ctx.requestIndex % targets.length + 1}번째를 선택했습니다.`,
    resourceIds: [chosen.targetId, tg.id],
    connectionIds: [chosen.connectionId],
    rules: healthRows,
  });
  const targetEni = topo.enisOf(chosen.targetId)[0];
  if (!targetEni || targetEni.privateIp === null) {
    log.fail({
      kind: "target",
      category: "configuration",
      title: `${chosen.targetName}의 사설 IP가 올바르지 않음`,
      resourceIds: [chosen.targetId],
      fixes: ["EC2의 사설 IP를 서브넷 범위 안의 주소로 설정하세요."],
    });
  }
  transmit(
    ctx,
    { kind: "eni", eni: nodeEni },
    targetEni.privateIp,
    { protocol: "tcp", port: tg.config.port, ephemeralPort: pkt.ephemeralPort },
    `${alb.name} → ${chosen.targetName}`,
  );
  const target = topo.getOfType(chosen.targetId, "ec2");
  log.pass({
    kind: "service",
    title: `ALB가 ${chosen.targetName}의 응답을 클라이언트로 전달`,
    detail: `가상 HTTP 응답 코드: ${target?.config.httpResponseCode ?? "-"}`,
    resourceIds: [alb.id],
  });
}

function runHealthProbe(topo: Topology, args: ProbeArgs, ephemeralPort: number): ProbeResult {
  const log: SimulationLog = new SimulationLog();
  const ctx: Ctx = { topo, log, requestIndex: 0, healthCache: new Map(), selectedTargetId: null, ephemeralPort };
  try {
    const targetEni = topo.enisOf(args.target.id)[0];
    if (!targetEni || targetEni.privateIp === null) {
      log.fail({
        kind: "target",
        category: "configuration",
        title: `${args.target.name}의 사설 IP가 올바르지 않음`,
        resourceIds: [args.target.id],
      });
    }
    transmit(
      ctx,
      { kind: "eni", eni: args.nodeEni },
      targetEni.privateIp,
      { protocol: "tcp", port: args.port, ephemeralPort },
      `헬스 체크: ${args.alb.name} → ${args.target.name}`,
    );
    return { connected: true, steps: log.steps, failure: null };
  } catch (e) {
    if (e instanceof SimulationHalt) return { connected: false, steps: log.steps, failure: e.failure };
    throw e;
  }
}

/** 프로젝트의 모든 대상 그룹에 대한 가상 헬스 상태. */
export function computeAllTargetHealth(
  topoOrProject: Topology | Project,
  ephemeralPort = DEFAULT_EPHEMERAL_PORT,
): Map<string, TargetHealth[]> {
  const topo = topoOrProject instanceof Topology ? topoOrProject : buildTopology(topoOrProject);
  const result = new Map<string, TargetHealth[]>();
  for (const tg of topo.ofType("target-group")) {
    result.set(tg.id, computeTargetHealth(topo, tg.id, (args) => runHealthProbe(topo, args, ephemeralPort)));
  }
  return result;
}

// ---------------------------------------------------------------- 요청 해석

class InvalidRequest extends Error {}

function resolveSource(ctx: Ctx, spec: EndpointSpec): Origin {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  if (spec.kind === "internet") {
    const value = parseIpv4(spec.ip);
    if (value === null) throw new InvalidRequest(`인터넷 클라이언트 IP가 올바르지 않습니다: "${spec.ip}"`);
    if (!isPublicRoutableIp(value)) {
      throw new InvalidRequest(`인터넷 클라이언트 IP는 공인 주소여야 합니다: ${spec.ip} (사설/예약 대역)`);
    }
    const pool = tryParseCidr(VIRTUAL_PUBLIC_POOL)!;
    if (cidrContainsIp(pool, value)) {
      throw new InvalidRequest(`${spec.ip}은(는) 리소스용 가상 퍼블릭 IP 대역(${VIRTUAL_PUBLIC_POOL})입니다. 다른 주소(예: ${DEFAULT_INTERNET_CLIENT_IP})를 사용하세요.`);
    }
    log.pass({ kind: "endpoint", title: `출발지: 인터넷 클라이언트 ${spec.ip} (가상)`, detail: "가상 인터넷의 외부 클라이언트입니다." });
    return { kind: "internet", ip: value };
  }
  const r = topo.get(spec.resourceId);
  if (!r) throw new InvalidRequest("출발지 리소스가 존재하지 않습니다.");
  if (r.type !== "ec2") throw new InvalidRequest(`출발지로 지원하는 리소스는 EC2와 인터넷 클라이언트입니다. (${RESOURCE_TYPE_INFO[r.type].label} 불가)`);
  const eni = topo.enisOf(r.id)[0];
  const state = r.config.state;
  if (state !== "running") {
    log.fail({
      kind: "state",
      category: "state",
      title: `출발지 ${topo.label(r.id)} 상태: ${state}`,
      reason:
        state === "pending"
          ? `${topo.label(r.id)}이(가) 아직 시작 중(Pending)이어서 통신을 시작할 수 없습니다.`
          : `${topo.label(r.id)}이(가) ${state} 상태라 통신을 시작할 수 없습니다.`,
      resourceIds: [r.id],
      fixes: state === "terminated" ? ["종료된 인스턴스는 다시 시작할 수 없습니다."] : ["인스턴스를 Running 상태로 만드세요."],
      concept: CONCEPT.state,
    });
  }
  if (!eni.subnetId) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `${topo.label(r.id)}이(가) 서브넷에 배치되지 않음`,
      resourceIds: [r.id],
      fixes: ["EC2를 서브넷과 연결하세요."],
    });
  }
  if (!eni.vpcId) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `서브넷 ${topo.name(eni.subnetId)}이(가) VPC에 속하지 않음`,
      resourceIds: [eni.subnetId],
      fixes: ["서브넷을 VPC와 연결하세요."],
    });
  }
  checkEniAddress(ctx, eni);
  log.pass({
    kind: "endpoint",
    title: `출발지: ${eni.label}`,
    detail: `서브넷 ${topo.name(eni.subnetId)}, 사설 IP ${ip(eni.privateIp)}${eni.publicIp !== null ? `, 가상 퍼블릭 IP ${ip(eni.publicIp)}` : ", 퍼블릭 IP 없음"}`,
    resourceIds: [r.id, eni.subnetId],
  });
  return { kind: "eni", eni };
}

function checkEniAddress(ctx: Ctx, eni: Eni): void {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  if (eni.ownerType !== "ec2") return;
  const subnet = topo.getOfType(eni.subnetId, "subnet");
  const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
  if (eni.privateIp === null) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `${eni.label}의 사설 IP가 올바르지 않음`,
      resourceIds: [eni.ownerId],
      fixes: ["EC2 설정에서 서브넷 범위 안의 사설 IPv4 주소를 지정하세요."],
    });
  }
  if (!cidr || !cidrContainsIp(cidr, eni.privateIp)) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `${eni.label}의 사설 IP ${ip(eni.privateIp)}이(가) 서브넷 범위 밖`,
      reason: `사설 IP ${ip(eni.privateIp)}이(가) 서브넷 ${topo.name(eni.subnetId)}(${subnet?.config.cidr ?? "?"}) 범위에 포함되지 않습니다.`,
      resourceIds: [eni.ownerId, eni.subnetId],
      fixes: ["서브넷 CIDR 범위 안의 주소로 변경하세요."],
    });
  }
  const reserved = awsReservedReason(cidr, eni.privateIp);
  if (reserved) {
    log.fail({
      kind: "endpoint",
      category: "configuration",
      title: `${eni.label}의 사설 IP가 AWS 예약 주소 (${reserved})`,
      resourceIds: [eni.ownerId],
      fixes: ["서브넷의 처음 4개와 마지막 1개 주소를 제외한 주소를 사용하세요."],
    });
  }
}

interface ResolvedDestination {
  address: number;
  label: string;
  resourceId: string | null;
}

function vpcDnsEnabled(ctx: Ctx, vpcId: string | null): boolean {
  const vpc = ctx.topo.getOfType(vpcId, "vpc");
  return !!vpc?.config.enableDnsSupport;
}

function resolveDestination(ctx: Ctx, spec: EndpointSpec, origin: Origin): ResolvedDestination {
  const topo = ctx.topo;
  const log: SimulationLog = ctx.log;
  if (spec.kind === "internet") {
    const value = parseIpv4(spec.ip);
    if (value === null) throw new InvalidRequest(`목적지 IP가 올바르지 않습니다: "${spec.ip}"`);
    log.info({ kind: "endpoint", title: `목적지: 인터넷 호스트 ${spec.ip}`, detail: "" });
    return { address: value, label: `인터넷 ${spec.ip}`, resourceId: null };
  }
  const r = topo.get(spec.resourceId);
  if (!r) throw new InvalidRequest("목적지 리소스가 존재하지 않습니다.");
  const srcVpc = origin.kind === "eni" ? origin.eni.vpcId : null;

  const requireDns = (name: string | null) => {
    if (origin.kind !== "eni") {
      log.info({ kind: "dns", title: `가상 퍼블릭 DNS 조회: ${name}`, detail: "인터넷 클라이언트는 퍼블릭 DNS로 엔드포인트 이름을 조회합니다." });
      return;
    }
    if (!vpcDnsEnabled(ctx, srcVpc)) {
      log.fail({
        kind: "dns",
        category: "dns",
        title: `DNS 이름을 해석할 수 없음: ${name}`,
        reason: `출발지 VPC ${topo.name(srcVpc)}의 DNS 확인(enableDnsSupport)이 꺼져 있어 엔드포인트 이름을 해석할 수 없습니다.`,
        resourceIds: [srcVpc],
        fixes: ["VPC 설정에서 'DNS 확인(enableDnsSupport)'을 활성화하세요."],
        concept: CONCEPT.dns,
      });
    }
  };

  switch (r.type) {
    case "ec2": {
      const eni = topo.enisOf(r.id)[0];
      let mode = spec.addressing ?? "auto";
      if (mode === "auto") mode = origin.kind === "eni" && origin.eni.vpcId && origin.eni.vpcId === eni.vpcId ? "private" : "public";
      if (mode === "private") {
        if (eni.privateIp === null) {
          log.fail({
            kind: "endpoint",
            category: "configuration",
            title: `${topo.label(r.id)}의 사설 IP가 올바르지 않음`,
            resourceIds: [r.id],
            fixes: ["EC2 설정에서 사설 IPv4 주소를 지정하세요."],
          });
        }
        log.info({ kind: "endpoint", title: `목적지: ${eni.label} 사설 IP ${ip(eni.privateIp)}`, resourceIds: [r.id] });
        return { address: eni.privateIp, label: topo.label(r.id), resourceId: r.id };
      }
      if (eni.publicIp === null) {
        const stopped = r.config.state === "stopped" || r.config.state === "terminated";
        log.fail({
          kind: "endpoint",
          category: stopped ? "state" : "configuration",
          title: `${topo.label(r.id)}에 퍼블릭 IPv4 주소가 없음`,
          reason: stopped
            ? `${topo.label(r.id)}이(가) ${r.config.state} 상태라 퍼블릭 IP가 해제되었습니다.`
            : `${topo.label(r.id)}에 퍼블릭 IP가 할당되지 않아 인터넷(또는 다른 VPC)에서 주소로 지정할 수 없습니다.`,
          resourceIds: [r.id],
          fixes: stopped
            ? ["인스턴스를 시작하세요."]
            : [
                "EC2 설정에서 퍼블릭 IPv4 자동 할당을 활성화하세요 (퍼블릭 서브넷에 배치 필요).",
                "또는 internet-facing ALB를 통해 서비스를 노출하세요.",
              ],
          concept: CONCEPT.igw,
        });
      }
      log.info({ kind: "endpoint", title: `목적지: ${eni.label} 가상 퍼블릭 IP ${ip(eni.publicIp)}`, resourceIds: [r.id] });
      return { address: eni.publicIp, label: topo.label(r.id), resourceId: r.id };
    }
    case "alb": {
      const name = topo.dnsName(r.id);
      requireDns(name);
      const nodes = topo.enisOf(r.id);
      if (!nodes.length) {
        log.fail({
          kind: "dns",
          category: "configuration",
          title: `${topo.label(r.id)}이(가) 서브넷에 배치되지 않음`,
          reason: "ALB 노드가 없어 DNS 이름이 어떤 주소로도 해석되지 않습니다.",
          resourceIds: [r.id],
          fixes: ["ALB를 서로 다른 가용 영역의 서브넷 2개 이상과 연결하세요."],
        });
      }
      const internetFacing = r.config.scheme === "internet-facing";
      const addresses = nodes.map((n) => (internetFacing ? n.publicIp : n.privateIp)).filter((a): a is number => a !== null);
      if (!addresses.length) {
        log.fail({
          kind: "dns",
          category: "configuration",
          title: "ALB 노드에 주소가 없음",
          reason: "ALB 서브넷의 CIDR이 올바르지 않거나 사용할 수 있는 주소가 없습니다.",
          resourceIds: [r.id],
        });
      }
      log.pass({
        kind: "dns",
        title: `가상 DNS: ${name}`,
        detail: `${internetFacing ? "internet-facing → 노드의 가상 퍼블릭 IP" : "internal → 노드의 사설 IP"}: ${addresses.map((a) => ip(a)).join(", ")} (첫 번째 주소 사용)`,
        resourceIds: [r.id],
        concept: CONCEPT.dns,
      });
      return { address: addresses[0], label: topo.label(r.id), resourceId: r.id };
    }
    case "rds": {
      const name = topo.dnsName(r.id);
      requireDns(name);
      const eni = topo.enisOf(r.id)[0];
      if (!eni || eni.privateIp === null) {
        log.fail({
          kind: "dns",
          category: "configuration",
          title: `${topo.label(r.id)}이(가) DB 서브넷 그룹에 배치되지 않음`,
          reason: "RDS가 서브넷에 배치되지 않아 엔드포인트가 해석되지 않습니다.",
          resourceIds: [r.id],
          fixes: ["RDS를 DB 서브넷 그룹과 연결하고, 그룹에 서브넷을 추가하세요."],
        });
      }
      const fromSameVpc = origin.kind === "eni" && origin.eni.vpcId === eni.vpcId;
      const usePublic = !fromSameVpc && r.config.publiclyAccessible && eni.publicIp !== null;
      const address = usePublic ? eni.publicIp! : eni.privateIp;
      log.pass({
        kind: "dns",
        title: `가상 DNS: ${name}`,
        detail: fromSameVpc
          ? `같은 VPC에서 조회 → 사설 IP ${ip(address)}`
          : r.config.publiclyAccessible
            ? `외부에서 조회 + Publicly Accessible → 가상 퍼블릭 IP ${ip(address)}`
            : `Publicly Accessible이 꺼져 있어 외부에서도 사설 IP ${ip(address)}로 해석됩니다.`,
        resourceIds: [r.id],
        concept: CONCEPT.dns,
      });
      return { address, label: topo.label(r.id), resourceId: r.id };
    }
    default:
      throw new InvalidRequest(
        `목적지로 지원하는 리소스는 EC2, ALB, RDS, 인터넷 호스트입니다. (${RESOURCE_TYPE_INFO[r.type].label} 불가)`,
      );
  }
}

function endpointLabel(topo: Topology, spec: EndpointSpec): string {
  return spec.kind === "internet" ? `인터넷 ${spec.ip}` : topo.label(spec.resourceId);
}

// ---------------------------------------------------------------- 공개 API

interface SingleRun {
  outcome: Exclude<SimulationOutcome, "invalid-request">;
  steps: SimStep[];
  path: PathHop[];
  failure: FailureInfo | null;
  selectedTargetId: string | null;
  truncated: boolean;
  errorMessage?: string;
}

function runOnce(
  topo: Topology,
  request: SimulationRequest,
  requestIndex: number,
  healthCache: Map<string, TargetHealth[]>,
): SingleRun {
  const ephemeralPort = request.ephemeralPort ?? DEFAULT_EPHEMERAL_PORT;
  const log: SimulationLog = new SimulationLog();
  const ctx: Ctx = { topo, log, requestIndex, healthCache, selectedTargetId: null, ephemeralPort };
  const pkt: Packet = {
    protocol: request.protocol,
    port: request.protocol === "icmp" ? null : request.port,
    ephemeralPort,
  };
  try {
    const origin = resolveSource(ctx, request.source);
    const destination = resolveDestination(ctx, request.destination, origin);
    transmit(ctx, origin, destination.address, pkt, `${endpointLabel(topo, request.source)} → ${destination.label}`);
    return { outcome: "success", steps: log.steps, path: log.path, failure: null, selectedTargetId: ctx.selectedTargetId, truncated: log.isTruncated };
  } catch (e) {
    if (e instanceof SimulationHalt) {
      return {
        outcome: "failure",
        steps: log.steps,
        path: log.path,
        failure: e.failure,
        selectedTargetId: ctx.selectedTargetId,
        truncated: log.isTruncated,
      };
    }
    if (e instanceof InvalidRequest) throw e;
    return {
      outcome: "engine-error",
      steps: log.steps,
      path: log.path,
      failure: null,
      selectedTargetId: null,
      truncated: log.isTruncated,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}

function validateRequest(request: SimulationRequest): string | null {
  if (!request?.source || !request?.destination) return "출발지와 목적지를 선택하세요.";
  if (!["tcp", "udp", "icmp"].includes(request.protocol)) return "프로토콜은 TCP, UDP, ICMP 중 하나여야 합니다.";
  if (request.protocol !== "icmp" && (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)) {
    return "포트는 1~65535 사이의 정수여야 합니다.";
  }
  const eph = request.ephemeralPort ?? DEFAULT_EPHEMERAL_PORT;
  if (!Number.isInteger(eph) || eph < 1024 || eph > 65535) return "임시 포트는 1024~65535 사이의 정수여야 합니다.";
  if (request.source.kind === "internet" && request.destination.kind === "internet") {
    return "인터넷 ↔ 인터넷 통신은 시뮬레이션 대상이 아닙니다. 출발지나 목적지 중 하나는 프로젝트의 리소스여야 합니다.";
  }
  if (
    request.source.kind === "resource" &&
    request.destination.kind === "resource" &&
    request.source.resourceId === request.destination.resourceId
  ) {
    return "출발지와 목적지가 같은 리소스입니다.";
  }
  const count = request.requestCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_REQUEST_COUNT) {
    return `요청 수는 1~${MAX_REQUEST_COUNT} 사이여야 합니다.`;
  }
  return null;
}

export function simulateWithTopology(topo: Topology, request: SimulationRequest): SimulationResult {
  const base = {
    request,
    sourceLabel: request?.source ? endpointLabel(topo, request.source) : "",
    destinationLabel: request?.destination ? endpointLabel(topo, request.destination) : "",
    assumptions: SIMULATION_ASSUMPTIONS,
  };
  const invalid = validateRequest(request);
  if (invalid) {
    return {
      ...base,
      outcome: "invalid-request",
      summary: `요청을 실행할 수 없음: ${invalid}`,
      steps: [],
      path: [],
      failure: null,
      distribution: null,
      selectedTargetId: null,
      truncated: false,
      errorMessage: invalid,
    };
  }
  try {
    const healthCache = new Map<string, TargetHealth[]>();
    const first = runOnce(topo, request, 0, healthCache);
    let distribution: DistributionEntry[] | null = null;
    const count = request.requestCount ?? 1;
    const destination = request.destination.kind === "resource" ? topo.get(request.destination.resourceId) : undefined;
    if (destination?.type === "alb" && count > 1) {
      const tally = new Map<string, DistributionEntry>();
      const record = (run: SingleRun) => {
        if (!run.selectedTargetId) return;
        const entry = tally.get(run.selectedTargetId) ?? {
          targetId: run.selectedTargetId,
          targetName: topo.name(run.selectedTargetId),
          requests: 0,
          successes: 0,
        };
        entry.requests += 1;
        if (run.outcome === "success") entry.successes += 1;
        tally.set(run.selectedTargetId, entry);
      };
      record(first);
      for (let i = 1; i < count; i++) record(runOnce(topo, request, i, healthCache));
      distribution = [...tally.values()].sort((a, b) => topo.orderOf(a.targetId) - topo.orderOf(b.targetId));
    }
    const summary =
      first.outcome === "success"
        ? `요청 성공 (가상): ${base.sourceLabel} → ${base.destinationLabel} (${request.protocol === "icmp" ? "ICMP" : `${request.protocol.toUpperCase()} ${request.port}`}) — 응답이 출발지로 돌아왔습니다.`
        : first.outcome === "failure"
          ? `요청 실패: ${first.failure?.reason}`
          : `시뮬레이션 엔진 오류: ${first.errorMessage} (통신 실패가 아니라 엔진 내부 문제입니다)`;
    return { ...base, ...first, summary, distribution };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof InvalidRequest) {
      return {
        ...base,
        outcome: "invalid-request",
        summary: `요청을 실행할 수 없음: ${message}`,
        steps: [],
        path: [],
        failure: null,
        distribution: null,
        selectedTargetId: null,
        truncated: false,
        errorMessage: message,
      };
    }
    return {
      ...base,
      outcome: "engine-error",
      summary: `시뮬레이션 엔진 오류: ${message} (통신 실패가 아니라 엔진 내부 문제입니다)`,
      steps: [],
      path: [],
      failure: null,
      distribution: null,
      selectedTargetId: null,
      truncated: false,
      errorMessage: message,
    };
  }
}

export function simulate(project: Project, request: SimulationRequest): SimulationResult {
  return simulateWithTopology(buildTopology(project), request);
}
