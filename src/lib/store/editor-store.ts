"use client";

/**
 * 아키텍처 빌더 화면 상태 (선택, 포커스 요청, 하단 패널, 시뮬레이션 결과/경로 표시).
 * 프로젝트 데이터는 project-store에 있고, 이 스토어는 화면 상태만 다룬다.
 */
import { create } from "zustand";
import type { SimulationRequest, SimulationResult } from "@/lib/engine/connectivity-engine";

export type BottomTab = "validation" | "simulation" | "activity" | "cost" | "lab";

export interface SimulationRun {
  id: string;
  at: string;
  result: SimulationResult;
}

export interface PathHighlight {
  /** 경로 순서대로의 리소스 ID */
  resourceIds: string[];
  connectionIds: string[];
  failedResourceIds: string[];
  outcome: SimulationResult["outcome"];
  /** 애니메이션 진행 위치 (경로 인덱스). 끝까지 재생되면 resourceIds.length */
  playhead: number;
}

interface EditorState {
  projectId: string | null;
  selectedResourceIds: string[];
  selectedConnectionIds: string[];
  focusRequest: { ids: string[]; nonce: number } | null;
  bottomTab: BottomTab;
  bottomOpen: boolean;
  showZones: boolean;
  showMembershipEdges: boolean;
  /** 시뮬레이션 콘솔에 미리 채울 요청 (실습 단계 등에서 전달) */
  pendingRequest: { request: SimulationRequest; autoRun: boolean; nonce: number } | null;
  runs: SimulationRun[];
  activeRunId: string | null;
  highlight: PathHighlight | null;

  reset: (projectId: string) => void;
  setSelection: (resourceIds: string[], connectionIds: string[]) => void;
  focusResources: (ids: string[]) => void;
  setBottomTab: (tab: BottomTab) => void;
  setBottomOpen: (open: boolean) => void;
  toggleZones: () => void;
  toggleMembershipEdges: () => void;
  requestSimulation: (request: SimulationRequest, autoRun?: boolean) => void;
  clearPendingRequest: () => void;
  addRun: (run: SimulationRun) => void;
  setActiveRun: (id: string | null) => void;
  setHighlight: (highlight: PathHighlight | null) => void;
  advancePlayhead: () => void;
}

const MAX_RUNS = 30;

export const useEditorStore = create<EditorState>()((set) => ({
  projectId: null,
  selectedResourceIds: [],
  selectedConnectionIds: [],
  focusRequest: null,
  bottomTab: "validation",
  bottomOpen: true,
  showZones: true,
  showMembershipEdges: true,
  pendingRequest: null,
  runs: [],
  activeRunId: null,
  highlight: null,

  reset: (projectId) =>
    set((s) =>
      s.projectId === projectId
        ? s
        : {
            projectId,
            selectedResourceIds: [],
            selectedConnectionIds: [],
            focusRequest: null,
            pendingRequest: null,
            runs: [],
            activeRunId: null,
            highlight: null,
          },
    ),
  setSelection: (resourceIds, connectionIds) =>
    set((s) =>
      sameIds(s.selectedResourceIds, resourceIds) && sameIds(s.selectedConnectionIds, connectionIds)
        ? s
        : { selectedResourceIds: resourceIds, selectedConnectionIds: connectionIds },
    ),
  focusResources: (ids) =>
    set((s) => ({
      focusRequest: { ids, nonce: (s.focusRequest?.nonce ?? 0) + 1 },
      selectedResourceIds: ids.slice(0, 1),
      selectedConnectionIds: [],
    })),
  setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true }),
  setBottomOpen: (open) => set({ bottomOpen: open }),
  toggleZones: () => set((s) => ({ showZones: !s.showZones })),
  toggleMembershipEdges: () => set((s) => ({ showMembershipEdges: !s.showMembershipEdges })),
  requestSimulation: (request, autoRun = true) =>
    set((s) => ({
      pendingRequest: { request, autoRun, nonce: (s.pendingRequest?.nonce ?? 0) + 1 },
      bottomTab: "simulation",
      bottomOpen: true,
    })),
  clearPendingRequest: () => set({ pendingRequest: null }),
  addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS), activeRunId: run.id })),
  setActiveRun: (id) => set({ activeRunId: id }),
  setHighlight: (highlight) => set({ highlight }),
  advancePlayhead: () =>
    set((s) =>
      s.highlight && s.highlight.playhead < s.highlight.resourceIds.length
        ? { highlight: { ...s.highlight, playhead: s.highlight.playhead + 1 } }
        : s,
    ),
}));

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
