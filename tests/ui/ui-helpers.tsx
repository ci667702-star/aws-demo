import { render } from "@testing-library/react";
import { act } from "react";
import { beforeAll } from "vitest";
import { preloadLazyGroups } from "@/components/app/lazy";
import { resetConsoleUi } from "@/components/console/console-store";
import { resetTutorialStore } from "@/components/console/tutorial/tutorial-store";
import { ConsoleRoute } from "@/components/console/console-route";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/lib/engine/resource-models";
import { useEditorStore } from "@/lib/store/editor-store";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";

export { routerPush } from "./router-mock";

// 콘솔 화면 코드는 필요할 때 불러온다(lazyGroup). 테스트에서는 미리 불러 두어 화면이 기다림 없이 바로 그려지게 한다
// (실제 앱에서도 콘솔이 열리면 한가할 때 미리 받아 둔다).
beforeAll(async () => {
  await preloadLazyGroups();
});

export function seedStore(projects: Project[]) {
  resetProjectStore();
  resetConsoleUi();
  resetTutorialStore();
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
    inspectorDoc: null,
    fieldFocus: null,
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
