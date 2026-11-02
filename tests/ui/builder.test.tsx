import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Builder } from "@/components/builder/builder";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { ProjectBuilder } from "@/lib/project/builder";
import { createEmptyProject } from "@/lib/project/factory";
import { createThreeTierSample } from "@/lib/project/samples";
import { exportProjectJson } from "@/lib/project/serialization";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { project, renderWithProviders, routerPush, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  routerPush.mockClear();
});

function setup(p = createEmptyProject("UI 테스트")) {
  seedStore([p]);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<Builder projectId={p.id} />);
  return { user, id: p.id };
}

function configOf(projectId: string, resourceId: string): Record<string, unknown> {
  return project(projectId).resources.find((r) => r.id === resourceId)?.config as Record<string, unknown>;
}

function select(resourceIds: string[], connectionIds: string[] = []) {
  act(() => useEditorStore.getState().setSelection(resourceIds, connectionIds));
}

describe("Architecture Builder UI", () => {
  it("팔레트를 클릭하면 리소스가 생성되고 캔버스에 노드가 나타난다", async () => {
    const { user, id } = setup();
    await user.click(screen.getByTestId("palette-vpc"));
    await waitFor(() => expect(project(id).resources).toHaveLength(1));
    expect(project(id).resources[0]).toMatchObject({ type: "vpc", name: "vpc-1", config: { cidr: "10.0.0.0/16" } });
    expect(await screen.findByTestId("node-vpc-1")).toBeInTheDocument();
  });

  it("선택한 VPC가 있으면 새 서브넷을 그 VPC에 자동으로 연결한다", async () => {
    const { user, id } = setup();
    await user.click(screen.getByTestId("palette-vpc"));
    const vpcId = project(id).resources[0].id;
    select([vpcId]);
    await user.click(screen.getByTestId("palette-subnet"));
    await waitFor(() => expect(project(id).connections).toHaveLength(1));
    expect(project(id).connections[0]).toMatchObject({ relationType: "vpc-subnet", sourceResourceId: vpcId });
  });

  it("설정 패널에서 잘못된 CIDR은 거부하고 올바른 값만 저장한다", async () => {
    const b = new ProjectBuilder("cidr");
    const vpc = b.vpc("main", "10.0.0.0/16");
    const p = b.build();
    const { user, id } = setup(p);
    select([vpc]);
    const input = await screen.findByTestId("vpc-cidr");
    await user.clear(input);
    await user.type(input, "10.0.0.0/33{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("접두사 길이");
    expect(configOf(id, vpc).cidr).toBe("10.0.0.0/16");

    await user.clear(input);
    await user.type(input, "10.0.0.0/8{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("/16 ~ /28");

    await user.clear(input);
    await user.type(input, "10.20.0.0/16{Enter}");
    await waitFor(() => expect(configOf(id, vpc).cidr).toBe("10.20.0.0/16"));
  });

  it("EC2 사설 IP는 서브넷 범위 밖이거나 예약 주소면 거부한다", async () => {
    const b = new ProjectBuilder("ip");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const sg = b.securityGroup("sg", vpc);
    const e = b.ec2("web", s, { ip: "10.0.1.10", sgs: [sg] });
    b.ec2("other", s, { ip: "10.0.1.20", sgs: [sg] });
    const { user, id } = setup(b.build());
    select([e]);
    const input = await screen.findByTestId("ec2-private-ip");
    for (const [value, message] of [
      ["10.0.2.5", "범위 밖"],
      ["10.0.1.1", "예약"],
      ["10.0.1.20", "이미 사용 중"],
    ]) {
      await user.clear(input);
      await user.type(input, `${value}{Enter}`);
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
    }
    expect(configOf(id, e).privateIp).toBe("10.0.1.10");
  });

  it("설정 패널의 선택 상자로 연결을 만들고, 연결 패널에서 삭제한다", async () => {
    const b = new ProjectBuilder("conn");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const subnet = b.subnet("s", null, "10.0.1.0/24", "ap-northeast-2a");
    const { user, id } = setup(b.build());
    select([subnet]);
    await user.selectOptions(await screen.findByTestId("subnet-vpc"), vpc);
    await waitFor(() => expect(project(id).connections).toHaveLength(1));
    const connId = project(id).connections[0].id;

    select([], [connId]);
    await user.click(await screen.findByRole("button", { name: "연결 삭제" }));
    await waitFor(() => expect(project(id).connections).toHaveLength(0));
  });

  it("지원되지 않거나 규칙에 어긋나는 관계는 거부한다 (IGW는 VPC당 하나)", async () => {
    const b = new ProjectBuilder("igw");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    b.igw("igw-a", vpc);
    const igwB = b.igw("igw-b", null);
    setup(b.build());
    select([igwB]);
    const vpcSelect = await screen.findByTestId("igw-vpc");
    const option = within(vpcSelect).getByRole("option", { name: /이미 igw-a 연결됨/ });
    expect(option).toBeDisabled();
    expect(option).toHaveValue(vpc);
  });

  it("검증 센터가 실제 설정에 따라 결과를 보여주고 다시 검증할 수 있다", async () => {
    const b = new ProjectBuilder("validation");
    b.subnet("orphan", null, "10.0.1.0/24", "ap-northeast-2a");
    const { user } = setup(b.build());
    const center = await screen.findByTestId("validation-center");
    expect(within(center).getAllByTestId("finding").map((f) => f.dataset.rule)).toContain("NET-003");
    await user.click(within(center).getByRole("button", { name: /다시 검증/ }));
    await waitFor(() => expect(useProjectStore.getState().activity.some((a) => a.kind === "validation")).toBe(true));
  });

  it("시뮬레이션 콘솔에서 요청을 실행하고 단계별 결과를 확인한다", async () => {
    const p = createThreeTierSample();
    const { user } = setup(p);
    await user.click(screen.getByTestId("tab-simulation"));
    const alb = p.resources.find((r) => r.name === "web-alb")!;
    await user.selectOptions(screen.getByTestId("sim-destination"), alb.id);
    expect(screen.getByTestId("sim-port")).toHaveValue("80");
    await user.click(screen.getByTestId("sim-run"));
    const result = await screen.findByTestId("simulation-result", {}, { timeout: 3000 });
    expect(result.dataset.outcome).toBe("success");
    expect(within(result).getAllByTestId("sim-step").length).toBeGreaterThan(10);
    expect(within(result).getByRole("status")).toHaveTextContent("요청 성공 (가상)");
  });

  it("보안 그룹 규칙을 삭제하면 같은 요청이 실패하고 원인이 표시된다", async () => {
    const p = createThreeTierSample();
    const appSg = p.resources.find((r) => r.name === "app-sg")!;
    const { user, id } = setup(p);
    select([appSg.id]);
    const inbound = await screen.findByTestId("sg-rules-inbound");
    await user.click(within(inbound).getByRole("button", { name: "규칙 1 삭제" }));
    await waitFor(() => {
      const sg = project(id).resources.find((r) => r.id === appSg.id);
      expect(sg?.type === "security-group" && sg.config.inboundRules).toHaveLength(0);
    });
    await user.click(screen.getByTestId("tab-simulation"));
    const alb = p.resources.find((r) => r.name === "web-alb")!;
    await user.selectOptions(screen.getByTestId("sim-destination"), alb.id);
    await user.click(screen.getByTestId("sim-run"));
    const result = await screen.findByTestId("simulation-result", {}, { timeout: 3000 });
    expect(result.dataset.outcome).toBe("failure");
    expect(within(result).getAllByText(/app-sg/).length).toBeGreaterThan(0);
  });

  it("EC2 가상 상태: 시작하면 Pending을 거쳐 Running이 되고, 종료 후에는 다시 시작할 수 없다", async () => {
    const b = new ProjectBuilder("state");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const s = b.subnet("s", vpc, "10.0.1.0/24", "ap-northeast-2a");
    const e = b.ec2("web", s, { ip: "10.0.1.10", state: "stopped", sgs: [b.securityGroup("sg", vpc)] });
    const { user, id } = setup(b.build());
    select([e]);
    await user.click(await screen.findByRole("button", { name: "시작" }));
    await waitFor(() => expect(configOf(id, e).state).toBe("pending"));
    await waitFor(() => expect(configOf(id, e).state).toBe("running"), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "종료" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "종료" }));
    await waitFor(() => expect(configOf(id, e).state).toBe("terminated"));
    expect(screen.queryByRole("button", { name: "시작" })).not.toBeInTheDocument();
  });

  it("Ctrl+Z / Ctrl+Shift+Z로 리소스 생성을 실행 취소하고 다시 실행한다", async () => {
    const { user, id } = setup();
    await user.click(screen.getByTestId("palette-ec2"));
    await waitFor(() => expect(project(id).resources).toHaveLength(1));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(project(id).resources).toHaveLength(0));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(project(id).resources).toHaveLength(1));
  });

  it("JSON 가져오기는 잘못된 데이터를 거부하고, 올바른 데이터는 새 프로젝트로 추가한다", async () => {
    const { user, id } = setup();
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await user.click(await screen.findByRole("menuitem", { name: /JSON 가져오기/ }));
    const textarea = await screen.findByLabelText("JSON");

    fireEvent.change(textarea, { target: { value: '{"format":"aws-playground-project","project":{"name":1}}' } });
    await user.click(screen.getByRole("button", { name: "검증 후 가져오기" }));
    expect(await screen.findByText(/가져오기 실패/)).toBeInTheDocument();
    expect(Object.keys(useProjectStore.getState().projects)).toEqual([id]);

    const sample = createThreeTierSample("가져온 프로젝트");
    fireEvent.change(textarea, { target: { value: exportProjectJson(sample) } });
    await user.click(screen.getByRole("button", { name: "검증 후 가져오기" }));
    await waitFor(() => expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(2));
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\//));
    expect(project(id).resources).toHaveLength(0);
  });

  it("JSON 내보내기는 프로젝트 파일을 내려받는다", async () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { user } = setup(createThreeTierSample());
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await user.click(await screen.findByRole("menuitem", { name: /JSON 내보내기/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    const text = await blob.text();
    expect(JSON.parse(text)).toMatchObject({ format: "aws-playground-project" });
    expect(click).toHaveBeenCalled();
  });
});
