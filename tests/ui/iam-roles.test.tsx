import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actingIdentity } from "@/lib/engine/iam-session";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createEmptyProject } from "@/lib/project/factory";
import { lifecycleTiming } from "@/lib/project/lifecycle";
import { goTo, project, renderConsole, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  lifecycleTiming.scale = 0;
});

afterEach(() => {
  lifecycleTiming.scale = 1;
});

describe("IAM 역할 나누기 (학교 역할 템플릿)", () => {
  it("템플릿을 만들고 역할별 사용자로 로그인하면, 그 역할이 맡지 않은 작업은 거부된다", async () => {
    const p = createEmptyProject("역할 실습");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/iam/templates");

    // 1. 루트로 템플릿 만들기 (정책·그룹·예시 사용자)
    await user.click(await screen.findByTestId("apply-role-templates"));
    await waitFor(() => expect(project(p.id).services.iam.users.map((u) => u.name)).toContain("net-admin"));
    expect(project(p.id).services.iam.policies.map((x) => x.name)).toContain("School-NetworkAdmin");
    const matrix = screen.getByTestId("capability-matrix");
    expect(within(matrix).getByText("네트워크 관리자")).toBeInTheDocument();

    // 2. 네트워크 관리자로 로그인 → 화면 위 안내 띠
    await user.click(await screen.findByTestId("template-sign-in-network-admin"));
    expect(await screen.findByTestId("identity-banner")).toHaveTextContent("IAM 사용자 net-admin");
    expect(actingIdentity(project(p.id))).toMatchObject({ kind: "user", user: { name: "net-admin" } });

    // 3. VPC는 만들 수 있다
    await goTo("#/vpc/vpcs/create");
    await user.type(await screen.findByLabelText("IPv4 CIDR"), "10.0.0.0/16");
    await user.type(screen.getByLabelText(/이름 태그/), "net-vpc");
    await user.click(screen.getByRole("button", { name: "VPC 생성" }));
    await waitFor(() => expect(project(p.id).resources.some((r) => r.type === "vpc" && r.name === "net-vpc")).toBe(true));

    // 4. S3 버킷은 네트워크 관리자의 일이 아니다 → AccessDenied, 버킷은 만들어지지 않는다
    await goTo("#/s3/create");
    await user.type(await screen.findByLabelText("버킷 이름"), "school-data");
    await user.click(screen.getByRole("button", { name: "버킷 만들기" }));
    expect((await screen.findAllByText(/\[AccessDenied\].*s3:CreateBucket/)).length).toBeGreaterThan(0);
    expect(project(p.id).services.s3.buckets).toHaveLength(0);

    // 5. 상단 계정 메뉴에서 스토리지 담당으로 전환하면 school-로 시작하는 버킷만 만들 수 있다
    await user.click(screen.getByTestId("identity-menu"));
    await user.click(await screen.findByTestId("sign-in-storage-mgr"));
    await waitFor(() => expect(actingIdentity(project(p.id))).toMatchObject({ kind: "user", user: { name: "storage-mgr" } }));
    await goTo("#/s3");
    await goTo("#/s3/create");
    await user.type(await screen.findByLabelText("버킷 이름"), "school-data");
    await user.click(screen.getByRole("button", { name: "버킷 만들기" }));
    await waitFor(() => expect(project(p.id).services.s3.buckets.map((b) => b.name)).toEqual(["school-data"]));

    // 6. 루트로 돌아가면 안내 띠가 사라진다
    await user.click(screen.getByRole("button", { name: "루트로 돌아가기" }));
    await waitFor(() => expect(screen.queryByTestId("identity-banner")).not.toBeInTheDocument());
    expect(actingIdentity(project(p.id)).kind).toBe("root");
  });
});
