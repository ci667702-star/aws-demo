"use client";

/**
 * 진행 중인 튜토리얼을 driver.js 팝업으로 보여 준다.
 * - 판정(isDone) 단계: 실제 설정이 맞으면 자동으로 다음 단계로 넘어간다.
 * - 단계마다 해당 화면으로 이동하고, 양식이 나타나면 그 부분을 강조한다.
 */
import { driver, type Driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";
import { useEffect, useEffectEvent, useRef } from "react";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { notify } from "../notify";
import { navigate, useHashLocation } from "../router";
import { useTutorialStore } from "./tutorial-store";
import { resolveStepPath, tutorialById, type TutorialContext, type TutorialStep } from "./tutorials";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function describe(step: TutorialStep, onRightPage: boolean): string {
  const parts = step.body.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (step.task) parts.push(`<div class="pg-tour-task"><strong>지금 할 일</strong><p>${escapeHtml(step.task)}</p></div>`);
  if (step.isDone && !onRightPage) {
    parts.push(`<p class="pg-tour-note">이 단계의 화면이 아닙니다. 이미 진행했다면 잠시 기다리면(예: 인스턴스가 Running이 될 때까지) 자동으로 다음 단계로 넘어갑니다.</p>`);
  }
  return parts.join("");
}

function addButton(popover: PopoverDOM, label: string, onClick: () => void, kind: "primary" | "link" = "link") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.className = kind === "primary" ? "pg-tour-btn pg-tour-btn-primary" : "pg-tour-btn pg-tour-btn-link";
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
  const driverRef = useRef<Driver | null>(null);
  const entered = useRef<{ key: string; doneOnEntry: boolean } | null>(null);
  const stepKey = active ? `${active.tutorialId}:${active.stepIndex}` : null;

  // 마지막 단계를 넘기면 종료
  useEffect(() => {
    if (active && tutorial && active.stepIndex >= tutorial.steps.length) useTutorialStore.getState().stop();
    if (active && !tutorial) useTutorialStore.getState().stop();
  }, [active, tutorial]);

  // 완료 판정 → 다음 단계
  useEffect(() => {
    if (!step || !stepKey) return;
    if (entered.current?.key !== stepKey) entered.current = { key: stepKey, doneOnEntry: doneNow };
    if (!step.isDone || !doneNow) return;
    const silent = entered.current.doneOnEntry;
    if (!silent) notify({ type: "success", title: `${step.title} 완료!`, description: "튜토리얼의 다음 단계로 넘어갑니다." });
    const timer = setTimeout(() => useTutorialStore.getState().next(), silent ? 0 : 1000);
    return () => clearTimeout(timer);
  }, [step, stepKey, doneNow]);

  // 단계가 바뀌면 그 단계의 화면으로 이동 (사용자가 다른 화면으로 가도 강제로 되돌리지 않는다)
  const goToStepPage = useEffectEvent(() => {
    const current = window.location.hash.replace(/^#/, "").split("?")[0] || "/";
    if (expected && current !== expected) navigate(expected);
  });
  useEffect(() => {
    if (stepKey) goToStepPage();
  }, [stepKey]);

  // 팝업 표시
  useEffect(() => {
    const destroy = () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    };
    if (!tutorial || !step || !active || doneNow) {
      destroy();
      return;
    }
    let cancelled = false;
    const index = active.stepIndex;
    const total = tutorial.steps.length;
    const onRightPage = !expected || location.path === expected;
    const isLast = index === total - 1;

    const show = (element?: Element) => {
      if (cancelled) return;
      destroy();
      const store = useTutorialStore.getState();
      const d = driver({
        animate: true,
        allowClose: true,
        allowKeyboardControl: false,
        overlayOpacity: element ? 0.35 : 0.45,
        stagePadding: 10,
        stageRadius: 16,
        disableActiveInteraction: false,
        overlayClickBehavior: () => undefined,
        popoverClass: "pg-tour",
        showButtons: ["next", "previous", "close"],
        nextBtnText: isLast ? "마치기" : "다음",
        prevBtnText: "이전",
        doneBtnText: "마치기",
        onNextClick: () => (isLast ? store.stop() : store.next()),
        onPrevClick: () => store.prev(),
        onCloseClick: () => store.stop(),
        onPopoverRender: (popover) => {
          popover.progress.style.display = "block";
          popover.progress.textContent = `${tutorial.title} · ${index + 1} / ${total}`;
          if (index === 0) popover.previousButton.style.display = "none";
          if (step.isDone) {
            popover.nextButton.style.display = "none";
            addButton(popover, "건너뛰기", () => store.next());
          }
          if (expected && !onRightPage) addButton(popover, "이 단계 화면으로 이동", () => navigate(expected), "primary");
        },
      });
      driverRef.current = d;
      d.highlight({
        element,
        popover: {
          title: step.title,
          description: describe(step, onRightPage),
          side: element ? (step.side ?? "bottom") : undefined,
          align: "start",
          // highlight()는 기본으로 버튼을 숨기므로 직접 지정한다
          showButtons: ["next", "previous", "close"],
          showProgress: true,
        },
      });
    };

    if (onRightPage && step.target) {
      const started = Date.now();
      const tick = () => {
        if (cancelled) return;
        const el = document.querySelector(step.target!);
        if (el) show(el);
        else if (Date.now() - started < 4000) setTimeout(tick, 120);
        else show(undefined);
      };
      tick();
    } else {
      show(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [tutorial, step, active, location.path, doneNow, expected]);

  // 콘솔을 떠나면 팝업 정리
  useEffect(
    () => () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    },
    [],
  );

  return null;
}
