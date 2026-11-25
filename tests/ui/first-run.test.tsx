import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Builder } from "@/components/builder/builder";
import { Dashboard } from "@/components/dashboard/dashboard";
import { GlossaryText } from "@/components/docs/glossary-text";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createEmptyProject } from "@/lib/project/factory";
import { useGuidePrefs } from "@/lib/store/guide-prefs";
import { useProjectStore } from "@/lib/store/project-store";
import { goTo, project, renderConsole, renderWithProviders, routerPush, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  routerPush.mockClear();
});

const projects = () => Object.values(useProjectStore.getState().projects);
const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

describe("첫 화면: 어디서 시작할지", () => {
  it("'첫 웹 서버 따라하기 시작'은 빈 샌드박스를 만들고 콘솔에서 그 따라하기를 첫 단계부터 연다", async () => {
    seedStore([]);
    const user = setup();
    renderWithProviders(<Dashboard />);
    await user.click(within(screen.getByTestId("quick-start")).getByRole("button", { name: "첫 웹 서버 따라하기 시작" }));
    await waitFor(() => expect(projects()).toHaveLength(1));
    expect(projects()[0]).toMatchObject({ name: "첫 웹 서버 따라하기", preferredMode: "console", resources: [] });
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/console\/proj-\d+#\/\?tutorial=first-web-server$/));
  });

  it("따라하기 주제를 고르면 그 주제로 시작하고, 샌드박스가 있으면 시작 안내는 한 줄로 줄어든다", async () => {
    seedStore([]);
    const user = setup();
    renderWithProviders(<Dashboard />);
    const cards = screen.getAllByTestId("topic-card");
    expect(cards).toHaveLength(7);
    await user.click(cards.find((c) => c.textContent?.includes("S3로 정적 웹 사이트 공개하기"))!);
    await waitFor(() => expect(projects()).toHaveLength(1));
    expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/#\/\?tutorial=s3-static-site$/));
    // 다시 온 사람: 내 샌드박스가 위에 보이고, 시작 안내는 한 줄
    expect(screen.getByRole("table", { name: "샌드박스 목록" })).toBeInTheDocument();
    expect(within(screen.getByTestId("quick-start")).queryByRole("heading")).toBeNull();
  });
});

