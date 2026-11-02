import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { idOf, natInstanceProject } from "../helpers";
import { project, renderConsole, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
});

describe("콘솔에서 NAT 인스턴스 구성", () => {
  it("작업 → 네트워킹 → 소스/대상 확인 변경으로 중지하면 NAT 인스턴스로 동작한다고 표시한다", async () => {
    const p = natInstanceProject({ sourceDestCheck: true });
    const natId = idOf(p, "nat-instance");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, `#/ec2/instances/${natId}?tab=networking`);

    expect(await screen.findByTestId("nat-instance-status")).toHaveTextContent("소스/대상 확인이 켜져 있어");
    await user.click(screen.getByRole("button", { name: "작업" }));
    await user.click(await screen.findByRole("menuitem", { name: "소스/대상 확인 변경" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "소스/대상 확인 중지" }));
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(project(p.id).resources.find((r) => r.id === natId)?.config).toMatchObject({ sourceDestCheck: false }));
    expect(await screen.findByTestId("nat-instance-status")).toHaveTextContent("NAT 인스턴스로 동작합니다");
  });

  it("라우팅 편집의 대상 목록에 같은 VPC의 인스턴스가 나온다", async () => {
    const p = natInstanceProject();
    seedStore([p]);
    renderConsole(p.id, `#/vpc/route-tables/${idOf(p, "private-rt")}/edit-routes`);
    const select = await screen.findByLabelText("경로 1 대상 리소스");
    expect(within(select).getByRole("option", { name: /인스턴스 · .*nat-instance/ })).toBeInTheDocument();
  });

  it("가상 비용 화면에 NAT 게이트웨이와 NAT 인스턴스 비교가 나온다", async () => {
    const p = natInstanceProject();
    seedStore([p]);
    renderConsole(p.id, "#/billing");
    const card = await screen.findByTestId("nat-cost-comparison");
    expect(card).toHaveTextContent("NAT 게이트웨이 vs NAT 인스턴스");
    expect(card).toHaveTextContent("지금 구성");
  });
});

describe("리소스 맵 범례", () => {
  it("선 종류를 눌러 숨기고 다시 보일 수 있고, 소속 선은 처음에 숨겨져 있다", async () => {
    const p = natInstanceProject();
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/map");
    const legend = await screen.findByTestId("map-legend");
    const security = within(legend).getByRole("button", { name: /보안 그룹/ });
    expect(security).toHaveAttribute("aria-pressed", "true");
    await user.click(security);
    expect(security).toHaveAttribute("aria-pressed", "false");
    await user.click(security);
    expect(security).toHaveAttribute("aria-pressed", "true");
    expect(within(legend).getByRole("button", { name: /소속/ })).toHaveAttribute("aria-pressed", "false");
  });
});
