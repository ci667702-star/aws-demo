/**
 * Security Group 평가 (상태 저장형 방화벽).
 * - 허용(allow) 규칙만 존재한다. 연결된 모든 보안 그룹의 규칙을 합집합으로 평가한다.
 * - 일치하는 허용 규칙이 없으면 거부한다 (암묵적 거부).
 * - 상태 저장형이므로 허용된 연결의 응답 트래픽은 규칙과 무관하게 자동 허용된다.
 *   (응답에 대한 처리는 connectivity-engine이 담당한다.)
 */
import { cidrContainsIp, formatIpv4, formatPortRange, tryParseCidr } from "./cidr-utils";
import type { ResourceOfType, SgRule } from "./resource-models";

export type PacketProtocol = "tcp" | "udp" | "icmp";
export type Direction = "inbound" | "outbound";

export interface SgPacket {
  protocol: PacketProtocol;
  /** 목적지 포트 (ICMP는 null) */
  port: number | null;
  /** 상대방 IP (인바운드: 출발지, 아웃바운드: 목적지) */
  peerIp: number;
  /** 상대방 인터페이스에 연결된 보안 그룹 (같은 VPC의 사설 IP 통신일 때만 알 수 있다) */
  peerSecurityGroupIds: string[];
}

export interface SgRuleEvaluation {
  securityGroupId: string;
  securityGroupName: string;
  rule: SgRule;
  matches: boolean;
  note: string;
}

export interface SgDecision {
  allowed: boolean;
  direction: Direction;
  matched: SgRuleEvaluation | null;
  evaluations: SgRuleEvaluation[];
  /** 평가할 보안 그룹이 하나도 없었는지 */
  noGroups: boolean;
}

export function protocolMatches(ruleProtocol: SgRule["protocol"], packet: PacketProtocol): boolean {
  return ruleProtocol === "all" || ruleProtocol === packet;
}

export function portMatches(
  rule: { protocol: SgRule["protocol"]; fromPort: number; toPort: number },
  port: number | null,
): boolean {
  if (rule.protocol === "all" || rule.protocol === "icmp") return true;
  if (port === null) return false;
  return port >= rule.fromPort && port <= rule.toPort;
}

export function describeSgRule(rule: SgRule, sgName: (id: string) => string): string {
  const proto = rule.protocol === "all" ? "모든 트래픽" : rule.protocol.toUpperCase();
  const ports =
    rule.protocol === "all" || rule.protocol === "icmp" ? "" : ` ${formatPortRange(rule.fromPort, rule.toPort)}`;
  const peer = rule.peer.kind === "cidr" ? rule.peer.cidr : `SG ${sgName(rule.peer.securityGroupId)}`;
  return `${proto}${ports} ↔ ${peer}`;
}

function evaluateRule(rule: SgRule, packet: SgPacket): { matches: boolean; note: string } {
  if (!protocolMatches(rule.protocol, packet.protocol)) {
    return { matches: false, note: `프로토콜 불일치 (${rule.protocol.toUpperCase()} ≠ ${packet.protocol.toUpperCase()})` };
  }
  if (!portMatches(rule, packet.port)) {
    return { matches: false, note: `포트 불일치 (${formatPortRange(rule.fromPort, rule.toPort)}에 ${packet.port} 미포함)` };
  }
  if (rule.peer.kind === "cidr") {
    const cidr = tryParseCidr(rule.peer.cidr);
    if (!cidr) return { matches: false, note: `유효하지 않은 CIDR "${rule.peer.cidr}" — 평가에서 제외` };
    if (!cidrContainsIp(cidr, packet.peerIp)) {
      return { matches: false, note: `${formatIpv4(packet.peerIp)}이(가) ${cidr.text}에 포함되지 않음` };
    }
    return { matches: true, note: `${formatIpv4(packet.peerIp)}이(가) ${cidr.text}에 포함됨` };
  }
  if (!packet.peerSecurityGroupIds.includes(rule.peer.securityGroupId)) {
    return {
      matches: false,
      note:
        packet.peerSecurityGroupIds.length === 0
          ? "상대방의 보안 그룹을 알 수 없음 (인터넷/NAT를 거친 트래픽은 SG 참조 규칙과 일치하지 않음)"
          : "상대방 인터페이스에 참조된 보안 그룹이 연결되어 있지 않음",
    };
  }
  return { matches: true, note: "상대방 인터페이스에 참조된 보안 그룹이 연결되어 있음" };
}

export function evaluateSecurityGroups(
  groups: ResourceOfType<"security-group">[],
  direction: Direction,
  packet: SgPacket,
): SgDecision {
  const evaluations: SgRuleEvaluation[] = [];
  let matched: SgRuleEvaluation | null = null;
  for (const sg of groups) {
    const rules = direction === "inbound" ? sg.config.inboundRules : sg.config.outboundRules;
    for (const rule of rules) {
      const { matches, note } = evaluateRule(rule, packet);
      const evaluation: SgRuleEvaluation = {
        securityGroupId: sg.id,
        securityGroupName: sg.name,
        rule,
        matches,
        note,
      };
      evaluations.push(evaluation);
      if (matches && !matched) matched = evaluation;
    }
  }
  return { allowed: matched !== null, direction, matched, evaluations, noGroups: groups.length === 0 };
}

/** 규칙이 특정 포트를 특정 CIDR 범위 전체에서 허용하는지 (검증 엔진용). */
export function ruleAllowsFromAnywhere(rule: SgRule): boolean {
  if (rule.peer.kind !== "cidr") return false;
  const cidr = tryParseCidr(rule.peer.cidr);
  return !!cidr && cidr.prefix === 0;
}

export function ruleCoversPort(rule: SgRule, protocol: PacketProtocol, port: number): boolean {
  return protocolMatches(rule.protocol, protocol) && portMatches(rule, port);
}
