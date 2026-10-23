"use client";

import { useMemo } from "react";
import { CircleCheck, CircleX, History, Pencil, Redo2, TriangleAlert, Undo2, Zap } from "lucide-react";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore, type ActivityEntry } from "@/lib/store/project-store";
import { formatTime } from "@/lib/ui/format";
import { buildHighlight } from "./simulation-console";

const ICONS: Record<ActivityEntry["kind"], typeof Pencil> = {
  edit: Pencil,
  undo: Undo2,
  redo: Redo2,
  error: TriangleAlert,
  simulation: Zap,
  validation: CircleCheck,
  system: History,
};

const MAX_VISIBLE = 150;

export function ActivityLog({ projectId }: { projectId: string }) {
  const activity = useProjectStore((s) => s.activity);
  const project = useProjectStore((s) => s.projects[projectId]);
  const runs = useEditorStore((s) => s.runs);
  const entries = useMemo(() => activity.filter((a) => a.projectId === projectId).slice(0, MAX_VISIBLE), [activity, projectId]);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-2" data-testid="activity-log">
      <section className="min-h-0 overflow-auto border-b p-3 md:border-r md:border-b-0" aria-labelledby="runs-heading">
        <h3 id="runs-heading" className="mb-2 text-xs font-semibold text-muted-foreground">
          시뮬레이션 실행 기록 ({runs.length})
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">아직 실행한 시뮬레이션이 없습니다.</p>
        ) : (
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => {
                    const editor = useEditorStore.getState();
                    editor.setActiveRun(r.id);
                    if (project) editor.setHighlight(buildHighlight(r.result, project));
                    editor.setBottomTab("simulation");
                  }}
                >
                  {r.result.outcome === "success" ? (
                    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-label="성공" />
                  ) : (
                    <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-600" aria-label="실패" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {r.result.sourceLabel} → {r.result.destinationLabel}
                    </span>
                    <span className="block truncate text-muted-foreground">{r.result.summary}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatTime(r.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="min-h-0 overflow-auto p-3" aria-labelledby="activity-heading">
        <h3 id="activity-heading" className="mb-2 text-xs font-semibold text-muted-foreground">
          작업 기록 (이 세션)
        </h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">아직 기록이 없습니다. 리소스를 추가하거나 설정을 변경하면 여기에 표시됩니다.</p>
        ) : (
          <ul className="space-y-0.5">
            {entries.map((e) => {
              const Icon = ICONS[e.kind];
              return (
                <li key={e.id} className="flex items-start gap-2 text-xs">
                  <Icon className={`mt-0.5 size-3.5 shrink-0 ${e.kind === "error" ? "text-red-600" : "text-muted-foreground"}`} aria-hidden />
                  <span className="min-w-0 flex-1">{e.message}</span>
                  <span className="shrink-0 text-muted-foreground">{formatTime(e.at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
