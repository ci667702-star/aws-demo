/**
 * Guided Lab: 시작 상태는 미완료이고, 사용자가 콘솔에서 하는 것과 같은 동작(console-actions)을 순서대로 적용하면
 * 해당 단계가 실제 설정·분석 결과로 완료 판정되어야 한다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { simulate, type SimulationRequest } from "@/lib/engine/connectivity-engine";
import type { Project, SgRule } from "@/lib/engine/resource-models";
import { createLabContext, evaluateLab, labById, LABS } from "@/lib/labs/labs";
import * as aws from "@/lib/project/console-actions";
import { DEFAULT_HEALTH_CHECK, NACL, SG } from "@/lib/project/factory";
import { settleLifecycle } from "@/lib/project/lifecycle";
import { idOf, internet, res, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

/** 콘솔 동작을 순서대로 적용하는 세션 */
class Session {
  constructor(public project: Project) {}
  do(action: (p: Project) => aws.ActionResult): string {
    const r = action(this.project);
    if (!r.ok) throw new Error(`${r.error} ${r.hint ?? ""}`);
    this.project = r.project;
    return r.createdId ?? "";
  }
  /** 시간이 지나 pending/provisioning/creating 리소스가 준비된 상태 */
  wait() {
    this.project = settleLifecycle(this.project);
  }
  /** Reachability Analyzer: 경로를 만들고 분석 결과를 기록한다 */
  analyze(request: SimulationRequest) {
    const pathId = this.do((p) => aws.createNetworkPath(p, { name: "", request }));
    const result = simulate(this.project, request);
    this.project = aws.recordPathAnalysis(this.project, pathId, result);
    return result;
  }
  done(labId: string) {
    return evaluateLab(labById(labId)!, createLabContext(this.project));
  }
  doneIds(labId: string) {
    return this.done(labId).steps.filter((s) => s.done).map((s) => s.id);
  }
  id(name: string) {
    return idOf(this.project, name);
  }
}

const web = aws.userDataFor("amazon-linux-2023", "web-server");

function launch(s: Session, name: string, subnetId: string, sgIds: string[], options: Partial<aws.LaunchInstancesInput> = {}) {
  return s.do((p) =>
    aws.launchInstances(p, {
      name,
      ami: "amazon-linux-2023",
      instanceType: "t3.micro",
      subnetId,
      publicIpMode: "disabled",
      securityGroupIds: sgIds,
      listenPorts: web.listenPorts,
      httpResponseCode: 200,
      userData: web.script,
      count: 1,
      ...options,
    }),
  );
}

function sg(s: Session, name: string, vpcId: string, inbound: SgRule[]) {
  return s.do((p) => aws.createSecurityGroup(p, { name, description: name, vpcId, inboundRules: inbound, outboundRules: [SG.all("0.0.0.0/0")] }));
}

/** VPC + IGW + 퍼블릭 라우팅 테이블 + 지정한 퍼블릭 서브넷들 */
function publicNetwork(s: Session, subnets: { name: string; az: string; cidr: string }[]) {
  const vpcId = s.do((p) => aws.createVpc(p, { name: "lab-vpc", cidr: "10.0.0.0/16" }));
  const ids = subnets.map((x) => s.do((p) => aws.createSubnet(p, { vpcId, name: x.name, availabilityZone: x.az, cidr: x.cidr })));
  const igwId = s.do((p) => aws.createInternetGateway(p, { name: "lab-igw" }));
  s.do((p) => aws.attachInternetGateway(p, igwId, vpcId));
  const rtId = s.do((p) => aws.createRouteTable(p, { vpcId, name: "public-rt" }));
  s.do((p) => aws.editRoutes(p, rtId, [{ destination: "0.0.0.0/0", targetId: igwId }]));
  s.do((p) => aws.editRouteTableAssociations(p, rtId, ids));
  return { vpcId, subnetIds: ids, igwId };
}

