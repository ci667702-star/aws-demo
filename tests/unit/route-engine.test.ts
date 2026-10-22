import { describe, expect, it } from "vitest";
import { parseIpv4, tryParseCidr } from "@/lib/engine/cidr-utils";
import { findDuplicateDestinations, selectRoute } from "@/lib/engine/route-engine";
import type { EffectiveRoute } from "@/lib/engine/topology-engine";

function route(destination: string, targetKind: EffectiveRoute["targetKind"], key = destination): EffectiveRoute {
  return {
    key,
    destinationCidr: destination,
    cidr: tryParseCidr(destination),
    targetKind,
    targetId: targetKind === "local" ? null : `${targetKind}-1`,
    connectionId: targetKind === "local" ? null : key,
  };
}

const ip = (s: string) => parseIpv4(s)!;

describe("라우팅 결정 (Longest Prefix Match)", () => {
  const routes = [
    route("10.0.0.0/16", "local", "local"),
    route("0.0.0.0/0", "internet-gateway"),
    route("198.51.100.0/24", "nat-gateway"),
  ];

  it("VPC 내부 주소는 local 경로를 선택한다", () => {
    expect(selectRoute(routes, ip("10.0.5.20")).route?.targetKind).toBe("local");
  });

  it("인터넷 주소는 기본 경로(0.0.0.0/0)를 선택한다", () => {
    expect(selectRoute(routes, ip("203.0.113.10")).route?.targetKind).toBe("internet-gateway");
  });

  it("더 구체적인 경로가 기본 경로보다 우선한다", () => {
    const decision = selectRoute(routes, ip("198.51.100.7"));
    expect(decision.route?.targetKind).toBe("nat-gateway");
    expect(decision.evaluations.filter((e) => e.matches)).toHaveLength(2);
  });

  it("일치하는 경로가 없으면 null을 반환한다", () => {
    expect(selectRoute([route("10.0.0.0/16", "local", "local")], ip("8.8.8.8")).route).toBeNull();
  });

  it("유효하지 않은 경로는 평가에서 제외하고 이유를 기록한다", () => {
    const decision = selectRoute([route("0.0.0.0/33", "internet-gateway")], ip("8.8.8.8"));
    expect(decision.route).toBeNull();
    expect(decision.evaluations[0].note).toContain("유효하지 않은");
  });

  it("같은 Destination 중복(라우팅 충돌)을 찾는다", () => {
    const dup = findDuplicateDestinations([
      route("10.0.0.0/16", "local", "local"),
      route("0.0.0.0/0", "internet-gateway", "a"),
      route("0.0.0.0/0", "nat-gateway", "b"),
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0].map((r) => r.key)).toEqual(["a", "b"]);
  });
});
