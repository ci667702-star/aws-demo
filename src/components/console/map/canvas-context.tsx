"use client";

import { createContext, useContext } from "react";

export interface CanvasActions {
  /** 없으면 연결선 삭제 버튼을 표시하지 않는다 (읽기 전용 리소스 맵) */
  deleteConnections?: (ids: string[]) => void;
}

const CanvasActionsContext = createContext<CanvasActions>({});

export const CanvasActionsProvider = CanvasActionsContext.Provider;

export function useCanvasActions() {
  return useContext(CanvasActionsContext);
}
