"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Circle, GraduationCap, Lightbulb, Play, Trophy } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { simulateWithTopology } from "@/lib/engine/connectivity-engine";
import { evaluateLab, labById, LABS, type LabContext } from "@/lib/labs/labs";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "../analysis-context";

export function LabPanel({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId])!;
  const analysis = useAnalysis();
  const lab = labById(project.labId);
  const router = useRouter();
  const requestSimulation = useEditorStore((s) => s.requestSimulation);
  const [hints, setHints] = useState<Record<string, boolean>>({});

  const ctx = useMemo<LabContext | null>(
    () =>
      lab
        ? {
            project: analysis.project,
            topo: analysis.topology,
            findings: analysis.findings,
            health: analysis.health,
            simulate: (request) => simulateWithTopology(analysis.topology, request),
          }
        : null,
    [lab, analysis],
  );
  const progress = useMemo(() => (lab && ctx ? evaluateLab(lab, ctx) : null), [lab, ctx]);

  if (!lab || !ctx || !progress) {
    return (
      <div className="space-y-3 overflow-auto p-3" data-testid="lab-panel">
        <p className="flex items-center gap-2 text-sm font-medium">
          <GraduationCap className="size-4" aria-hidden /> 이 프로젝트는 Guided Lab이 아닙니다.
        </p>
        <p className="text-xs text-muted-foreground">실습을 시작하면 새 프로젝트가 만들어지고, 단계별 완료 여부가 실제 설정과 검증 결과로 판정됩니다.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LABS.map((l) => (
            <div key={l.id} className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Lab {l.order} · {l.level}
              </p>
              <p className="text-sm font-medium">{l.title}</p>
              <Button
                size="xs"
                className="mt-2"
                onClick={() => {
                  const id = useProjectStore.getState().startLab(l.id);
                  if (id) router.push(`/projects/${id}`);
                }}
              >
                실습 시작
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const pct = Math.round((progress.completedCount / lab.steps.length) * 100);
  return (
    <div className="h-full space-y-3 overflow-auto p-3" data-testid="lab-panel">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Lab {lab.order} · {lab.level}
        </p>
        <p className="font-semibold">{lab.title}</p>
        <p className="text-xs text-muted-foreground">{lab.summary}</p>
        <div className="flex items-center gap-2 pt-1">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="실습 진행률">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-medium" data-testid="lab-progress">
            {progress.completedCount}/{lab.steps.length}
          </span>
        </div>
      </div>
      {progress.completed && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm" role="status">
          <Trophy className="size-4 text-emerald-600" aria-hidden /> 실습 완료! 실제 설정과 시뮬레이션 결과로 모든 단계가 확인되었습니다.
        </div>
      )}
      <div className="rounded-lg border p-3 text-xs">
        <p className="mb-1 font-medium">학습 목표</p>
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          {lab.objectives.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      </div>
      <ol className="space-y-2">
        {lab.steps.map((step, i) => {
          const done = progress.steps[i]?.done;
          const request = step.simulation?.(ctx) ?? null;
          return (
            <li key={step.id} className={cn("rounded-lg border p-3", done && "border-emerald-500/40 bg-emerald-500/5")} data-testid="lab-step" data-done={done}>
              <div className="flex items-start gap-2">
                {done ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="완료" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="미완료" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">
                    {i + 1}. {step.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{step.instruction}</p>
                  {hints[step.id] && (
                    <p className="flex items-start gap-1 rounded-md bg-amber-500/10 p-2 text-xs">
                      <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden /> {step.hint}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {!done && (
                      <Button variant="ghost" size="xs" onClick={() => setHints((h) => ({ ...h, [step.id]: !h[step.id] }))}>
                        <Lightbulb /> {hints[step.id] ? "힌트 숨기기" : "힌트 보기"}
                      </Button>
                    )}
                    {request && (
                      <Button variant="outline" size="xs" onClick={() => requestSimulation(request, true)}>
                        <Play /> 콘솔에서 실행
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-muted-foreground">단계 완료 여부는 버튼 클릭이 아니라 현재 아키텍처의 실제 설정·검증·시뮬레이션 결과로 자동 판정됩니다.</p>
    </div>
  );
}
