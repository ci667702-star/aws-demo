import { beforeEach, describe, expect, it } from "vitest";
import { checkConnection } from "@/lib/engine/connection-rules";
import type { Project } from "@/lib/engine/resource-models";
import { ProjectBuilder } from "@/lib/project/builder";
import { createEmptyProject, SG } from "@/lib/project/factory";
import {
  addResource,
  addRoute,
  connectResources,
  deleteResources,
  disconnect,
  setListenerTargetGroup,
  setSingleRelation,
  toggleRelation,
  updateResourceConfig,
  updateRouteDestination,
  updateRouteTarget,
  type MutationResult,
} from "@/lib/project/mutations";
import { createThreeTierSample } from "@/lib/project/samples";
import { idOf, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function unwrap(r: MutationResult): Extract<MutationResult, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error} ${r.hint ?? ""}`);
  return r;
}

function twoVpcs() {
  const b = new ProjectBuilder("two");
  const a = b.vpc("vpc-a", "10.0.0.0/16");
  const c = b.vpc("vpc-b", "10.1.0.0/16");
  const sa = b.subnet("subnet-a", a, "10.0.1.0/24", "ap-northeast-2a");
  const sb = b.subnet("subnet-b", c, "10.1.1.0/24", "ap-northeast-2a");
  const sgA = b.securityGroup("sg-a", a);
  const sgB = b.securityGroup("sg-b", c);
  const ec2 = b.ec2("web", sa, { ip: "10.0.1.10" });
  const rtA = b.routeTable("rt-a", a);
  const igwB = b.igw("igw-b", c);
  return { p: b.build(), a, c, sa, sb, sgA, sgB, ec2, rtA, igwB };
}

describe("리소스 연결 유효성", () => {
  it("방향과 관계없이 지원되는 관계를 찾아 정규화한다", () => {
    const { p, sgA, ec2 } = twoVpcs();
    const r = checkConnection(p, sgA, ec2);
    expect(r.ok && r.connection).toMatchObject({ relationType: "ec2-security-group", sourceResourceId: ec2, targetResourceId: sgA });
  });

  it("지원되지 않는 관계는 이유와 함께 거부한다", () => {
    const { p, ec2, igwB } = twoVpcs();
    const r = checkConnection(p, ec2, igwB);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("지원되는 관계가 없습니다");
      expect(r.hint).toContain("Subnet");
    }
  });

  it("다른 VPC의 보안 그룹은 연결할 수 없다", () => {
    const { p, ec2, sgB } = twoVpcs();
    const r = checkConnection(p, ec2, sgB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("서로 다른 VPC");
  });

  it("서브넷은 하나의 VPC에만 속한다", () => {
    const { p, c, sa } = twoVpcs();
    const r = checkConnection(p, c, sa);
    expect(!r.ok && r.reason).toContain("하나의 VPC");
  });

  it("다른 VPC에 연결된 IGW를 경로 대상으로 쓸 수 없다", () => {
    const { p, rtA, igwB } = twoVpcs();
    expect(checkConnection(p, rtA, igwB).ok).toBe(false);
  });

  it("같은 Destination 경로 중복을 거부한다", () => {
    const p = createThreeTierSample();
    const r = checkConnection(p, idOf(p, "public-rt"), idOf(p, "nat-a"));
    expect(!r.ok && r.reason).toContain("0.0.0.0/0");
  });

  it("ALB는 가용 영역당 하나의 서브넷만 사용한다", () => {
    const p = createThreeTierSample();
    const r = checkConnection(p, idOf(p, "web-alb"), idOf(p, "app-a"));
    expect(!r.ok && r.hint).toContain("가용 영역당");
  });

  it("EC2를 서브넷에 배치하면 사설 IP를 자동 할당한다", () => {
    let p: Project = createEmptyProject("ip");
    const vpc = unwrap(addResource(p, "vpc", { x: 0, y: 0 }));
    p = vpc.project;
    const subnet = unwrap(addResource(p, "subnet", { x: 0, y: 0 }));
    p = unwrap(connectResources(subnet.project, vpc.createdId!, subnet.createdId!)).project;
    const ec2 = unwrap(addResource(p, "ec2", { x: 0, y: 0 }));
    const placed = unwrap(connectResources(ec2.project, ec2.createdId!, subnet.createdId!));
    const inst = placed.project.resources.find((r) => r.id === ec2.createdId);
    expect(inst?.type === "ec2" && inst.config.privateIp).toBe("10.0.0.10");
    expect(placed.notes.join()).toContain("자동으로 할당");
  });

  it("ALB → Target Group 연결은 비어 있는 리스너에 지정된다", () => {
    let p = createThreeTierSample();
    p = unwrap(setListenerTargetGroup(p, idOf(p, "web-alb"), (p.resources.find((r) => r.name === "web-alb") as Extract<Project["resources"][number], { type: "alb" }>).config.listeners[0].id, null)).project;
    const r = unwrap(connectResources(p, idOf(p, "web-tg"), idOf(p, "web-alb")));
    expect(r.notes.join()).toContain("HTTP:80");
  });
});

describe("변경 연산", () => {
  it("리소스 삭제 시 관련 연결과 SG 참조 규칙을 정리한다", () => {
    const p = createThreeTierSample();
    const r = unwrap(deleteResources(p, [idOf(p, "app-sg")]));
    expect(r.project.connections.some((c) => c.targetResourceId === idOf(p, "app-sg") || c.sourceResourceId === idOf(p, "app-sg"))).toBe(false);
    const dbSg = r.project.resources.find((x) => x.name === "db-sg");
    expect(dbSg?.type === "security-group" && dbSg.config.inboundRules).toHaveLength(0);
    expect(r.notes.join(" ")).toContain("규칙");
  });

  it("Terminated 인스턴스는 다시 Running으로 바꿀 수 없다", () => {
    let p = createThreeTierSample();
    p = unwrap(updateResourceConfig(p, idOf(p, "app-1"), { state: "terminated" })).project;
    const r = updateResourceConfig(p, idOf(p, "app-1"), { state: "running" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Terminated");
  });

  it("스키마에 맞지 않는 설정값을 거부한다", () => {
    const p = createThreeTierSample();
    const r = updateResourceConfig(p, idOf(p, "app-1"), { instanceType: "x1.huge" as never });
    expect(r.ok).toBe(false);
  });

  it("리스너를 삭제하면 해당 전달 연결도 삭제한다", () => {
    const p = createThreeTierSample();
    const r = unwrap(updateResourceConfig(p, idOf(p, "web-alb"), { listeners: [] }));
    expect(r.project.connections.filter((c) => c.relationType === "alb-target-group")).toHaveLength(0);
  });

  it("단일 관계를 교체한다 (서브넷의 라우팅 테이블 변경)", () => {
    const p = createThreeTierSample();
    const r = unwrap(setSingleRelation(p, idOf(p, "app-a"), "route-table-subnet", idOf(p, "public-rt")));
    const assoc = r.project.connections.filter((c) => c.relationType === "route-table-subnet" && c.targetResourceId === idOf(p, "app-a"));
    expect(assoc).toHaveLength(1);
    expect(assoc[0].sourceResourceId).toBe(idOf(p, "public-rt"));
  });

  it("보안 그룹 연결을 켜고 끈다", () => {
    const p = createThreeTierSample();
    const off = unwrap(toggleRelation(p, idOf(p, "app-1"), idOf(p, "app-sg"), false)).project;
    expect(off.connections.some((c) => c.relationType === "ec2-security-group" && c.sourceResourceId === idOf(p, "app-1"))).toBe(false);
    const on = unwrap(toggleRelation(off, idOf(p, "app-1"), idOf(p, "app-sg"), true)).project;
    expect(on.connections.some((c) => c.relationType === "ec2-security-group" && c.sourceResourceId === idOf(p, "app-1"))).toBe(true);
  });

  it("경로를 추가하고 Destination과 대상을 수정한다", () => {
    const p = createThreeTierSample();
    const added = unwrap(addRoute(p, idOf(p, "db-rt"), idOf(p, "nat-a"), "203.0.113.0/24"));
    const connId = added.createdId!;
    expect(updateRouteDestination(added.project, connId, "not-a-cidr").ok).toBe(false);
    const moved = unwrap(updateRouteDestination(added.project, connId, "198.18.0.0/15"));
    const route = moved.project.connections.find((c) => c.id === connId);
    expect(route?.relationType === "route-table-nat-gateway" && route.metadata.destinationCidr).toBe("198.18.0.0/15");
    const retarget = unwrap(updateRouteTarget(moved.project, connId, idOf(p, "main-igw")));
    expect(retarget.project.connections.some((c) => c.relationType === "route-table-internet-gateway" && c.sourceResourceId === idOf(p, "db-rt"))).toBe(true);
    expect(retarget.project.connections.some((c) => c.id === connId)).toBe(false);
  });

  it("연결선 삭제는 즉시 반영된다", () => {
    const p = createThreeTierSample();
    const target = p.connections.find((c) => c.relationType === "target-group-ec2")!;
    const r = unwrap(disconnect(p, [target.id]));
    expect(r.project.connections).toHaveLength(p.connections.length - 1);
  });

  it("보안 그룹 규칙 추가는 설정 변경으로 처리된다", () => {
    const p = createThreeTierSample();
    const sg = p.resources.find((r) => r.name === "alb-sg")!;
    if (sg.type !== "security-group") throw new Error();
    const r = unwrap(updateResourceConfig(p, sg.id, { inboundRules: [...sg.config.inboundRules, SG.tcp(443, "0.0.0.0/0")] }));
    const updated = r.project.resources.find((x) => x.id === sg.id);
    expect(updated?.type === "security-group" && updated.config.inboundRules).toHaveLength(2);
  });
});
