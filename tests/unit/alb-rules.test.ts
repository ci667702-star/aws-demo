import { beforeEach, describe, expect, it } from "vitest";
import { normalizeHttpPath, pathPatternMatches, simulate } from "@/lib/engine/connectivity-engine";
import type { Project } from "@/lib/engine/resource-models";
import { buildTopology } from "@/lib/engine/topology-engine";
import * as aws from "@/lib/project/console-actions";
import { DEFAULT_HEALTH_CHECK } from "@/lib/project/factory";
import { deleteResources } from "@/lib/project/mutations";
import { createThreeTierSample } from "@/lib/project/samples";
import { idOf, internet, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function must(r: aws.ActionResult): { project: Project; id: string } {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}

/** 3계층 예시 + app-2만 등록한 api-tg */
function setup() {
  const p = createThreeTierSample();
  const alb = idOf(p, "web-alb");
  const albResource = p.resources.find((r) => r.id === alb);
  const listenerId = albResource?.type === "alb" ? albResource.config.listeners[0].id : "";
  const vpcId = buildTopology(p).vpcOf(alb)!;
  const tg = must(aws.createTargetGroup(p, { name: "api-tg", protocol: "HTTP", port: 80, vpcId, healthCheck: DEFAULT_HEALTH_CHECK, targetIds: [idOf(p, "app-2")] }));
  return { project: tg.project, alb, listener: listenerId, apiTg: tg.id };
}

const toAlb = (alb: string, httpPath: string) => ({ source: internet(), destination: { kind: "resource" as const, resourceId: alb }, protocol: "tcp" as const, port: 80, httpPath });

describe("경로 패턴", () => {
  it("*와 ?를 지원하고 대소문자를 구분한다", () => {
    expect(pathPatternMatches("/api/*", "/api/users")).toBe(true);
    expect(pathPatternMatches("/api/*", "/API/users")).toBe(false);
    expect(pathPatternMatches("/img/?.png", "/img/a.png")).toBe(true);
    expect(pathPatternMatches("/img/?.png", "/img/ab.png")).toBe(false);
    expect(normalizeHttpPath("api/users?id=1")).toBe("/api/users");
  });
});

describe("ALB 리스너 규칙", () => {
  it("경로가 맞는 규칙의 대상 그룹으로 전달하고, 아니면 기본 작업을 쓴다", () => {
    const s = setup();
    const p = must(aws.addListenerRule(s.project, s.alb, s.listener, { priority: 10, pathPatterns: ["/api/*"], action: { type: "forward", targetGroupId: s.apiTg } })).project;
    const api = simulate(p, toAlb(s.alb, "/api/users"));
    expect(api.outcome).toBe("success");
    expect(api.selectedTargetId).toBe(idOf(p, "app-2"));
    expect(api.matchedRuleId).not.toBeNull();
    const home = simulate(p, toAlb(s.alb, "/"));
    expect(home.outcome).toBe("success");
    expect(home.matchedRuleId).toBeNull();
  });

  it("고정 응답 규칙은 대상 없이 ALB가 직접 응답한다", () => {
    const s = setup();
    const p = must(
      aws.addListenerRule(s.project, s.alb, s.listener, { priority: 5, pathPatterns: ["/maintenance"], action: { type: "fixed-response", statusCode: 503, contentType: "text/plain", body: "점검 중" } }),
    ).project;
    const r = simulate(p, toAlb(s.alb, "/maintenance"));
    expect(r.outcome).toBe("success");
    expect(r.fixedResponse).toMatchObject({ statusCode: 503, body: "점검 중" });
    expect(r.selectedTargetId).toBeNull();
    expect(r.summary).toContain("고정 응답 503");
  });

  it("우선순위 중복·잘못된 경로·3XX 고정 응답을 거부한다", () => {
    const s = setup();
    const p = must(aws.addListenerRule(s.project, s.alb, s.listener, { priority: 10, pathPatterns: ["/api/*"], action: { type: "forward", targetGroupId: s.apiTg } })).project;
    const dup = aws.addListenerRule(p, s.alb, s.listener, { priority: 10, pathPatterns: ["/b"], action: { type: "forward", targetGroupId: s.apiTg } });
    expect(dup.ok ? "" : dup.error).toContain("[PriorityInUse]");
    const bad = aws.addListenerRule(p, s.alb, s.listener, { priority: 20, pathPatterns: ["api users"], action: { type: "forward", targetGroupId: s.apiTg } });
    expect(bad.ok).toBe(false);
    const redirect = aws.addListenerRule(p, s.alb, s.listener, { priority: 30, pathPatterns: ["/old"], action: { type: "fixed-response", statusCode: 301, contentType: "text/plain", body: "" } });
    expect(redirect.ok).toBe(false);
  });

  it("규칙이 쓰는 대상 그룹은 콘솔에서 삭제할 수 없고, 강제로 지우면 규칙도 정리된다", () => {
    const s = setup();
    const p = must(aws.addListenerRule(s.project, s.alb, s.listener, { priority: 10, pathPatterns: ["/api/*"], action: { type: "forward", targetGroupId: s.apiTg } })).project;
    const denied = aws.deleteTargetGroup(p, s.apiTg);
    expect(denied.ok ? "" : denied.error).toContain("[ResourceInUse]");
    const removed = deleteResources(p, [s.apiTg]);
    if (!removed.ok) throw new Error(removed.error);
    const alb = removed.project.resources.find((r) => r.id === s.alb && r.type === "alb");
    expect(alb?.type === "alb" ? alb.config.listeners[0].rules : null).toEqual([]);
  });
});
