"use client";

/** 진행 중인 튜토리얼 (화면 상태라 저장하지 않는다. 판정 단계는 설정으로 다시 확인하므로 '이어서 하기'로 남은 단계부터 다시 시작할 수 있다) */
import { create } from "zustand";

export interface ActiveTutorial {
  tutorialId: string;
  stepIndex: number;
}

interface TutorialState {
  active: ActiveTutorial | null;
  start: (tutorialId: string, stepIndex?: number) => void;
  next: () => void;
  prev: () => void;
  goTo: (stepIndex: number) => void;
  stop: () => void;
}

export const useTutorialStore = create<TutorialState>()((set) => ({
  active: null,
  start: (tutorialId, stepIndex = 0) => set({ active: { tutorialId, stepIndex } }),
  next: () => set((s) => (s.active ? { active: { ...s.active, stepIndex: s.active.stepIndex + 1 } } : s)),
  prev: () => set((s) => (s.active && s.active.stepIndex > 0 ? { active: { ...s.active, stepIndex: s.active.stepIndex - 1 } } : s)),
  goTo: (stepIndex) => set((s) => (s.active ? { active: { ...s.active, stepIndex } } : s)),
  stop: () => set({ active: null }),
}));

export const TOUR_SEEN_KEY = "aws-playground:console-tour-offered";
