import { beforeEach, describe, expect, it } from "vitest";
import { resumeStepIndex, tutorialById, tutorialProgress } from "@/components/console/tutorial/tutorials";
import { ALL_DOC_KEYS } from "@/lib/docs";
import { AWS_DOC_LINKS } from "@/lib/docs/aws-links";
import { compareNatCost, DEFAULT_COST_ASSUMPTIONS, estimateCost } from "@/lib/engine/cost-engine";
import { requiredActions } from "@/lib/engine/iam-permissions";
import { checkNatInstance, hasNatSoftware, natInstanceScript, natInstanceUsages } from "@/lib/engine/nat-instance";
import { buildTopology } from "@/lib/engine/topology-engine";
import * as aws from "@/lib/project/console-actions";
import { createNatInstanceSample } from "@/lib/project/samples";
import { idOf, natInstanceProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

describe("NAT 인스턴스 설정 스크립트", () => {
  it("Linux AMI에는 AWS 문서 절차(IP 포워딩 + MASQUERADE)가 들어가고, Windows는 해당 없음", () => {
    for (const ami of ["amazon-linux-2023", "ubuntu-24.04"] as const) {
      const script = natInstanceScript(ami)!;
      expect(script).toContain("net.ipv4.ip_forward=1");
      expect(script).toMatch(/iptables -t nat -A POSTROUTING -o "\$IFACE" -j MASQUERADE/);
      expect(hasNatSoftware(script)).toBe(true);
    }
    expect(natInstanceScript("windows-server-2022")).toBeNull();
    expect(aws.userDataFor("windows-server-2022", "nat-instance").script).toBe("");
    expect(aws.userDataFor("amazon-linux-2023", "nat-instance")).toEqual({ listenPorts: [22], script: natInstanceScript("amazon-linux-2023") });
  });

  it("웹 서버 스크립트만으로는 NAT 소프트웨어로 보지 않는다", () => {
    expect(hasNatSoftware(aws.userDataFor("amazon-linux-2023", "web-server").script)).toBe(false);
  });
});

describe("AWS 공식 문서 링크", () => {
  it("모든 리소스·서비스 설명에 AWS 공식 문서(한국어) 링크가 있다", () => {
    for (const key of ALL_DOC_KEYS) {
      expect(AWS_DOC_LINKS[key].length, key).toBeGreaterThan(0);
      for (const link of AWS_DOC_LINKS[key]) {
        expect(link.url).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/ko_kr\/.+\.html$/);
        expect(link.title.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("NAT 인스턴스 판정", () => {
  it("올바른 구성은 문제가 없고, 경로를 쓰는 프라이빗 서브넷을 찾는다", () => {
    const p = natInstanceProject();
    const topo = buildTopology(p);
    const nat = topo.getOfType(idOf(p, "nat-instance"), "ec2")!;
    expect(checkNatInstance(topo, nat)).toEqual({ ok: true, problems: [] });
    const [usage] = natInstanceUsages(topo);
    expect(usage.ec2.id).toBe(nat.id);
    expect(usage.subnetIds).toEqual([idOf(p, "private-a")]);
  });

  it("소스/대상 확인·스크립트·퍼블릭 IP 문제를 각각 알려 준다", () => {
    const p = natInstanceProject({ sourceDestCheck: true, script: false, publicIp: false });
    const topo = buildTopology(p);
    const fields = checkNatInstance(topo, topo.getOfType(idOf(p, "nat-instance"), "ec2")!).problems.map((x) => x.field);
    expect(fields).toEqual(["sourceDestCheck", "userData", "publicIpMode"]);
  });
});

describe("콘솔: 경로 대상 인스턴스와 소스/대상 확인", () => {
  it("라우팅 편집에서 같은 VPC의 인스턴스를 대상으로 지정하고, 준비가 덜 됐으면 주의 사항을 알려 준다", () => {
    const p = natInstanceProject({ sourceDestCheck: true });
    const rt = idOf(p, "private-rt");
    const nat = idOf(p, "nat-instance");
    const r = aws.editRoutes(p, rt, [{ destination: "0.0.0.0/0", targetId: nat }]);
    if (!r.ok) throw new Error(r.error);
    const route = r.project.connections.find((c) => c.sourceResourceId === rt && c.targetResourceId === nat);
    expect(route?.relationType).toBe("route-table-ec2");
    expect(r.notes.join(" ")).toContain("소스/대상 확인");
  });

  it("종료된 인스턴스는 경로 대상으로 지정할 수 없다", () => {
    const p = natInstanceProject({ state: "terminated" });
    const r = aws.editRoutes(p, idOf(p, "private-rt"), [{ destination: "0.0.0.0/0", targetId: idOf(p, "nat-instance") }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("IncorrectInstanceState");
  });

  it("소스/대상 확인을 중지하면 NAT 인스턴스 조건을 만족하고, 필요한 IAM 작업은 ModifyInstanceAttribute이다", () => {
    const p = natInstanceProject({ sourceDestCheck: true });
    const nat = idOf(p, "nat-instance");
    const r = aws.changeSourceDestCheck(p, nat, false);
    if (!r.ok) throw new Error(r.error);
    const topo = buildTopology(r.project);
    expect(checkNatInstance(topo, topo.getOfType(nat, "ec2")!).ok).toBe(true);
    expect(requiredActions(p, r.project).map((x) => x.action)).toEqual(["ec2:ModifyInstanceAttribute"]);
  });
});

describe("NAT 비용 비교 (교육용 가정 단가)", () => {
  it("같은 가정에서 NAT 게이트웨이는 시간+처리 데이터, NAT 인스턴스는 인스턴스 시간만 계산한다", () => {
    const a = DEFAULT_COST_ASSUMPTIONS;
    const c = compareNatCost(a, "t3.micro");
    const hours = a.hoursPerMonth;
    expect(c.gateway.monthly).toBeCloseTo(hours * a.natHourly + a.dataProcessedGb * a.natPerGb + hours * a.publicIpv4Hourly, 2);
    expect(c.instance.monthly).toBeCloseTo(hours * a.ec2Hourly["t3.micro"] + hours * a.publicIpv4Hourly, 2);
    expect(c.savings).toBeCloseTo(c.gateway.monthly - c.instance.monthly, 2);
    expect(c.savings).toBeGreaterThan(0);
  });

  it("비용 추정에서 NAT 인스턴스로 쓰는 EC2에 안내를 붙인다", () => {
    const p = natInstanceProject();
    const line = estimateCost(p).lines.find((l) => l.resourceId === idOf(p, "nat-instance"));
    expect(line?.note).toContain("NAT 인스턴스");
  });
});

describe("NAT 인스턴스 튜토리얼", () => {
  it("샘플 구성은 통신 분석 전까지의 단계를 모두 완료한 것으로 판정한다", () => {
    const tutorial = tutorialById("nat-instance")!;
    const project = createNatInstanceSample();
    const ctx = { project, topo: buildTopology(project) };
    const progress = tutorialProgress(tutorial, ctx);
    expect(progress.done).toBe(progress.total - 1);
    expect(tutorial.steps[resumeStepIndex(tutorial, ctx)].id).toBe("analyze");
  });
});
