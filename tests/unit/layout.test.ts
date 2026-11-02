import { beforeEach, describe, expect, it } from "vitest";
import { focusNeighborhood, focusStateOf, isImplicitEdge } from "@/components/console/map/canvas-model";
import { buildTopology } from "@/lib/engine/topology-engine";
import { computeAutoLayout, NODE_HEIGHT, NODE_WIDTH } from "@/lib/project/layout";
import { ProjectBuilder } from "@/lib/project/builder";
import { SG } from "@/lib/project/factory";
import { createNatInstanceSample, createPrivateNatSample, createThreeTierSample, SAMPLES } from "@/lib/project/samples";
import { idOf, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

describe("자동 정렬: 아키텍처 그림 모양", () => {
  it.each(SAMPLES.map((s) => [s.id, s.create] as const))("%s: 어떤 리소스도 겹치지 않고, 모든 리소스가 배치된다", (_id, create) => {
    const project = create();
    const positions = computeAutoLayout(project);
    expect(Object.keys(positions).sort()).toEqual(project.resources.map((r) => r.id).sort());
    const list = Object.entries(positions);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, pa] = list[i];
        const [b, pb] = list[j];
        const overlap = Math.abs(pa.x - pb.x) < NODE_WIDTH && Math.abs(pa.y - pb.y) < NODE_HEIGHT;
        expect(overlap, `${a}와 ${b}이(가) 겹침`).toBe(false);
      }
    }
  });

  it("가용 영역은 같은 열, 서브넷 종류는 위에서 아래로 퍼블릭 → 프라이빗(NAT) → 프라이빗(격리) 순서다", () => {
    const p = createThreeTierSample();
    const pos = computeAutoLayout(p);
    const at = (name: string) => pos[idOf(p, name)];
    // 같은 AZ는 같은 x, 다른 AZ는 다른 x
    expect(at("public-a").x).toBe(at("app-a").x);
    expect(at("public-a").x).toBe(at("db-a").x);
    expect(at("public-c").x).toBe(at("app-c").x);
    expect(at("public-a").x).not.toBe(at("public-c").x);
    // 같은 종류는 같은 y, 위에서 아래로
    expect(at("public-a").y).toBe(at("public-c").y);
    expect(at("public-a").y).toBeLessThan(at("app-a").y);
    expect(at("app-a").y).toBeLessThan(at("db-a").y);
    // EC2는 자기 서브넷 바로 아래
    expect(at("app-1").x).toBe(at("app-a").x);
    expect(at("app-1").y).toBeGreaterThan(at("app-a").y);
  });

  it("요청 흐름 순서대로 위에서 아래로 놓인다 (IGW·ALB → 대상 그룹 → EC2 → RDS)", () => {
    const p = createThreeTierSample();
    const pos = computeAutoLayout(p);
    const y = (name: string) => pos[idOf(p, name)].y;
    expect(y("main-igw")).toBeLessThan(y("public-a"));
    expect(y("web-alb")).toBeLessThan(y("public-a"));
    expect(y("web-tg")).toBeLessThan(y("app-1"));
    expect(y("web-tg")).toBeGreaterThan(y("public-a"));
    expect(y("app-1")).toBeLessThan(y("orders-db"));
  });

  it("라우팅 테이블과 보안 그룹은 쓰이는 서브넷·리소스와 같은 높이의 오른쪽 열에 놓인다", () => {
    const p = createThreeTierSample();
    const pos = computeAutoLayout(p);
    const at = (name: string) => pos[idOf(p, name)];
    expect(at("private-rt").y).toBe(at("app-a").y);
    expect(at("db-rt").y).toBe(at("db-a").y);
    expect(at("app-sg").y).toBe(at("app-1").y);
    expect(at("private-rt").x).toBeGreaterThan(at("public-c").x);
    expect(at("app-sg").x).toBeGreaterThan(at("private-rt").x);
  });

  it("탄력적 IP는 연결된 NAT 옆에 놓인다 (긴 선이 생기지 않는다)", () => {
    const p = createPrivateNatSample();
    const pos = computeAutoLayout(p);
    const nat = pos[idOf(p, "nat-a")];
    const eip = pos[idOf(p, "nat-a-eip")];
    expect(Math.abs(eip.x - nat.x) + Math.abs(eip.y - nat.y)).toBeLessThan(300);
  });

  it("VPC가 여러 개면 블록이 겹치지 않게 옆으로 놓인다", () => {
    const b = new ProjectBuilder("two-vpcs");
    for (const n of [1, 2]) {
      const vpc = b.vpc(`vpc-${n}`, `10.${n}.0.0/16`);
      const subnet = b.subnet(`subnet-${n}`, vpc, `10.${n}.1.0/24`, "ap-northeast-2a");
      b.ec2(`ec2-${n}`, subnet, { sgs: [b.securityGroup(`sg-${n}`, vpc, { inbound: [SG.tcp(80, "0.0.0.0/0")] })] });
    }
    const p = b.build();
    const pos = computeAutoLayout(p);
    expect(pos[idOf(p, "sg-1")].x).toBeLessThan(pos[idOf(p, "subnet-2")].x);
  });
});

describe("선택 강조", () => {
  it("선택한 리소스와 직접 연결된 것만 강조하고, 나머지는 흐리게 한다", () => {
    const p = createNatInstanceSample();
    const worker = idOf(p, "worker-1");
    const hood = focusNeighborhood(p.connections, [worker]);
    expect(focusStateOf(worker, [worker], hood)).toBe("focus");
    expect(focusStateOf(idOf(p, "private-a"), [worker], hood)).toBe("related");
    expect(focusStateOf(idOf(p, "worker-sg"), [worker], hood)).toBe("related");
    expect(focusStateOf(idOf(p, "lab-igw"), [worker], hood)).toBe("dim");
    expect(hood.edges.size).toBeGreaterThan(0);
  });

  it("아무것도 선택하지 않으면 강조도 흐림도 없다", () => {
    const p = createNatInstanceSample();
    const hood = focusNeighborhood(p.connections, []);
    expect(hood.edges.size).toBe(0);
    expect(focusStateOf(idOf(p, "lab-igw"), [], hood)).toBeNull();
  });

  it("기본 NACL ↔ 서브넷 선만 평소에 숨기는 대상이다", () => {
    const p = createThreeTierSample();
    const topo = buildTopology(p);
    const implicit = p.connections.filter((c) => isImplicitEdge(c, topo));
    expect(implicit.length).toBe(6);
    expect(implicit.every((c) => c.relationType === "network-acl-subnet")).toBe(true);
  });
});
