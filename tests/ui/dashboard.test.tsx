import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard/dashboard";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createPublicEc2Sample } from "@/lib/project/samples";
import { exportProjectJson } from "@/lib/project/serialization";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";
import { renderWithProviders, routerPush, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  routerPush.mockClear();
});

const projects = () => Object.values(useProjectStore.getState().projects);

describe("샌드박스 목록 (첫 화면)", () => {
  it("첫 방문에도 예시 프로젝트를 미리 만들지 않는다", async () => {
    resetProjectStore();
    useProjectStore.getState().hydrate(window.localStorage);
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText("샌드박스 없음")).toBeInTheDocument();
    expect(projects()).toEqual([]);
    expect(window.localStorage.getItem("aws-playground:projects:v1")).toBeNull();
  });

  it("샌드박스를 만들면 리소스가 하나도 없는 콘솔로 이동한다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    await user.click(screen.getAllByRole("button", { name: "샌드박스 생성" })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("이름"), "내 VPC 실습");
    await user.click(within(dialog).getByRole("button", { name: "생성 후 열기" }));
    await waitFor(() => expect(projects().map((p) => p.name)).toEqual(["내 VPC 실습"]));
    expect(projects()[0].resources).toEqual([]);
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/console\/proj-\d+#\/$/));
  });

  it("쉬운 모드를 고르면 그림 빌더로 열고, 그 선택을 샌드박스에 기억한다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    await user.click(screen.getAllByRole("button", { name: "샌드박스 생성" })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /쉬운 모드/ }));
    await user.click(within(dialog).getByRole("button", { name: "생성 후 열기" }));
    await waitFor(() => expect(projects()).toHaveLength(1));
    expect(projects()[0].preferredMode).toBe("easy");
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\/proj-\d+$/));
    expect(await screen.findByText("쉬운 모드", { selector: "span" })).toBeInTheDocument();
  });

  it("목록에서 리소스 수를 보여 주고 이름 변경·복제·삭제할 수 있다", async () => {
    const a = createPublicEc2Sample("Alpha");
    seedStore([a]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    const table = screen.getByRole("table", { name: "샌드박스 목록" });
    expect(within(table).getByText("Alpha")).toBeInTheDocument();
    expect(within(table).getByText(`${a.resources.length}개`)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Alpha 선택" }));
    await user.click(screen.getByRole("button", { name: "작업" }));
    await user.click(await screen.findByRole("menuitem", { name: "이름 변경" }));
    let dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("이름");
    await user.clear(input);
    await user.type(input, "Beta");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(useProjectStore.getState().projects[a.id].name).toBe("Beta"));

    await user.click(screen.getByRole("button", { name: "작업" }));
    await user.click(await screen.findByRole("menuitem", { name: "복제" }));
    await waitFor(() => expect(projects()).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "작업" }));
    await user.click(await screen.findByRole("menuitem", { name: "삭제" }));
    dialog = await screen.findByRole("dialog");
    const remove = within(dialog).getByRole("button", { name: "삭제" });
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "delete");
    await user.click(remove);
    await waitFor(() => expect(projects()).toHaveLength(1));
  });

  it("실습을 시작하면 빈 샌드박스(실습 1~4)를 만들고 실습 패널을 연다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    const labCards = screen.getAllByTestId("lab-card");
    expect(labCards).toHaveLength(5);
    await user.click(within(labCards[0]).getByRole("button", { name: "실습 시작" }));
    await waitFor(() => expect(projects()).toHaveLength(1));
    expect(projects()[0]).toMatchObject({ labId: "lab-1-public-ec2", resources: [] });
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/#\/\?tools=labs$/));
  });

  it("완성된 예시는 사용자가 직접 열 때만 만들어진다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    expect(screen.queryByRole("button", { name: "예시 열기" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /완성된 예시 아키텍처 살펴보기/ }));
    await user.click(screen.getAllByRole("button", { name: "예시 열기" })[0]);
    await waitFor(() => expect(projects()).toHaveLength(1));
    expect(projects()[0].resources.length).toBeGreaterThan(0);
  });

  it("JSON 가져오기는 검증 후 새 샌드박스로 추가하고, 잘못된 JSON이면 오류를 보여 준다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    await user.click(screen.getByRole("button", { name: "가져오기" }));
    let dialog = await screen.findByRole("dialog");
    const textarea = within(dialog).getByLabelText("JSON");
    await user.click(textarea);
    await user.paste("{ not json");
    await user.click(within(dialog).getByRole("button", { name: "검증 후 가져오기" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("가져오기 실패");
    expect(projects()).toHaveLength(0);
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(exportProjectJson(createPublicEc2Sample("가져온 샌드박스")));
    await user.click(within(dialog).getByRole("button", { name: "검증 후 가져오기" }));
    await waitFor(() => expect(projects().map((p) => p.name)).toEqual(["가져온 샌드박스"]));
    dialog = screen.queryByRole("dialog") as HTMLElement;
    expect(dialog).toBeNull();
  });
});
