import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@/lib/engine/resource-models";
import { validateProject, VALIDATION_RULES } from "@/lib/engine/validation-engine";
import { ProjectBuilder } from "@/lib/project/builder";
import { NACL, SG } from "@/lib/project/factory";
import { createPublicEc2Sample, createThreeTierSample } from "@/lib/project/samples";
import { createLab5Starter } from "@/lib/labs/labs";
import { useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

/** 퍼블릭 서브넷 2개 + 앱 서브넷 2개 + ALB/TG 기본 구성 */
function webTier(options: {
  appInbound?: ReturnType<typeof SG.tcp>[];
  albInbound?: ReturnType<typeof SG.tcp>[];
  listenPorts?: number[];
  httpResponseCode?: number;
  albSubnets?: "two-az" | "one" | "same-az" | "private";
  scheme?: "internet-facing" | "internal";
  listeners?: { protocol?: "HTTP" | "HTTPS"; port: number; targetGroup?: boolean }[];
  targetAz?: string;
  healthCheck?: Record<string, unknown>;
} = {}) {
  const b = new ProjectBuilder("web-tier");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const pubC = b.subnet("public-c", vpc, "10.0.2.0/24", "ap-northeast-2c");
  const pubA2 = b.subnet("public-a2", vpc, "10.0.3.0/24", "ap-northeast-2a");
  const appA = b.subnet("app-a", vpc, "10.0.11.0/24", options.targetAz ?? "ap-northeast-2a");
  const appC = b.subnet("app-c", vpc, "10.0.12.0/24", "ap-northeast-2c");
  const igw = b.igw("igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pubA, pubC, pubA2], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("app-rt", vpc, { subnets: [appA, appC] });
  const albSg = b.securityGroup("alb-sg", vpc, { inbound: options.albInbound ?? [SG.tcp(80, "0.0.0.0/0")] });
  const appSg = b.securityGroup("app-sg", vpc, { inbound: options.appInbound ?? [SG.tcp(80, { sg: albSg })] });
  const app1 = b.ec2("app-1", appA, { ip: "10.0.11.10", sgs: [appSg], listenPorts: options.listenPorts ?? [80], httpResponseCode: options.httpResponseCode });
  const app2 = b.ec2("app-2", appC, { ip: "10.0.12.10", sgs: [appSg], listenPorts: options.listenPorts ?? [80], httpResponseCode: options.httpResponseCode });
  const tg = b.targetGroup("tg", { targets: [app1, app2], healthCheck: options.healthCheck });
  const subnets =
    options.albSubnets === "one"
      ? [pubA]
      : options.albSubnets === "same-az"
        ? [pubA, pubA2]
        : options.albSubnets === "private"
          ? [appA, appC]
          : [pubA, pubC];
  b.alb("alb", {
    scheme: options.scheme,
    subnets,
    sgs: [albSg],
    listeners: (options.listeners ?? [{ port: 80, targetGroup: true }]).map((l) => ({
      protocol: l.protocol,
      port: l.port,
      targetGroup: l.targetGroup ? tg : undefined,
    })),
  });
  return b.build();
}

/** VPC 하나와 서브넷 하나 */
function single(build: (b: ProjectBuilder, ids: { vpc: string; subnet: string }) => void, cidr = "10.0.0.0/16"): Project {
  const b = new ProjectBuilder("single");
  const vpc = b.vpc("vpc", cidr);
  const subnet = b.subnet("subnet", vpc, "10.0.1.0/24", "ap-northeast-2a");
  build(b, { vpc, subnet });
  return b.build();
}

function dbTier(options: { publiclyAccessible?: boolean; dbPublic?: boolean; dbInbound?: ReturnType<typeof SG.tcp>[]; dns?: boolean; subnets?: "two" | "one" | "two-vpc"; state?: "available" | "stopped"; multiAz?: boolean } = {}) {
  const b = new ProjectBuilder("db-tier");
  const vpc = b.vpc("vpc", "10.0.0.0/16", { enableDnsHostnames: options.dns ?? true });
  const other = b.vpc("other-vpc", "10.9.0.0/16");
  const app = b.subnet("app-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const dbA = b.subnet("db-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  const dbC = b.subnet("db-c", vpc, "10.0.22.0/24", "ap-northeast-2c");
  const foreign = b.subnet("foreign-c", other, "10.9.22.0/24", "ap-northeast-2c");
  const igw = b.igw("igw", vpc);
  b.routeTable("db-rt", vpc, {
    subnets: [dbA, dbC],
    routes: options.dbPublic ? [{ destination: "0.0.0.0/0", igw }] : [],
  });
  const appSg = b.securityGroup("app-sg", vpc);
  const dbSg = b.securityGroup("db-sg", vpc, { inbound: options.dbInbound ?? [SG.tcp(3306, { sg: appSg })] });
  b.ec2("app", app, { ip: "10.0.11.10", sgs: [appSg] });
  const group = b.dbSubnetGroup(
    "dbsg",
    options.subnets === "one" ? [dbA] : options.subnets === "two-vpc" ? [dbA, foreign] : [dbA, dbC],
  );
  b.rds("db", {
    subnetGroup: group,
    sgs: [dbSg],
    publiclyAccessible: options.publiclyAccessible,
    state: options.state,
    multiAz: options.multiAz ?? true,
  });
  return b.build();
}

const triggers: Record<string, () => Project> = {
  "NET-001": () => single(() => {}, "10.0.0.0/8"),
  "NET-002": () => single((b, { vpc }) => b.subnet("tiny", vpc, "10.0.2.0/30", "ap-northeast-2a")),
  "NET-003": () => single((b) => b.subnet("orphan", null, "10.0.2.0/24", "ap-northeast-2a")),
  "NET-004": () => single((b, { vpc }) => b.subnet("outside", vpc, "10.1.1.0/24", "ap-northeast-2a")),
  "NET-005": () => single((b, { vpc }) => b.subnet("overlap", vpc, "10.0.0.0/23", "ap-northeast-2a")),
  "NET-006": () => single((b) => b.vpc("vpc-2", "10.0.0.0/16")),
  "NET-007": () => single((b, { vpc }) => b.subnet("bad-az", vpc, "10.0.2.0/24", "us-east-1a")),
  "NET-008": () => single((b) => b.igw("loose-igw")),
  "NET-009": () =>
    single((b, { vpc }) => {
      const igw = b.igw("igw", vpc);
      b.routeTable("rt", vpc, { routes: [{ destination: "0.0.0.0/33", igw }] });
    }),
  "NET-010": () =>
    single((b, { vpc, subnet }) => {
      const igw = b.igw("detached");
      b.routeTable("rt", vpc, { subnets: [subnet], routes: [{ destination: "0.0.0.0/0", igw }] });
    }),
  "NET-011": () =>
    single((b, { vpc }) => {
      const nat = b.nat("floating-nat", null);
      b.routeTable("rt", vpc, { routes: [{ destination: "0.0.0.0/0", nat }] });
    }),
  "NET-012": () =>
    single((b, { vpc, subnet }) => {
      const igw = b.igw("igw", vpc);
      const nat = b.nat("nat", subnet);
      b.routeTable("rt", vpc, { routes: [{ destination: "0.0.0.0/0", igw }, { destination: "0.0.0.0/0", nat }] });
    }),
  "NET-013": () => single((b) => b.routeTable("loose-rt", null)),
  "NET-014": () =>
    single((b, { subnet }) => {
      const other = b.vpc("other", "10.5.0.0/16");
      b.routeTable("foreign-rt", other, { subnets: [subnet] });
    }),
  "NET-015": () => single((b, { vpc, subnet }) => b.ec2("isolated", subnet, { sgs: [b.securityGroup("sg", vpc)] })),
  "NET-016": () => single((b, { subnet }) => b.nat("nat-in-private", subnet)),
  "NET-017": () => single((b) => b.nat("nat-nowhere", null)),
  "NET-018": () =>
    single((b, { vpc }) => {
      const igw = b.igw("igw", vpc);
      b.routeTable("rt", vpc, { routes: [{ destination: "10.0.5.0/24", igw }] });
    }),
  "NET-019": () => single((b, { vpc, subnet }) => b.ec2("public-ip-private", subnet, { publicIp: "enabled", sgs: [b.securityGroup("sg", vpc)] })),
  "NET-020": () => single(() => {}),
  "NET-021": () => single(() => {}),
  "NET-022": () =>
    single((b, { vpc }) => {
      b.routeTable("main-1", vpc, { main: true });
      b.routeTable("main-2", vpc, { main: true });
    }),
  "NET-023": () => single(() => {}, "172.32.0.0/16"),
  "NET-024": () => single((b, { subnet }) => b.nat("legacy-nat", subnet, { eip: false })),
  "NET-025": () => single((b, { subnet }) => b.nat("broken-nat", subnet, { state: "failed" })),
  "EIP-001": () => single((b) => b.elasticIp("spare-eip")),
  "SEC-001": () => single((b, { vpc }) => b.securityGroup("open", vpc, { inbound: [SG.all("0.0.0.0/0")] })),
  "SEC-002": () => single((b, { vpc }) => b.securityGroup("ssh", vpc, { inbound: [SG.tcp(22, "0.0.0.0/0")] })),
  "SEC-003": () => single((b, { vpc }) => b.securityGroup("db", vpc, { inbound: [SG.tcp([3000, 4000], "0.0.0.0/0")] })),
  "SEC-004": () => single((b, { vpc }) => b.securityGroup("bad", vpc, { inbound: [{ ...SG.tcp(80, "10.0.0.0/33") }] })),
  "SEC-005": () =>
    single((b, { vpc }) => {
      const other = b.vpc("other", "10.5.0.0/16");
      const foreign = b.securityGroup("foreign", other);
      b.securityGroup("ref", vpc, { inbound: [SG.tcp(80, { sg: foreign })] });
    }),
  "SEC-006": () => single((b, { subnet }) => b.ec2("naked", subnet)),
  "SEC-007": () =>
    single((b, { subnet }) => {
      const other = b.vpc("other", "10.5.0.0/16");
      b.ec2("mixed", subnet, { sgs: [b.securityGroup("foreign", other)] });
    }),
  "SEC-008": () => single((b) => b.securityGroup("homeless", null)),
  "SEC-009": () => single((b, { vpc }) => b.securityGroup("unused", vpc)),
  "SEC-010": () =>
    single((b, { vpc, subnet }) =>
      b.networkAcl("acl", vpc, {
        subnets: [subnet],
        inbound: [NACL.allow(100, "tcp", 80, "0.0.0.0/0")],
        outbound: [NACL.allow(100, "tcp", 80, "0.0.0.0/0")],
      }),
    ),
  "SEC-011": () =>
    single((b, { vpc }) =>
      b.networkAcl("dup", vpc, { inbound: [NACL.allow(100, "tcp", 80, "0.0.0.0/0"), NACL.deny(100, "tcp", 22, "0.0.0.0/0")] }),
    ),
  "SEC-012": () =>
    single((b, { vpc }) =>
      b.networkAcl("shadow", vpc, { inbound: [NACL.allow(100, "all", null, "0.0.0.0/0"), NACL.deny(200, "tcp", 22, "0.0.0.0/0")] }),
    ),
  "SEC-013": () => single((b, { vpc, subnet }) => b.networkAcl("deny-all", vpc, { subnets: [subnet] })),
  "EC2-001": () => single((b, { vpc }) => b.ec2("floating", null, { sgs: [b.securityGroup("sg", vpc)] })),
  "EC2-002": () => single((b, { vpc, subnet }) => b.ec2("wrong-ip", subnet, { ip: "10.0.9.10", sgs: [b.securityGroup("sg", vpc)] })),
  "EC2-003": () =>
    single((b, { vpc, subnet }) => {
      const sg = b.securityGroup("sg", vpc);
      b.ec2("a", subnet, { ip: "10.0.1.10", sgs: [sg] });
      b.ec2("b", subnet, { ip: "10.0.1.10", sgs: [sg] });
    }),
  "EC2-004": () => single((b, { vpc, subnet }) => b.ec2("stopped", subnet, { state: "stopped", sgs: [b.securityGroup("sg", vpc)] })),
  "EC2-005": () =>
    single((b, { vpc, subnet }) => {
      const e = b.ec2("gone", subnet, { state: "terminated", sgs: [b.securityGroup("sg", vpc)] });
      b.targetGroup("tg", { targets: [e] });
    }),
  "ELB-001": () => webTier({ listeners: [] }),
  "ELB-002": () => webTier({ listeners: [{ port: 80, targetGroup: false }] }),
  "ELB-003": () => {
    const b = new ProjectBuilder("empty-tg");
    b.targetGroup("lonely");
    return b.build();
  },
  "ELB-004": () => webTier({ appInbound: [] }),
  "ELB-005": () => webTier({ appInbound: [] }),
  "ELB-006": () => webTier({ albSubnets: "one" }),
  "ELB-007": () => webTier({ albSubnets: "same-az" }),
  "ELB-008": () => webTier({ albSubnets: "private" }),
  "ELB-009": () => webTier({ albInbound: [SG.tcp(443, "0.0.0.0/0")] }),
  "ELB-010": () => webTier({ targetAz: "ap-northeast-2b" }),
  "ELB-011": () => webTier({ listeners: [{ port: 80, targetGroup: true }, { port: 80 }] }),
  "ELB-012": () => webTier({ healthCheck: { timeoutSeconds: 30, intervalSeconds: 10 } }),
  "ELB-013": () => {
    const b = new ProjectBuilder("unused-tg");
    b.targetGroup("unused");
    return b.build();
  },
  "ELB-014": () => webTier({ listeners: [{ protocol: "HTTPS", port: 443, targetGroup: true }], albInbound: [SG.tcp(443, "0.0.0.0/0")] }),
  "ELB-015": () => webTier({ httpResponseCode: 500 }),
  "ELB-016": () => {
    const p = webTier();
    const alb = p.resources.find((r) => r.type === "alb");
    if (alb?.type === "alb") alb.config.state = "provisioning";
    return p;
  },
  "RDS-001": () => {
    const b = new ProjectBuilder("rds-alone");
    b.rds("db");
    return b.build();
  },
  "RDS-002": () => dbTier({ subnets: "one" }),
  "RDS-003": () => dbTier({ subnets: "two-vpc" }),
  "RDS-004": () => dbTier({ dbInbound: [] }),
  "RDS-005": () => dbTier({ publiclyAccessible: true }),
  "RDS-006": () => dbTier({ dbInbound: [SG.tcp(3306, "0.0.0.0/0")] }),
  "RDS-007": () => dbTier({ publiclyAccessible: true, dbPublic: true, dbInbound: [SG.tcp(3306, "0.0.0.0/0")] }),
  "RDS-008": () => dbTier({ publiclyAccessible: true, dns: false }),
  "RDS-009": () => dbTier({ multiAz: false }),
  "RDS-010": () => dbTier({ state: "stopped" }),
  "RDS-011": () => dbTier({ dbPublic: true }),
  "GEN-001": () => {
    const b = new ProjectBuilder("orphan");
    b.vpc("vpc", "10.0.0.0/16");
    b.igw("lonely-igw");
    return b.build();
  },
};

describe("검증 규칙", () => {
  it("모든 규칙은 고유 ID를 가진다", () => {
    const ids = VALIDATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(NET|SEC|EC2|ELB|RDS|GEN|EIP)-\d{3}$/);
  });

  it("모든 규칙에 트리거 테스트가 있다", () => {
    const missing = VALIDATION_RULES.map((r) => r.id).filter((id) => !triggers[id]);
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(triggers))("%s 규칙이 해당 설정에서 탐지된다", (ruleId) => {
    const report = validateProject(triggers[ruleId]());
    const finding = report.findings.find((f) => f.ruleId === ruleId);
    expect(finding, `${ruleId} 미탐지: ${report.findings.map((f) => f.ruleId).join(", ")}`).toBeDefined();
    expect(finding!.cause.length).toBeGreaterThan(0);
    expect(finding!.fix.length).toBeGreaterThan(0);
    expect(finding!.concept.length).toBeGreaterThan(0);
    expect(finding!.impact.length).toBeGreaterThan(0);
  });
});

describe("검증 결과는 실제 설정에 따라 달라진다", () => {
  it("정상 구성(3-Tier 샘플)에는 오류와 경고가 없다", () => {
    const report = validateProject(createThreeTierSample());
    expect(report.findings.filter((f) => f.severity !== "info").map((f) => `${f.ruleId}: ${f.cause}`)).toEqual([]);
  });

  it("퍼블릭 EC2 샘플에도 오류와 경고가 없다", () => {
    const report = validateProject(createPublicEc2Sample());
    expect(report.counts.error).toBe(0);
    expect(report.counts.warning).toBe(0);
  });

  it("광범위한 접근 허용은 통신 오류가 아니라 경고로 분류한다", () => {
    const report = validateProject(triggers["SEC-002"]());
    expect(report.findings.find((f) => f.ruleId === "SEC-002")?.severity).toBe("warning");
  });

  it("앱 포트 차단 시에만 ELB-005가 나타나고, 규칙을 고치면 사라진다", () => {
    expect(validateProject(webTier({ appInbound: [] })).findings.some((f) => f.ruleId === "ELB-005")).toBe(true);
    expect(validateProject(webTier()).findings.some((f) => f.ruleId === "ELB-005")).toBe(false);
  });

  it("격리된 서브넷에 EC2가 없으면 NET-015는 정보 수준이다", () => {
    const report = validateProject(single(() => {}));
    expect(report.findings.find((f) => f.ruleId === "NET-015")?.severity).toBe("info");
  });

  it("Lab 5 시작 상태에는 의도된 문제들이 포함되어 있다", () => {
    const ids = new Set(validateProject(createLab5Starter()).findings.map((f) => f.ruleId));
    for (const id of ["SEC-002", "SEC-003", "RDS-006", "ELB-005", "ELB-004", "ELB-009", "SEC-010"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("관련 리소스로 이동할 수 있도록 resourceIds를 포함한다", () => {
    const p = triggers["NET-004"]();
    const f = validateProject(p).findings.find((x) => x.ruleId === "NET-004")!;
    expect(f.resourceIds).toContain(p.resources.find((r) => r.name === "outside")!.id);
  });
});
