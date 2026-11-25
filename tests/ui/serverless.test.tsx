import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Builder } from "@/components/builder/builder";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { useEditorStore } from "@/lib/store/editor-store";
import { lambdaProject, scheduledLambdaProject } from "../helpers";
import { project, renderConsole, renderWithProviders, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
});

const fnId = (projectId: string, name = "fn") => project(projectId).resources.find((r) => r.type === "lambda" && r.name === name)!.id;

describe("Lambda 콘솔", () => {
  it("함수 생성: 새 실행 역할과 함께 함수를 만들고 상세 화면으로 이동한다", async () => {
    const p = lambdaProject({ placement: "none", role: "basic", template: "hello" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/lambda/functions/create");
    const name = await screen.findByRole("textbox", { name: "함수 이름" });
    await user.clear(name);
    await user.type(name, "health-check");
    await user.click(screen.getByRole("radio", { name: /외부 API 호출/ }));
    await user.click(screen.getByRole("button", { name: "함수 생성" }));

    await waitFor(() => expect(project(p.id).resources.some((r) => r.type === "lambda" && r.name === "health-check")).toBe(true));
    const fn = project(p.id).resources.find((r) => r.name === "health-check")!;
    expect(fn.type === "lambda" && fn.config).toMatchObject({ codeTemplate: "http-get", runtime: "nodejs22.x" });
    const role = project(p.id).services.iam.roles.find((r) => fn.type === "lambda" && r.id === fn.config.roleId);
    expect(role).toMatchObject({ trustedEntity: "lambda.amazonaws.com", policyIds: ["aws:AWSLambdaBasicExecutionRole"] });
    expect(await screen.findByRole("heading", { level: 1, name: "health-check" })).toBeInTheDocument();
  });

  it("테스트 탭: 호출 결과와 REPORT 로그, 실패하면 원인을 보여 준다", async () => {
    const p = lambdaProject({ placement: "public", template: "http-get" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, `#/lambda/functions/${fnId(p.id)}?tab=test`);
    await user.click(await screen.findByTestId("lambda-test"));
    expect(await screen.findByTestId("lambda-result")).toHaveTextContent("시간 초과");
    // 함수 개요와 '왜 이런 결과인가요?' 모두에 원인이 나온다
    expect(screen.getAllByText(/퍼블릭 IP를 받지 않아/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/REPORT RequestId: .* Billed Duration: 3000 ms/)).toBeInTheDocument();
  });

  it("실행 역할이 없으면 함수 생성을 AWS 오류로 거부한다 (기존 역할 사용인데 선택 안 함)", async () => {
    const p = lambdaProject({ placement: "none", role: "basic", template: "hello" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, "#/lambda/functions/create");
    await user.click(await screen.findByRole("radio", { name: /기존 역할 사용/ }));
    await user.click(screen.getByRole("button", { name: "함수 생성" }));
    expect(await screen.findByText(/\[InvalidParameterValueException\] 실행 역할을 선택하세요/)).toBeInTheDocument();
  });
});

describe("EventBridge 콘솔", () => {
  it("일정 생성: 잘못된 표현식은 이유를 보여 주고, 자주 쓰는 일정으로 만들면 다음 실행 시각과 호출 가능 여부를 보여 준다", async () => {
    const p = lambdaProject({ placement: "none", role: "basic", template: "hello" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, `#/eventbridge/schedules/create?target=${fnId(p.id)}`);
    const expression = await screen.findByRole("textbox", { name: "일정 표현식" });
    await user.clear(expression);
    await user.type(expression, "cron(0 9 * * * *)");
    expect(await screen.findByText(/중 하나는 \?여야 합니다/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "평일 09:00" }));
    expect(await screen.findByText("평일 09:00 (Asia/Seoul)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "일정 생성" }));

    await waitFor(() => expect(project(p.id).services.eventbridge.schedules).toHaveLength(1));
    expect(project(p.id).services.eventbridge.schedules[0]).toMatchObject({ expression: "cron(0 9 ? * MON-FRI *)", timezone: "Asia/Seoul" });
    expect(await screen.findByTestId("schedule-invoke")).toHaveTextContent("Scheduler가 함수를 호출할 수 있음");
  });

  it("규칙 상세: 테스트 이벤트를 보내면 필드별 일치 근거와 함수 실행 결과를 보여 준다", async () => {
    const p = scheduledLambdaProject({ rule: "with-permission" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderConsole(p.id, `#/eventbridge/rules/${p.services.eventbridge.rules[0].id}`);
    await user.click(await screen.findByTestId("send-test-event"));
    const delivery = await screen.findByTestId("delivery-ec2-stopped");
    expect(delivery).toHaveTextContent("일치");
    expect(delivery).toHaveTextContent("detail.state");
    expect(within(delivery).getAllByText("성공").length).toBeGreaterThan(0);
  });
});

describe("빌더의 Lambda 설정", () => {
  it("실행 역할이 없으면 실행할 수 없다고 보여 주고, '기본 실행 역할 만들기'로 바로 고칠 수 있다", async () => {
    const p = lambdaProject({ role: "none", placement: "none", template: "hello" });
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<Builder projectId={p.id} />);
    const id = fnId(p.id);
    act(() => useEditorStore.getState().setSelection([id], []));
    expect(await screen.findByText("실행할 수 없음")).toBeInTheDocument();
    await user.click(screen.getByTestId("lambda-create-role"));
    await waitFor(() => expect(project(p.id).services.iam.roles.some((r) => r.trustedEntity === "lambda.amazonaws.com" && r.name.startsWith("fn-role-"))).toBe(true));
    expect(await screen.findByText("성공")).toBeInTheDocument();
  });
});
