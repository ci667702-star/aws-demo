"use client";

/**
 * 진행 중인 튜토리얼을 driver.js 팝업으로 보여 준다.
 * - 단계는 사용자가 '다음'을 눌러야만 넘어간다. 판정(isDone) 단계는 실제 설정이 맞으면 '완료'로 표시하고 '다음' 버튼을 켠다.
 * - 화면도 자동으로 옮기지 않는다. 다른 화면의 단계면 '이 단계 화면으로 이동' 버튼이나 왼쪽 메뉴로 사용자가 직접 이동한다.
 * - 튜토리얼 중에도 화면 전체를 그대로 쓸 수 있다(강조 영역 밖 클릭을 막지 않음).
 * - 강조 영역은 양식 크기·위치가 바뀌면 다시 계산하고, 팝업은 양식 옆에 공간이 있으면 옆에, 없으면 화면 왼쪽 아래에 붙여 양식을 가리지 않는다.
 */
import { driver, type Driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";
import { useEffect, useRef, useState } from "react";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { notify } from "../notify";
import { navigate, useHashLocation } from "../router";
import { resolveRoute } from "../routes";
import { serviceItemName } from "../service-names";
import { useTutorialStore } from "./tutorial-store";
import { resolveStepPath, tutorialById, type TutorialContext, type TutorialStep } from "./tutorials";

type Side = "top" | "right" | "bottom" | "left";

/** 팝업 자리: 대상 옆(anchored), 화면 왼쪽 아래(docked), 화면 가운데(center, 읽기만 하는 안내) */
type Placement = { mode: "center" } | { mode: "docked" } | { mode: "anchored"; side: Side; width?: number };

const SIDE_GAP = 24;
/** 콘솔 상단 메뉴(52px) 아래에서 팝업이 시작하게 한다 */
const HEADER_BOTTOM = 60;
const POPOVER_WIDTH = 380;
const MIN_SIDE_WIDTH = 270;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 화면에서 직접 무언가를 하는 단계 (양식 작성, 화면 살펴보기). 읽기만 하는 안내는 아님 */
function isPractice(step: TutorialStep): boolean {
  return !!(step.task || step.isDone || (step.target && step.path));
}

function placementFor(step: TutorialStep, element: Element | null): Placement {
  const practice = isPractice(step);
  if (!element) return practice ? { mode: "docked" } : { mode: "center" };
  if (!practice) return { mode: "anchored", side: step.side ?? "bottom" };
  const r = element.getBoundingClientRect();
  const space = { left: r.left - SIDE_GAP, right: window.innerWidth - r.right - SIDE_GAP };
  const order: ("left" | "right")[] = step.side === "right" ? ["right", "left"] : ["left", "right"];
  for (const side of order) {
    if (space[side] >= MIN_SIDE_WIDTH) return { mode: "anchored", side, width: Math.min(POPOVER_WIDTH, Math.floor(space[side])) };
  }
  // 낮은 대상은 위·아래에 둘 수 있다. 화면을 채우는 양식은 위에 덮지 않도록 화면 아래에 붙인다.
  if (r.height < window.innerHeight * 0.3) return { mode: "anchored", side: step.side === "top" ? "top" : "bottom" };
  return { mode: "docked" };
}

function samePlacement(a: Placement, b: Placement): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "anchored" && b.mode === "anchored") return a.side === b.side;
  return true;
}

interface ViewState {
  done: boolean;
  onRightPage: boolean;
  /** 이 단계 화면의 이동 경로 이름 (예: S3 › 범용 버킷 › my-site › 정적 웹 사이트 호스팅 편집) */
  pageLabel: string | null;
  expected: string | null;
  collapsed: boolean;
}

function describe(step: TutorialStep, s: ViewState): string {
  // 작업 단계에서는 행동 지침만 보여 설명과 할 일이 같은 화면에 중복되지 않게 한다.
  const parts = step.task ? [] : step.body.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (step.task) parts.push(`<div class="pg-tour-task"><strong>지금 할 일</strong><p>${escapeHtml(step.task)}</p></div>`);
  if (step.isDone) {
    parts.push(
      s.done
        ? `<div class="pg-tour-status pg-tour-status-done" role="status">✓ 완료 · 다음을 눌러 계속하세요.</div>`
        : `<div class="pg-tour-status" role="status">저장하면 완료 여부를 확인합니다.</div>`,
    );
  }
  if (s.expected && !s.onRightPage && !s.done) {
    const where = s.pageLabel ? `<strong>${escapeHtml(s.pageLabel)}</strong> 화면` : "다른 화면";
    parts.push(`<p class="pg-tour-note">이 단계는 ${where}에서 진행합니다. 아래 '이 단계 화면으로 이동'을 누르거나 왼쪽 메뉴에서 직접 찾아가세요.</p>`);
  }
  return parts.join("");
}

