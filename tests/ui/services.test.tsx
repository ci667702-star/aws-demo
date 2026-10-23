import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { createEmptyProject } from "@/lib/project/factory";
import { lifecycleTiming } from "@/lib/project/lifecycle";
import { createThreeTierSample } from "@/lib/project/samples";
import { goTo, project, renderConsole, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  lifecycleTiming.scale = 0;
});

afterEach(() => {
  lifecycleTiming.scale = 1;
});

describe("IAM (가상)", () => {
  it("사용자를 만들고 가상 액세스 키를 발급한다 — 비밀 키는 한 번만 보이고 저장되지 않는다", async () => {
    const p = createEmptyProject("IAM UI");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/iam/users/create");
    await user.type(await screen.findByLabelText("사용자 이름"), "dev-kim");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("checkbox", { name: /AmazonS3ReadOnlyAccess/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "사용자 생성" }));
    expect(await screen.findByRole("heading", { name: "dev-kim", level: 1 })).toBeInTheDocument();
    const userId = project(p.id).services.iam.users[0].id;

    await goTo(`#/iam/users/${userId}/create-access-key`);
    const next = await screen.findByRole("button", { name: "다음" });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /권장 사항을 이해했으며/ }));
    await user.click(next);
    await user.click(screen.getByRole("button", { name: "액세스 키 만들기" }));
    await user.click(await screen.findByRole("button", { name: "표시" }));
    const secret = screen.getByText(/^SIMULATED/).textContent ?? "";
    const keyId = project(p.id).services.iam.users[0].accessKeys[0].id;
    expect(keyId).toMatch(/^PGSIM/);
    expect(secret).toHaveLength(40);
    expect(JSON.stringify(project(p.id))).not.toContain(secret);
  });
});

describe("S3 (가상)", () => {
  it("버킷 이름 규칙과 전역 중복을 알려 주고, 퍼블릭 정책은 차단이 켜져 있으면 저장되지 않는다", async () => {
    const p = createEmptyProject("S3 UI");
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/s3/create");
    const name = await screen.findByLabelText("버킷 이름");
    await user.type(name, "My_Bucket");
    await user.click(screen.getByRole("button", { name: "버킷 만들기" }));
    expect(await screen.findByText(/\[InvalidBucketName\]/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "test");
    await user.click(screen.getByRole("button", { name: "버킷 만들기" }));
    expect(await screen.findByText(/\[BucketAlreadyExists\]/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "site-2026-kim");
    await user.click(screen.getByRole("button", { name: "버킷 만들기" }));
    expect(await screen.findByRole("heading", { name: "site-2026-kim", level: 1 })).toBeInTheDocument();
    expect(project(p.id).services.s3.buckets[0].blockPublicAccess.blockPublicPolicy).toBe(true);

    const bucketId = project(p.id).services.s3.buckets[0].id;
    await goTo(`#/s3/buckets/${bucketId}/edit-policy`);
    await user.click(await screen.findByRole("button", { name: "퍼블릭 읽기 (정적 웹 사이트용)" }));
    await user.click(screen.getByRole("button", { name: "변경 사항 저장" }));
    expect(await screen.findByText(/\[AccessDenied\]/)).toBeInTheDocument();
    expect(project(p.id).services.s3.buckets[0].policy).toBe("");
  });
});

describe("CloudWatch (가상)", () => {
  it("가상 부하를 만들면 도달 여부를 보여 주고, 경보 목록은 빈 상태 안내를 보여 준다", async () => {
    const p = createThreeTierSample();
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/cloudwatch/load");
    await user.click(await screen.findByRole("button", { name: "부하 시작" }));
    const table = await screen.findByRole("table", { name: "가상 부하 목록" });
    expect(await within(table).findByText("대상까지 도달")).toBeInTheDocument();
    expect(project(p.id).services.cloudwatch.loads).toHaveLength(1);

    await goTo("#/cloudwatch/alarms");
    expect(await screen.findByText("경보 없음")).toBeInTheDocument();
  });
});

describe("ALB 리스너 규칙", () => {
  it("고정 응답 규칙을 추가하고 경로 테스트로 일치 여부를 확인한다", async () => {
    const p = createThreeTierSample();
    seedStore([p]);
    const albId = p.resources.find((r) => r.type === "alb")!.id;
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, `#/ec2/load-balancers/${albId}`);
    const rules = await screen.findByTestId("listener-rules");
    await user.click(within(rules).getByRole("button", { name: "규칙 추가" }));
    const dialog = await screen.findByRole("dialog");
    const patterns = within(dialog).getByLabelText(/경로 패턴/);
    await user.clear(patterns);
    await user.type(patterns, "/maintenance");
    await user.click(within(dialog).getByRole("radio", { name: /고정 응답 반환/ }));
    await user.click(within(dialog).getByRole("button", { name: "규칙 추가" }));
    expect(await within(rules).findByText(/고정 응답/)).toBeInTheDocument();
    const tester = within(rules).getByLabelText("경로 테스트");
    await user.clear(tester);
    await user.type(tester, "/maintenance");
    expect(within(rules).getByText(/규칙 10 일치/)).toBeInTheDocument();
    const alb = project(p.id).resources.find((r) => r.id === albId);
    expect(alb?.type === "alb" ? alb.config.listeners[0].rules : []).toHaveLength(1);
  });
});
