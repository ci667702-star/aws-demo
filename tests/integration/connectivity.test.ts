import { beforeEach, describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/connectivity-engine";
import { ProjectBuilder } from "@/lib/project/builder";
import { NACL, SG } from "@/lib/project/factory";
import { createThreeTierSample } from "@/lib/project/samples";
import { idOf, internet, privateNatProject, publicWebProject, res, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

describe("Public Subnet의 EC2 통신", () => {
  it("인터넷 → 퍼블릭 EC2:80 요청이 IGW를 거쳐 성공한다", () => {
    const p = publicWebProject();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("success");
    expect(r.path.map((h) => h.label)).toEqual(expect.arrayContaining([expect.stringContaining("igw"), expect.stringContaining("web")]));
    expect(r.steps.some((s) => s.kind === "security-group" && s.status === "pass")).toBe(true);
    expect(r.steps.some((s) => s.phase === "response")).toBe(true);
  });

  it("퍼블릭 EC2 → 인터넷 호스트 요청이 성공한다", () => {
    const p = publicWebProject();
    const r = simulate(p, { source: res(idOf(p, "web")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.outcome).toBe("success");
  });

  it("기본 경로가 없으면 응답 경로가 없어 실패한다", () => {
    const p = publicWebProject({ route: false });
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("routing");
    expect(r.failure?.reason).toContain("경로가 없습니다");
  });

  it("IGW가 VPC에 연결되지 않으면 실패한다", () => {
    const p = publicWebProject({ igwAttached: false });
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("gateway");
  });

  it("퍼블릭 IP가 없는 인스턴스는 인터넷에서 주소로 지정할 수 없다", () => {
    const p = publicWebProject({ publicIp: false });
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.reason).toContain("퍼블릭 IP");
  });
});

describe("Private Subnet의 NAT 경유 통신", () => {
  it("프라이빗 EC2 → 인터넷 요청이 NAT와 IGW를 거쳐 성공한다", () => {
    const p = privateNatProject();
    const r = simulate(p, { source: res(idOf(p, "worker")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.outcome).toBe("success");
    const labels = r.path.map((h) => h.label).join(" > ");
    expect(labels).toMatch(/nat.*igw/i);
    expect(r.steps.some((s) => s.kind === "nat" && s.title.includes("SNAT"))).toBe(true);
  });

  it("인터넷 → 프라이빗 EC2는 퍼블릭 IP가 없어 실패한다", () => {
    const p = privateNatProject();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "worker"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("failure");
  });

  it("NAT Gateway가 Available이 아니면 실패한다", () => {
    const p = privateNatProject({ natState: "failed" });
    const r = simulate(p, { source: res(idOf(p, "worker")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.failure?.category).toBe("state");
  });

  it("NAT Gateway가 프라이빗 서브넷에 있으면 경로 루프로 실패한다", () => {
    const p = privateNatProject({ natInPrivate: true });
    const r = simulate(p, { source: res(idOf(p, "worker")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.reason).toMatch(/NAT/);
  });
});

describe("Security Group에 의한 통신 차단", () => {
  it("인바운드 규칙이 없는 포트는 보안 그룹 단계에서 거부된다", () => {
    const p = publicWebProject({ sgInbound: [SG.tcp(443, "0.0.0.0/0")] });
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("security-group");
    const failed = r.steps[r.failure!.stepIndex];
    expect(failed.kind).toBe("security-group");
    expect(failed.rules?.length).toBeGreaterThan(0);
  });

  it("아웃바운드 규칙이 없으면 출발지 보안 그룹에서 거부된다", () => {
    const b = new ProjectBuilder("egress");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const igw = b.igw("igw", vpc);
    b.routeTable("rt", vpc, { subnets: [s], routes: [{ destination: "0.0.0.0/0", igw }] });
    const sg = b.securityGroup("no-egress", vpc, { outbound: [] });
    b.ec2("web", s, { ip: "10.0.1.10", publicIp: "enabled", sgs: [sg] });
    const p = b.build();
    const r = simulate(p, { source: res(idOf(p, "web")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.failure?.category).toBe("security-group");
    expect(r.failure?.reason).toContain("아웃바운드");
  });

  it("상태 저장형이므로 응답 단계에서는 보안 그룹을 다시 평가하지 않는다", () => {
    const p = publicWebProject();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    const responseSg = r.steps.filter((s) => s.phase === "response" && s.kind === "security-group");
    expect(responseSg.every((s) => s.status === "info")).toBe(true);
    expect(responseSg[0]?.title).toContain("상태 저장형");
  });
});

describe("Network ACL에 의한 통신 차단 (상태 비저장)", () => {
  it("요청은 허용해도 응답 임시 포트를 막으면 응답 단계에서 실패한다", () => {
    const p = privateNatProject({ privateNacl: "no-ephemeral" });
    const r = simulate(p, { source: res(idOf(p, "worker")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.outcome).toBe("failure");
    expect(r.failure?.category).toBe("network-acl");
    expect(r.steps[r.failure!.stepIndex].phase).toBe("response");
    expect(r.failure?.fixes.join(" ")).toContain("1024-65535");
  });

  it("임시 포트를 허용하면 같은 요청이 성공한다", () => {
    const p = privateNatProject({ privateNacl: "ok" });
    const r = simulate(p, { source: res(idOf(p, "worker")), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 });
    expect(r.outcome).toBe("success");
  });

  it("번호가 낮은 DENY 규칙이 요청을 차단한다", () => {
    const b = new ProjectBuilder("nacl-deny");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const igw = b.igw("igw", vpc);
    b.routeTable("rt", vpc, { subnets: [s], routes: [{ destination: "0.0.0.0/0", igw }] });
    b.networkAcl("acl", vpc, {
      subnets: [s],
      inbound: [NACL.deny(90, "tcp", 80, "203.0.113.0/24"), NACL.allow(100, "all", null, "0.0.0.0/0")],
      outbound: [NACL.allow(100, "all", null, "0.0.0.0/0")],
    });
    const sg = b.securityGroup("sg", vpc, { inbound: [SG.tcp(80, "0.0.0.0/0")] });
    b.ec2("web", s, { ip: "10.0.1.10", publicIp: "enabled", sgs: [sg] });
    const p = b.build();
    const blocked = simulate(p, { source: internet("203.0.113.10"), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(blocked.failure?.category).toBe("network-acl");
    expect(blocked.failure?.reason).toContain("#90");
    const allowed = simulate(p, { source: internet("198.18.0.10"), destination: res(idOf(p, "web"), "public"), protocol: "tcp", port: 80 });
    expect(allowed.outcome).toBe("success");
  });
});

describe("ALB에서 EC2로의 요청 전달", () => {
  it("인터넷 → ALB:80 요청이 정상 대상으로 전달되어 성공한다", () => {
    const p = createThreeTierSample();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp", port: 80 });
    expect(r.outcome).toBe("success");
    expect(r.selectedTargetId).toBe(idOf(p, "app-1"));
    expect(r.steps.some((s) => s.kind === "listener" && s.status === "pass")).toBe(true);
    expect(r.steps.some((s) => s.kind === "target" && s.title.includes("대상 선택"))).toBe(true);
  });

  it("여러 요청을 라운드 로빈으로 분산한다", () => {
    const p = createThreeTierSample();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp", port: 80, requestCount: 6 });
    expect(r.distribution).toEqual([
      { targetId: idOf(p, "app-1"), targetName: "app-1", requests: 3, successes: 3 },
      { targetId: idOf(p, "app-2"), targetName: "app-2", requests: 3, successes: 3 },
    ]);
  });

  it("리스너가 없는 포트로 요청하면 리스너 단계에서 실패한다", () => {
    const p = createThreeTierSample();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp", port: 8080 });
    expect(r.outcome).toBe("failure");
  });
});

describe("EC2에서 RDS로의 가상 연결", () => {
  it("앱 서버 → RDS:3306 연결 검사가 성공한다 (SQL 미실행)", () => {
    const p = createThreeTierSample();
    const r = simulate(p, { source: res(idOf(p, "app-1")), destination: res(idOf(p, "orders-db")), protocol: "tcp", port: 3306 });
    expect(r.outcome).toBe("success");
    const service = r.steps.find((s) => s.kind === "service" && s.title.includes("3306"));
    expect(service?.detail).toContain("SQL");
  });

  it("인터넷 → 비공개 RDS는 실패한다", () => {
    const p = createThreeTierSample();
    const r = simulate(p, { source: internet(), destination: res(idOf(p, "orders-db")), protocol: "tcp", port: 3306 });
    expect(r.outcome).toBe("failure");
  });

  it("잘못된 포트로 연결하면 서비스 단계에서 거부된다", () => {
    const p = createThreeTierSample();
    const dbSg = p.resources.find((r) => r.name === "db-sg")!;
    if (dbSg.type === "security-group") dbSg.config.inboundRules.push(SG.tcp(5432, "10.0.0.0/16"));
    const r = simulate(p, { source: res(idOf(p, "app-1")), destination: res(idOf(p, "orders-db")), protocol: "tcp", port: 5432 });
    expect(r.failure?.category).toBe("service");
  });

  it("VPC DNS 확인이 꺼져 있으면 엔드포인트 이름을 해석하지 못한다", () => {
    const p = createThreeTierSample();
    const vpc = p.resources.find((r) => r.type === "vpc")!;
    if (vpc.type === "vpc") vpc.config.enableDnsSupport = false;
    const r = simulate(p, { source: res(idOf(p, "app-1")), destination: res(idOf(p, "orders-db")), protocol: "tcp", port: 3306 });
    expect(r.failure?.category).toBe("dns");
  });
});

describe("요청 검증과 엔진 오류 구분", () => {
  it("잘못된 요청은 통신 실패가 아니라 invalid-request로 구분한다", () => {
    const p = publicWebProject();
    expect(simulate(p, { source: internet(), destination: internet("8.8.8.8"), protocol: "tcp", port: 80 }).outcome).toBe("invalid-request");
    expect(simulate(p, { source: internet("10.0.0.1"), destination: res(idOf(p, "web")), protocol: "tcp", port: 80 }).outcome).toBe(
      "invalid-request",
    );
    expect(simulate(p, { source: internet(), destination: res(idOf(p, "web")), protocol: "tcp", port: 70000 }).outcome).toBe(
      "invalid-request",
    );
    expect(simulate(p, { source: internet(), destination: res("missing"), protocol: "tcp", port: 80 }).outcome).toBe("invalid-request");
  });

  it("동일한 입력에 대해 항상 같은 결과를 반환한다", () => {
    const p = createThreeTierSample();
    const req = { source: internet(), destination: res(idOf(p, "web-alb")), protocol: "tcp" as const, port: 80, requestCount: 4 };
    const a = simulate(p, req);
    const b = simulate(p, req);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
