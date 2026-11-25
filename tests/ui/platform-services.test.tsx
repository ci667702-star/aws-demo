import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import * as sm from "@/lib/project/secrets-actions";
import * as ssm from "@/lib/project/ssm-actions";
import { cdnProject, lambdaProject, must, ssmNodeProject } from "../helpers";
import { project, renderConsole, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
});

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

describe("Secrets Manager 콘솔", () => {
  it("새 보안 암호 저장: 값은 입력받지 않고 키 이름만 저장하며, 값 검색은 가상 값을 보여 준다", async () => {
    const p = lambdaProject({ template: "hello" });
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/secretsmanager/secrets/create");
    await user.click(await screen.findByRole("radio", { name: /다른 유형의 보안 암호/ }));
    const key = screen.getByRole("textbox", { name: "키 1" });
    await user.clear(key);
    await user.type(key, "api_key");
    const name = screen.getByRole("textbox", { name: "보안 암호 이름" });
    await user.clear(name);
    await user.type(name, "prod/my-app/api");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(project(p.id).services.secretsmanager.secrets).toHaveLength(1));
    const secret = project(p.id).services.secretsmanager.secrets[0];
    expect(secret).toMatchObject({ name: "prod/my-app/api", keys: ["api_key"], kind: "other" });
    expect(JSON.stringify(project(p.id))).not.toContain("PGSIM-");
    expect(await screen.findByRole("heading", { level: 1, name: "prod/my-app/api" })).toBeInTheDocument();

    await user.click(screen.getByTestId("secret-retrieve"));
    const value = await screen.findByTestId("secret-value");
    expect(value).toHaveTextContent("api_key");
    expect(value).toHaveTextContent(/PGSIM-/);
  });

  it("접근 테스트: 실행 역할에 권한이 없는 함수는 AccessDeniedException과 실패 단계를 보여 준다", async () => {
    const p = must(sm.createSecret(lambdaProject({ template: "hello", placement: "none", role: "basic" }), { name: "prod/my-app/api", description: "", kind: "other", keys: ["api_key"] })).project;
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, `#/secretsmanager/secrets/${p.services.secretsmanager.secrets[0].id}?tab=access`);
    await user.click(await screen.findByTestId("secret-access-run"));
    const result = await screen.findByTestId("secret-access-result");
    expect(result).toHaveAttribute("data-ok", "false");
    expect(result).toHaveTextContent("AccessDeniedException");
    expect(within(result).getByText(/권한: .*secretsmanager:GetSecretValue/)).toBeInTheDocument();
  });

  it("삭제 예약 → 상세에 경고가 보이고, 삭제 취소로 되돌린다", async () => {
    const p = must(sm.createSecret(lambdaProject({ template: "hello" }), { name: "prod/my-app/api", description: "", kind: "other", keys: ["api_key"] })).project;
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, `#/secretsmanager/secrets/${p.services.secretsmanager.secrets[0].id}`);
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제 예약" }));
    await waitFor(() => expect(project(p.id).services.secretsmanager.secrets[0].deletion).toMatchObject({ recoveryDays: 30 }));
    expect(await screen.findByText("이 보안 암호는 삭제가 예약되어 있습니다")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "삭제 취소" }));
    await waitFor(() => expect(project(p.id).services.secretsmanager.secrets[0].deletion).toBeNull());
  });
});

describe("Systems Manager 콘솔", () => {
  it("파라미터 생성 → 편집하면 버전이 올라가고 기록 탭에 이전 값이 남는다", async () => {
    const p = lambdaProject({ template: "hello" });
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/ssm/parameters/create");
    await user.click(await screen.findByRole("button", { name: "파라미터 생성" }));
    await waitFor(() => expect(project(p.id).services.ssm.parameters).toHaveLength(1));
    const param = project(p.id).services.ssm.parameters[0];
    expect(param).toMatchObject({ name: "/my-app/prod/db-host", type: "String", value: "db.internal.example", version: 1 });
    expect(await screen.findByTestId("parameter-value")).toHaveTextContent("db.internal.example");

    await user.click(screen.getByRole("link", { name: "편집" }));
    const value = await screen.findByRole("textbox", { name: "값" });
    await user.clear(value);
    await user.type(value, "db2.internal.example");
    await user.click(screen.getByRole("button", { name: "변경 사항 저장" }));
    await waitFor(() => expect(project(p.id).services.ssm.parameters[0]).toMatchObject({ version: 2, value: "db2.internal.example" }));
    await user.click(await screen.findByRole("tab", { name: "기록" }));
    const history = await screen.findByRole("table", { name: "파라미터 기록" });
    expect(history).toHaveTextContent("db.internal.example");
    expect(history).toHaveTextContent("2 (현재)");
  });

  it("비밀처럼 보이는 이름을 String으로 만들면 시뮬레이터 안전 규칙으로 거부한다", async () => {
    const p = lambdaProject({ template: "hello" });
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/ssm/parameters/create");
    const name = await screen.findByRole("textbox", { name: "이름" });
    await user.clear(name);
    await user.type(name, "/my-app/db-password");
    await user.click(screen.getByRole("button", { name: "파라미터 생성" }));
    expect(await screen.findByText(/\[SimulatorSafetyRule\]/)).toBeInTheDocument();
    expect(project(p.id).services.ssm.parameters).toHaveLength(0);
  });

  it("관리형 노드: NAT 경로가 없으면 연결 안 됨과 이유를 보여 주고, 세션은 TargetNotConnected로 막힌다", async () => {
    const { p } = ssmNodeProject({ route: "none" });
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, "#/ssm/nodes");
    await user.click(await screen.findByRole("radio", { name: "app 선택" }));
    const checks = await screen.findByTestId("node-checks");
    expect(checks).toHaveAttribute("data-managed", "false");
    expect(checks).toHaveTextContent(/Systems Manager 엔드포인트/);
    await user.click(screen.getByRole("link", { name: "세션 시작" }));
    expect(await screen.findByText(/\[TargetNotConnected\]/)).toBeInTheDocument();
  });

  it("세션: 관리형 노드에서 명령을 누르면 가상 출력과 이유를 보여 준다", async () => {
    const { p, app } = ssmNodeProject();
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, `#/ssm/sessions/${app}`);
    await user.click(await screen.findByRole("button", { name: "whoami" }));
    await user.click(screen.getByRole("button", { name: "aws sts get-caller-identity" }));
    const output = await screen.findByTestId("session-output");
    expect(output).toHaveTextContent("ssm-user");
    expect(output).toHaveTextContent(/assumed-role\/app-ssm-role/);
  });
});