describe("콘솔: 다음 할 일과 사이드 메뉴", () => {
  it("#/?tutorial= 로 열면 그 따라하기 안내가 첫 단계에서 열리고 주소의 표시는 지운다", async () => {
    const p = createEmptyProject("따라하기");
    seedStore([p]);
    renderConsole(p.id, "#/?tutorial=first-web-server");
    const panel = await screen.findByTestId("tutorial-panel");
    expect(within(panel).getByRole("heading", { name: "무엇을 만들까요?" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("다음 할 일 줄은 지금 설정으로 다음 단계를 보여 주고, 숨기면 콘솔 홈에서 다시 켤 수 있다", async () => {
    const p = createEmptyProject("다음 할 일");
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/vpc/vpcs");
    const bar = await screen.findByTestId("next-step-bar");
    expect(bar).toHaveTextContent("첫 웹 서버까지 0/7");
    expect(bar).toHaveTextContent("VPC 만들기");
    expect(within(bar).getByTestId("next-step-go")).toHaveAttribute("href", "#/vpc/vpcs/create");

    await goTo("#/vpc/vpcs/create");
    expect(await screen.findByText("지금 이 화면에서 하면 됩니다")).toBeInTheDocument();

    await user.click(within(screen.getByTestId("next-step-bar")).getByRole("button", { name: "다음 할 일 숨기기" }));
    expect(screen.queryByTestId("next-step-bar")).toBeNull();
    expect(useGuidePrefs.getState().nextStepHidden[p.id]).toBe(true);

    await goTo("#/");
    await user.click(await screen.findByRole("button", { name: "다음 할 일 줄 다시 보이기" }));
    await goTo("#/vpc/subnets");
    expect(await screen.findByTestId("next-step-bar")).toBeInTheDocument();
  });

  it("다음 할 일 줄은 콘솔 홈·관계없는 서비스 화면·따라하기 중에는 보이지 않는다", async () => {
    const p = createEmptyProject("홈");
    seedStore([p]);
    renderConsole(p.id, "#/");
    await screen.findByRole("heading", { level: 1, name: "콘솔 홈" });
    expect(screen.queryByTestId("next-step-bar")).toBeNull();
    // IAM·S3 화면에서 VPC 단계를 권하지 않는다 (분석 도구 화면에는 보인다)
    await goTo("#/iam/users");
    await screen.findByRole("heading", { level: 1, name: /사용자/ });
    expect(screen.queryByTestId("next-step-bar")).toBeNull();
    await goTo("#/vpc/reachability");
    expect(await screen.findByTestId("next-step-bar")).toBeInTheDocument();
    await goTo("#/vpc/vpcs?tutorial=first-web-server");
    await screen.findByTestId("tutorial-panel");
    expect(screen.queryByTestId("next-step-bar")).toBeNull();
  });

  it("실습 문제 샌드박스에는 다음 할 일 줄을 보이지 않는다 (실습의 목표와 섞이지 않게)", async () => {
    const p = { ...createEmptyProject("실습"), labId: "lab-1-public-ec2" };
    seedStore([p]);
    renderConsole(p.id, "#/vpc/vpcs");
    await screen.findByRole("heading", { level: 1, name: /VPC/ });
    expect(screen.queryByTestId("next-step-bar")).toBeNull();
  });

  it("사이드 메뉴는 기본 서비스만 보이고 '서비스 더 보기'로 나머지를 연다. 지금 보는 서비스는 항상 보인다", async () => {
    const p = createEmptyProject("메뉴");
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/lambda/functions");
    await user.click(await screen.findByRole("button", { name: "탐색 창 열기" }));
    const nav = screen.getByRole("navigation", { name: "서비스 탐색" });
    expect(within(nav).getByRole("button", { name: /네트워크 \(VPC\)/ })).toBeInTheDocument();
    // 지금 화면(Lambda)의 그룹은 숨기지 않는다
    expect(within(nav).getByRole("button", { name: /서버리스 \(Lambda\)/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /데이터베이스 \(RDS\)/ })).toBeNull();
    const more = within(nav).getByTestId("nav-show-more");
    expect(more).toHaveTextContent("RDS");
    await user.click(more);
    expect(within(nav).getByRole("button", { name: /데이터베이스 \(RDS\)/ })).toBeInTheDocument();
    expect(useGuidePrefs.getState().navShowAll).toBe(true);
    await user.click(within(nav).getByTestId("nav-show-less"));
    expect(within(nav).queryByRole("button", { name: /데이터베이스 \(RDS\)/ })).toBeNull();
  });
});

describe("쉬운 모드: 첫 화면", () => {
  it("빈 캔버스에서 1단계를 알려 주고, 팔레트는 자주 쓰는 리소스만 보이며, 놓을 때마다 다음 단계로 바뀐다", async () => {
    const p = createEmptyProject("쉬운 모드");
    seedStore([p]);
    const user = setup();
    renderWithProviders(<Builder projectId={p.id} />);
    const guide = await screen.findByTestId("builder-next-step");
    expect(guide).toHaveTextContent("1단계 / 7");
    expect(guide).toHaveTextContent("VPC 만들기");
    expect(screen.getByTestId("palette-vpc")).toHaveAccessibleName("VPC (가상 네트워크) 추가");
    expect(screen.queryByTestId("palette-alb")).toBeNull();

    await user.click(within(guide).getByTestId("next-step-find"));
    await waitFor(() => expect(screen.getByTestId("palette-vpc")).toHaveAttribute("data-field-flash"));

    await user.click(screen.getByTestId("palette-vpc"));
    await waitFor(() => expect(project(p.id).resources).toHaveLength(1));
    expect(await screen.findByTestId("builder-next-step")).toHaveTextContent("서브넷 만들기");

    await user.click(screen.getByTestId("palette-show-more"));
    expect(screen.getByTestId("palette-alb")).toBeInTheDocument();
  });
});

describe("용어 풀이", () => {
  it("밑줄 친 용어에 마우스를 올리거나 누르면 한 줄 풀이를 보여 준다", async () => {
    const user = setup();
    renderWithProviders(
      <p>
        <GlossaryText text="라우팅 테이블에 0.0.0.0/0 경로가 있어야 퍼블릭 서브넷이 됩니다." />
      </p>,
    );
    const terms = screen.getAllByTestId("glossary-term");
    expect(terms.map((t) => t.textContent)).toEqual(["라우팅 테이블", "0.0.0.0/0", "퍼블릭 서브넷"]);
    await user.hover(terms[0]);
    expect(await screen.findByTestId("glossary-popover")).toHaveTextContent("서브넷의 길 안내표");
    await user.unhover(terms[0]);
    await waitFor(() => expect(screen.queryByTestId("glossary-popover")).toBeNull());
    // 터치·키보드처럼 눌러서 열고 닫는다
    act(() => terms[2].focus());
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("glossary-popover")).toHaveTextContent("인터넷 게이트웨이로 가는 경로");
  });
});
