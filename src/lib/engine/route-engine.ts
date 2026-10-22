/**
 * 라우팅 결정.
 * 구현 범위: 목적지 IP를 포함하는 경로 중 가장 구체적인 경로(Longest Prefix Match)를 선택한다.
 * 같은 접두사 길이의 중복 경로는 검증 오류이며, 시뮬레이션에서는 local 경로 → 정의 순서로 결정한다.
 */
import { cidrContainsIp, formatIpv4 } from "./cidr-utils";
import type { EffectiveRoute } from "./topology-engine";

export interface RouteEvaluation {
  route: EffectiveRoute;
  matches: boolean;
  note: string;
}

export interface RouteDecision {
  destinationIp: number;
  route: EffectiveRoute | null;
  evaluations: RouteEvaluation[];
}

export function selectRoute(routes: EffectiveRoute[], destinationIp: number): RouteDecision {
  const evaluations: RouteEvaluation[] = routes.map((route) => {
    if (!route.cidr) {
      return { route, matches: false, note: `유효하지 않은 대상 CIDR "${route.destinationCidr}" — 평가에서 제외` };
    }
    const matches = cidrContainsIp(route.cidr, destinationIp);
    return {
      route,
      matches,
      note: matches
        ? `${formatIpv4(destinationIp)} 포함 (접두사 /${route.cidr.prefix})`
        : `${formatIpv4(destinationIp)} 미포함`,
    };
  });

  let best: EffectiveRoute | null = null;
  for (const e of evaluations) {
    if (!e.matches || !e.route.cidr) continue;
    if (!best || !best.cidr || e.route.cidr.prefix > best.cidr.prefix) best = e.route;
  }

  if (best) {
    const chosen = evaluations.find((e) => e.route === best);
    if (chosen) chosen.note += " ← 가장 구체적인 경로로 선택";
  }

  return { destinationIp, route: best, evaluations };
}

/** 같은 대상 CIDR이 두 번 이상 정의되었는지 찾는다 (라우팅 충돌). */
export function findDuplicateDestinations(routes: EffectiveRoute[]): EffectiveRoute[][] {
  const groups = new Map<string, EffectiveRoute[]>();
  for (const r of routes) {
    if (!r.cidr) continue;
    const key = r.cidr.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