describe("CloudFront 콘솔", () => {
  it("OAC 버킷 정책이 없으면 경고 → 원본 탭에서 정책을 추가하면 요청이 성공하고, 두 번째 요청은 캐시에서 응답한다", async () => {
    const { p, distId, bucketId } = cdnProject({ policy: "none" });
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, `#/cloudfront/distributions/${distId}`);
    expect(await screen.findByText("S3 버킷 정책을 업데이트해야 합니다")).toBeInTheDocument();
    expect(screen.getByTestId("distribution-health")).toHaveAttribute("data-ok", "false");

    await user.click(screen.getByRole("tab", { name: "원본" }));
    await user.click(await screen.findByTestId("add-oac-policy-site-origin"));
    await waitFor(() => expect(project(p.id).services.s3.buckets.find((b) => b.id === bucketId)?.policy).toContain("AWS:SourceArn"));
    expect(screen.getByTestId("origin-check-site-origin")).toHaveAttribute("data-type", "success");

    await user.click(screen.getByRole("tab", { name: "요청 테스트" }));
    await user.click(await screen.findByTestId("cf-send"));
    await waitFor(() => expect(screen.getAllByTestId("cf-response")[0]).toHaveAttribute("data-xcache", "Miss from cloudfront"));
    expect(project(p.id).services.cloudfront.distributions[0].cache).toHaveLength(1);
    await user.click(screen.getByTestId("cf-send"));
    await waitFor(() => expect(screen.getAllByTestId("cf-response")[0]).toHaveAttribute("data-xcache", "Hit from cloudfront"));
  });

  it("무효화하면 엣지 캐시가 비워진다", async () => {
    const { p, distId } = cdnProject();
    seedStore([p]);
    const user = setup();
    renderConsole(p.id, `#/cloudfront/distributions/${distId}?tab=test`);
    await user.click(await screen.findByTestId("cf-send"));
    await waitFor(() => expect(project(p.id).services.cloudfront.distributions[0].cache).toHaveLength(1));
    await user.click(screen.getByRole("tab", { name: "무효화" }));
    await user.click(await screen.findByTestId("cf-invalidate"));
    await waitFor(() => expect(project(p.id).services.cloudfront.distributions[0].cache).toHaveLength(0));
    expect(project(p.id).services.cloudfront.distributions[0].invalidations[0].paths).toEqual(["/*"]);
  });

  it("배포 생성: 첫 버킷을 OAC 원본으로 채운 양식으로 배포를 만들고 상세 화면으로 이동한다 (배포 중)", async () => {
    const { p } = cdnProject();
    const fresh = { ...p, services: { ...p.services, cloudfront: { distributions: [] } } };
    seedStore([fresh]);
    const user = setup();
    renderConsole(fresh.id, "#/cloudfront/distributions/create");
    await user.click(await screen.findByRole("button", { name: "배포 생성" }));
    await waitFor(() => expect(project(fresh.id).services.cloudfront.distributions).toHaveLength(1));
    const dist = project(fresh.id).services.cloudfront.distributions[0];
    expect(dist.origins[0]).toMatchObject({ kind: "s3", originAccess: "oac" });
    expect(dist.defaultRootObject).toBe("index.html");
    expect(await screen.findByRole("heading", { level: 1, name: dist.id })).toBeInTheDocument();
  });
});

describe("Lambda 코드 템플릿 대상", () => {
  it("보안 암호 읽기 템플릿은 보안 암호를 목록에서 고른다", async () => {
    const p = must(ssm.putParameter(must(sm.createSecret(lambdaProject({ template: "hello" }), { name: "prod/my-app/api", description: "", kind: "other", keys: ["k"] })).project, { name: "/my-app/prod/db-host", description: "", type: "String", tier: "Standard", value: "v", overwrite: false })).project;
    seedStore([p]);
    const user = setup();
    const fn = p.resources.find((r) => r.type === "lambda")!;
    renderConsole(p.id, `#/lambda/functions/${fn.id}?tab=code`);
    await user.selectOptions(await screen.findByRole("combobox", { name: "코드 템플릿" }), "secret-get");
    await user.selectOptions(screen.getByRole("combobox", { name: /읽을 보안 암호/ }), "prod/my-app/api");
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(project(p.id).resources.find((r) => r.id === fn.id)).toMatchObject({ config: { codeTemplate: "secret-get", templateTarget: "prod/my-app/api" } }));
  });
});
