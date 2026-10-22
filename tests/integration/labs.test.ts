/**
 * Guided Lab: 시작 상태는 미완료, 사용자가 UI에서 하는 것과 같은 변경 연산을 적용하면 완료로 판정되어야 한다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import { createLabContext, evaluateLab, labById, LABS } from "@/lib/labs/labs";
import { NACL, SG } from "@/lib/project/factory";
import { addResource, connectResources, updateResourceConfig, type MutationResult } from "@/lib/project/mutations";
import { idOf, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

class Session {
  constructor(public project: Project) {}
  private apply(r: MutationResult): string | undefined {
    if (!r.ok) throw new Error(`${r.error} ${r.hint ?? ""}`);
    this.project = r.project;
    return r.createdId;
  }
  add(type: ResourceType): string {
    return this.apply(addResource(this.project, type, { x: 0, y: 0 }))!;
  }
  connect(a: string, b: string, destinationCidr?: string) {
    this.apply(connectResources(this.project, a, b, destinationCidr ? { destinationCidr } : {}));
  }
  config(id: string, patch: Record<string, unknown>) {
    this.apply(updateResourceConfig(this.project, id, patch));
  }
  id(name: string) {
    return idOf(this.project, name);
  }
  progress(labId: string) {
    return evaluateLab(labById(labId)!, createLabContext(this.project));
  }
  get(name: string) {
    return this.project.resources.find((r) => r.name === name)!;
  }
}

describe("Guided Lab 판정", () => {
  it("모든 실습의 시작 상태는 완료되지 않은 상태다", () => {
    for (const lab of LABS) {
      const progress = evaluateLab(lab, createLabContext(lab.createStarter()));
      expect(progress.completed, lab.id).toBe(false);
    }
  });

  it("Lab 1: Public EC2 구성을 단계별로 완료한다", () => {
    const s = new Session(labById("lab-1-public-ec2")!.createStarter());
    const done = () => s.progress("lab-1-public-ec2").completedCount;
    expect(done()).toBe(0);
    const vpc = s.add("vpc");
    expect(done()).toBe(1);
    const subnet = s.add("subnet");
    s.connect(vpc, subnet);
    expect(done()).toBe(2);
    const igw = s.add("internet-gateway");
    s.connect(vpc, igw);
    const rt = s.add("route-table");
    s.connect(vpc, rt);
    s.connect(rt, igw);
    s.connect(rt, subnet);
    expect(done()).toBe(4);
    const ec2 = s.add("ec2");
    s.connect(ec2, subnet);
    s.config(ec2, { publicIpMode: "enabled" });
    const sg = s.add("security-group");
    s.connect(vpc, sg);
    s.connect(ec2, sg);
    expect(s.progress("lab-1-public-ec2").steps.find((x) => x.id === "sg")?.done).toBe(false);
    s.config(sg, { inboundRules: [SG.tcp(80, "0.0.0.0/0")] });
    expect(s.progress("lab-1-public-ec2").completed).toBe(true);
  });

  it("Lab 2: 프라이빗 EC2와 NAT Gateway", () => {
    const s = new Session(labById("lab-2-private-nat")!.createStarter());
    const vpc = s.id("lab-vpc");
    const priv = s.add("subnet");
    s.connect(vpc, priv);
    const nat = s.add("nat-gateway");
    s.connect(nat, s.id("public-a"));
    const rt = s.add("route-table");
    s.connect(vpc, rt);
    s.connect(rt, nat);
    s.connect(rt, priv);
    const ec2 = s.add("ec2");
    s.connect(ec2, priv);
    const sg = s.add("security-group");
    s.connect(vpc, sg);
    s.connect(ec2, sg);
    const progress = s.progress("lab-2-private-nat");
    expect(progress.steps.filter((x) => !x.done)).toEqual([]);
  });

  it("Lab 3: ALB와 EC2 구성", () => {
    const s = new Session(labById("lab-3-alb")!.createStarter());
    const vpc = s.id("lab-vpc");
    const alb = s.add("alb");
    s.connect(alb, s.id("public-a"));
    s.connect(alb, s.id("public-c"));
    const albSg = s.add("security-group");
    s.connect(vpc, albSg);
    s.config(albSg, { inboundRules: [SG.tcp(80, "0.0.0.0/0")] });
    s.connect(alb, albSg);
    const tg = s.add("target-group");
    s.connect(alb, tg);
    s.connect(tg, s.id("app-1"));
    s.connect(tg, s.id("app-2"));
    let progress = s.progress("lab-3-alb");
    expect(progress.steps.find((x) => x.id === "healthy")?.done).toBe(false);
    s.config(s.id("app-sg"), { inboundRules: [SG.tcp(80, { sg: albSg })] });
    progress = s.progress("lab-3-alb");
    expect(progress.steps.filter((x) => !x.done)).toEqual([]);
  });

  it("Lab 4: RDS 연결", () => {
    const s = new Session(labById("lab-4-rds")!.createStarter());
    const vpc = s.id("lab-vpc");
    const group = s.add("db-subnet-group");
    s.connect(group, s.id("db-a"));
    s.connect(group, s.id("db-c"));
    const rds = s.add("rds");
    s.connect(rds, group);
    const dbSg = s.add("security-group");
    s.connect(vpc, dbSg);
    s.config(dbSg, { inboundRules: [SG.tcp(3306, { sg: s.id("app-sg") })] });
    s.connect(rds, dbSg);
    expect(s.progress("lab-4-rds").steps.filter((x) => !x.done)).toEqual([]);
  });

  it("Lab 5: 의도된 보안 오류를 모두 고치면 완료된다", () => {
    const s = new Session(labById("lab-5-security")!.createStarter());
    expect(s.progress("lab-5-security").completedCount).toBe(0);
    s.config(s.id("app-sg"), { inboundRules: [SG.tcp(80, { sg: s.id("alb-sg") })] });
    s.config(s.id("db-sg"), { inboundRules: [SG.tcp(3306, { sg: s.id("app-sg") })] });
    const albSg = s.get("alb-sg");
    if (albSg.type !== "security-group") throw new Error();
    s.config(albSg.id, { inboundRules: [...albSg.config.inboundRules, SG.tcp(80, "0.0.0.0/0")] });
    let progress = s.progress("lab-5-security");
    expect(progress.steps.find((x) => x.id === "nacl")?.done).toBe(false);
    expect(progress.steps.find((x) => x.id === "verify")?.done).toBe(false);
    const nacl = s.get("public-nacl");
    if (nacl.type !== "network-acl") throw new Error();
    s.config(nacl.id, { outboundRules: [...nacl.config.outboundRules, NACL.allow(130, "tcp", [1024, 65535], "0.0.0.0/0")] });
    progress = s.progress("lab-5-security");
    expect(progress.steps.filter((x) => !x.done)).toEqual([]);
  });
});
