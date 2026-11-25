"use client";

/**
 * 처음 쓰는 사람을 위한 안내 표시 설정 (이 브라우저에만 기억).
 * - 다음 할 일 안내: 샌드박스마다 숨길 수 있다
 * - 사이드 메뉴의 서비스 더 보기, 쉬운 모드 팔레트의 리소스 더 보기
 */
import { create } from "zustand";

const HIDDEN_KEY = "aws-playground:next-step-hidden";
const NAV_KEY = "aws-playground:nav-show-all";
const PALETTE_KEY = "aws-playground:palette-show-all";

function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 저장하지 못해도 이번 화면에서는 적용된다
  }
}

function readHidden(): Record<string, true> {
  try {
    const v = JSON.parse(read(HIDDEN_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).map((k) => [k, true as const])) : {};
  } catch {
    return {};
  }
}

interface GuidePrefs {
  nextStepHidden: Record<string, true>;
  navShowAll: boolean;
  paletteShowAll: boolean;
  setNextStepHidden: (projectId: string, hidden: boolean) => void;
  setNavShowAll: (show: boolean) => void;
  setPaletteShowAll: (show: boolean) => void;
}

const initial = () => ({ nextStepHidden: readHidden(), navShowAll: read(NAV_KEY) === "1", paletteShowAll: read(PALETTE_KEY) === "1" });

export const useGuidePrefs = create<GuidePrefs>()((set, get) => ({
  ...initial(),
  setNextStepHidden: (projectId, hidden) => {
    const next = { ...get().nextStepHidden };
    if (hidden) next[projectId] = true;
    else delete next[projectId];
    write(HIDDEN_KEY, JSON.stringify(next));
    set({ nextStepHidden: next });
  },
  setNavShowAll: (show) => {
    write(NAV_KEY, show ? "1" : null);
    set({ navShowAll: show });
  },
  setPaletteShowAll: (show) => {
    write(PALETTE_KEY, show ? "1" : null);
    set({ paletteShowAll: show });
  },
}));

/** 테스트용: 저장된 설정을 지우고 처음 상태로 */
export function resetGuidePrefs() {
  for (const key of [HIDDEN_KEY, NAV_KEY, PALETTE_KEY]) write(key, null);
  useGuidePrefs.setState(initial());
}
