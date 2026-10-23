"use client";

/** 진행 중인 튜토리얼 (화면 상태라 저장하지 않는다. 판정 단계는 설정으로 다시 확인되므로 다시 시작해도 이어진다) */
import { create } from "zustand";

export interface ActiveTutorial {
  tutorialId: string;
  stepIndex: number;
}

interface TutorialState {
  active: ActiveTutorial | null;
  start: (tutorialId: string) => void;
  next: () => void;
  prev: () => void;
  goTo: (stepIndex: number) => void;
  stop: () => void;
}

export const useTutorialStore = create<TutorialState>()((set) => ({
  active: null,
  start: (tutorialId) => set({ active: { tutorialId, stepIndex: 0 } }),
  next: () => set((s) => (s.active ? { active: { ...s.active, stepIndex: s.active.stepIndex + 1 } } : s)),
  prev: () => set((s) => (s.active && s.active.stepIndex > 0 ? { active: { ...s.active, stepIndex: s.active.stepIndex - 1 } } : s)),
  goTo: (stepIndex) => set((s) => (s.active ? { active: { ...s.active, stepIndex } } : s)),
  stop: () => set({ active: null }),
}));

export const TOUR_SEEN_KEY = "aws-playground:console-tour-offered";
