import { simulate, type SimulationRequest } from "@/lib/engine/connectivity-engine";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import type { Project, Resource } from "@/lib/engine/resource-models";
import { validateProject } from "@/lib/engine/validation-engine";
import { natInstanceScript } from "@/lib/engine/nat-instance";
import { ProjectBuilder } from "@/lib/project/builder";
import { NACL, SG } from "@/lib/project/factory";

export function useDeterministicIds() {
  setIdGenerator(sequentialIdGenerator());
}

export function byName(project: Project, name: string): Resource {
  const r = project.resources.find((x) => x.name === name);
  if (!r) throw new Error(`리소스 ${name} 없음`);
  return r;
}

export function idOf(project: Project, name: string): string {
  return byName(project, name).id;
}

export function ruleIds(project: Project): string[] {
  return validateProject(project).findings.map((f) => f.ruleId);
}

export function run(project: Project, request: SimulationRequest) {
  return simulate(project, request);
}

export const internet = (ip = "203.0.113.10") => ({ kind: "internet" as const, ip });
export const res = (resourceId: string, addressing?: "auto" | "private" | "public") => ({
  kind: "resource" as const,
  resourceId,
  addressing,
});

/** 퍼블릭 서브넷의 웹 서버 한 대 */
export function publicWebProject(options: { sgInbound?: ReturnType<typeof SG.tcp>[]; route?: boolean; igwAttached?: boolean; publicIp?: boolean } = {}) {
  const b = new ProjectBuilder("public-web");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const subnet = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", options.igwAttached === false ? null : vpc);
  b.routeTable("public-rt", vpc, {
    subnets: [subnet],
    routes: options.route === false ? [] : [{ destination: "0.0.0.0/0", igw }],
  });
  const sg = b.securityGroup("web-sg", vpc, { inbound: options.sgInbound ?? [SG.tcp(80, "0.0.0.0/0")] });
  b.ec2("web", subnet, { ip: "10.0.1.10", publicIp: options.publicIp === false ? "disabled" : "enabled", sgs: [sg] });
  return b.build();
}

/** 퍼블릭 서브넷(NAT 인스턴스) + 프라이빗 서브넷(EC2). 기본값은 올바르게 구성된 NAT 인스턴스 */
export function natInstanceProject(
  options: {
    sourceDestCheck?: boolean;
    script?: boolean;
    natInPrivate?: boolean;
    publicIp?: boolean;
    state?: "running" | "stopped" | "terminated";
    natSgInbound?: ReturnType<typeof SG.tcp>[];
  } = {},
) {
  const b = new ProjectBuilder("nat-instance");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  const natSg = b.securityGroup("nat-sg", vpc, {
    inbound: options.natSgInbound ?? [SG.tcp(80, "10.0.11.0/24"), SG.tcp(443, "10.0.11.0/24")],
  });
  const nat = b.ec2("nat-instance", options.natInPrivate ? priv : pub, {
    ip: options.natInPrivate ? "10.0.11.5" : "10.0.1.5",
    publicIp: options.publicIp === false ? "disabled" : "enabled",
    sgs: [natSg],
    listenPorts: [22],
    state: options.state ?? "running",
    sourceDestCheck: options.sourceDestCheck ?? false,
    userData: options.script === false ? "#!/bin/bash\ndnf install -y httpd" : (natInstanceScript("amazon-linux-2023") ?? ""),
  });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", instance: nat }] });
  const sg = b.securityGroup("worker-sg", vpc);
  b.ec2("worker", priv, { ip: "10.0.11.10", sgs: [sg] });
  return b.build();
}

/** 퍼블릭 서브넷(NAT) + 프라이빗 서브넷(EC2) */
export function privateNatProject(options: { natState?: "available" | "pending" | "failed"; natInPrivate?: boolean; privateNacl?: "ok" | "no-ephemeral" } = {}) {
  const b = new ProjectBuilder("private-nat");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const igw = b.igw("igw", vpc);
  const nat = b.nat("nat", options.natInPrivate ? priv : pub, { state: options.natState ?? "available" });
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", nat }] });
  if (options.privateNacl) {
    b.networkAcl("private-nacl", vpc, {
      subnets: [priv],
      inbound:
        options.privateNacl === "ok"
          ? [NACL.allow(100, "tcp", [1024, 65535], "0.0.0.0/0")]
          : [NACL.allow(100, "tcp", 22, "10.0.0.0/16")],
      outbound: [NACL.allow(100, "tcp", 443, "0.0.0.0/0")],
    });
  }
  const sg = b.securityGroup("worker-sg", vpc);
  b.ec2("worker", priv, { ip: "10.0.11.10", sgs: [sg] });
  return b.build();
}
