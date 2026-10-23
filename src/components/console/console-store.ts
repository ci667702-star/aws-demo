"use client";

/**
 * 콘솔 화면 상태 (알림 표시줄, 도움말/실습 패널, 탐색 창).
 * 프로젝트 데이터는 project-store에 있고 여기에는 화면 상태만 둔다.
 */
import { create } from "zustand";
import type { SimulationResult } from "@/lib/engine/connectivity-engine";

export type FlashType = "success" | "error" | "info" | "warning" | "in-progress";

export interface Flash {
  id: number;
  type: FlashType;
  header?: string;
  content: string;
  notes?: string[];
  /** 알림 오른쪽의 이동 버튼 (예: "VPC에 연결") */
  action?: { label: string; href: string };
}

export type ToolsTab = "help" | "labs";

/** Reachability Analyzer에서 마지막으로 분석한 결과 (리소스 맵 경로 표시용) */
export interface AnalysisRun {
  pathId: string | null;
  result: SimulationResult;
  at: string;
}

interface ConsoleUiState {
  projectId: string | null;
  flashes: Flash[];
  navOpen: boolean;
  toolsOpen: boolean;
  toolsTab: ToolsTab;
  helpTopic: string | null;
  runs: Record<string, AnalysisRun>;

  reset: (projectId: string) => void;
  pushFlash: (flash: Omit<Flash, "id">) => void;
  dismissFlash: (id: number) => void;
  clearFlashes: () => void;
  setNavOpen: (open: boolean) => void;
  openHelp: (topic: string) => void;
  openLabs: () => void;
  setToolsOpen: (open: boolean) => void;
  setToolsTab: (tab: ToolsTab) => void;
  recordRun: (key: string, run: AnalysisRun) => void;
}

let flashSeq = 0;
const MAX_FLASHES = 4;

export const useConsoleUi = create<ConsoleUiState>()((set) => ({
  projectId: null,
  flashes: [],
  navOpen: true,
  toolsOpen: false,
  toolsTab: "help",
  helpTopic: null,
  runs: {},

  reset: (projectId) =>
    set((s) => (s.projectId === projectId ? s : { projectId, flashes: [], runs: {}, helpTopic: null })),
  pushFlash: (flash) => set((s) => ({ flashes: [{ ...flash, id: ++flashSeq }, ...s.flashes].slice(0, MAX_FLASHES) })),
  dismissFlash: (id) => set((s) => ({ flashes: s.flashes.filter((f) => f.id !== id) })),
  clearFlashes: () => set({ flashes: [] }),
  setNavOpen: (navOpen) => set({ navOpen }),
  openHelp: (helpTopic) => set({ helpTopic, toolsOpen: true, toolsTab: "help" }),
  openLabs: () => set({ toolsOpen: true, toolsTab: "labs" }),
  setToolsOpen: (toolsOpen) => set({ toolsOpen }),
  setToolsTab: (toolsTab) => set({ toolsTab, toolsOpen: true }),
  recordRun: (key, run) => set((s) => ({ runs: { ...s.runs, [key]: run } })),
}));

export function resetConsoleUi() {
  useConsoleUi.setState({ projectId: null, flashes: [], navOpen: true, toolsOpen: false, toolsTab: "help", helpTopic: null, runs: {} });
}
