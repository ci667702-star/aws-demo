"use client";

import { createContext, useContext } from "react";

export interface CanvasActions {
  deleteConnections: (ids: string[]) => void;
}

const CanvasActionsContext = createContext<CanvasActions>({ deleteConnections: () => {} });

export const CanvasActionsProvider = CanvasActionsContext.Provider;

export function useCanvasActions() {
  return useContext(CanvasActionsContext);
}
