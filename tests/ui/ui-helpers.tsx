import { render } from "@testing-library/react";
import { act } from "react";
import { resetConsoleUi } from "@/components/console/console-store";
import { ConsoleRoute } from "@/components/console/console-route";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/lib/engine/resource-models";
import { useEditorStore } from "@/lib/store/editor-store";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";

export { routerPush } from "./router-mock";

export function seedStore(projects: Project[]) {
  resetProjectStore();
  resetConsoleUi();
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
  return render(
    <TooltipProvider>
      {ui}
      <Toaster />
    </TooltipProvider>,
  );
}

/** 콘솔을 특정 해시 경로에서 렌더링한다. */
export function renderConsole(projectId: string, hash = "#/") {
  window.history.replaceState(null, "", `/console/${projectId}${hash}`);
  return renderWithProviders(<ConsoleRoute projectId={projectId} />);
}

/** 콘솔 안에서 해시 경로를 바꾼다. */
export async function goTo(hash: string) {
  await act(async () => {
    window.location.hash = hash.replace(/^#/, "");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
