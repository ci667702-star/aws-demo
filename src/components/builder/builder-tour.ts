"use client";

/** 쉬운 모드(그림 빌더) 둘러보기 — driver.js 단계 팝업 */
import { driver } from "driver.js";
import "driver.js/dist/driver.css";

const steps = [
  {
    title: "쉬운 모드에 오신 것을 환영합니다",
    description:
      "<p>리소스를 그림으로 놓고 선으로 연결해 아키텍처를 설계하는 화면입니다. 새 리소스에는 기본값이 자동으로 채워져서 처음 배울 때 편합니다.</p><p>중요한 부분을 차례로 보여 드릴게요.</p>",
  },
  {
    element: '[data-testid="palette"]',
    title: "① 리소스 팔레트",
    description: "<p>VPC, 서브넷, EC2 같은 리소스를 클릭하거나 캔버스로 끌어다 놓아 추가합니다. VPC나 서브넷 영역 위에 놓으면 자동으로 그 안에 연결됩니다.</p>",
    side: "right" as const,
  },
  {
    element: ".react-flow",
    title: "② 캔버스",
    description: "<p>리소스를 끌어서 옮길 수 있습니다. 한 리소스의 아래쪽 점을 다른 리소스의 위쪽 점으로 끌면 관계(연결)가 만들어집니다. 예: 라우팅 테이블 → 인터넷 게이트웨이 = 0.0.0.0/0 경로</p>",
    side: "bottom" as const,
  },
  {
    element: '[data-testid="inspector"]',
    title: "③ 설정 패널",
    description: "<p>선택한 리소스의 설정(CIDR, 보안 그룹 규칙, 퍼블릭 IP 등)을 바꾸고, 연결된 리소스와 검증 결과를 확인합니다.</p>",
    side: "left" as const,
  },
  {
    element: '[data-testid="tab-validation"]',
    title: "④ 검증 센터",
    description: "<p>설정 실수를 규칙으로 찾아 줍니다. 오류는 통신이 확실히 실패하는 설정, 경고는 위험하거나 의도와 다를 수 있는 설정입니다.</p>",
    side: "top" as const,
  },
  {
    element: '[data-testid="tab-simulation"]',
    title: "⑤ 시뮬레이션",
    description: "<p>인터넷 → 서버처럼 출발지와 목적지를 고르면 가상 패킷이 어디를 지나고 어디서 막히는지 단계별로 보여 줍니다.</p>",
    side: "top" as const,
  },
  {
    element: '[data-testid="tab-lab"]',
    title: "⑥ Guided Lab",
    description: "<p>목표가 주어지는 실습입니다. 설정이 맞으면 단계가 자동으로 완료됩니다.</p>",
    side: "top" as const,
  },
  {
    element: '[data-testid="open-console-mode"]',
    title: "⑦ 심화 모드",
    description: "<p>같은 샌드박스를 AWS 콘솔처럼 메뉴와 양식으로 직접 설정하는 심화 모드로 바꿀 수 있습니다. IAM, S3, CloudWatch는 심화 모드에서 다룹니다.</p>",
    side: "bottom" as const,
  },
];

export function startBuilderTour() {
  const d = driver({
    popoverClass: "pg-tour",
    showProgress: true,
    progressText: "쉬운 모드 둘러보기 · {{current}} / {{total}}",
    nextBtnText: "다음",
    prevBtnText: "이전",
    doneBtnText: "마치기",
    allowKeyboardControl: true,
    overlayOpacity: 0.45,
    stagePadding: 8,
    stageRadius: 12,
    skipMissingElement: true,
    steps: steps.map((s) => ({
      element: "element" in s ? s.element : undefined,
      popover: { title: s.title, description: s.description, side: "side" in s ? s.side : undefined, align: "start" as const },
    })),
  });
  d.drive();
}
