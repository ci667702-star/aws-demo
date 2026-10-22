import { beforeEach, describe, expect, it } from "vitest";
import { parseIpv4 } from "@/lib/engine/cidr-utils";
import { DEFAULT_NACL_RULES, evaluateNacl, findShadowedRules } from "@/lib/engine/network-acl-engine";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { evaluateSecurityGroups } from "@/lib/engine/security-group-engine";
import { NACL, SG } from "@/lib/project/factory";
import { useDeterministicIds } from "../helpers";

const ip = (s: string) => parseIpv4(s)!;

function sg(id: string, inbound: ReturnType<typeof SG.tcp>[], outbound: ReturnType<typeof SG.tcp>[] = []): ResourceOfType<"security-group"> {
  return {
    id,
    type: "security-group",
    name: id,
    position: { x: 0, y: 0 },
    config: { description: "", inboundRules: inbound, outboundRules: outbound },
  };
}

beforeEach(useDeterministicIds);

describe("Security Group 평가", () => {
  it("일치하는 허용 규칙이 있으면 허용한다", () => {
    const d = evaluateSecurityGroups([sg("sg-a", [SG.tcp(80, "0.0.0.0/0")])], "inbound", {
      protocol: "tcp",
      port: 80,
      peerIp: ip("203.0.113.10"),
      peerSecurityGroupIds: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.matched?.rule.fromPort).toBe(80);
  });

  it("일치하는 규칙이 없으면 암묵적으로 거부한다", () => {
    const d = evaluateSecurityGroups([sg("sg-a", [SG.tcp(443, "0.0.0.0/0")])], "inbound", {
      protocol: "tcp",
      port: 80,
      peerIp: ip("203.0.113.10"),
      peerSecurityGroupIds: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.evaluations[0].note).toContain("포트 불일치");
  });

  it("여러 보안 그룹의 규칙을 합집합으로 평가한다", () => {
    const groups = [sg("sg-a", [SG.tcp(22, "10.0.0.0/16")]), sg("sg-b", [SG.tcp(80, "0.0.0.0/0")])];
    expect(
      evaluateSecurityGroups(groups, "inbound", { protocol: "tcp", port: 80, peerIp: ip("1.2.3.4"), peerSecurityGroupIds: [] }).allowed,
    ).toBe(true);
  });

  it("CIDR 범위 밖의 출발지는 거부한다", () => {
    const d = evaluateSecurityGroups([sg("sg-a", [SG.tcp(22, "203.0.113.0/24")])], "inbound", {
      protocol: "tcp",
      port: 22,
      peerIp: ip("198.18.0.1"),
      peerSecurityGroupIds: [],
    });
    expect(d.allowed).toBe(false);
  });

  it("보안 그룹 참조 규칙은 상대 인터페이스의 보안 그룹으로 판정한다", () => {
    const groups = [sg("sg-db", [SG.tcp(3306, { sg: "sg-app" })])];
    const packet = { protocol: "tcp" as const, port: 3306, peerIp: ip("10.0.1.10") };
    expect(evaluateSecurityGroups(groups, "inbound", { ...packet, peerSecurityGroupIds: ["sg-app"] }).allowed).toBe(true);
    expect(evaluateSecurityGroups(groups, "inbound", { ...packet, peerSecurityGroupIds: ["sg-other"] }).allowed).toBe(false);
    expect(evaluateSecurityGroups(groups, "inbound", { ...packet, peerSecurityGroupIds: [] }).allowed).toBe(false);
  });

  it("all 프로토콜 규칙은 모든 포트와 프로토콜을 허용한다", () => {
    const groups = [sg("sg-a", [], [SG.all("0.0.0.0/0")])];
    expect(evaluateSecurityGroups(groups, "outbound", { protocol: "udp", port: 53, peerIp: ip("8.8.8.8"), peerSecurityGroupIds: [] }).allowed).toBe(true);
  });

  it("보안 그룹이 하나도 없으면 거부하고 noGroups를 표시한다", () => {
    const d = evaluateSecurityGroups([], "inbound", { protocol: "tcp", port: 80, peerIp: ip("1.1.1.1"), peerSecurityGroupIds: [] });
    expect(d.allowed).toBe(false);
    expect(d.noGroups).toBe(true);
  });
});

describe("Network ACL 평가 (규칙 번호 순서, 첫 일치 적용)", () => {
  it("번호가 낮은 DENY가 높은 번호의 ALLOW보다 먼저 적용된다", () => {
    const rules = [NACL.allow(200, "tcp", 80, "0.0.0.0/0"), NACL.deny(100, "tcp", 80, "203.0.113.0/24")];
    const d = evaluateNacl(rules, "inbound", { protocol: "tcp", port: 80, peerIp: ip("203.0.113.10") });
    expect(d.allowed).toBe(false);
    expect(d.decidingRule?.ruleNumber).toBe(100);
  });

  it("번호가 낮은 ALLOW가 먼저 일치하면 뒤의 DENY는 적용되지 않는다", () => {
    const rules = [NACL.allow(100, "tcp", 80, "0.0.0.0/0"), NACL.deny(200, "tcp", 80, "203.0.113.0/24")];
    expect(evaluateNacl(rules, "inbound", { protocol: "tcp", port: 80, peerIp: ip("203.0.113.10") }).allowed).toBe(true);
  });

  it("일치하는 규칙이 없으면 마지막 * 규칙으로 거부한다", () => {
    const d = evaluateNacl([NACL.allow(100, "tcp", 443, "0.0.0.0/0")], "outbound", { protocol: "tcp", port: 50000, peerIp: ip("1.2.3.4") });
    expect(d.allowed).toBe(false);
    expect(d.decidingRule).toBeNull();
    expect(d.evaluations.at(-1)?.label).toContain("*");
  });

  it("기본 NACL은 모든 트래픽을 허용한다", () => {
    expect(DEFAULT_NACL_RULES).toHaveLength(1);
    const d = evaluateNacl("default", "inbound", { protocol: "udp", port: 53, peerIp: ip("8.8.8.8") });
    expect(d.allowed).toBe(true);
    expect(d.isDefaultNacl).toBe(true);
  });

  it("앞선 규칙에 가려진 규칙을 찾는다", () => {
    const rules = [NACL.allow(100, "all", null, "0.0.0.0/0"), NACL.deny(200, "tcp", 22, "0.0.0.0/0")];
    const shadowed = findShadowedRules(rules);
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].rule.ruleNumber).toBe(200);
  });
});
