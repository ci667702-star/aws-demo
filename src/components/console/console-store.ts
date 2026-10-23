"use client";

/**
 * 콘솔 화면 상태 (도움말/실습 패널, 탐색 창, 이번 세션의 분석 결과).
 * 프로젝트 데이터는 project-store에 있고 여기에는 화면 상태만 둔다. 알림은 sonner 토스트(notify.tsx)를 쓴다.
 */
import { create } from "zustand";
import type { SimulationResult } from "@/lib/engine/connectivity-engine";

export type ToolsTab = "help" | "labs";

/** Reachability Analyzer에서 마지막으로 분석한 결과 (리소스 맵 경로 표시용) */
export interface AnalysisRun {
  pathId: string | null;
  result: SimulationResult;
  at: string;
}

interface ConsoleUiState {
  projectId: string | null;
  navOpen: boolean;
  toolsOpen: boolean;
  toolsTab: ToolsTab;
  helpTopic: string | null;
  runs: Record<string, AnalysisRun>;

  reset: (projectId: string) => void;
  setNavOpen: (open: boolean) => void;
  openHelp: (topic: string) => void;
  openLabs: () => void;
  setToolsOpen: (open: boolean) => void;
  setToolsTab: (tab: ToolsTab) => void;
  recordRun: (key: string, run: AnalysisRun) => void;
}

export const useConsoleUi = create<ConsoleUiState>()((set) => ({
  projectId: null,
  navOpen: true,
  toolsOpen: false,
  toolsTab: "help",
  helpTopic: null,
  runs: {},

  reset: (projectId) =>
    set((s) => (s.projectId === projectId ? s : { projectId, runs: {}, helpTopic: null })),
  setNavOpen: (navOpen) => set({ navOpen }),
  openHelp: (helpTopic) => set({ helpTopic, toolsOpen: true, toolsTab: "help" }),
  openLabs: () => set({ toolsOpen: true, toolsTab: "labs" }),
  setToolsOpen: (toolsOpen) => set({ toolsOpen }),
  setToolsTab: (toolsTab) => set({ toolsTab, toolsOpen: true }),
  recordRun: (key, run) => set((s) => ({ runs: { ...s.runs, [key]: run } })),
}));

export function resetConsoleUi() {
  useConsoleUi.setState({ projectId: null, navOpen: true, toolsOpen: false, toolsTab: "help", helpTopic: null, runs: {} });
}
