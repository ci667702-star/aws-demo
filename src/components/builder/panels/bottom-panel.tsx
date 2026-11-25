"use client";

import { Calculator, ChevronDown, ChevronUp, GraduationCap, History, Maximize2, Minimize2, ShieldAlert, Zap } from "lucide-react";
import { cn } from "cn";
import { Suspense } from "react";
import { lazyGroup } from "@/components/app/lazy";
import { Button } from "@/components/ui/button";
import { useEditorStore, type BottomTab } from "@/lib/store/editor-store";
import { useAnalysis } from "@/components/console/analysis-context";
import { ValidationCenter } from "./validation-center";

// 처음 보이는 검증 센터만 바로 싣고, 나머지 탭은 열 때 불러온다 (한가할 때 미리 받아 둔다)
const { ActivityLog } = lazyGroup(() => import("./activity-log"), ["ActivityLog"]);
const { CostPanel } = lazyGroup(() => import("./cost-panel"), ["CostPanel"]);
const { LabPanel } = lazyGroup(() => import("./lab-panel"), ["LabPanel"]);
const { SimulationConsole } = lazyGroup(() => import("./simulation-console"), ["SimulationConsole"]);

export function BottomPanel({
  projectId,
  expanded,
  onToggleExpanded,
  onRevalidate,
}: {
  projectId: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRevalidate: () => void;
}) {
  const tab = useEditorStore((s) => s.bottomTab);
  const open = useEditorStore((s) => s.bottomOpen);
  const setTab = useEditorStore((s) => s.setBottomTab);
  const setOpen = useEditorStore((s) => s.setBottomOpen);
  const analysis = useAnalysis();

  const tabs: { id: BottomTab; label: string; icon: typeof Zap; badge?: React.ReactNode }[] = [
    {
      id: "validation",
      label: "검증 센터",
      icon: ShieldAlert,
      badge: (
        <span className="flex gap-1">
          {analysis.counts.error > 0 && <span className="rounded bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-300">{analysis.counts.error}</span>}
          {analysis.counts.warning > 0 && <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-800 dark:text-amber-300">{analysis.counts.warning}</span>}
        </span>
      ),
    },
    { id: "simulation", label: "시뮬레이션", icon: Zap },
    { id: "lab", label: "실습 문제", icon: GraduationCap },
    { id: "cost", label: "가상 비용", icon: Calculator },
    { id: "activity", label: "실행 로그", icon: History },
  ];

  return (
    <section
      className={cn("flex min-h-0 flex-col border-t bg-background", open ? (expanded ? "h-[62vh]" : "h-[38vh] min-h-56") : "h-9")}
      aria-label="하단 패널"
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1" role="tablist" aria-label="하단 패널 탭">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = open && tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              data-testid={`tab-${t.id}`}
              onClick={() => (active ? setOpen(false) : setTab(t.id))}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                active && "bg-muted text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t.label}
              {t.badge}
            </button>
          );
        })}
        <div className="ml-auto flex items-center">
          {open && (
            <Button variant="ghost" size="icon-xs" onClick={onToggleExpanded} aria-label={expanded ? "패널 축소" : "패널 확대"}>
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={() => setOpen(!open)} aria-label={open ? "하단 패널 접기" : "하단 패널 펼치기"}>
            {open ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
      </div>
      {open && (
        <div className="min-h-0 flex-1" role="tabpanel">
          {tab === "validation" && <ValidationCenter onRevalidate={onRevalidate} />}
          <Suspense fallback={<p className="pg-delayed-fade p-4 text-sm text-muted-foreground" role="status">불러오는 중…</p>}>
            {tab === "simulation" && <SimulationConsole projectId={projectId} />}
            {tab === "lab" && <LabPanel projectId={projectId} />}
            {tab === "cost" && <CostPanel projectId={projectId} />}
            {tab === "activity" && <ActivityLog projectId={projectId} />}
          </Suspense>
        </div>
      )}
    </section>
  );
}
