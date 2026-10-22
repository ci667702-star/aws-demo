import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/lib/engine/resource-models";
import { useEditorStore } from "@/lib/store/editor-store";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";

export { routerPush } from "./router-mock";

export function seedStore(projects: Project[]) {
  resetProjectStore();
  useEditorStore.setState({
    projectId: null,
    selectedResourceIds: [],
    selectedConnectionIds: [],
    focusRequest: null,
    bottomTab: "validation",
    bottomOpen: true,
    pendingRequest: null,
    runs: [],
    activeRunId: null,
    highlight: null,
  });
  useProjectStore.setState({
    status: "ready",
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    saveStatus: "saved",
  });
}

export function project(id: string): Project {
  return useProjectStore.getState().projects[id];
}

export function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}
