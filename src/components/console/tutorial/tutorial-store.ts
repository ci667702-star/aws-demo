"use client";

/**
 * 진행 중인 튜토리얼 (화면 상태).
 * - 샌드박스마다 따로 기억한다: 새로고침하거나 나갔다 와도 하던 단계에서 이어진다 (이 브라우저의 localStorage).
 * - 판정 단계의 완료 여부는 저장하지 않고 매번 실제 설정으로 다시 확인한다.
 */
import { create } from "zustand";

export interface ActiveTutorial {
  tutorialId: string;
  stepIndex: number;
}

interface TutorialState {
  /** 지금 콘솔에 열려 있는 샌드박스 */
  projectId: string | null;
  active: ActiveTutorial | null;
  /** 안내 패널을 접어 둔 상태 (작은 버튼만 보인다) */
  minimized: boolean;
  /** 작업할 곳만 밝게 두고 주변을 어둡게 한다 */
  dim: boolean;
  /** 콘솔을 열 때: 이 샌드박스에서 하던 튜토리얼을 다시 불러온다 */
  load: (projectId: string) => void;
  start: (tutorialId: string, stepIndex?: number) => void;
  next: () => void;
  prev: () => void;
  goTo: (stepIndex: number) => void;
  stop: () => void;
  setMinimized: (minimized: boolean) => void;
  setDim: (dim: boolean) => void;
}

const ACTIVE_PREFIX = "aws-playground:tutorial:";
const DIM_KEY = "aws-playground:tutorial-dim";

function readActive(projectId: string): ActiveTutorial | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_PREFIX + projectId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ActiveTutorial>;
    return typeof v.tutorialId === "string" && Number.isInteger(v.stepIndex) && v.stepIndex! >= 0 ? { tutorialId: v.tutorialId, stepIndex: v.stepIndex! } : null;
  } catch {
    return null;
  }
}

function writeActive(projectId: string | null, active: ActiveTutorial | null) {
  if (!projectId) return;
  try {
    if (active) window.localStorage.setItem(ACTIVE_PREFIX + projectId, JSON.stringify(active));
    else window.localStorage.removeItem(ACTIVE_PREFIX + projectId);
  } catch {
    // 저장소를 쓸 수 없으면 이번 화면에서만 유지한다
  }
}

function readDim(): boolean {
  try {
    return window.localStorage.getItem(DIM_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useTutorialStore = create<TutorialState>()((set, get) => {
  /** 진행 상태를 바꾸고 이 샌드박스 것으로 저장한다 */
  const setActive = (active: ActiveTutorial | null, extra: Partial<TutorialState> = {}) => {
    writeActive(get().projectId, active);
    set({ active, ...extra });
  };
  return {
    projectId: null,
    active: null,
    minimized: false,
    dim: true,
    load: (projectId) => {
      const current = get();
      if (current.projectId === projectId) return;
      // 콘솔이 열리기 직전에 시작한 튜토리얼은 이 샌드박스 것으로 삼는다
      if (current.projectId === null && current.active) {
        writeActive(projectId, current.active);
        set({ projectId, dim: readDim() });
        return;
      }
      set({ projectId, active: readActive(projectId), minimized: false, dim: readDim() });
    },
    start: (tutorialId, stepIndex = 0) => setActive({ tutorialId, stepIndex }, { minimized: false }),
    next: () => {
      const a = get().active;
      if (a) setActive({ ...a, stepIndex: a.stepIndex + 1 });
    },
    prev: () => {
      const a = get().active;
      if (a && a.stepIndex > 0) setActive({ ...a, stepIndex: a.stepIndex - 1 });
    },
    goTo: (stepIndex) => {
      const a = get().active;
      if (a && stepIndex >= 0) setActive({ ...a, stepIndex });
    },
    stop: () => setActive(null, { minimized: false }),
    setMinimized: (minimized) => set({ minimized }),
    setDim: (dim) => {
      try {
        window.localStorage.setItem(DIM_KEY, dim ? "1" : "0");
      } catch {
        // 저장하지 못해도 이번 화면에서는 적용된다
      }
      set({ dim });
    },
  };
});

/** 테스트용: 스토어를 처음 상태로 되돌린다 */
export function resetTutorialStore() {
  useTutorialStore.setState({ projectId: null, active: null, minimized: false, dim: true });
}

export const TOUR_SEEN_KEY = "aws-playground:console-tour-offered";