describe("Guided Lab 판정 (콘솔 동작 기준)", () => {
  it("모든 실습의 시작 상태는 완료되지 않은 상태이고, 실습 1~4는 빈 샌드박스에서 시작한다", () => {
    for (const lab of LABS) {
      const starter = lab.createStarter();
      expect(evaluateLab(lab, createLabContext(starter)).completed, lab.id).toBe(false);
      if (lab.id !== "lab-5-security") expect(starter.resources, lab.id).toEqual([]);
    }
  });

  it("Lab 1: 빈 샌드박스에서 퍼블릭 웹 서버를 단계별로 완성한다", () => {
    const lab = "lab-1-public-ec2";
    const s = new Session(labById(lab)!.createStarter());
    expect(s.done(lab).completedCount).toBe(0);
    const vpcId = s.do((p) => aws.createVpc(p, { name: "lab-vpc", cidr: "10.0.0.0/16" }));
    expect(s.doneIds(lab)).toEqual(["vpc"]);
    const subnetId = s.do((p) => aws.createSubnet(p, { vpcId, name: "public-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" }));
    const igwId = s.do((p) => aws.createInternetGateway(p, { name: "lab-igw" }));
    expect(s.doneIds(lab)).toEqual(["vpc", "subnet"]);
    s.do((p) => aws.attachInternetGateway(p, igwId, vpcId));
    const mainRt = s.project.resources.find((r) => r.type === "route-table")!.id;
    s.do((p) => aws.editRoutes(p, mainRt, [{ destination: "0.0.0.0/0", targetId: igwId }]));
    expect(s.doneIds(lab)).toEqual(["vpc", "subnet", "igw", "route"]);
    const sgId = sg(s, "web-sg", vpcId, [SG.tcp(80, "0.0.0.0/0")]);
    const ec2 = launch(s, "web-1", subnetId, [sgId], { publicIpMode: "enabled" });
    expect(s.doneIds(lab)).not.toContain("ec2");
    s.wait();
    expect(s.doneIds(lab)).toContain("ec2");
    expect(s.done(lab).completed).toBe(false);
    s.analyze({ source: internet(), destination: res(ec2), protocol: "tcp", port: 80 });
    expect(s.done(lab).completed).toBe(true);
  });

  it("Lab 1: 사용자 데이터 없이 시작한 인스턴스는 웹 서버 단계를 통과하지 못한다", () => {
    const lab = "lab-1-public-ec2";
    const s = new Session(labById(lab)!.createStarter());
    const net = publicNetwork(s, [{ name: "public-a", az: "ap-northeast-2a", cidr: "10.0.1.0/24" }]);
    const sgId = sg(s, "web-sg", net.vpcId, [SG.tcp(80, "0.0.0.0/0")]);
    const plain = aws.userDataFor("amazon-linux-2023", "none");
    const ec2 = launch(s, "web-1", net.subnetIds[0], [sgId], { publicIpMode: "enabled", listenPorts: plain.listenPorts, userData: "" });
    s.wait();
    expect(s.doneIds(lab)).not.toContain("ec2");
    expect(s.analyze({ source: internet(), destination: res(ec2), protocol: "tcp", port: 80 }).outcome).toBe("failure");
    expect(s.doneIds(lab)).not.toContain("analyze");
  });

  it("Lab 2: 프라이빗 인스턴스와 NAT 게이트웨이", () => {
    const lab = "lab-2-private-nat";
    const s = new Session(labById(lab)!.createStarter());
    const net = publicNetwork(s, [{ name: "public-a", az: "ap-northeast-2a", cidr: "10.0.1.0/24" }]);
    expect(s.doneIds(lab)).toEqual(["public-network"]);
    const priv = s.do((p) => aws.createSubnet(p, { vpcId: net.vpcId, name: "private-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.11.0/24" }));
    const eip = s.do((p) => aws.allocateElasticIp(p, { name: "nat-eip" }));
    const nat = s.do((p) => aws.createNatGateway(p, { name: "nat-a", subnetId: net.subnetIds[0], eipId: eip }));
    expect(s.doneIds(lab)).toEqual(["public-network", "private-subnet", "eip"]);
    s.wait();
    expect(s.doneIds(lab)).toContain("nat");
    const rt = s.do((p) => aws.createRouteTable(p, { vpcId: net.vpcId, name: "private-rt" }));
    s.do((p) => aws.editRoutes(p, rt, [{ destination: "0.0.0.0/0", targetId: nat }]));
    s.do((p) => aws.editRouteTableAssociations(p, rt, [priv]));
    const defaultSg = s.project.resources.find((r) => r.type === "security-group" && r.config.isDefault)!.id;
    const ec2 = launch(s, "worker-1", priv, [defaultSg]);
    s.wait();
    expect(s.doneIds(lab)).toEqual(["public-network", "private-subnet", "eip", "nat", "private-route", "private-ec2"]);
    expect(s.analyze({ source: res(ec2), destination: internet("203.0.113.200"), protocol: "tcp", port: 443 }).outcome).toBe("success");
    expect(s.analyze({ source: internet(), destination: res(ec2), protocol: "tcp", port: 80 }).outcome).toBe("failure");
    expect(s.done(lab).completed).toBe(true);
  });

  it("Lab 3: ALB와 EC2 — 보안 그룹 참조 규칙을 추가해야 대상이 healthy가 된다", () => {
    const lab = "lab-3-alb";
    const s = new Session(labById(lab)!.createStarter());
    const net = publicNetwork(s, [
      { name: "public-a", az: "ap-northeast-2a", cidr: "10.0.1.0/24" },
      { name: "public-c", az: "ap-northeast-2c", cidr: "10.0.2.0/24" },
    ]);
    const appA = s.do((p) => aws.createSubnet(p, { vpcId: net.vpcId, name: "app-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.11.0/24" }));
    const appC = s.do((p) => aws.createSubnet(p, { vpcId: net.vpcId, name: "app-c", availabilityZone: "ap-northeast-2c", cidr: "10.0.12.0/24" }));
    const appSg = sg(s, "app-sg", net.vpcId, []);
    const app1 = launch(s, "app-1", appA, [appSg]);
    const app2 = launch(s, "app-2", appC, [appSg]);
    s.wait();
    const albSg = sg(s, "alb-sg", net.vpcId, [SG.tcp(80, "0.0.0.0/0")]);
    const tg = s.do((p) => aws.createTargetGroup(p, { name: "web-tg", protocol: "HTTP", port: 80, vpcId: net.vpcId, healthCheck: { ...DEFAULT_HEALTH_CHECK }, targetIds: [app1, app2] }));
    const alb = s.do((p) =>
      aws.createLoadBalancer(p, {
        name: "web-alb",
        scheme: "internet-facing",
        vpcId: net.vpcId,
        subnetIds: net.subnetIds,
        securityGroupIds: [albSg],
        listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg }],
      }),
    );
    expect(s.doneIds(lab)).not.toContain("alb");
    s.wait();
    expect(s.doneIds(lab)).toEqual(["network", "servers", "alb-sg", "tg", "alb"]);
    s.do((p) => aws.editSecurityGroupRules(p, appSg, "inbound", [SG.tcp(80, { sg: albSg }, "HTTP from ALB")]));
    expect(s.doneIds(lab)).toContain("healthy");
    const result = s.analyze({ source: internet(), destination: res(alb), protocol: "tcp", port: 80, requestCount: 6 });
    expect(result.distribution?.filter((d) => d.successes > 0)).toHaveLength(2);
    expect(s.done(lab).completed).toBe(true);
  });

  it("Lab 4: 앱 서버에서만 접근할 수 있는 RDS", () => {
    const lab = "lab-4-rds";
    const s = new Session(labById(lab)!.createStarter());
    const vpcId = s.do((p) => aws.createVpc(p, { name: "lab-vpc", cidr: "10.0.0.0/16" }));
    const appSubnet = s.do((p) => aws.createSubnet(p, { vpcId, name: "app-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.11.0/24" }));
    const appSg = sg(s, "app-sg", vpcId, []);
    const app = launch(s, "app-1", appSubnet, [appSg]);
    s.wait();
    expect(s.doneIds(lab)).toContain("app");
    const dbA = s.do((p) => aws.createSubnet(p, { vpcId, name: "db-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.21.0/24" }));
    const dbC = s.do((p) => aws.createSubnet(p, { vpcId, name: "db-c", availabilityZone: "ap-northeast-2c", cidr: "10.0.22.0/24" }));
    const group = s.do((p) => aws.createDbSubnetGroup(p, { name: "db-subnets", description: "db", vpcId, subnetIds: [dbA, dbC] }));
    const dbSg = sg(s, "db-sg", vpcId, [SG.tcp(3306, { sg: appSg }, "MySQL from app")]);
    const rds = s.do((p) =>
      aws.createDatabase(p, {
        identifier: "orders-db",
        engine: "mysql",
        instanceClass: "db.t3.micro",
        allocatedStorageGb: 20,
        multiAz: false,
        dbSubnetGroupId: group,
        publiclyAccessible: false,
        securityGroupIds: [dbSg],
        port: 3306,
      }),
    );
    expect(s.doneIds(lab)).not.toContain("rds");
    s.wait();
    expect(s.doneIds(lab)).toEqual(["app", "db-subnets", "dbsg", "db-sg", "rds", "private"]);
    expect(s.analyze({ source: res(app), destination: res(rds), protocol: "tcp", port: 3306 }).outcome).toBe("success");
    expect(s.done(lab).completed).toBe(true);
  });

  it("Lab 5: 의도된 보안 오류를 모두 고치고 분석으로 확인하면 완료된다", () => {
    const lab = "lab-5-security";
    const s = new Session(labById(lab)!.createStarter());
    expect(s.done(lab).completedCount).toBe(0);
    s.do((p) => aws.editSecurityGroupRules(p, s.id("app-sg"), "inbound", [SG.tcp(80, { sg: s.id("alb-sg") })]));
    s.do((p) => aws.editSecurityGroupRules(p, s.id("db-sg"), "inbound", [SG.tcp(3306, { sg: s.id("app-sg") })]));
    s.do((p) => aws.editSecurityGroupRules(p, s.id("alb-sg"), "inbound", [SG.tcp(443, "0.0.0.0/0"), SG.tcp(80, "0.0.0.0/0")]));
    expect(s.doneIds(lab)).toEqual(["ssh", "db-exposure", "targets", "alb-port"]);
    const nacl = s.project.resources.find((r) => r.name === "public-nacl");
    if (nacl?.type !== "network-acl") throw new Error("public-nacl 없음");
    s.do((p) => aws.editNetworkAclRules(p, nacl.id, "outbound", [...nacl.config.outboundRules, NACL.allow(130, "tcp", [1024, 65535], "0.0.0.0/0")]));
    expect(s.doneIds(lab)).toContain("nacl");
    expect(s.doneIds(lab)).not.toContain("verify");
    expect(s.analyze({ source: internet(), destination: res(s.id("shop-alb")), protocol: "tcp", port: 80 }).outcome).toBe("success");
    expect(s.done(lab).completed).toBe(true);
  });
});
