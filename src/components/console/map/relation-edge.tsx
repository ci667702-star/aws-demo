"use client";

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useInternalNode, useStore, type EdgeProps, type InternalNode, type ReactFlowState } from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "cn";
import type { RelationCategory } from "@/lib/engine/resource-models";
import { COMPACT_ZOOM, type RelationFlowEdge } from "./canvas-model";
import { useCanvasActions } from "./canvas-context";

/** 관계 유형별 선 스타일 (테마와 무관하게 대비가 충분한 고정 색상) */
export const EDGE_STROKES: Record<RelationCategory, { color: string; dash?: string; width: number; label: string }> = {
  membership: { color: "#94a3b8", dash: "4 4", width: 1.25, label: "소속" },
  attachment: { color: "#0ea5e9", width: 1.75, label: "IGW·탄력적 IP 연결" },
  association: { color: "#14b8a6", dash: "6 3", width: 1.5, label: "서브넷 연결" },
  route: { color: "#f59e0b", width: 2, label: "경로" },
  placement: { color: "#64748b", width: 1.5, label: "배치" },
  security: { color: "#f43f5e", dash: "2 4", width: 1.5, label: "보안 그룹" },
  traffic: { color: "#8b5cf6", width: 2, label: "트래픽 전달" },
};

const PATH_COLOR = "#0284c7";

const zoomedOut = (s: ReactFlowState) => s.transform[2] < COMPACT_ZOOM;

/**
 * 두 노드의 위치에 따라 가까운 변끼리 잇는다.
 * 항상 아래 → 위로 그리면 대상이 위나 옆에 있을 때 선이 크게 돌아가 다른 선과 겹친다.
 */
function nearestSides(source: InternalNode, target: InternalNode) {
  const sw = source.measured.width;
  const sh = source.measured.height;
  const tw = target.measured.width;
  const th = target.measured.height;
  if (!sw || !sh || !tw || !th) return null;
  const sx = source.internals.positionAbsolute.x + sw / 2;
  const sy = source.internals.positionAbsolute.y + sh / 2;
  const tx = target.internals.positionAbsolute.x + tw / 2;
  const ty = target.internals.positionAbsolute.y + th / 2;
  if (Math.abs(ty - sy) >= (sh + th) / 2 + 12) {
    const down = ty > sy;
    return {
      sourceX: sx,
      sourceY: sy + (down ? sh : -sh) / 2,
      sourcePosition: down ? Position.Bottom : Position.Top,
      targetX: tx,
      targetY: ty + (down ? -th : th) / 2,
      targetPosition: down ? Position.Top : Position.Bottom,
    };
  }
  const right = tx > sx;
  return {
    sourceX: sx + (right ? sw : -sw) / 2,
    sourceY: sy,
    sourcePosition: right ? Position.Right : Position.Left,
    targetX: tx + (right ? -tw : tw) / 2,
    targetY: ty,
    targetPosition: right ? Position.Left : Position.Right,
  };
}

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const { deleteConnections } = useCanvasActions();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const sides = sourceNode && targetNode ? nearestSides(sourceNode, targetNode) : null;
  const [path, labelX, labelY] = getBezierPath(sides ?? { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const compact = useStore(zoomedOut);
  if (!data) return null;
  const stroke = EDGE_STROKES[data.category];
  // 멀리서 볼 때는 작은 라벨이 겹쳐 읽기 어려우므로, 선택·강조·경로 표시 중인 선의 라벨만 보여 준다
  const showLabel = (data.alwaysShowLabel && !compact && !data.dimmed) || selected || data.pathActive || data.emphasized;
  const strong = data.pathActive || selected || data.emphasized;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          stroke: data.pathActive ? PATH_COLOR : selected ? "var(--primary)" : stroke.color,
          strokeWidth: strong ? stroke.width + 1 : stroke.width,
          strokeDasharray: data.pathActive ? undefined : stroke.dash,
          opacity: strong ? 1 : data.dimmed ? 0.08 : data.faded ? 0.35 : 1,
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-0.5 text-[10px] font-medium shadow-sm",
              selected && "border-primary text-primary",
              data.pathActive && "border-sky-500 text-sky-700 dark:text-sky-300",
              compact && "px-2 py-1 text-[16px]",
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
