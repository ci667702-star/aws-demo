/**
 * Network ACL 평가 (상태 비저장형 방화벽).
 * - 규칙 번호가 낮은 순서대로 평가하고, 처음 일치한 규칙(allow/deny)을 적용한다.
 * - 일치하는 규칙이 없으면 마지막 "*" 규칙에 의해 거부된다.
 * - 상태 비저장형이므로 요청과 응답을 각각 평가해야 한다. 응답은 보통 임시 포트(ephemeral port)를 사용한다.
 * - 서브넷에 명시적으로 연결된 NACL이 없으면 VPC 기본 NACL(모든 트래픽 허용)을 사용한다고 가정한다.
 */
import { cidrContainsIp, formatIpv4, formatPortRange, tryParseCidr } from "./cidr-utils";
import type { NaclRule } from "./resource-models";
import { portMatches, protocolMatches, type Direction, type PacketProtocol } from "./security-group-engine";

export interface NaclPacket {
  protocol: PacketProtocol;
  port: number | null;
  /** 상대방 IP (인바운드: 출발지, 아웃바운드: 목적지) */
  peerIp: number;
}

export interface NaclRuleEvaluation {
  rule: NaclRule | null;
  label: string;
  matches: boolean;
  note: string;
}

export interface NaclDecision {
  allowed: boolean;
  direction: Direction;
  /** 결정에 사용된 규칙 (null이면 "*" 기본 거부) */
  decidingRule: NaclRule | null;
  evaluations: NaclRuleEvaluation[];
  isDefaultNacl: boolean;
}

/** VPC 기본 NACL 규칙: 100번 모두 허용. */
export const DEFAULT_NACL_RULES: NaclRule[] = [
  { id: "default-100", ruleNumber: 100, protocol: "all", fromPort: 0, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" },
];

export function describeNaclRule(rule: NaclRule): string {
  const proto = rule.protocol === "all" ? "모든 트래픽" : rule.protocol.toUpperCase();
  const ports =
    rule.protocol === "all" || rule.protocol === "icmp" ? "" : ` ${formatPortRange(rule.fromPort, rule.toPort)}`;
  return `#${rule.ruleNumber} ${rule.action === "allow" ? "ALLOW" : "DENY"} ${proto}${ports} ${rule.cidr}`;
}

export function naclRuleMatches(rule: NaclRule, packet: NaclPacket): { matches: boolean; note: string } {
  if (!protocolMatches(rule.protocol, packet.protocol)) {
    return { matches: false, note: "프로토콜 불일치" };
  }
  if (!portMatches(rule, packet.port)) {
    return { matches: false, note: `포트 ${packet.port} 미포함` };
  }
  const cidr = tryParseCidr(rule.cidr);
  if (!cidr) return { matches: false, note: `유효하지 않은 CIDR "${rule.cidr}" — 평가에서 제외` };
  if (!cidrContainsIp(cidr, packet.peerIp)) {
    return { matches: false, note: `${formatIpv4(packet.peerIp)} 미포함` };
  }
  return { matches: true, note: "일치" };
}

export function sortNaclRules(rules: NaclRule[]): NaclRule[] {
  return [...rules].sort((a, b) => a.ruleNumber - b.ruleNumber);
}

export function evaluateNacl(rules: NaclRule[] | "default", direction: Direction, packet: NaclPacket): NaclDecision {
  const isDefault = rules === "default";
  const sorted = sortNaclRules(isDefault ? DEFAULT_NACL_RULES : rules);
  const evaluations: NaclRuleEvaluation[] = [];
  for (const rule of sorted) {
    const { matches, note } = naclRuleMatches(rule, packet);
    evaluations.push({ rule, label: describeNaclRule(rule), matches, note: matches ? `${note} → ${rule.action.toUpperCase()} 적용` : note });
    if (matches) {
      return {
        allowed: rule.action === "allow",
        direction,
        decidingRule: rule,
        evaluations,
        isDefaultNacl: isDefault,
      };
    }
  }
  evaluations.push({ rule: null, label: "* DENY 모든 트래픽 0.0.0.0/0", matches: true, note: "일치하는 번호 규칙이 없어 기본 거부" });
  return { allowed: false, direction, decidingRule: null, evaluations, isDefaultNacl: isDefault };
}

/**
 * 앞선(번호가 낮은) 규칙에 완전히 가려져 결코 적용되지 않는 규칙을 찾는다.
 * 포트/프로토콜/CIDR 범위가 앞선 규칙에 완전히 포함되는 경우만 판정한다.
 */
export function findShadowedRules(rules: NaclRule[]): { rule: NaclRule; shadowedBy: NaclRule }[] {
  const sorted = sortNaclRules(rules);
  const result: { rule: NaclRule; shadowedBy: NaclRule }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const rule = sorted[i];
    const ruleCidr = tryParseCidr(rule.cidr);
    if (!ruleCidr) continue;
    for (let j = 0; j < i; j++) {
      const prev = sorted[j];
      const prevCidr = tryParseCidr(prev.cidr);
      if (!prevCidr) continue;
      const protoCovered = prev.protocol === "all" || prev.protocol === rule.protocol;
      const portsCovered =
        prev.protocol === "all" ||
        prev.protocol === "icmp" ||
        (rule.protocol !== "all" && prev.fromPort <= rule.fromPort && prev.toPort >= rule.toPort);
      const cidrCovered = prevCidr.prefix <= ruleCidr.prefix && cidrContainsIp(prevCidr, ruleCidr.network);
      if (protoCovered && portsCovered && cidrCovered && prev.action !== rule.action) {
        result.push({ rule, shadowedBy: prev });
        break;
      }
    }
  }
  return result;
}
