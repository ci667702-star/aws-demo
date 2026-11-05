import { expect, test, type Page } from "@playwright/test";

/** 첫 화면에서 빈 샌드박스를 만들고 콘솔 홈으로 이동한다 */
async function createSandbox(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "생성" }).first().click();
  await page.getByRole("dialog").getByLabel("이름").fill(name);
  await page.getByRole("button", { name: "생성 후 열기" }).click();
  await expect(page).toHaveURL(/\/console\/proj-[^#]+#\/$/);
  await expect(page.getByRole("heading", { name: "콘솔 홈", level: 1 })).toBeVisible();
}

async function go(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}

/** 콘솔 화면만으로 퍼블릭 웹 서버를 구성한다 (앱이 대신 설정하는 것 없음) */
async function buildPublicWebServer(page: Page) {
  // VPC
  await go(page, "#/vpc/vpcs/create");
  await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.0.0.0/16");
  await page.getByLabel(/이름 태그/).fill("e2e-vpc");
  await page.getByRole("button", { name: "VPC 생성" }).click();
  await expect(page.getByRole("heading", { name: /vpc-.+ \/ e2e-vpc/, level: 1 })).toBeVisible();

  // 서브넷
  await go(page, "#/vpc/subnets/create");
  await page.getByLabel("VPC ID").selectOption({ index: 1 });
  await page.getByLabel("서브넷 이름").fill("public-a");
  await page.getByLabel("가용 영역", { exact: true }).selectOption("ap-northeast-2a");
  await page.getByLabel(/IPv4 서브넷 CIDR 블록/).fill("10.0.1.0/24");
  await page.getByRole("button", { name: "서브넷 생성" }).click();
  await expect(page.getByRole("heading", { name: /subnet-.+ \/ public-a/, level: 1 })).toBeVisible();

  // 인터넷 게이트웨이 생성 → 알림의 "VPC에 연결" → 연결
  await go(page, "#/vpc/igws/create");
  await page.getByRole("button", { name: "인터넷 게이트웨이 생성" }).click();
  await page.locator("[data-sonner-toaster]").getByRole("button", { name: "VPC에 연결" }).click();
  await page.getByLabel("사용 가능한 VPC").selectOption({ index: 1 });
  await page.getByRole("button", { name: "인터넷 게이트웨이 연결" }).click();
  await expect(page.getByText("Attached").first()).toBeVisible();

  // 기본 라우팅 테이블에 0.0.0.0/0 → IGW
  await go(page, "#/vpc/route-tables");
  await page.getByRole("table", { name: "라우팅 테이블 목록" }).getByRole("radio").first().check();
  await page.getByRole("button", { name: "작업" }).click();
  await page.getByRole("menuitem", { name: "라우팅 편집" }).click();
  await page.getByRole("button", { name: "라우팅 추가" }).click();
  await page.getByLabel("경로 1 대상 CIDR").fill("0.0.0.0/0");
  await page.getByLabel("경로 1 대상 리소스").selectOption({ index: 1 });
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await expect(page.getByRole("table", { name: "경로" })).toContainText("0.0.0.0/0");

  // 인스턴스 시작
  await go(page, "#/ec2/instances/launch");
  await page.getByLabel("이름", { exact: true }).fill("web-1");
  await page.getByLabel("서브넷", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("퍼블릭 IP 자동 할당").selectOption("enabled");
  await page.getByRole("checkbox", { name: /인터넷에서 HTTP 트래픽 허용/ }).check();
  await page.getByRole("radio", { name: /웹 서버 설치/ }).check();
  await page.getByRole("button", { name: "인스턴스 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: /인스턴스 요약/, level: 1 })).toBeVisible();
  await expect(page.getByText("실행 중 (Running)").first()).toBeVisible({ timeout: 15_000 });
}

test("첫 화면에는 미리 만든 프로젝트가 없고, 새 샌드박스는 리소스 없이 시작한다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("샌드박스 없음")).toBeVisible();
  // 학습용 시뮬레이터 안내: 실제 AWS 계정·자격 증명·리소스를 쓰지 않고 요금이 없다는 점을 안내 상자와 바닥글에 보여 준다
  await expect(page.getByText(/실제 AWS 계정·자격 증명·리소스를 사용하지 않으며 요금이 부과되지 않습니다\. 또한 모든 리소스와 통신 결과는/)).toBeVisible();
  await expect(page.locator("footer")).toContainText("실제 AWS 계정·자격 증명·리소스를 사용하지 않으며 요금이 발생하지 않습니다.");
  await createSandbox(page, "E2E 빈 샌드박스");
  await go(page, "#/vpc/vpcs");
  await expect(page.getByText("VPC 없음")).toBeVisible();
  await go(page, "#/ec2/instances");
  await expect(page.getByText("인스턴스 없음")).toBeVisible();
});

test("콘솔 화면만으로 퍼블릭 웹 서버를 구성하고 Reachability Analyzer로 도달 가능을 확인한다", async ({ page }) => {
  await createSandbox(page, "E2E 웹 서버");
  await buildPublicWebServer(page);

  await go(page, "#/vpc/reachability/create");
  await page.getByLabel("대상", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "경로 생성 및 분석" }).click();
  await expect(page.getByTestId("analysis-outcome")).toHaveAttribute("data-outcome", "success");
  await expect(page.getByTestId("analysis-steps")).toContainText("보안 그룹");

  // 리소스 맵에서 경로 표시
  await page.getByRole("link", { name: "리소스 맵에서 보기" }).click();
  await expect(page.getByTestId("resource-map")).toBeVisible();
  await expect(page.locator(".react-flow__node-resource").first()).toBeVisible();
  expect(await page.locator(".react-flow__node-resource").count()).toBeGreaterThanOrEqual(6);

  // 새로고침해도 구성이 남아 있다
  await page.reload();
  await go(page, "#/ec2/instances");
  await expect(page.getByRole("table", { name: "인스턴스 목록" })).toContainText("web-1");
});

test("AWS처럼 잘못된 입력과 의존성 있는 삭제를 오류 코드로 거부한다", async ({ page }) => {
  await createSandbox(page, "E2E 오류");
  await go(page, "#/vpc/vpcs/create");
  await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.0.0.0/8");
  await page.getByRole("button", { name: "VPC 생성" }).click();
  await expect(page.getByText(/\[InvalidVpc\.Range\]/)).toBeVisible();

  await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.1.0.0/16");
  await page.getByRole("button", { name: "VPC 생성" }).click();
  await expect(page.getByRole("heading", { name: /vpc-/, level: 1 })).toBeVisible();

  // 기본 보안 그룹은 삭제할 수 없다 (메뉴 비활성)
  await go(page, "#/vpc/security-groups");
  await page.getByRole("table", { name: "보안 그룹 목록" }).getByRole("radio").first().check();
  await page.getByRole("button", { name: "작업" }).click();
  await expect(page.getByRole("menuitem", { name: "보안 그룹 삭제" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // VPC에 연결된 인터넷 게이트웨이는 분리하기 전에는 삭제할 수 없다
  await go(page, "#/vpc/igws/create");
  await page.getByRole("button", { name: "인터넷 게이트웨이 생성" }).click();
  await page.locator("[data-sonner-toaster]").getByRole("button", { name: "VPC에 연결" }).click();
  await page.getByLabel("사용 가능한 VPC").selectOption({ index: 1 });
  await page.getByRole("button", { name: "인터넷 게이트웨이 연결" }).click();
  await page.getByRole("button", { name: "작업" }).click();
  await page.getByRole("menuitem", { name: "인터넷 게이트웨이 삭제" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("delete");
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog")).toContainText("[DependencyViolation]");
});

test("실습을 시작하면 빈 샌드박스와 실습 패널이 열리고 진행 상황을 판정한다", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("lab-card").first().getByRole("button", { name: "실습 시작" }).click();
  await expect(page.getByTestId("lab-guide")).toBeVisible();
  await expect(page.getByTestId("lab-progress")).toHaveText("0/7 단계");
  await page.getByTestId("lab-guide").getByRole("link", { name: "콘솔에서 열기 →" }).first().click();
  await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.0.0.0/16");
  await page.getByRole("button", { name: "VPC 생성" }).click();
  await expect(page.getByTestId("lab-progress")).toHaveText("1/7 단계");
});

test("모바일 너비에서도 가로로 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createSandbox(page, "E2E 모바일");
  for (const hash of ["#/", "#/vpc/vpcs", "#/vpc/subnets/create", "#/ec2/instances/launch", "#/vpc/security-groups/create", "#/checks", "#/billing"]) {
    await go(page, hash);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, hash).toBeLessThanOrEqual(1);
  }
});

test("IAM 가상 액세스 키를 발급하고, S3 버킷을 정적 웹 사이트로 공개한다", async ({ page }) => {
  await createSandbox(page, "E2E 서비스");

  // IAM: 사용자 → 가상 액세스 키 (PGSIM으로 시작하는 연습용 값)
  await go(page, "#/iam/users/create");
  await page.getByLabel("사용자 이름").fill("dev-kim");
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "사용자 생성" }).click();
  await expect(page.getByRole("heading", { name: "dev-kim", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "작업" }).click();
  await page.getByRole("menuitem", { name: "액세스 키 만들기" }).click();
  await page.getByRole("checkbox", { name: /권장 사항을 이해했으며/ }).check();
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "액세스 키 만들기" }).click();
  await expect(page.getByText(/^PGSIM[A-Z2-7]{15}$/)).toBeVisible();

  // S3: 버킷 → index.html 업로드 → 호스팅 → 차단 해제 → 공개 정책 → 200 OK
  await go(page, "#/s3/create");
  await page.getByLabel("버킷 이름", { exact: true }).fill("e2e-site-2026");
  await page.getByRole("button", { name: "버킷 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "e2e-site-2026", level: 1 })).toBeVisible();
  const bucketPath = new URL(page.url()).hash.split("?")[0];
  await go(page, `${bucketPath}/upload`);
  await page.getByRole("button", { name: "목록에 추가" }).click();
  await page.getByRole("button", { name: "업로드", exact: true }).click();
  await expect(page.getByRole("table", { name: "객체 목록" })).toContainText("index.html");

  await go(page, `${bucketPath}/edit-website`);
  await page.getByRole("switch", { name: "정적 웹 사이트 호스팅 활성화" }).click();
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await go(page, `${bucketPath}/edit-bpa`);
  await page.getByRole("checkbox", { name: /모든 퍼블릭 액세스 차단/ }).uncheck();
  await page.getByPlaceholder("확인").fill("확인");
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await go(page, `${bucketPath}/edit-policy`);
  await page.getByRole("button", { name: "퍼블릭 읽기 (정적 웹 사이트용)" }).click();
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await expect(page.getByText("⚠ 퍼블릭").first()).toBeVisible();

  await go(page, `${bucketPath}?tab=properties`);
  await page.getByRole("button", { name: "웹 사이트 열어 보기 (가상)" }).click();
  await expect(page.getByRole("dialog")).toContainText("200 OK");
});

test("리소스 설명 패널: 선택한 리소스의 설명·설정 도움말을 보여 주고, 도움말이 화면 밖으로 나가지 않는다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "완성된 예시 아키텍처 살펴보기" }).click();
  await page.getByRole("button", { name: "예시 열기" }).first().click();
  await expect(page).toHaveURL(/\/console\/proj-/);
  const projectId = new URL(page.url()).pathname.split("/")[2];

  // 쉬운 모드: 캔버스에서 ALB를 고르면 ALB 설명과 실제 설정 폼이 함께 나온다
  await page.goto(`/projects/${projectId}`);
  await page.getByTestId("node-web-alb").click();
  await expect(page.getByTestId("doc-header")).toHaveAttribute("data-doc-key", "alb");
  await expect(page.getByTestId("current-relations")).toContainText("web-tg");
  const settings = page.getByTestId("doc-section-settings");
  await settings.getByRole("button", { name: "체계 (Scheme) 도움말" }).click();
  const popover = page.getByTestId("field-help-popover");
  await expect(popover).toContainText("이 시뮬레이터에서는");
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await page.keyboard.press("Escape");

  // 분석(E)의 설정 이름을 누르면 폼의 그 설정 항목으로 이동해 강조한다
  await page.getByTestId("doc-section-analysis").getByRole("button", { name: "체계", exact: true }).click();
  await expect(settings.locator('[data-field="scheme"]').first()).toHaveAttribute("data-field-flash", "");

  // 좁은 화면에서도 도움말 팝오버가 화면 안에 열린다
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("node-web-alb").click();
  await page.getByTestId("doc-section-settings").getByRole("button", { name: "체계 (Scheme) 도움말" }).click();
  const mobileBox = (await page.getByTestId("field-help-popover").boundingBox())!;
  expect(mobileBox.x).toBeGreaterThanOrEqual(0);
  expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // 심화 모드: 화면의 리소스를 따라 같은 설명을 도움말 패널에서 본다
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/console/${projectId}#/ec2/load-balancers`);
  await page.getByRole("link", { name: "web-alb" }).first().click();
  await page.getByTestId("open-resource-doc").click();
  await expect(page.getByTestId("console-resource-doc")).toHaveAttribute("data-doc-key", "alb");
});

test("튜토리얼은 '다음'을 눌러야 넘어가고, 화면도 자동으로 바뀌지 않으며, 강조 영역이 양식 크기를 따라간다", async ({ page }) => {
  await createSandbox(page, "E2E 튜토리얼");
  await page.locator('[data-tour="tutorial-menu"]').click();
  await page.getByRole("menuitem", { name: /S3로 정적 웹 사이트 공개하기/ }).click();
  const popover = page.locator(".driver-popover");
  const next = page.locator(".driver-popover-next-btn");
  await next.click();

  // ① 버킷 만들기: 할 일을 마치기 전에는 '다음'이 잠겨 있고, 화면은 그대로다
  await expect(popover).toContainText("① 버킷 만들기");
  await expect(next).toBeDisabled();
  await expect(page).toHaveURL(/#\/$/);
  await popover.getByRole("button", { name: "이 단계 화면으로 이동" }).click();
  await expect(page).toHaveURL(/#\/s3\/create$/);
  await page.getByLabel("버킷 이름", { exact: true }).fill("e2e-tour-2026");
  await page.getByRole("button", { name: "버킷 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "e2e-tour-2026", level: 1 })).toBeVisible();

  // 완료되어도 자동으로 넘어가지 않는다
  await expect(popover.locator(".pg-tour-status-done")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(popover).toContainText("① 버킷 만들기");
  await expect(next).toBeEnabled();
  const bucketPath = new URL(page.url()).hash.split("?")[0];
  await next.click();
  await expect(popover).toContainText("② index.html 올리기");
  expect(new URL(page.url()).hash.split("?")[0]).toBe(bucketPath);

  // 튜토리얼 중에도 화면의 다른 메뉴를 그대로 쓸 수 있다
  await page.getByRole("link", { name: "콘솔 홈" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(popover).toContainText("② index.html 올리기");

  // ② 업로드 → ③ 호스팅: 스위치를 켜 양식이 커져도 강조 영역과 팝업이 양식을 가리지 않게 따라간다
  await popover.getByRole("button", { name: "이 단계 화면으로 이동" }).click();
  await page.getByRole("button", { name: "목록에 추가" }).click();
  await page.getByRole("button", { name: "업로드", exact: true }).click();
  await expect(next).toBeEnabled();
  await next.click();
  await popover.getByRole("button", { name: "이 단계 화면으로 이동" }).click();
  const form = page.locator('[data-tour="s3-website-form"]');
  await expect(form).toHaveClass(/driver-active-element/);
  const before = (await form.boundingBox())!;
  await page.getByRole("switch", { name: "정적 웹 사이트 호스팅 활성화" }).click();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThan(before.height + 100);
  const formBox = (await form.boundingBox())!;
  const popBox = (await popover.boundingBox())!;
  const overlapX = Math.max(0, Math.min(formBox.x + formBox.width, popBox.x + popBox.width) - Math.max(formBox.x, popBox.x));
  const overlapY = Math.max(0, Math.min(formBox.y + formBox.height, popBox.y + popBox.height) - Math.max(formBox.y, popBox.y));
  expect(overlapX * overlapY).toBe(0);
  // driver.js의 강조 구멍(오버레이 경로)이 커진 양식 높이를 덮는다
  const stageHeight = () =>
    page.evaluate(() => {
      const d = document.querySelector(".driver-overlay path")?.getAttribute("d") ?? "";
      const m = /v([\d.]+)/.exec(d.split("M")[2] ?? "");
      return m ? Number(m[1]) : 0;
    });
  await expect.poll(stageHeight).toBeGreaterThan(formBox.height - 40);
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await expect(popover.locator(".pg-tour-status-done")).toBeVisible();
  await expect(popover).toContainText("③ 정적 웹 사이트 호스팅 켜기");
});

test("NAT 인스턴스 예시: 리소스 맵 범례·선택 강조, 프라이빗 서버의 외부 통신, 소스/대상 확인을 켜면 막히는 이유", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "완성된 예시 아키텍처 살펴보기" }).click();
  await page.getByRole("button", { name: "예시 열기" }).nth(3).click();
  await expect(page.getByTestId("resource-map")).toBeVisible();
  await expect(page.getByTestId("node-nat-instance")).toBeVisible();

  // 범례: 선 종류를 숨기면 선이 줄고, 리소스를 선택하면 나머지가 흐려진다
  const edges = page.locator(".react-flow__edge");
  const before = await edges.count();
  await page.getByTestId("map-legend").getByRole("button", { name: /보안 그룹/ }).click();
  await expect.poll(() => edges.count()).toBeLessThan(before);
  await page.getByTestId("map-legend").getByRole("button", { name: /보안 그룹/ }).click();
  await page.getByTestId("node-worker-1").click();
  await expect(page.locator('[data-focus="dim"]').first()).toBeVisible();
  await expect(page.getByTestId("node-worker-1")).toHaveAttribute("data-focus", "focus");

  // 프라이빗 서버 → 인터넷: NAT 인스턴스를 거쳐 성공
  await go(page, "#/vpc/reachability/create");
  await page.getByLabel("소스 유형").selectOption("ec2");
  const source = page.getByLabel("소스", { exact: true });
  await source.selectOption((await source.locator("option", { hasText: "worker-1" }).getAttribute("value"))!);
  await page.getByLabel("대상 유형").selectOption("internet");
  await page.getByRole("button", { name: "경로 생성 및 분석" }).click();
  await expect(page.getByTestId("analysis-outcome")).toHaveAttribute("data-outcome", "success");
  await expect(page.getByTestId("analysis-steps")).toContainText("MASQUERADE");
  const pathHash = await page.evaluate(() => window.location.hash);

  // 소스/대상 확인을 다시 켜면 같은 분석이 왜 막혔는지 알려 준다
  await go(page, "#/ec2/instances");
  await page.getByRole("row", { name: /nat-instance/ }).getByRole("link").first().click();
  await page.getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("menuitem", { name: "소스/대상 확인 변경" }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "소스/대상 확인 중지" }).uncheck();
  await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await go(page, pathHash);
  await page.getByRole("button", { name: "경로 분석", exact: true }).click();
  await expect(page.getByTestId("analysis-outcome")).toHaveAttribute("data-outcome", "failure");
  await expect(page.getByTestId("analysis-steps")).toContainText("소스/대상 확인");
});

test("학교 역할 템플릿: 네트워크 관리자로 로그인하면 VPC는 만들고 S3 버킷은 거부된다", async ({ page }) => {
  await createSandbox(page, "E2E 역할");
  await go(page, "#/iam/templates");
  await page.getByTestId("apply-role-templates").click();
  await page.getByTestId("template-sign-in-network-admin").click();
  await expect(page.getByTestId("identity-banner")).toContainText("net-admin");

  await go(page, "#/vpc/vpcs/create");
  await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.0.0.0/16");
  await page.getByLabel(/이름 태그/).fill("role-vpc");
  await page.getByRole("button", { name: "VPC 생성" }).click();
  await expect(page.getByRole("heading", { name: /vpc-.+ \/ role-vpc/, level: 1 })).toBeVisible();

  await go(page, "#/s3/create");
  await page.getByLabel("버킷 이름", { exact: true }).fill("school-data");
  await page.getByRole("button", { name: "버킷 만들기" }).click();
  await expect(page.getByText(/\[AccessDenied\].*s3:CreateBucket/).first()).toBeVisible();

  await page.getByRole("button", { name: "루트로 돌아가기" }).click();
  await expect(page.getByTestId("identity-banner")).toBeHidden();
});

test("NAT 인스턴스 튜토리얼: 안내대로 콘솔에서 따라 하면 모든 단계가 완료되고 프라이빗 서버가 밖으로 나간다", async ({ page }) => {
  test.slow();
  await createSandbox(page, "E2E NAT 튜토리얼");
  await buildPublicWebServer(page);

  await page.locator('[data-tour="tutorial-menu"]').click();
  await page.getByRole("menuitem", { name: /NAT 인스턴스로 비용 줄이기/ }).click();
  const popover = page.locator(".driver-popover");
  const next = page.locator(".driver-popover-next-btn");
  const moveToStep = async () => {
    const button = popover.getByRole("button", { name: "이 단계 화면으로 이동" });
    if (await button.isVisible()) await button.click();
  };
  const finishStep = async () => {
    await expect(popover.locator(".pg-tour-status-done")).toBeVisible();
    await next.click();
  };
  const selectByText = async (label: string, text: string) => {
    const select = page.getByLabel(label, { exact: true });
    await select.selectOption((await select.locator("option", { hasText: text }).getAttribute("value"))!);
  };

  // 퍼블릭 서브넷은 이미 있으므로 다음 할 일부터 시작한다
  await expect(popover).toContainText("①-1 프라이빗 서브넷 만들기");
  await moveToStep();
  await page.getByLabel("VPC ID").selectOption({ index: 1 });
  await page.getByLabel("서브넷 이름").fill("private-a");
  await page.getByLabel("가용 영역", { exact: true }).selectOption("ap-northeast-2a");
  await page.getByLabel(/IPv4 서브넷 CIDR 블록/).fill("10.0.11.0/24");
  await page.getByRole("button", { name: "서브넷 생성" }).click();
  await finishStep();

  // 기본 테이블에 IGW 경로가 있어 새 서브넷도 퍼블릭이다 → 프라이빗 테이블을 만들어 연결
  await expect(popover).toContainText("①-2 프라이빗 라우팅 테이블 연결");
  await expect(next).toBeDisabled();
  await moveToStep();
  await page.getByRole("textbox", { name: /^이름/ }).fill("private-rt");
  await page.getByLabel("VPC", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "라우팅 테이블 생성" }).click();
  await expect(page.getByRole("heading", { name: /rtb-.+ \/ private-rt/, level: 1 })).toBeVisible();
  await moveToStep();
  await page.getByRole("checkbox", { name: "private-a 선택" }).check();
  await page.getByRole("button", { name: "연결 저장" }).click();
  await finishStep();

  await expect(popover).toContainText("② NAT 인스턴스용 보안 그룹");
  await moveToStep();
  await page.getByLabel("보안 그룹 이름", { exact: true }).fill("nat-sg");
  await page.getByLabel("설명", { exact: true }).fill("NAT instance");
  await page.getByLabel("VPC", { exact: true }).selectOption({ index: 1 });
  const addRule = page.getByRole("button", { name: "규칙 추가", exact: true }).first();
  const inbound = page.getByRole("table", { name: "인바운드 규칙 편집" });
  await addRule.click();
  await inbound.getByLabel("규칙 1 유형").selectOption("http");
  await inbound.getByLabel("규칙 1 소스 CIDR").fill("10.0.11.0/24");
  await addRule.click();
  await inbound.getByLabel("규칙 2 유형").selectOption("https");
  await inbound.getByLabel("규칙 2 소스 CIDR").fill("10.0.11.0/24");
  await page.getByRole("button", { name: "보안 그룹 생성" }).click();
  await finishStep();

  await expect(popover).toContainText("③ NAT 인스턴스 시작하기");
  await moveToStep();
  await page.getByLabel("이름", { exact: true }).fill("nat-instance");
  await selectByText("서브넷", "public-a");
  await page.getByLabel("퍼블릭 IP 자동 할당").selectOption("enabled");
  await page.getByRole("radio", { name: "기존 보안 그룹 선택" }).check();
  await page.getByRole("group", { name: "보안 그룹 선택" }).getByRole("checkbox", { name: /nat-sg/ }).check();
  await page.getByRole("radio", { name: /NAT 인스턴스/ }).check();
  await page.getByRole("button", { name: "인스턴스 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: /인스턴스 요약.*nat-instance/, level: 1 })).toBeVisible();
  await expect(page.getByText("실행 중 (Running)").first()).toBeVisible({ timeout: 15_000 });
  await finishStep();

  await expect(popover).toContainText("④ 소스/대상 확인 중지");
  await moveToStep();
  await page.getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("menuitem", { name: "소스/대상 확인 변경" }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "소스/대상 확인 중지" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
  await finishStep();

  await expect(popover).toContainText("⑤ 프라이빗 경로");
  await moveToStep();
  await page.getByRole("button", { name: "라우팅 추가" }).click();
  await page.getByLabel("경로 1 대상 CIDR").fill("0.0.0.0/0");
  await selectByText("경로 1 대상 리소스", "nat-instance");
  await page.getByRole("button", { name: "변경 사항 저장" }).click();
  await finishStep();

  await expect(popover).toContainText("⑥ 프라이빗 서버 시작하기");
  await moveToStep();
  await page.getByLabel("이름", { exact: true }).fill("worker-1");
  await selectByText("서브넷", "private-a");
  await page.getByLabel("퍼블릭 IP 자동 할당").selectOption("disabled");
  await page.getByRole("button", { name: "인스턴스 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: /인스턴스 요약.*worker-1/, level: 1 })).toBeVisible();
  await expect(page.getByText("실행 중 (Running)").first()).toBeVisible({ timeout: 15_000 });
  await finishStep();

  await expect(popover).toContainText("⑦ 프라이빗 서버 → 인터넷 분석하기");
  await moveToStep();
  await page.getByLabel("소스 유형").selectOption("ec2");
  await selectByText("소스", "worker-1");
  await page.getByLabel("대상 유형").selectOption("internet");
  await page.getByLabel("대상 포트").fill("443");
  await page.getByRole("button", { name: "경로 생성 및 분석" }).click();
  await expect(page.getByTestId("analysis-outcome")).toHaveAttribute("data-outcome", "success");
  await expect(page.getByTestId("analysis-steps")).toContainText("MASQUERADE");
  await finishStep();

  await expect(popover).toContainText("⑧ 비용 비교하기");
  await moveToStep();
  await expect(page.getByTestId("nat-cost-comparison")).toContainText("지금 구성");
  await next.click();
  await expect(popover).toContainText("NAT 인스턴스를 직접 구성했습니다");
});
