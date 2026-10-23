import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import type { Project } from "@/lib/engine/resource-models";
import * as aws from "@/lib/project/console-actions";
import { createEmptyProject, SG } from "@/lib/project/factory";
import { lifecycleTiming, settleLifecycle } from "@/lib/project/lifecycle";
import { useProjectStore } from "@/lib/store/project-store";
import { goTo, project, renderConsole, seedStore } from "./ui-helpers";

function must(r: aws.ActionResult) {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}

/** VPC + 퍼블릭 서브넷 + IGW + 퍼블릭 라우팅 테이블 (콘솔 동작으로 구성) */
function publicNetwork(p: Project = createEmptyProject("콘솔 UI 테스트")) {
  const vpc = must(aws.createVpc(p, { name: "lab-vpc", cidr: "10.0.0.0/16" }));
  const subnet = must(aws.createSubnet(vpc.project, { vpcId: vpc.id, name: "public-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" }));
  const igw = must(aws.createInternetGateway(subnet.project, { name: "lab-igw" }));
  let next = must(aws.attachInternetGateway(igw.project, igw.id, vpc.id)).project;
  const rt = must(aws.createRouteTable(next, { vpcId: vpc.id, name: "public-rt" }));
  next = must(aws.editRoutes(rt.project, rt.id, [{ destination: "0.0.0.0/0", targetId: igw.id }])).project;
  next = must(aws.editRouteTableAssociations(next, rt.id, [subnet.id])).project;
  return { project: next, vpcId: vpc.id, subnetId: subnet.id, igwId: igw.id, rtId: rt.id };
}

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  lifecycleTiming.scale = 0;
});

afterEach(() => {
  lifecycleTiming.scale = 1;
});