/** 팝업 내용·버튼을 현재 상태로 채운다 (단계 안에서 상태가 바뀌면 팝업을 다시 만들지 않고 이것만 다시 부른다) */
function decoratePopover(popover: PopoverDOM, step: TutorialStep, s: ViewState, placement: Placement | null, onToggleCollapse: () => void) {
  const store = useTutorialStore.getState();
  const current = store.active;
  const t = tutorialById(current?.tutorialId);
  if (!current || !t) return;
  const index = current.stepIndex;
  const total = t.steps.length;
  const isLast = index === total - 1;

  popover.description.innerHTML = describe(step, s);
  popover.progress.style.display = "block";
  popover.progress.textContent = `${t.title} · ${index + 1} / ${total}`;
  popover.previousButton.style.display = index === 0 ? "none" : "";

  // 할 일을 마치기 전에는 '다음'을 잠근다 (건너뛰기는 따로 있다)
  const locked = !!step.isDone && !s.done;
  popover.nextButton.textContent = isLast ? "마치기" : "다음";
  popover.nextButton.disabled = locked;
  popover.nextButton.classList.toggle("driver-popover-btn-disabled", locked);
  popover.nextButton.setAttribute("aria-disabled", String(locked));
  popover.nextButton.title = locked ? "할 일을 마치면 누를 수 있습니다" : "";

  popover.footerButtons.querySelectorAll(".pg-tour-extra").forEach((b) => b.remove());
  const practice = placement?.mode === "docked" || (placement?.mode === "anchored" && !!placement.width);
  if (practice) addButton(popover, s.collapsed ? "펼치기" : "접기", onToggleCollapse);
  if (locked && !isLast) addButton(popover, "건너뛰기", () => store.next());
  if (s.expected && !s.onRightPage && !s.done) addButton(popover, "이 단계 화면으로 이동", () => navigate(s.expected!), "primary");

  popover.wrapper.classList.toggle("pg-tour-docked", placement?.mode === "docked");
  popover.wrapper.classList.toggle("pg-tour-collapsed", practice && s.collapsed);
  if (placement?.mode === "anchored" && placement.width) {
    popover.wrapper.style.width = `${placement.width}px`;
    popover.wrapper.style.minWidth = "0";
    popover.wrapper.style.maxWidth = "none";
  } else {
    popover.wrapper.style.removeProperty("width");
    popover.wrapper.style.removeProperty("min-width");
    popover.wrapper.style.removeProperty("max-width");
  }
}

/**
 * driver.js가 자리를 잡은 뒤에 부른다.
 * - 대상 옆 팝업이 위로 스크롤되어 상단 메뉴를 덮지 않게 내린다.
 * - 화면 아래에 붙은 팝업만큼 페이지 아래에 여백을 두어, 양식 맨 아래 버튼도 팝업 위로 스크롤해 누를 수 있게 한다.
 */
function keepBelowHeader(popover: PopoverDOM | null, placement: Placement | null) {
  const body = document.body;
  if (popover && placement?.mode === "docked") {
    body.style.setProperty("--pg-tour-dock-space", `${Math.ceil(popover.wrapper.getBoundingClientRect().height) + 32}px`);
    body.classList.add("pg-tour-dock-space");
  } else {
    body.classList.remove("pg-tour-dock-space");
  }
  if (!popover || placement?.mode !== "anchored") return;
  const r = popover.wrapper.getBoundingClientRect();
  if (r.top >= HEADER_BOTTOM) return;
  popover.wrapper.style.top = `${Math.max(8, Math.min(HEADER_BOTTOM, window.innerHeight - r.height - 8))}px`;
  popover.wrapper.style.bottom = "auto";
}

function addButton(popover: PopoverDOM, label: string, onClick: () => void, kind: "primary" | "link" = "link") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.className = `pg-tour-extra pg-tour-btn ${kind === "primary" ? "pg-tour-btn-primary" : "pg-tour-btn-link"}`;
  btn.addEventListener("click", onClick);
  popover.footerButtons.prepend(btn);
}

