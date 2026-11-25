import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTutorialStore, useTutorialStore } from "@/components/console/tutorial/tutorial-store";
import { TUTORIALS } from "@/components/console/tutorial/tutorials";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createEmptyProject } from "@/lib/project/factory";
import { project, renderConsole, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
});

const panel = () => screen.getByTestId("tutorial-panel");
/** 패널에 보이는 지금 단계의 제목 */
const stepTitle = (name: string) => within(panel()).getByRole("heading", { name });
const hashPath = () => window.location.hash.replace(/^#/, "").split("?")[0];

async function startFirstWebServer() {
  const p = createEmptyProject("튜토리얼");
  seedStore([p]);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderConsole(p.id, "#/");
  await user.click(await screen.findByRole("button", { name: "튜토리얼 시작" }));
  return { p, user };
}

describe("튜토리얼 안내 패널", () => {
  it("'다음'을 눌러야 넘어가고, 화면은 자동으로 옮기지 않는다 ('이 화면으로 이동'을 눌러야 이동)", async () => {
    const { user } = await startFirstWebServer();
    expect(stepTitle("무엇을 만들까요?")).toBeInTheDocument();
    await user.click(screen.getByTestId("tutorial-next"));

    // ① VPC 만들기: 다른 화면의 단계 → 어느 화면인지 알려 주고, 지금 화면은 그대로다
    expect(stepTitle("① VPC 만들기")).toBeInTheDocument();
    expect(hashPath()).toBe("/");
    expect(screen.getByTestId("tutorial-where")).toHaveTextContent("VPC › VPC › VPC 생성");
    expect(screen.getByTestId("tutorial-next")).toBeDisabled();

    await user.click(screen.getByTestId("tutorial-go"));
    expect(hashPath()).toBe("/vpc/vpcs/create");
    expect(screen.queryByTestId("tutorial-where")).not.toBeInTheDocument();
  });

  it("할 일 목록은 넣을 값을 보여 주고, 실제 설정이 맞으면 완료로 바뀐다 (완료되어도 다음 단계로 저절로 넘어가지 않는다)", async () => {
    const { p, user } = await startFirstWebServer();
    await user.click(screen.getByTestId("tutorial-next"));
    await user.click(screen.getByTestId("tutorial-go"));

    const todo = screen.getByTestId("tutorial-todo");
    expect(todo).toHaveTextContent("이름 태그");
    expect(within(todo).getByRole("button", { name: "my-vpc 복사" })).toBeInTheDocument();
    expect(within(todo).getByRole("button", { name: "10.0.0.0/16 복사" })).toBeInTheDocument();
    expect(screen.getByTestId("tutorial-status")).toHaveTextContent("저장하면 완료 여부를 확인합니다.");

    // 할 일 이름을 누르면 화면의 그 입력란을 찾아 강조한다
    await user.click(within(todo).getByRole("button", { name: "화면에서 IPv4 CIDR 찾기" }));
    expect(screen.getByRole("textbox", { name: "IPv4 CIDR" }).closest("[data-field-flash]")).not.toBeNull();

    await user.type(screen.getByRole("textbox", { name: "IPv4 CIDR" }), "10.0.0.0/16");
    await user.click(screen.getByRole("button", { name: "VPC 생성" }));
    await waitFor(() => expect(project(p.id).resources.some((r) => r.type === "vpc")).toBe(true));

    // 좁은 화면(테스트 환경)에서는 양식을 만지면 안내가 한 줄로 접힌다. 접힌 채로도 완료 여부와 '다음'이 보인다
    await waitFor(() => expect(panel()).toHaveAttribute("data-done"));
    expect(screen.getByTestId("tutorial-next")).toBeEnabled();
    await user.click(within(panel()).getByRole("button", { name: "안내 펼치기" }));
    expect(screen.getByTestId("tutorial-status")).toHaveTextContent("완료");
    expect(stepTitle("① VPC 만들기")).toBeInTheDocument();

    // '다음'은 단계만 넘긴다. 화면(방금 만든 VPC 상세)은 그대로다
    const before = hashPath();
    await user.click(screen.getByTestId("tutorial-next"));
    expect(stepTitle("② 서브넷 만들기")).toBeInTheDocument();
    expect(hashPath()).toBe(before);
    expect(screen.getByTestId("tutorial-where")).toHaveTextContent("VPC › 서브넷 › 서브넷 생성");
  });

  it("건너뛰기·이전·전체 단계로 단계를 오갈 수 있고, 접어 두었다가 다시 열 수 있다", async () => {
    const { user } = await startFirstWebServer();
    await user.click(screen.getByTestId("tutorial-next"));
    await user.click(screen.getByTestId("tutorial-skip"));
    expect(stepTitle("② 서브넷 만들기")).toBeInTheDocument();
    await user.click(screen.getByTestId("tutorial-prev"));
    expect(stepTitle("① VPC 만들기")).toBeInTheDocument();

    // 끝내면 패널이 사라지고, 상단 메뉴에서 다시 시작할 수 있다
    await user.click(within(panel()).getByRole("button", { name: "튜토리얼 끝내기" }));
    expect(screen.queryByTestId("tutorial-panel")).not.toBeInTheDocument();
    expect(useTutorialStore.getState().active).toBeNull();
  });

  it("샌드박스마다 진행 단계를 기억해 새로고침해도 이어지고, 다른 샌드박스에는 보이지 않는다", async () => {
    const { p, user } = await startFirstWebServer();
    await user.click(screen.getByTestId("tutorial-next"));
    expect(stepTitle("① VPC 만들기")).toBeInTheDocument();

    // 새로고침: 화면 상태는 사라지고 저장된 진행 단계만 남는다
    cleanup();
    resetTutorialStore();
    renderConsole(p.id, "#/");
    expect(within(await screen.findByTestId("tutorial-panel")).getByRole("heading", { name: "① VPC 만들기" })).toBeInTheDocument();

    // 다른 샌드박스
    cleanup();
    resetTutorialStore();
    const other = createEmptyProject("다른 샌드박스");
    seedStore([p, other]);
    renderConsole(other.id, "#/");
    await screen.findByRole("heading", { name: "콘솔 홈", level: 1 });
    expect(screen.queryByTestId("tutorial-panel")).not.toBeInTheDocument();
  });
});

describe("튜토리얼 정의", () => {
  it("할 일 목록이 있는 단계는 판정이 있고, 직접 입력하는 항목에는 넣을 값이 있다", () => {
    for (const t of TUTORIALS) {
      for (const s of t.steps) {
        if (!s.todo) continue;
        expect(s.todo.length, `${t.id}/${s.id}`).toBeGreaterThan(0);
        expect(s.task, `${t.id}/${s.id}: 한 줄 요약(task)도 있어야 한다`).toBeTruthy();
        for (const item of s.todo) {
          expect(item.label.trim(), `${t.id}/${s.id}`).not.toBe("");
          if ((item.kind ?? "type") === "type") expect(item.value, `${t.id}/${s.id}/${item.label}: 입력할 값`).toBeTruthy();
        }
      }
    }
  });

  it("튜토리얼 ID와 단계 ID는 겹치지 않는다", () => {
    expect(new Set(TUTORIALS.map((t) => t.id)).size).toBe(TUTORIALS.length);
    for (const t of TUTORIALS) expect(new Set(t.steps.map((s) => s.id)).size, t.id).toBe(t.steps.length);
  });
});
