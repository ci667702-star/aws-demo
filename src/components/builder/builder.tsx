"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { ImportDialog } from "@/components/app/import-dialog";
import { Button } from "@/components/ui/button";
import type { ResourceType } from "@/lib/engine/resource-models";
import { exportFileName, exportProjectJson } from "@/lib/project/serialization";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { downloadTextFile } from "@/lib/ui/download";
import { analyzeProject, AnalysisProvider } from "./analysis-context";
import { ArchitectureCanvas, type CanvasCommands } from "./canvas/architecture-canvas";
import { Inspector } from "./inspector/inspector";
import { Palette } from "./palette";
import { BottomPanel } from "./panels/bottom-panel";
import { BuilderToolbar } from "./toolbar";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function Builder({ projectId }: { projectId: string }) {
  const router = useRouter();
  const project = useProjectStore((s) => s.projects[projectId])!;
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const log = useProjectStore((s) => s.log);
  const resetEditor = useEditorStore((s) => s.reset);
  const selectedCount = useEditorStore((s) => s.selectedResourceIds.length + s.selectedConnectionIds.length);
  const commandsRef = useRef<CanvasCommands | null>(null);
  const [revalidateNonce, setRevalidateNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    resetEditor(projectId);
  }, [projectId, resetEditor]);

  const analysis = useMemo(() => {
    void revalidateNonce;
    return analyzeProject(project);
  }, [project, revalidateNonce]);

  // 작은 화면에서는 리소스를 선택하면 설정 패널을 연다
  const [prevSelected, setPrevSelected] = useState(selectedCount);
  if (selectedCount !== prevSelected) {
    setPrevSelected(selectedCount);
    if (selectedCount > 0) setRightOpen(true);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!undo(projectId)) toast.info("실행 취소할 작업이 없습니다.");
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        if (!redo(projectId)) toast.info("다시 실행할 작업이 없습니다.");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, undo, redo]);

  const onAdd = (type: ResourceType) => {
    commandsRef.current?.addAtCenter(type);
    setLeftOpen(false);
  };

  return (
    <AnalysisProvider value={analysis}>
      <ReactFlowProvider>
        <div className="flex h-dvh flex-col overflow-hidden bg-background" data-testid="builder">
          <BuilderToolbar
            projectId={projectId}
            onToggleLeft={() => setLeftOpen((o) => !o)}
            onToggleRight={() => setRightOpen((o) => !o)}
            onExport={() => {
              downloadTextFile(exportFileName(project), exportProjectJson(project));
              toast.success("프로젝트를 JSON으로 내보냈습니다.");
            }}
            onImport={() => setImportOpen(true)}
          />
          <div className="relative flex min-h-0 flex-1">
            <aside
              className={cn(
                "w-56 shrink-0 border-r bg-background lg:static lg:block",
                leftOpen ? "absolute inset-y-0 left-0 z-30 block shadow-xl" : "hidden",
              )}
              aria-label="리소스 팔레트"
            >
              <Palette onAdd={onAdd} />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
                <ArchitectureCanvas projectId={projectId} commandsRef={commandsRef} />
              </div>
              <BottomPanel
                projectId={projectId}
                expanded={expanded}
                onToggleExpanded={() => setExpanded((x) => !x)}
                onRevalidate={() => {
                  setRevalidateNonce((n) => n + 1);
                  const next = analyzeProject(project);
                  log({ projectId, kind: "validation", message: `검증 실행: 오류 ${next.counts.error}, 경고 ${next.counts.warning}, 정보 ${next.counts.info}` });
                  toast.success(`검증 완료 — 오류 ${next.counts.error}개, 경고 ${next.counts.warning}개, 정보 ${next.counts.info}개`);
                }}
              />
            </div>
            <aside
              className={cn(
                "w-80 shrink-0 flex-col border-l bg-background xl:w-96 lg:static lg:flex",
                rightOpen ? "absolute inset-y-0 right-0 z-30 flex shadow-xl" : "hidden",
              )}
              aria-label="설정 패널"
            >
              <div className="flex h-9 items-center justify-between border-b px-3 lg:hidden">
                <span className="text-xs font-semibold">설정</span>
                <Button variant="ghost" size="icon-xs" onClick={() => setRightOpen(false)} aria-label="설정 패널 닫기">
                  <X />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <Inspector projectId={projectId} />
              </div>
            </aside>
          </div>
        </div>
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImport={(imported) => {
            const id = useProjectStore.getState().addImportedProject(imported);
            toast.success(`"${imported.name}"을(를) 새 프로젝트로 가져왔습니다. 현재 프로젝트는 변경되지 않았습니다.`);
            router.push(`/projects/${id}`);
          }}
        />
      </ReactFlowProvider>
    </AnalysisProvider>
  );
}
