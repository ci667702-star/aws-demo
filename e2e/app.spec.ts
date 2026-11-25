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

/** 튜토리얼 안내 패널을 다루는 도우미. 양식은 본문(main) 안에서만 찾는다 (패널의 할 일 목록에도 같은 이름이 나오므로) */
function tutorial(page: Page) {
  const panel = page.getByTestId("tutorial-panel");
  const next = page.getByTestId("tutorial-next");
  const main = page.locator("#console-main");
  return {
    panel,
    next,
    main,
    /** 상단 '튜토리얼' 메뉴에서 시작한다 */
    start: async (name: RegExp) => {
      await page.locator('[data-tour="tutorial-menu"]').click();
      await page.getByRole("menuitem", { name }).click();
      await expect(panel).toBeVisible();
    },
    /** 지금 단계의 제목 */
    expectStep: async (title: string | RegExp) => {
      await expect(panel.getByRole("heading", { level: 3 })).toContainText(title);
    },
    /** 다른 화면의 단계면 '이 화면으로 이동'을 누른다 (이미 그 화면이면 버튼이 없다) */
    moveToStep: async () => {
      const button = page.getByTestId("tutorial-go");
      if (await button.isVisible()) await button.click();
    },
    expectDone: async () => {
      await expect(page.getByTestId("tutorial-status")).toHaveAttribute("data-done", "true");
    },
    /** 할 일을 마친 것을 확인하고 다음 단계로 */
    finishStep: async () => {
      await expect(page.getByTestId("tutorial-status")).toHaveAttribute("data-done", "true");
      await next.click();
    },
  };
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

test("튜토리얼은 '다음'을 눌러야 넘어가고, 화면도 자동으로 바뀌지 않으며, 안내 패널이 양식을 가리지 않고 강조가 양식 크기를 따라간다", async ({ page }) => {
  await createSandbox(page, "E2E 튜토리얼");
  const t = tutorial(page);
  await t.start(/S3로 정적 웹 사이트 공개하기/);
  await t.next.click();

  // ① 버킷 만들기: 할 일을 마치기 전에는 '다음'이 잠겨 있고, 화면은 그대로다
  await t.expectStep("① 버킷 만들기");
  await expect(t.next).toBeDisabled();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("tutorial-where")).toContainText("버킷 만들기");
  await t.moveToStep();
  await expect(page).toHaveURL(/#\/s3\/create$/);
  // 할 일 목록의 값은 복사해서 쓸 수 있다
  await expect(page.getByTestId("tutorial-todo")).toContainText("버킷 이름");
  await t.main.getByLabel("버킷 이름", { exact: true }).fill("e2e-tour-2026");
  await t.main.getByRole("button", { name: "버킷 만들기", exact: true }).click();
  await expect(t.main.getByRole("heading", { name: "e2e-tour-2026", level: 1 })).toBeVisible();

  // 완료되어도 자동으로 넘어가지 않는다
  await t.expectDone();
  await page.waitForTimeout(1500);
  await t.expectStep("① 버킷 만들기");
  await expect(t.next).toBeEnabled();
  const bucketPath = new URL(page.url()).hash.split("?")[0];
  await t.next.click();
  await t.expectStep("② index.html 올리기");
  expect(new URL(page.url()).hash.split("?")[0]).toBe(bucketPath);

  // 튜토리얼 중에도 화면의 다른 메뉴를 그대로 쓸 수 있다
  await page.getByRole("link", { name: "콘솔 홈" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await t.expectStep("② index.html 올리기");

  // ② 업로드 → ③ 호스팅: 스위치를 켜 양식이 커져도 강조가 따라가고, 안내 패널은 양식을 가리지 않는다
  await t.moveToStep();
  await t.main.getByRole("button", { name: "목록에 추가" }).click();
  await t.main.getByRole("button", { name: "업로드", exact: true }).click();
  await expect(t.next).toBeEnabled();
  await t.next.click();
  await t.moveToStep();
  const form = page.locator('[data-tour="s3-website-form"]');
  await expect(form).toHaveAttribute("data-tour-active", "");
  const ring = page.getByTestId("tutorial-spotlight").locator("rect.pg-spot-ring").first();
  const before = (await form.boundingBox())!;
  await t.main.getByRole("switch", { name: "정적 웹 사이트 호스팅 활성화" }).click();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThan(before.height + 100);
  const formBox = (await form.boundingBox())!;
  const panelBox = (await t.panel.boundingBox())!;
  const overlapX = Math.max(0, Math.min(formBox.x + formBox.width, panelBox.x + panelBox.width) - Math.max(formBox.x, panelBox.x));
  const overlapY = Math.max(0, Math.min(formBox.y + formBox.height, panelBox.y + panelBox.height) - Math.max(formBox.y, panelBox.y));
  expect(overlapX * overlapY).toBe(0);
  // 강조 테두리가 커진 양식 전체를 두른다
  await expect.poll(async () => Number(await ring.getAttribute("height"))).toBeGreaterThan(formBox.height);
  await t.main.getByRole("button", { name: "변경 사항 저장" }).click();
  await t.expectDone();
  await t.expectStep("③ 정적 웹 사이트 호스팅 켜기");

  // 새로고침해도 하던 단계에서 이어진다
  await page.reload();
  await t.expectStep("③ 정적 웹 사이트 호스팅 켜기");
  // 안내를 접었다가 다시 열 수 있다
  await page.getByRole("button", { name: "안내 접기" }).click();
  await expect(t.panel).toBeHidden();
  await page.getByTestId("tutorial-chip").click();
  await t.expectStep("③ 정적 웹 사이트 호스팅 켜기");
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

  const t = tutorial(page);
  const { main } = t;
  await t.start(/NAT 인스턴스로 비용 줄이기/);
  const selectByText = async (label: string, text: string) => {
    const select = main.getByLabel(label, { exact: true });
    await select.selectOption((await select.locator("option", { hasText: text }).getAttribute("value"))!);
  };

  // 퍼블릭 서브넷은 이미 있으므로 다음 할 일부터 시작한다
  await t.expectStep("①-1 프라이빗 서브넷 만들기");
  await t.moveToStep();
  await main.getByLabel("VPC ID").selectOption({ index: 1 });
  await main.getByLabel("서브넷 이름").fill("private-a");
  await main.getByLabel("가용 영역", { exact: true }).selectOption("ap-northeast-2a");
  await main.getByLabel(/IPv4 서브넷 CIDR 블록/).fill("10.0.11.0/24");
  await main.getByRole("button", { name: "서브넷 생성" }).click();
  await t.finishStep();

  // 기본 테이블에 IGW 경로가 있어 새 서브넷도 퍼블릭이다 → 프라이빗 테이블을 만들어 연결
  await t.expectStep("①-2 프라이빗 라우팅 테이블 연결");
  await expect(t.next).toBeDisabled();
  await t.moveToStep();
  await main.getByRole("textbox", { name: /^이름/ }).fill("private-rt");
  await main.getByLabel("VPC", { exact: true }).selectOption({ index: 1 });
  await main.getByRole("button", { name: "라우팅 테이블 생성" }).click();
  await expect(main.getByRole("heading", { name: /rtb-.+ \/ private-rt/, level: 1 })).toBeVisible();
  await t.moveToStep();
  await main.getByRole("checkbox", { name: "private-a 선택" }).check();
  await main.getByRole("button", { name: "연결 저장" }).click();
  await t.finishStep();

  await t.expectStep("② NAT 인스턴스용 보안 그룹");
  await t.moveToStep();
  await main.getByLabel("보안 그룹 이름", { exact: true }).fill("nat-sg");
  await main.getByLabel("설명", { exact: true }).fill("NAT instance");
  await main.getByLabel("VPC", { exact: true }).selectOption({ index: 1 });
  const addRule = main.getByRole("button", { name: "규칙 추가", exact: true }).first();
  const inbound = main.getByRole("table", { name: "인바운드 규칙 편집" });
  await addRule.click();
  await inbound.getByLabel("규칙 1 유형").selectOption("http");
  await inbound.getByLabel("규칙 1 소스 CIDR").fill("10.0.11.0/24");
  await addRule.click();
  await inbound.getByLabel("규칙 2 유형").selectOption("https");
  await inbound.getByLabel("규칙 2 소스 CIDR").fill("10.0.11.0/24");
  await main.getByRole("button", { name: "보안 그룹 생성" }).click();
  await t.finishStep();

  await t.expectStep("③ NAT 인스턴스 시작하기");
  await t.moveToStep();
  await main.getByLabel("이름", { exact: true }).fill("nat-instance");
  await selectByText("서브넷", "public-a");
  await main.getByLabel("퍼블릭 IP 자동 할당").selectOption("enabled");
  await main.getByRole("radio", { name: "기존 보안 그룹 선택" }).check();
  await main.getByRole("group", { name: "보안 그룹 선택" }).getByRole("checkbox", { name: /nat-sg/ }).check();
  await main.getByRole("radio", { name: /NAT 인스턴스/ }).check();
  await main.getByRole("button", { name: "인스턴스 시작", exact: true }).click();
  await expect(main.getByRole("heading", { name: /인스턴스 요약.*nat-instance/, level: 1 })).toBeVisible();
  await expect(main.getByText("실행 중 (Running)").first()).toBeVisible({ timeout: 15_000 });
  await t.finishStep();

  await t.expectStep("④ 소스/대상 확인 중지");
  await t.moveToStep();
  await main.getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("menuitem", { name: "소스/대상 확인 변경" }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "소스/대상 확인 중지" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
  await t.finishStep();

  await t.expectStep("⑤ 프라이빗 경로");
  await t.moveToStep();
  await main.getByRole("button", { name: "라우팅 추가" }).click();
  await main.getByLabel("경로 1 대상 CIDR").fill("0.0.0.0/0");
  await selectByText("경로 1 대상 리소스", "nat-instance");
  await main.getByRole("button", { name: "변경 사항 저장" }).click();
  await t.finishStep();

  await t.expectStep("⑥ 프라이빗 서버 시작하기");
  await t.moveToStep();
  await main.getByLabel("이름", { exact: true }).fill("worker-1");
  await selectByText("서브넷", "private-a");
  await main.getByLabel("퍼블릭 IP 자동 할당").selectOption("disabled");
  await main.getByRole("button", { name: "인스턴스 시작", exact: true }).click();
  await expect(main.getByRole("heading", { name: /인스턴스 요약.*worker-1/, level: 1 })).toBeVisible();
  await expect(main.getByText("실행 중 (Running)").first()).toBeVisible({ timeout: 15_000 });
  await t.finishStep();

  await t.expectStep("⑦ 프라이빗 서버 → 인터넷 분석하기");
  await t.moveToStep();
  await main.getByLabel("소스 유형").selectOption("ec2");
  await selectByText("소스", "worker-1");
  await main.getByLabel("대상 유형").selectOption("internet");
  await main.getByLabel("대상 포트").fill("443");
  await main.getByRole("button", { name: "경로 생성 및 분석" }).click();
  await expect(page.getByTestId("analysis-outcome")).toHaveAttribute("data-outcome", "success");
  await expect(page.getByTestId("analysis-steps")).toContainText("MASQUERADE");
  await t.finishStep();

  await t.expectStep("⑧ 비용 비교하기");
  await t.moveToStep();
  await expect(page.getByTestId("nat-cost-comparison")).toContainText("지금 구성");
  await t.next.click();
  await t.expectStep("NAT 인스턴스를 직접 구성했습니다");
});

test("Lambda 튜토리얼: 함수를 만들어 테스트하고, 일정으로 호출되게 연결한 뒤 오류 경보를 만든다", async ({ page }) => {
  test.slow();
  await createSandbox(page, "E2E Lambda");
  const t = tutorial(page);
  const { main } = t;
  await t.start(/Lambda를 일정에 따라 실행하기/);

  await t.expectStep("무엇을 만들까요?");
  await t.next.click();

  // ① 함수 만들기 (새 실행 역할과 함께)
  await t.expectStep("① 함수 만들기");
  await expect(t.next).toBeDisabled();
  await t.moveToStep();
  await main.getByRole("textbox", { name: "함수 이름" }).fill("health-check");
  await main.getByRole("radio", { name: /외부 API 호출/ }).check();
  await main.getByRole("button", { name: "함수 생성" }).click();
  await expect(main.getByRole("heading", { name: "health-check", level: 1 })).toBeVisible();
  await t.finishStep();

  // ② 테스트 호출: 결과와 REPORT 로그
  // 함수를 만든 직후에는 이미 함수 화면(코드 탭)에 있으므로, 안내대로 테스트 탭을 연다
  await t.expectStep("② 테스트 호출하기");
  await t.moveToStep();
  await main.getByRole("tab", { name: "테스트" }).click();
  await main.getByTestId("lambda-test").click();
  await expect(main.getByTestId("lambda-result")).toContainText("성공");
  await expect(main.getByText(/REPORT RequestId:/)).toBeVisible();
  await t.next.click();

  // ③ 일정 만들기 (새 실행 역할)
  await t.expectStep("③ 일정 만들기");
  await t.moveToStep();
  await main.getByRole("textbox", { name: "일정 이름" }).fill("health-every-minute");
  await main.getByRole("textbox", { name: "일정 표현식" }).fill("rate(1 minute)");
  await expect(main.getByText("1분마다 (Asia/Seoul)")).toBeVisible();
  await main.getByRole("button", { name: "일정 생성" }).click();
  await expect(main.getByTestId("schedule-invoke")).toContainText("Scheduler가 함수를 호출할 수 있음");
  await t.finishStep();

  await t.expectStep("④ 다음 실행 시각 확인");
  await t.next.click();
  await t.expectStep("⑤ 지표 확인");
  await t.moveToStep();
  await expect(main.getByText("지표 (가상)")).toBeVisible();
  await t.next.click();

  // ⑥ Errors > 0 경보
  await t.expectStep("⑥ 오류 경보 만들기");
  await t.moveToStep();
  await expect(main.getByLabel("지표 이름", { exact: true })).toHaveValue("Errors");
  const wizardNext = main.getByRole("button", { name: "다음", exact: true });
  const alarmName = main.getByLabel("경보 이름", { exact: true });
  for (let i = 0; i < 3 && !(await alarmName.isVisible()); i++) await wizardNext.click();
  await alarmName.fill("health-check-errors");
  const create = main.getByRole("button", { name: "경보 생성" });
  for (let i = 0; i < 3 && !(await create.isVisible()); i++) await wizardNext.click();
  await create.click();
  await t.finishStep();
  await t.expectStep("일정에 따라 실행되는 서버리스 함수를 만들었습니다");
});

test("서버리스 예시: 세 함수가 모두 성공하고, 테스트 이벤트가 EC2 중지 규칙과 일치한다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "완성된 예시 아키텍처 살펴보기" }).click();
  await page.getByRole("button", { name: "예시 열기" }).nth(4).click();
  await expect(page.getByTestId("resource-map")).toBeVisible();
  await expect(page.getByTestId("node-attendance-report")).toBeVisible();

  await go(page, "#/lambda/functions");
  const table = page.getByRole("table", { name: "함수 목록" });
  await expect(table).toContainText("attendance-report");
  await expect(table.getByText("성공", { exact: true })).toHaveCount(3);

  await go(page, "#/eventbridge/send-event");
  await page.getByTestId("send-test-event").click();
  const delivery = page.getByTestId("delivery-ec2-stopped");
  await expect(delivery).toContainText("일치");
  await expect(delivery).toContainText("detail.state");
});

test("CloudFront·Secrets Manager·Parameter Store: 비공개 버킷을 OAC로 배포해 캐시를 확인하고, 값 입력 없이 보안 암호와 파라미터를 만든다", async ({ page }) => {
  await createSandbox(page, "E2E 플랫폼 서비스");

  // S3: 비공개 버킷에 index.html
  await go(page, "#/s3/create");
  await page.getByLabel("버킷 이름", { exact: true }).fill("e2e-cdn-2026");
  await page.getByRole("button", { name: "버킷 만들기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "e2e-cdn-2026", level: 1 })).toBeVisible();
  const bucketPath = new URL(page.url()).hash.split("?")[0];
  await go(page, `${bucketPath}/upload`);
  await page.getByRole("button", { name: "목록에 추가" }).click();
  await page.getByRole("button", { name: "업로드", exact: true }).click();
  await expect(page.getByRole("table", { name: "객체 목록" })).toContainText("index.html");

  // CloudFront: 양식 기본값(첫 버킷, OAC, 기본 루트 객체 index.html)으로 배포 → 버킷 정책 경고 → 정책 추가
  await go(page, "#/cloudfront/distributions/create");
  await page.getByRole("button", { name: "배포 생성" }).click();
  await expect(page.getByText("S3 버킷 정책을 업데이트해야 합니다")).toBeVisible();
  await expect(page.getByTestId("distribution-health")).toHaveAttribute("data-ok", "false");
  await page.getByRole("button", { name: "원본 탭으로" }).click();
  await page.getByRole("button", { name: "버킷 정책에 추가" }).click();
  await expect(page.locator("[data-testid^='origin-check-']")).toHaveAttribute("data-type", "success");

  // 배포가 끝나면(Deployed) 요청 테스트: 첫 요청은 원본(Miss), 두 번째는 엣지 캐시(Hit)
  await page.getByRole("tab", { name: "일반" }).click();
  await expect(page.getByTestId("distribution-health")).toHaveAttribute("data-ok", "true");
  await expect(page.getByText("배포 중", { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole("tab", { name: "요청 테스트" }).click();
  await page.getByTestId("cf-send").click();
  await expect(page.getByTestId("cf-response").first()).toHaveAttribute("data-xcache", "Miss from cloudfront");
  await page.getByTestId("cf-send").click();
  await expect(page.getByTestId("cf-response").first()).toHaveAttribute("data-xcache", "Hit from cloudfront");

  // Secrets Manager: 키 이름만 입력 → 값 검색은 연습용 가상 값
  await go(page, "#/secretsmanager/secrets/create");
  await page.getByRole("textbox", { name: "키 1" }).fill("api_key");
  await page.getByRole("textbox", { name: "보안 암호 이름" }).fill("prod/e2e/api");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("heading", { name: "prod/e2e/api", level: 1 })).toBeVisible();
  await page.getByTestId("secret-retrieve").click();
  await expect(page.getByTestId("secret-value")).toContainText(/PGSIM-/);

  // Parameter Store: 기본값으로 파라미터 생성
  await go(page, "#/ssm/parameters/create");
  await page.getByRole("button", { name: "파라미터 생성" }).click();
  await expect(page.getByTestId("parameter-value")).toHaveText("db.internal.example");
});
