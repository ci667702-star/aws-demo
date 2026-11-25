"use client";

/**
 * 진행 중인 튜토리얼의 현재 상태 (안내 패널과 화면 강조가 함께 쓴다).
 * 완료 여부는 저장하지 않고 이 샌드박스의 실제 설정으로 매번 판정한다.
 */
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { useHashLocation } from "../router";
import { resolveRoute } from "../routes";
import { serviceItemName } from "../service-names";
import { activeNavItem } from "../shell/navigation";
import { useTutorialStore, type ActiveTutorial } from "./tutorial-store";
import { resolveStepPath, tutorialById, type Tutorial, type TutorialContext, type TutorialStep, type TutorialTodo } from "./tutorials";

/** 이 샌드박스에서 진행 중인 튜토리얼 (다른 샌드박스의 진행 상태는 보이지 않는다) */
export function useActiveTutorial(): ActiveTutorial | null {
  const projectId = useConsoleProjectId();
  return useTutorialStore((s) => (s.projectId === projectId ? s.active : null));
}

export interface TutorialView {
  tutorial: Tutorial;
  step: TutorialStep;
  index: number;
  total: number;
  isLast: boolean;
  /** 판정 단계가 지금 완료 상태인지 */
  done: boolean;
  /** 판정 단계인데 아직 완료 전 ('다음'이 잠긴다) */
  locked: boolean;
  /** 이 단계의 화면 (쿼리 포함). 없으면 어느 화면에서든 진행 */
  expected: string | null;
  expectedPath: string | null;
  onRightPage: boolean;
  /** 이 단계 화면의 이동 경로 이름 (예: S3 › 범용 버킷 › my-site › 정적 웹 사이트 호스팅 편집) */
  pageLabel: string | null;
  /** 화면 경로가 앞 단계의 결과에 달려 있는데 아직 정해지지 않음 (앞 단계를 먼저 해야 함) */
  needsEarlierStep: boolean;
  /** 단계별 완료 상태 (목록 표시용). 판정이 없는 단계는 null */
  stepStates: (boolean | null)[];
}

export function useTutorialView(): TutorialView | null {
  const active = useActiveTutorial();
  const project = useProject();
  const { topology } = useAnalysis();
  const location = useHashLocation();
  const tutorial = tutorialById(active?.tutorialId);
  if (!active || !tutorial) return null;
  const index = Math.min(Math.max(active.stepIndex, 0), tutorial.steps.length - 1);
  const step = tutorial.steps[index];
  const ctx: TutorialContext = { project, topo: topology };
  const stepStates = tutorial.steps.map((s) => (s.isDone ? !!s.isDone(ctx) : null));
  const done = stepStates[index] === true;
  const expected = resolveStepPath(step, ctx);
  const expectedPath = expected ? expected.split("?")[0] : null;
  const onRightPage = !expectedPath || location.path === expectedPath;

  let pageLabel: string | null = null;
  if (expectedPath) {
    const name = (text: string) =>
      text
        .split(" - ")
        .map((part) => serviceItemName(project, part) ?? project.resources.find((r) => r.id === part)?.name ?? part)
        .join(" › ");
    const crumbs = resolveRoute(expectedPath.split("/").filter(Boolean)).crumbs.map((c) => name(c.text));
    pageLabel = crumbs.length ? crumbs.join(" › ") : null;
  }

  return {
    tutorial,
    step,
    index,
    total: tutorial.steps.length,
    isLast: index === tutorial.steps.length - 1,
    done,
    locked: !!step.isDone && !done,
    expected,
    expectedPath,
    onRightPage,
    pageLabel,
    needsEarlierStep: typeof step.path === "function" && expected === null && !done,
    stepStates,
  };
}

// ---------------------------------------------------------------- 화면에서 찾기

/** 화면에 그려진 요소인지 (display: none이거나 접힌 영역 안이면 false). 레이아웃을 계산하지 않는 환경에서는 문서에 있으면 된다 */
export function isShown(el: Element): boolean {
  if (!el.isConnected) return false;
  const hasLayout = document.documentElement.getClientRects().length > 0;
  return !hasLayout || el.getClientRects().length > 0;
}

/** 이 단계에서 밝게 표시할 요소: 단계 화면에서는 작업할 곳, 다른 화면에서는 그 화면으로 가는 메뉴·링크 */
export function resolveSpotlightTargets(view: TutorialView, currentPath: string): { elements: Element[]; kind: "work" | "hop" } {
  const { step } = view;
  if (view.onRightPage) {
    // 완료한 판정 단계는 더 표시하지 않는다 (패널의 '다음'으로 눈이 가게)
    if (!step.target || (step.isDone && view.done)) return { elements: [], kind: "work" };
    return { elements: [...document.querySelectorAll(step.target)].filter(isShown), kind: "work" };
  }
  if (view.done || !view.expectedPath) return { elements: [], kind: "hop" };
  const hop = findNextHop(view.expectedPath, currentPath);
  return { elements: hop ? [hop] : [], kind: "hop" };
}