export function TutorialHost() {
  const active = useTutorialStore((s) => s.active);
  const project = useProject();
  const { topology } = useAnalysis();
  const location = useHashLocation();
  const tutorial = tutorialById(active?.tutorialId);
  const step = tutorial && active ? tutorial.steps[active.stepIndex] : undefined;
  const ctx: TutorialContext = { project, topo: topology };
  const doneNow = !!step?.isDone?.(ctx);
  const expected = step ? resolveStepPath(step, ctx) : null;
  const expectedPath = expected ? expected.split("?")[0] : null;
  const onRightPage = !expectedPath || location.path === expectedPath;
  const stepKey = active ? `${active.tutorialId}:${active.stepIndex}` : null;
  // '접기'는 단계마다 처음에는 펼쳐 둔다
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const collapsed = !!stepKey && collapsedKey === stepKey;

  const pageLabel = (() => {
    if (!expectedPath) return null;
    const segments = expectedPath.split("/").filter(Boolean);
    const name = (text: string) =>
      text
        .split(" - ")
        .map((part) => serviceItemName(project, part) ?? project.resources.find((r) => r.id === part)?.name ?? part)
        .join(" › ");
    const crumbs = resolveRoute(segments).crumbs.map((c) => name(c.text));
    return crumbs.length ? crumbs.join(" › ") : null;
  })();

  const view: ViewState = { done: doneNow, onRightPage, pageLabel, expected, collapsed };
  // driver.js 콜백은 렌더링 밖에서 불리므로 최신 상태를 ref로 읽는다
  const viewRef = useRef(view);
  const stepRef = useRef(step);
  useEffect(() => {
    viewRef.current = view;
    stepRef.current = step;
  });

  const driverRef = useRef<Driver | null>(null);
  const popoverRef = useRef<PopoverDOM | null>(null);
  const placementRef = useRef<Placement | null>(null);

  // 마지막 단계를 넘기면 종료
  useEffect(() => {
    if (active && tutorial && active.stepIndex >= tutorial.steps.length) useTutorialStore.getState().stop();
    if (active && !tutorial) useTutorialStore.getState().stop();
  }, [active, tutorial]);

  // 할 일을 마치면 알려 주기만 한다 (다음 단계로는 사용자가 '다음'을 눌러 넘어간다)
  const entered = useRef<{ key: string; done: boolean } | null>(null);
  useEffect(() => {
    if (!step?.isDone || !stepKey) return;
    if (entered.current?.key !== stepKey) {
      entered.current = { key: stepKey, done: doneNow };
      return;
    }
    if (doneNow && !entered.current.done) {
      notify({ type: "success", title: `${step.title} 완료!`, description: "튜토리얼 팝업의 '다음'을 누르면 다음 단계로 넘어갑니다." });
    }
    entered.current.done = doneNow;
  }, [step, stepKey, doneNow]);

  // 튜토리얼 중에는 Tab 키로 강조 영역 밖(메뉴 등)으로도 이동할 수 있게 driver.js의 초점 가두기를 건너뛴다
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") e.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // 접기/펼치기 (단계가 바뀌면 다시 펼친 상태로 시작한다)
  const toggleCollapse = () => setCollapsedKey((k) => (k === stepKeyOf() ? null : stepKeyOf()));
  const toggleRef = useRef(toggleCollapse);
  useEffect(() => {
    toggleRef.current = toggleCollapse;
  });
  /** 효과·콜백 안에서만 부른다 (ref를 읽는다) */
  const decorate = (popover: PopoverDOM) => {
    const st = stepRef.current;
    if (st) decoratePopover(popover, st, viewRef.current, placementRef.current, () => toggleRef.current());
  };
  const decorateRef = useRef(decorate);
  useEffect(() => {
    decorateRef.current = decorate;
  });

  // 단계·화면이 바뀌면 팝업을 새로 만든다 (자동으로 다음 단계나 다른 화면으로 넘어가지 않는다)
  useEffect(() => {
    const body = document.body;
    const destroy = () => {
      driverRef.current?.destroy();
      driverRef.current = null;
      popoverRef.current = null;
      body.classList.remove("pg-tour-on", "pg-tour-spotlight", "pg-tour-dock-space");
    };
    const st = step;
    if (!tutorial || !st || !active) {
      destroy();
      return;
    }
    let cancelled = false;
    let element: Element | null = null;
    let firstShow = true;

    const show = () => {
      if (cancelled) return;
      // 같은 단계를 다시 그릴 때는 사용자가 입력하던 칸의 초점을 지킨다
      const focused = document.activeElement instanceof HTMLElement && !document.activeElement.closest(".driver-popover") ? document.activeElement : null;
      destroy();
      const placement = placementFor(st, element);
      placementRef.current = placement;
      const practice = isPractice(st);
      const overlayOpacity = placement.mode === "center" ? 0.5 : !element ? 0 : practice ? 0.58 : 0.48;
      body.classList.add("pg-tour-on");
      body.classList.toggle("pg-tour-spotlight", practice && !!element);
      const store = useTutorialStore.getState();
      const d = driver({
        animate: firstShow,
        allowClose: true,
        allowKeyboardControl: false,
        overlayOpacity,
        stagePadding: 10,
        stageRadius: 16,
        disableActiveInteraction: false,
        overlayClickBehavior: () => undefined,
        popoverClass: "pg-tour",
        showButtons: ["next", "previous", "close"],
        nextBtnText: "다음",
        prevBtnText: "이전",
        doneBtnText: "마치기",
        onNextClick: () => {
          const s = viewRef.current;
          const cur = stepRef.current;
          if (cur?.isDone && !s.done) return;
          const a = useTutorialStore.getState().active;
          const t = tutorialById(a?.tutorialId);
          if (a && t && a.stepIndex >= t.steps.length - 1) store.stop();
          else store.next();
        },
        onPrevClick: () => store.prev(),
        onCloseClick: () => store.stop(),
        onPopoverRender: (popover) => {
          popoverRef.current = popover;
          decorateRef.current(popover);
          // driver.js는 이 콜백 직후에 자리를 잡으므로 다음 프레임에 상단 메뉴와 겹치는지 확인한다
          requestAnimationFrame(() => keepBelowHeader(popoverRef.current, placementRef.current));
        },
      });
      driverRef.current = d;
      d.highlight({
        element: placement.mode === "center" ? undefined : (element ?? undefined),
        popover: {
          title: st.title,
          description: describe(st, viewRef.current),
          side: placement.mode === "anchored" ? placement.side : placement.mode === "docked" ? "left" : undefined,
          align: "start",
          // highlight()는 기본으로 버튼을 숨기므로 직접 지정한다
          showButtons: ["next", "previous", "close"],
          showProgress: true,
        },
      });
      firstShow = false;
      if (focused?.isConnected) focused.focus({ preventScroll: true });
    };

    // 양식이 커지거나(예: 호스팅을 켜면 입력란이 나타남) 화면 배치가 바뀌면 강조 영역과 팝업 자리를 다시 계산한다
    const reposition = () => {
      if (cancelled || !driverRef.current) return;
      const next = placementFor(st, element);
      const current = placementRef.current;
      if (current && samePlacement(next, current)) {
        placementRef.current = next;
        if (popoverRef.current) decorateRef.current(popoverRef.current);
        driverRef.current.refresh();
        requestAnimationFrame(() => keepBelowHeader(popoverRef.current, placementRef.current));
      } else {
        show();
      }
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reposition);
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    window.addEventListener("resize", schedule);
    // 스크롤하면 driver.js가 다음 프레임에 자리를 다시 잡으므로, 그 뒤에 상단 메뉴와 겹치지 않게 고친다
    const onScroll = () => requestAnimationFrame(() => keepBelowHeader(popoverRef.current, placementRef.current));
    window.addEventListener("scroll", onScroll, { passive: true });

    const start = () => {
      show();
      if (element) observer?.observe(element);
      observer?.observe(document.body);
    };

    if (onRightPage && st.target) {
      // 이전 화면의 강조가 남지 않게 먼저 지우고, 새 화면의 대상이 나타나면 다시 보여 준다
      destroy();
      const started = Date.now();
      const tick = () => {
        if (cancelled) return;
        element = document.querySelector(st.target!);
        if (element) start();
        else if (Date.now() - started < 4000) setTimeout(tick, 120);
        else start();
      };
      tick();
    } else {
      start();
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll);
    };
    // 상태(완료 여부, 접기)는 아래 효과에서 팝업 안만 고친다. 여기서는 단계·화면이 바뀔 때만 새로 만든다.
  }, [tutorial, step, active, location.path, onRightPage]);

  // 완료 여부·접기·이동할 화면이 바뀌면 팝업 내용만 고친다 (강조를 다시 하지 않아 스크롤이 튀지 않는다)
  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !driverRef.current) return;
    decorateRef.current(popover);
    driverRef.current.refresh();
    requestAnimationFrame(() => keepBelowHeader(popoverRef.current, placementRef.current));
  }, [doneNow, collapsed, expected, pageLabel]);

  // 콘솔을 떠나면 팝업 정리
  useEffect(
    () => () => {
      driverRef.current?.destroy();
      driverRef.current = null;
      document.body.classList.remove("pg-tour-on", "pg-tour-spotlight", "pg-tour-dock-space");
    },
    [],
  );

  return null;
}

function stepKeyOf(): string | null {
  const a = useTutorialStore.getState().active;
  return a ? `${a.tutorialId}:${a.stepIndex}` : null;
}
