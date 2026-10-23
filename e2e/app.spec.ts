import { expect, test, type Page } from "@playwright/test";

/** 첫 화면에서 빈 샌드박스를 만들고 콘솔 홈으로 이동한다 */
async function createSandbox(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "샌드박스 생성" }).first().click();
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
  await page.getByLabel("가용 영역").selectOption("ap-northeast-2a");
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
  await page.getByLabel("서브넷").selectOption({ index: 1 });
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
  await expect(page.getByText(/제휴하지 않은 독립 프로젝트/)).toBeVisible();
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
  await page.getByLabel("버킷 이름").fill("e2e-site-2026");
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
