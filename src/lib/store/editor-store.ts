"use client";

/**
 * 아키텍처 빌더 화면 상태 (선택, 포커스 요청, 하단 패널, 시뮬레이션 결과/경로 표시).
 * 프로젝트 데이터는 project-store에 있고, 이 스토어는 화면 상태만 다룬다.
 */
import { create } from "zustand";
import type { ServiceDocKey } from "@/lib/docs/types";
import type { SimulationRequest, SimulationResult } from "@/lib/engine/connectivity-engine";
import type { ResourceType } from "@/lib/engine/resource-models";

export type BottomTab = "validation" | "simulation" | "activity" | "cost" | "lab";

/** 오른쪽 패널에 리소스 대신 보여 줄 설명: 팔레트의 리소스 유형 설명, 또는 VPC 밖 서비스(S3·IAM·CloudWatch) */
export type InspectorDoc =
  | { kind: "preview"; type: ResourceType; from?: string | null }
  | { kind: "service"; key: ServiceDocKey; itemId: string | null; from?: string | null };

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
  /** 선택한 리소스가 없을 때 오른쪽 패널에 보여 줄 설명 */
  inspectorDoc: InspectorDoc | null;
  /** '설정으로 이동' 요청: 오른쪽 패널이 해당 설정 항목을 펼치고 강조한다 */
  fieldFocus: { resourceId: string; field: string; nonce: number } | null;

  reset: (projectId: string) => void;
  setSelection: (resourceIds: string[], connectionIds: string[]) => void;
  focusResources: (ids: string[]) => void;
  setBottomTab: (tab: BottomTab) => void;
  setBottomOpen: (open: boolean) => void;
  toggleZones: () => void;
  toggleMembershipEdges: () => void;
  /** 캔버스 전체가 보이도록 맞춘다 (값이 바뀔 때마다) */
  fitNonce: number;
  requestFit: () => void;
  requestSimulation: (request: SimulationRequest, autoRun?: boolean) => void;
  clearPendingRequest: () => void;
  addRun: (run: SimulationRun) => void;
  setActiveRun: (id: string | null) => void;
  setHighlight: (highlight: PathHighlight | null) => void;
  advancePlayhead: () => void;
  /** 리소스 선택을 풀고 설명을 보여 준다 (null이면 프로젝트 개요) */
  showDoc: (doc: InspectorDoc | null) => void;
  /** 리소스를 선택하고 그 리소스의 설정 항목으로 이동한다 */
  focusField: (resourceId: string, field: string) => void;
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
  inspectorDoc: null,
  fieldFocus: null,

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
            inspectorDoc: null,
            fieldFocus: null,
          },
    ),
  setSelection: (resourceIds, connectionIds) =>
    set((s) =>
      sameIds(s.selectedResourceIds, resourceIds) && sameIds(s.selectedConnectionIds, connectionIds)
        ? s
        : { selectedResourceIds: resourceIds, selectedConnectionIds: connectionIds, inspectorDoc: null },
    ),
  focusResources: (ids) =>
    set((s) => ({
      focusRequest: { ids, nonce: (s.focusRequest?.nonce ?? 0) + 1 },
      selectedResourceIds: ids.slice(0, 1),
      selectedConnectionIds: [],
      inspectorDoc: null,
    })),
  setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true }),
  setBottomOpen: (open) => set({ bottomOpen: open }),
  toggleZones: () => set((s) => ({ showZones: !s.showZones })),
  toggleMembershipEdges: () => set((s) => ({ showMembershipEdges: !s.showMembershipEdges })),
  fitNonce: 0,
  requestFit: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
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
  showDoc: (doc) => set({ inspectorDoc: doc, selectedResourceIds: [], selectedConnectionIds: [] }),
  focusField: (resourceId, field) =>
    set((s) => {
      const moving = !(s.selectedResourceIds.length === 1 && s.selectedResourceIds[0] === resourceId && !s.selectedConnectionIds.length);
      return {
        selectedResourceIds: [resourceId],
        selectedConnectionIds: [],
        inspectorDoc: null,
        fieldFocus: { resourceId, field, nonce: (s.fieldFocus?.nonce ?? 0) + 1 },
        // 다른 리소스로 옮길 때만 캔버스도 그 리소스로 이동한다
        focusRequest: moving ? { ids: [resourceId], nonce: (s.focusRequest?.nonce ?? 0) + 1 } : s.focusRequest,
      };
    }),
}));

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