describe("콘솔", () => {
  it("빈 샌드박스의 콘솔 홈은 시작하기 안내를 보여 주고 리소스를 미리 만들지 않는다", async () => {
    const p = createEmptyProject("빈 샌드박스");
    seedStore([p]);
    renderConsole(p.id, "#/");
    expect(await screen.findByRole("heading", { name: "콘솔 홈", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("시작하기")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /VPC 생성 — IPv4 CIDR/ })).toHaveAttribute("href", "#/vpc/vpcs/create");
    expect(project(p.id).resources).toEqual([]);
  });

  it("VPC 생성: 허용 범위를 벗어난 CIDR은 AWS 오류 코드로 거부하고, 성공하면 기본 리소스와 함께 상세 페이지로 이동한다", async () => {
    const p = createEmptyProject("VPC 테스트");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/vpc/vpcs/create");
    const cidr = await screen.findByLabelText("IPv4 CIDR");
    await user.type(cidr, "10.0.0.0/8");
    await user.click(screen.getByRole("button", { name: "VPC 생성" }));
    expect(await screen.findByText(/\[InvalidVpc\.Range\]/)).toBeInTheDocument();
    expect(project(p.id).resources).toEqual([]);

    await user.clear(cidr);
    await user.type(cidr, "10.0.0.0/16");
    await user.type(screen.getByLabelText(/이름 태그/), "my-vpc");
    await user.click(screen.getByRole("button", { name: "VPC 생성" }));
    expect(await screen.findByRole("heading", { name: /vpc-0001 \/ my-vpc/, level: 1 })).toBeInTheDocument();
    expect(within(screen.getByTestId("flashbar")).getByText(/VPC vpc-0001을\(를\) 생성했습니다/)).toBeInTheDocument();
    expect(project(p.id).resources.map((r) => r.type).sort()).toEqual(["network-acl", "route-table", "security-group", "vpc"]);
  });

  it("서브넷 생성: VPC 범위 밖 CIDR 오류를 해당 서브넷 필드에 표시한다", async () => {
    const { project: p, id: vpcId } = must(aws.createVpc(createEmptyProject("서브넷"), { name: "v", cidr: "10.0.0.0/16" }));
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/vpc/subnets/create");
    await user.selectOptions(await screen.findByLabelText("VPC ID"), vpcId);
    const cidr = screen.getByLabelText(/IPv4 서브넷 CIDR 블록/);
    await user.type(cidr, "192.168.0.0/24");
    await user.click(screen.getByRole("button", { name: "서브넷 생성" }));
    expect(await screen.findByText(/\[InvalidSubnet\.Range\]/)).toBeInTheDocument();
    await user.clear(cidr);
    await user.type(cidr, "10.0.1.0/24");
    await user.click(screen.getByRole("button", { name: "서브넷 생성" }));
    expect(await screen.findByRole("heading", { name: /subnet-0001/, level: 1 })).toBeInTheDocument();
    expect(project(p.id).resources.filter((r) => r.type === "subnet")).toHaveLength(1);
  });

  it("보안 그룹 인바운드 규칙을 AWS의 유형 목록으로 편집한다", async () => {
    const net = publicNetwork();
    const sg = must(aws.createSecurityGroup(net.project, { name: "web-sg", description: "web", vpcId: net.vpcId, inboundRules: [], outboundRules: [SG.all("0.0.0.0/0")] }));
    seedStore([sg.project]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(sg.project.id, `#/vpc/security-groups/${sg.id}/edit-inbound`);
    await user.click(await screen.findByRole("button", { name: "규칙 추가" }));
    await user.selectOptions(screen.getByLabelText("규칙 1 유형"), "http");
    expect(screen.getByLabelText("규칙 1 포트 범위")).toHaveValue("80");
    await user.selectOptions(screen.getByLabelText("규칙 1 소스 유형"), "anywhere");
    await user.click(screen.getByRole("button", { name: "규칙 저장" }));
    await waitFor(() => {
      const r = project(sg.project.id).resources.find((x) => x.id === sg.id);
      expect(r?.type === "security-group" && r.config.inboundRules).toEqual([expect.objectContaining({ protocol: "tcp", fromPort: 80, toPort: 80, peer: { kind: "cidr", cidr: "0.0.0.0/0" } })]);
    });
    expect(await screen.findByRole("heading", { name: `${sg.id} - web-sg`, level: 1 })).toBeInTheDocument();
  });

  it("인스턴스 시작 마법사: 웹 서버를 시작하면 Pending을 거쳐 Running이 되고, Reachability Analyzer로 도달 가능을 확인한다", async () => {
    const net = publicNetwork();
    seedStore([net.project]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(net.project.id, "#/ec2/instances/launch");
    await user.type(await screen.findByLabelText("이름"), "web-1");
    await user.selectOptions(screen.getByLabelText("서브넷"), net.subnetId);
    await user.selectOptions(screen.getByLabelText("퍼블릭 IP 자동 할당"), "enabled");
    await user.click(screen.getByRole("checkbox", { name: /인터넷에서 HTTP 트래픽 허용/ }));
    await user.click(screen.getByRole("radio", { name: /웹 서버 설치/ }));
    await user.click(screen.getByRole("button", { name: "인스턴스 시작" }));
    expect(await screen.findByRole("heading", { name: /인스턴스 요약: ec2-0001|인스턴스 요약: i-0001/, level: 1 })).toBeInTheDocument();
    const instanceId = project(net.project.id).resources.find((r) => r.type === "ec2")!.id;
    await waitFor(() => {
      const r = project(net.project.id).resources.find((x) => x.id === instanceId);
      expect(r?.type === "ec2" && r.config.state).toBe("running");
    });

    await goTo("#/vpc/reachability/create");
    await user.selectOptions(await screen.findByLabelText("대상"), instanceId);
    await user.click(screen.getByRole("button", { name: "경로 생성 및 분석" }));
    const outcome = await screen.findByTestId("analysis-outcome");
    expect(outcome).toHaveAttribute("data-outcome", "success");
    expect(project(net.project.id).networkPaths[0].lastAnalysis?.outcome).toBe("success");
  });

  it("의존성이 남아 있으면 삭제를 AWS처럼 거부한다", async () => {
    const net = publicNetwork();
    seedStore([net.project]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(net.project.id, "#/vpc/igws");
    await user.click(await screen.findByRole("radio", { name: "lab-igw 선택" }));
    await user.click(screen.getByRole("button", { name: "작업" }));
    await user.click(await screen.findByRole("menuitem", { name: "인터넷 게이트웨이 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "delete");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect(await within(dialog).findByText(/\[DependencyViolation\]/)).toBeInTheDocument();
    expect(project(net.project.id).resources.some((r) => r.id === net.igwId)).toBe(true);
  });

  it("상단 메뉴의 실행 취소로 마지막 작업을 되돌린다", async () => {
    const p = createEmptyProject("실행 취소");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/vpc/igws/create");
    await user.click(await screen.findByRole("button", { name: "인터넷 게이트웨이 생성" }));
    await waitFor(() => expect(project(p.id).resources).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "실행 취소" }));
    await waitFor(() => expect(project(p.id).resources).toHaveLength(0));
  });

  it("실습 가이드는 실제 설정으로 단계 완료를 판정한다", async () => {
    const base = publicNetwork({ ...createEmptyProject("실습"), labId: "lab-1-public-ec2" });
    seedStore([settleLifecycle(base.project)]);
    renderConsole(base.project.id, "#/?tools=labs");
    const guide = await screen.findByTestId("lab-guide");
    expect(within(guide).getByText("Public EC2 구성")).toBeInTheDocument();
    expect(within(guide).getByTestId("lab-progress")).toHaveTextContent("4/7");
    expect(useProjectStore.getState().projects[base.project.id].labId).toBe("lab-1-public-ec2");
  });
});
