import { expect, test, type Page } from "@playwright/test";

async function openExample(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "예시: 3-Tier 웹 아키텍처" }).first().click();
  await expect(page.getByTestId("builder")).toBeVisible();
  await expect(page.getByTestId("node-web-alb")).toBeVisible();
}

async function handleCenter(page: Page, nodeName: string, position: "top" | "bottom") {
  const handle = page.getByTestId(`node-${nodeName}`).locator("..").locator(`.react-flow__handle-${position}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`handle not visible: ${nodeName} ${position}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("첫 방문 시 예시 프로젝트가 있고, 새 프로젝트를 만들어 빌더로 이동한다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /클라우드 인프라를 설계하고/ })).toBeVisible();
  await expect(page.getByTestId("project-card").first()).toContainText("예시: 3-Tier 웹 아키텍처");
  await expect(page.getByText(/제휴하지 않은 독립 학습용 시뮬레이터/)).toBeVisible();

  await page.getByRole("button", { name: "새 프로젝트" }).first().click();
  await page.getByLabel("이름").fill("E2E 프로젝트");
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page).toHaveURL(/\/projects\/proj-/);
  await expect(page.getByTestId("project-name")).toHaveText("E2E 프로젝트");
  await expect(page.getByText("빈 캔버스입니다")).toBeVisible();
});

test("리소스를 추가하고 연결점을 드래그해 관계를 만들고, 삭제한다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 프로젝트" }).first().click();
  await page.getByLabel("이름").fill("연결 테스트");
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.getByTestId("builder")).toBeVisible();

  await page.getByTestId("palette-vpc").click();
  await expect(page.getByTestId("node-vpc-1")).toBeVisible();
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await page.getByTestId("palette-subnet").click();
  await expect(page.getByTestId("node-subnet-1")).toBeVisible();
  await page.getByRole("button", { name: "자동 정렬" }).click();
  await page.locator(".react-flow__controls-fitview").click();

  // 서브넷은 아직 VPC에 속하지 않는다 → 검증 오류
  await expect(page.getByTestId("tab-validation")).toContainText("1");

  const from = await handleCenter(page, "vpc-1", "bottom");
  const to = await handleCenter(page, "subnet-1", "top");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByText(/연결됨/).first()).toBeVisible();
  await expect(page.getByTestId("tab-validation")).not.toContainText(/\d/);

  // 연결선 선택 후 삭제
  await page.locator(".react-flow__edge").first().click({ force: true });
  const deleteButton = page.getByTestId("inspector").getByRole("button", { name: "연결 삭제" });
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  // 실행 취소로 연결 복원
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("설정 패널은 잘못된 CIDR을 거부한다", async ({ page }) => {
  await openExample(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByTestId("node-main-vpc").click();
  const cidr = page.getByTestId("vpc-cidr");
  await cidr.fill("10.0.0.0/33");
  await cidr.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "접두사 길이" })).toBeVisible();
  await cidr.press("Escape");
  await expect(cidr).toHaveValue("10.0.0.0/16");
});

test("시뮬레이션: 인터넷 → ALB 요청이 성공하고 두 EC2로 분산된다", async ({ page }) => {
  await openExample(page);
  await page.getByTestId("open-simulation").click();
  await page.getByRole("button", { name: /인터넷 → web-alb:80/ }).click();
  const result = page.getByTestId("simulation-result");
  await expect(result).toHaveAttribute("data-outcome", "success");
  await expect(page.getByTestId("distribution")).toContainText("app-1");
  await expect(page.getByTestId("distribution")).toContainText("app-2");
  await expect(page.locator(".react-flow__edge.path-active").first()).toBeVisible();
});

test("시뮬레이션: EC2를 중지하면 실패 원인이 바뀐다", async ({ page }) => {
  await openExample(page);
  await page.locator(".react-flow__controls-fitview").click();
  for (const name of ["app-1", "app-2"]) {
    await page.getByTestId(`node-${name}`).click();
    await page.getByRole("button", { name: "중지" }).click();
    await expect(page.getByTestId(`node-${name}`)).toContainText("stopped");
  }
  await page.getByTestId("open-simulation").click();
  await page.getByRole("button", { name: /인터넷 → web-alb:80/ }).click();
  await expect(page.getByTestId("simulation-result")).toHaveAttribute("data-outcome", "failure");
  await expect(page.getByTestId("simulation-result")).toContainText("Stopped");
});

test("프로젝트는 새로고침 후에도 복원된다", async ({ page }) => {
  await openExample(page);
  await page.getByTestId("project-name").click();
  const input = page.getByLabel("프로젝트 이름").first();
  await input.fill("새로고침 테스트");
  await input.press("Enter");
  await expect(page.getByTestId("save-status")).toContainText("저장됨");
  await page.reload();
  await expect(page.getByTestId("project-name")).toHaveText("새로고침 테스트");
});

test("JSON 내보내기 파일을 다시 가져오면 새 프로젝트가 된다", async ({ page }) => {
  await openExample(page);
  await page.getByRole("button", { name: "더 보기" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /JSON 내보내기/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.aws-playground\.json$/);
  const path = await download.path();

  await page.goto("/");
  await page.getByRole("button", { name: "JSON 가져오기" }).click();
  await page.getByTestId("import-file-input").setInputFiles(path);
  await page.getByRole("button", { name: "검증 후 가져오기" }).click();
  await expect(page).toHaveURL(/\/projects\/proj-/);
  await expect(page.getByTestId("node-web-alb")).toBeVisible();

  await page.goto("/");
  await expect(page.locator('section[aria-labelledby="projects-heading"] [data-testid="project-card"]')).toHaveCount(2);
});