const pathOfHref = (href: string | null): string | null => {
  if (!href || !href.startsWith("#")) return null;
  const raw = href.slice(1).split("?")[0];
  try {
    return decodeURI(raw) || "/";
  } catch {
    return raw || "/";
  }
};

/**
 * 이 단계의 화면으로 가려면 지금 눌러야 할 곳을 찾는다 (직접 찾아가는 연습을 돕는다).
 * 1) 지금 화면 안에 그 화면으로 가는 링크가 있으면 그 링크 (예: 목록의 '서브넷 생성')
 * 2) 없으면 왼쪽 메뉴에서 그 화면이 속한 항목 (묶음이 접혀 있으면 묶음 제목)
 */
export function findNextHop(expectedPath: string, currentPath: string): Element | null {
  const main = document.getElementById("console-main");
  const direct = [...(main?.querySelectorAll("a[href]") ?? [])].find((a) => pathOfHref(a.getAttribute("href")) === expectedPath && isShown(a));
  if (direct) return direct;
  const nav = document.querySelector('[data-tour="side-nav"]');
  const target = activeNavItem(expectedPath);
  if (!nav || !target || target.item.path === currentPath) return null;
  const link = [...nav.querySelectorAll("a[href]")].find((a) => pathOfHref(a.getAttribute("href")) === target.item.path);
  return link ?? nav.querySelector(`[data-nav-group="${target.group.id}"]`);
}

const textOf = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** 레이블 자체의 글자 ('- 선택 사항' 같은 덧붙인 표시는 뺀다) */
function ownText(el: Element): string {
  const direct = [...el.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return direct || textOf(el);
}

/** 레이블이 가리키는 입력 묶음 (설정 도움말이 쓰는 data-field 영역, 없으면 레이블을 감싼 영역) */
const fieldOf = (label: Element) => (label.closest("[data-field]") as HTMLElement | null) ?? (label.parentElement?.parentElement as HTMLElement | null) ?? (label as HTMLElement);

/**
 * 할 일의 이름으로 화면의 입력란·버튼을 찾는다 (없으면 null).
 * 이름이 정확히 같은 것을 먼저 찾고(예: 'IPv4 CIDR'과 'IPv4 CIDR 블록' 구분), 없을 때만 그 이름으로 시작하는 것을 찾는다.
 */
export function locateTodo(todo: TutorialTodo, roots: Element[]): HTMLElement | null {
  const name = (todo.find ?? todo.label).trim();
  const scopes: ParentNode[] = roots.length ? roots : [document.getElementById("console-main") ?? document.body];
  const esc = name.replace(/["\\]/g, "\\$&");
  const shown = <T extends Element>(list: Iterable<T>) => [...list].filter(isShown);
  for (const root of scopes) {
    const labels = shown(root.querySelectorAll("label"));
    const controls = shown(root.querySelectorAll("button, [role=tab], a, [role=menuitem], [role=switch]"));
    // 1) 이름이 정확히 같은 입력란(aria-label) · 레이블 · 버튼
    const ariaExact = shown(root.querySelectorAll<HTMLElement>(`[aria-label="${esc}"]`))[0];
    if (ariaExact) return ariaExact;
    const labelExact = labels.find((l) => ownText(l) === name);
    if (labelExact) return fieldOf(labelExact);
    const controlExact = controls.find((b) => textOf(b) === name);
    if (controlExact) return controlExact as HTMLElement;
    // 2) 그 이름으로 시작하는 레이블 · 입력란 (예: '확인하려면 필드에 …')
    const labelPrefix = labels.find((l) => textOf(l).startsWith(name));
    if (labelPrefix) return fieldOf(labelPrefix);
    const ariaPrefix = shown(root.querySelectorAll<HTMLElement>(`[aria-label^="${esc}"]`))[0];
    if (ariaPrefix) return ariaPrefix;
  }
  return null;
}

/** 요소를 화면 가운데로 옮기고 잠깐 강조한다 (설정 도움말의 '설정으로 이동'과 같은 표시) */
export function flashElement(el: HTMLElement) {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  el.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  el.removeAttribute("data-field-flash");
  void el.offsetWidth; // 같은 항목을 다시 눌러도 애니메이션이 처음부터 재생되게 한다
  el.setAttribute("data-field-flash", "");
  window.setTimeout(() => el.removeAttribute("data-field-flash"), 1800);
}
