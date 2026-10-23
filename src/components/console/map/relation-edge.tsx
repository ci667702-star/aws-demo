"use client";

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "cn";
import type { RelationCategory } from "@/lib/engine/resource-models";
import type { RelationFlowEdge } from "./canvas-model";
import { useCanvasActions } from "./canvas-context";

/** 관계 유형별 선 스타일 (테마와 무관하게 대비가 충분한 고정 색상) */
export const EDGE_STROKES: Record<RelationCategory, { color: string; dash?: string; width: number; label: string }> = {
  membership: { color: "#94a3b8", dash: "4 4", width: 1.25, label: "소속" },
  attachment: { color: "#0ea5e9", width: 1.75, label: "연결(Attach)" },
  association: { color: "#14b8a6", dash: "6 3", width: 1.5, label: "연결(Association)" },
  route: { color: "#f59e0b", width: 2, label: "경로" },
  placement: { color: "#64748b", width: 1.5, label: "배치" },
  security: { color: "#f43f5e", dash: "2 4", width: 1.5, label: "보안 그룹" },
  traffic: { color: "#8b5cf6", width: 2, label: "트래픽 전달" },
};

const PATH_COLOR = "#0284c7";

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const { deleteConnections } = useCanvasActions();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  const stroke = EDGE_STROKES[data.category];
  const showLabel = data.alwaysShowLabel || selected || data.pathActive;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          stroke: data.pathActive ? PATH_COLOR : selected ? "var(--primary)" : stroke.color,
          strokeWidth: data.pathActive || selected ? stroke.width + 1 : stroke.width,
          strokeDasharray: data.pathActive ? undefined : stroke.dash,
          opacity: data.faded && !selected && !data.pathActive ? 0.35 : 1,
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-0.5 text-[10px] font-medium shadow-sm",
              selected && "border-primary text-primary",
              data.pathActive && "border-sky-500 text-sky-700 dark:text-sky-300",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span>{data.label}</span>
            {selected && deleteConnections && (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={`연결 삭제: ${data.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConnections([id]);
                }}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
