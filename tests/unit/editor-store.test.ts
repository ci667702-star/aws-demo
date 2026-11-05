import { describe, expect, it } from "vitest";
import { useEditorStore } from "@/lib/store/editor-store";

describe("쉬운 모드 편집 상태의 기본값", () => {
  it("캔버스를 넓게 쓰도록 아래 패널은 접고, 소속 선은 숨긴 채 시작한다", () => {
    const initial = useEditorStore.getInitialState();
    expect(initial.bottomOpen).toBe(false);
    expect(initial.showMembershipEdges).toBe(false);
    expect(initial.showZones).toBe(true);
  });

  it("실습 프로젝트를 열면 아래 패널에 실습 가이드를 펼친다", () => {
    useEditorStore.setState(useEditorStore.getInitialState(), true);
    useEditorStore.getState().reset("lab-project", { lab: true });
    expect(useEditorStore.getState()).toMatchObject({ projectId: "lab-project", bottomTab: "lab", bottomOpen: true });
  });

  it("일반 프로젝트를 열면 사용자가 둔 아래 패널 상태를 바꾸지 않는다", () => {
    useEditorStore.setState(useEditorStore.getInitialState(), true);
    useEditorStore.getState().reset("plain-project");
    expect(useEditorStore.getState()).toMatchObject({ projectId: "plain-project", bottomOpen: false, bottomTab: "validation" });
  });
});
