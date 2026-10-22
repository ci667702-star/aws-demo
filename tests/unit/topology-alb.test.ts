import { beforeEach, describe, expect, it } from "vitest";
import { healthTiming, matcherIncludes, parseMatcher, pickRoundRobin, routableTargets, validateHealthCheck, type TargetHealth } from "@/lib/engine/alb-engine";
import { formatIpv4 } from "@/lib/engine/cidr-utils";
import { computeAllTargetHealth } from "@/lib/engine/connectivity-engine";
import { buildTopology } from "@/lib/engine/topology-engine";
import { DEFAULT_HEALTH_CHECK, SG } from "@/lib/project/factory";
import { updateResourceConfig } from "@/lib/project/mutations";
import { createThreeTierSample } from "@/lib/project/samples";
import { ProjectBuilder } from "@/lib/project/builder";
import { idOf, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

describe("서브넷 분류는 이름이 아니라 라우팅으로 결정된다", () => {
  it("IGW 경로가 있으면 public, NAT 경로면 private-nat, 없으면 private-isolated", () => {
    const p = createThreeTierSample();
    const t = buildTopology(p);
    expect(t.classifySubnet(idOf(p, "public-a")).kind).toBe("public");
    expect(t.classifySubnet(idOf(p, "app-a")).kind).toBe("private-nat");
    expect(t.classifySubnet(idOf(p, "db-a")).kind).toBe("private-isolated");
  });

  it("'public'이라는 이름이어도 IGW 경로가 없으면 퍼블릭이 아니다", () => {
    const b = new ProjectBuilder("naming");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("public-looking-subnet", vpc, "10.0.1.0/24", "ap-northeast-2a");
    b.igw("igw", vpc);
    const p = b.build();
    expect(buildTopology(p).classifySubnet(s).kind).toBe("private-isolated");
  });

  it("IGW가 연결되지 않은 경로는 퍼블릭으로 인정하지 않는다", () => {
    const b = new ProjectBuilder("detached");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const igw = b.igw("igw", null);
    b.routeTable("rt", vpc, { subnets: [s], routes: [{ destination: "0.0.0.0/0", igw }] });
    expect(buildTopology(b.build()).classifySubnet(s).kind).toBe("private-isolated");
  });

  it("명시적 연결이 없으면 기본(main) 라우팅 테이블을 사용한다", () => {
    const b = new ProjectBuilder("main");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const igw = b.igw("igw", vpc);
    const rt = b.routeTable("main-rt", vpc, { main: true, routes: [{ destination: "0.0.0.0/0", igw }] });
    const t = buildTopology(b.build());
    expect(t.routeTableRefFor(s)).toEqual({ kind: "main", routeTableId: rt });
    expect(t.classifySubnet(s).kind).toBe("public");
  });
});

describe("가상 IP 배정", () => {
  it("관리형 인터페이스(ALB/NAT/RDS)는 서브넷 상단 주소를 사용하고 EC2와 겹치지 않는다", () => {
    const p = createThreeTierSample();
    const t = buildTopology(p);
    const albNodes = t.enisOf(idOf(p, "web-alb"));
    expect(albNodes).toHaveLength(2);
    const nat = t.enisOf(idOf(p, "nat-a"))[0];
    const ips = [...albNodes, nat].map((e) => formatIpv4(e.privateIp!));
    expect(new Set(ips).size).toBe(ips.length);
    expect(ips).toContain("10.0.1.254");
    expect(t.enisOf(idOf(p, "orders-db"))[0].privateIp).not.toBeNull();
  });

  it("가상 퍼블릭 IP는 결정적이며 TEST-NET-2 대역을 사용한다", () => {
    const a = buildTopology(createThreeTierSample()).enis().map((e) => e.publicIp);
    useDeterministicIds();
    const b = buildTopology(createThreeTierSample()).enis().map((e) => e.publicIp);
    expect(a).toEqual(b);
    for (const ip of a.filter((x): x is number => x !== null)) expect(formatIpv4(ip)).toMatch(/^198\.51\.100\./);
  });

  it("중지된 EC2는 퍼블릭 IP를 잃는다", () => {
    const b = new ProjectBuilder("stop");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const e = b.ec2("web", s, { publicIp: "enabled", state: "stopped" });
    expect(buildTopology(b.build()).enisOf(e)[0].publicIp).toBeNull();
  });

  it("다음 사용 가능한 사설 IP를 제안한다", () => {
    const p = createThreeTierSample();
    expect(buildTopology(p).suggestPrivateIp(idOf(p, "app-a"))).toBe("10.0.11.11");
  });
});

describe("ALB / Target Group", () => {
  it("matcher를 파싱하고 응답 코드를 판정한다", () => {
    expect(parseMatcher("200").ok).toBe(true);
    expect(matcherIncludes("200-299", 204)).toBe(true);
    expect(matcherIncludes("200,302", 302)).toBe(true);
    expect(matcherIncludes("200", 500)).toBe(false);
    expect(parseMatcher("100").ok).toBe(false);
    expect(parseMatcher("abc").ok).toBe(false);
  });

  it("AWS 헬스 체크 제약을 검사한다", () => {
    expect(validateHealthCheck(DEFAULT_HEALTH_CHECK)).toEqual([]);
    expect(validateHealthCheck({ ...DEFAULT_HEALTH_CHECK, timeoutSeconds: 30, intervalSeconds: 30 }).join()).toContain("간격보다 짧아야");
    expect(validateHealthCheck({ ...DEFAULT_HEALTH_CHECK, path: "health" }).join()).toContain("/");
    expect(healthTiming(DEFAULT_HEALTH_CHECK)).toEqual({ secondsToHealthy: 150, secondsToUnhealthy: 60 });
  });

  it("라운드 로빈으로 대상을 선택한다", () => {
    expect([0, 1, 2, 3].map((i) => pickRoundRobin(["a", "b", "c"], i))).toEqual(["a", "b", "c", "a"]);
    expect(pickRoundRobin([], 0)).toBeUndefined();
  });

  it("정상 대상이 없으면 fail-open으로 비정상 대상을 사용한다", () => {
    const base = { connectionId: "c", availabilityZone: "a", reasonCode: "", reason: "", probe: null };
    const health: TargetHealth[] = [
      { ...base, targetId: "1", targetName: "1", state: "unhealthy" },
      { ...base, targetId: "2", targetName: "2", state: "unused" },
    ];
    expect(routableTargets(health)).toEqual({ targets: [health[0]], failOpen: true });
    expect(routableTargets([health[1]])).toEqual({ targets: [], failOpen: false });
  });

  it("헬스 상태를 설정값으로 계산한다", () => {
    let p = createThreeTierSample();
    const tg = idOf(p, "web-tg");
    expect(computeAllTargetHealth(p).get(tg)?.map((h) => h.state)).toEqual(["healthy", "healthy"]);

    const stopped = updateResourceConfig(p, idOf(p, "app-1"), { state: "stopped" });
    if (!stopped.ok) throw new Error(stopped.error);
    expect(computeAllTargetHealth(stopped.project).get(tg)?.[0]).toMatchObject({ state: "unused", reasonCode: "Target.InvalidState" });

    const wrongCode = updateResourceConfig(p, idOf(p, "app-1"), { httpResponseCode: 503 });
    if (!wrongCode.ok) throw new Error(wrongCode.error);
    expect(computeAllTargetHealth(wrongCode.project).get(tg)?.[0]).toMatchObject({ state: "unhealthy", reasonCode: "Target.ResponseCodeMismatch" });

    const noPort = updateResourceConfig(p, idOf(p, "app-1"), { listenPorts: [8080] });
    if (!noPort.ok) throw new Error(noPort.error);
    expect(computeAllTargetHealth(noPort.project).get(tg)?.[0]).toMatchObject({ state: "unhealthy", reasonCode: "Target.FailedHealthChecks" });

    const blocked = updateResourceConfig(p, idOf(p, "app-sg"), { inboundRules: [SG.tcp(22, "10.0.0.0/16")] });
    if (!blocked.ok) throw new Error(blocked.error);
    p = blocked.project;
    const h = computeAllTargetHealth(p).get(tg)!;
    expect(h.every((x) => x.state === "unhealthy" && x.reasonCode === "Target.Timeout")).toBe(true);
    expect(h[0].probe?.failure?.category).toBe("security-group");
  });
});
