/**
 * 명세의 실험 시나리오: Internet → IGW → Public Subnet → ALB → Private Subnet → EC2
 * 각 변경마다 요청이 실패하는 "이유"가 달라져야 한다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/connectivity-engine";
import type { Project } from "@/lib/engine/resource-models";
import {
  deleteResources,
  disconnect,
  setSingleRelation,
  updateResourceConfig,
} from "@/lib/project/mutations";
import { createThreeTierSample } from "@/lib/project/samples";
import { idOf, internet, res, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function ok(result: ReturnType<typeof updateResourceConfig>): Project {
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

function request(p: Project) {
  return simulate(p, { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp", port: 80 });
}

describe("설정 변경에 따른 실패 원인 변화", () => {
  it("기준 구성에서는 성공한다", () => {
    expect(request(createThreeTierSample()).outcome).toBe("success");
  });

  it("EC2 보안 그룹에서 애플리케이션 포트를 차단하면 대상이 비정상 → 요청 실패", () => {
    let p = createThreeTierSample();
    p = ok(updateResourceConfig(p, idOf(p, "app-sg"), { inboundRules: [] }));
    const r = request(p);
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("security-group");
    expect(r.steps.some((s) => s.kind === "target" && s.status === "warn" && s.title.includes("fail-open"))).toBe(true);
  });

  it("ALB 리스너를 제거하면 리스너 단계에서 실패한다", () => {
    let p = createThreeTierSample();
    p = ok(updateResourceConfig(p, idOf(p, "web-alb"), { listeners: [] }));
    expect(p.connections.some((c) => c.relationType === "alb-target-group")).toBe(false);
    const r = request(p);
    expect(r.failure?.category).toBe("listener");
    expect(r.failure?.reason).toContain("리스너가 없어");
  });

  it("대상 그룹에서 EC2 등록을 모두 해제하면 대상 단계에서 실패한다 (503)", () => {
    let p = createThreeTierSample();
    const registrations = p.connections.filter((c) => c.relationType === "target-group-ec2").map((c) => c.id);
    const result = disconnect(p, registrations);
    if (!result.ok) throw new Error(result.error);
    p = result.project;
    const r = request(p);
    expect(r.failure?.category).toBe("target");
    expect(r.failure?.reason).toContain("503");
  });

  it("퍼블릭 라우팅 테이블에서 기본 경로를 제거하면 라우팅 단계에서 실패한다", () => {
    let p = createThreeTierSample();
    const route = p.connections.find((c) => c.relationType === "route-table-internet-gateway")!;
    const result = disconnect(p, [route.id]);
    if (!result.ok) throw new Error(result.error);
    p = result.project;
    const r = request(p);
    expect(r.failure?.category).toBe("routing");
  });

  it("EC2를 모두 Stopped로 바꾸면 사용할 수 있는 대상이 없어 실패한다", () => {
    let p = createThreeTierSample();
    p = ok(updateResourceConfig(p, idOf(p, "app-1"), { state: "stopped" }));
    p = ok(updateResourceConfig(p, idOf(p, "app-2"), { state: "stopped" }));
    const r = request(p);
    expect(r.failure?.category).toBe("target");
    expect(r.failure?.reason).toContain("Stopped");
  });

  it("EC2 한 대만 Stopped면 나머지 대상으로 요청이 전달된다", () => {
    let p = createThreeTierSample();
    p = ok(updateResourceConfig(p, idOf(p, "app-1"), { state: "stopped" }));
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp", port: 80, requestCount: 4 });
    expect(r.outcome).toBe("success");
    expect(r.distribution).toEqual([{ targetId: idOf(p, "app-2"), targetName: "app-2", requests: 4, successes: 4 }]);
  });

  it("리소스를 삭제하면 연결과 시뮬레이션 결과에 즉시 반영된다", () => {
    let p = createThreeTierSample();
    const result = deleteResources(p, [idOf(p, "web-tg")]);
    if (!result.ok) throw new Error(result.error);
    p = result.project;
    expect(p.connections.some((c) => c.relationType === "target-group-ec2")).toBe(false);
    expect(request(p).failure?.category).toBe("listener");
  });

  it("서브넷의 라우팅 테이블 연결을 해제하면 기본 라우팅 테이블(local만)을 사용한다", () => {
    let p = createThreeTierSample();
    const result = setSingleRelation(p, idOf(p, "public-a"), "route-table-subnet", null);
    if (!result.ok) throw new Error(result.error);
    p = result.project;
    const r = request(p);
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("routing");
  });
});
