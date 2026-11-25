"use client";

/**
 * 진행 중인 튜토리얼을 화면에 연결한다.
 * - 안내 글과 버튼은 오른쪽 안내 패널(tutorial-panel.tsx)에 있다. 여기서는 화면에서 '어디를 보면 되는지'만 밝게 표시한다.
 * - 단계는 사용자가 '다음'을 눌러야만 넘어가고, 화면도 자동으로 옮기지 않는다.
 *   다른 화면의 단계면 그 화면으로 가는 메뉴·링크를 표시해 주고, 패널에는 '이 화면으로 이동' 버튼이 있다.
 * - 튜토리얼 중에도 화면 전체를 그대로 쓸 수 있다 (표시는 클릭을 막지 않는다).
 */
import { useCallback, useEffect } from "react";
import { useConsoleProjectId } from "../console-context";
import { useHashLocation } from "../router";
import { TutorialSpotlight } from "./tutorial-spotlight";
import { useTutorialStore } from "./tutorial-store";
import { resolveSpotlightTargets, useTutorialView } from "./use-tutorial";

export function TutorialHost() {
  const projectId = useConsoleProjectId();
  const view = useTutorialView();
  const location = useHashLocation();
  const dim = useTutorialStore((s) => s.dim);
  const minimized = useTutorialStore((s) => s.minimized);

  // 이 샌드박스에서 하던 튜토리얼을 이어서 보여 준다
  useEffect(() => {
    useTutorialStore.getState().load(projectId);
  }, [projectId]);

  // 없는 튜토리얼이나 범위를 벗어난 단계가 저장되어 있으면 정리한다
  const active = useTutorialStore((s) => (s.projectId === projectId ? s.active : null));
  useEffect(() => {
    if (!active) return;
    if (!view) useTutorialStore.getState().stop();
    else if (active.stepIndex !== view.index) useTutorialStore.getState().goTo(view.index);
  }, [active, view]);

  const path = location.path;
  const resolve = useCallback(() => (view ? resolveSpotlightTargets(view, path).elements : []), [view, path]);
  if (!view || minimized) return null;
  // 단계 화면에서는 작업할 곳(어둡게 + 테두리), 다른 화면에서는 눌러야 할 메뉴(깜빡이는 테두리만)
  const hop = !view.onRightPage;
  return (
    <TutorialSpotlight
      resolve={resolve}
      dim={dim && !hop}
      pulse={hop}
      watchKey={`${view.tutorial.id}:${view.index}:${path}:${hop ? "hop" : "work"}:${view.done ? "done" : "todo"}`}
    />
  );
}
