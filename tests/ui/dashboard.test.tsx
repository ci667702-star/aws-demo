import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard/dashboard";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createPublicEc2Sample, createThreeTierSample } from "@/lib/project/samples";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";
import { renderWithProviders, routerPush, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  routerPush.mockClear();
});

describe("Dashboard UI", () => {
  it("첫 방문이면 예시 프로젝트를 만들어 보여준다", async () => {
    resetProjectStore();
    useProjectStore.getState().hydrate(window.localStorage);
    renderWithProviders(<Dashboard />);
    expect((await screen.findAllByText("예시: 3-Tier 웹 아키텍처")).length).toBeGreaterThan(0);
    await waitFor(() => expect(window.localStorage.getItem("aws-playground:projects:v1")).toContain("예시: 3-Tier"));
  });

  it("새 프로젝트를 만들면 빌더로 이동한다", async () => {
    seedStore([]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    expect(screen.getByText("아직 프로젝트가 없습니다")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /새 프로젝트/ })[0]);
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("이름");
    await user.clear(name);
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("이름을 입력하세요");
    await user.type(name, "내 VPC 실습");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(Object.values(useProjectStore.getState().projects).map((p) => p.name)).toEqual(["내 VPC 실습"]));
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\/proj-/));
  });

  it("프로젝트 목록에 수정 시간과 리소스 수를 표시하고 이름 변경·복제·삭제할 수 있다", async () => {
    const a = createThreeTierSample("Alpha");
    seedStore([a]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    const cards = screen.getAllByTestId("project-card");
    expect(within(cards[0]).getByText(/리소스 21개/)).toBeInTheDocument();
    expect(within(cards[0]).getByText(/마지막 수정/)).toBeInTheDocument();

    await user.click(within(cards[0]).getByRole("button", { name: "Alpha 작업 메뉴" }));
    await user.click(await screen.findByRole("menuitem", { name: /이름 변경/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("이름");
    await user.clear(input);
    await user.type(input, "Beta");
    await user.click(within(dialog).getByRole("button", { name: "변경" }));
    await waitFor(() => expect(useProjectStore.getState().projects[a.id].name).toBe("Beta"));

    await user.click(screen.getAllByRole("button", { name: "Beta 작업 메뉴" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: /복제/ }));
    await waitFor(() => expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(2));

    await user.click(screen.getAllByRole("button", { name: "Beta 작업 메뉴" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: /삭제/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(1));
  });

  it("샘플 아키텍처와 Guided Lab을 새 프로젝트로 시작한다", async () => {
    seedStore([createPublicEc2Sample()]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Dashboard />);
    await user.click(screen.getAllByRole("button", { name: "불러오기" })[0]);
    await waitFor(() => expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(2));
    const labCards = screen.getAllByTestId("lab-card");
    expect(labCards).toHaveLength(5);
    await user.click(within(labCards[0]).getByRole("button", { name: "실습 시작" }));
    await waitFor(() =>
      expect(Object.values(useProjectStore.getState().projects).some((p) => p.labId === "lab-1-public-ec2")).toBe(true),
    );
    expect(routerPush).toHaveBeenCalledTimes(2);
  });
});
