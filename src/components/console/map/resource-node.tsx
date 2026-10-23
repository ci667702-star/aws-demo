"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleX, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { CATEGORY_STYLES, ResourceIcon, ToneBadge } from "@/components/resource-visuals";
import { RESOURCE_TYPE_INFO } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { NODE_WIDTH } from "@/lib/project/layout";
import type { ResourceFlowNode, ZoneFlowNode } from "./canvas-model";

export const ResourceNode = memo(function ResourceNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  const { resource, subtitle, badges, errors, warnings, pathState, pathOrder, typeLabel } = data;
  const category = CATEGORY_STYLES[RESOURCE_TYPE_INFO[resource.type].category];
  const name = displayName(resource);
  return (
    <div
      className={cn(
        "relative rounded-lg border border-l-4 bg-card text-card-foreground shadow-sm transition-shadow",
        category.border,
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        pathState === "active" && "node-pulse border-sky-500 ring-2 ring-sky-500/70",
        pathState === "failed" && "border-red-500 ring-2 ring-red-500/80",
        pathState === "pending" && "opacity-60",
      )}
      style={{ width: NODE_WIDTH }}
      data-testid={`node-${name}`}
      aria-label={`${typeLabel} ${name}`}
    >
      <Handle type="target" position={Position.Top} aria-label={`${name} 연결점 (위)`} />
      <div className="flex items-start gap-2 p-2">
        <ResourceIcon type={resource.type} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[13px] leading-tight font-medium" title={name}>
              {name}
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={subtitle}>
            {typeLabel} · {subtitle}
          </div>
          {badges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {badges.map((b) => (
                <ToneBadge key={b.label} tone={b.tone} title={b.title}>
                  {b.label}
                </ToneBadge>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {errors > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-red-600 dark:text-red-400" title={`오류 ${errors}개`}>
              <CircleX className="size-3" aria-hidden />
              {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400" title={`경고 ${warnings}개`}>
              <TriangleAlert className="size-3" aria-hidden />
              {warnings}
            </span>
          )}
        </div>
      </div>
      {pathOrder !== null && (
        <span className="absolute -top-2 -left-2 inline-flex size-5 items-center justify-center rounded-full bg-sky-600 text-[10px] font-semibold text-white shadow">
          {pathOrder + 1}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} aria-label={`${name} 연결점 (아래)`} />
    </div>
  );
});

const ZONE_STYLES: Record<string, string> = {
  vpc: "border-slate-400/60 bg-slate-500/[0.04] dark:border-slate-500/50",
  public: "border-emerald-500/50 bg-emerald-500/[0.06]",
  "private-nat": "border-sky-500/50 bg-sky-500/[0.06]",
  "private-isolated": "border-slate-400/50 bg-slate-500/[0.05]",
  unattached: "border-amber-500/50 bg-amber-500/[0.05]",
};

export const ZoneNode = memo(function ZoneNode({ data, width, height }: NodeProps<ZoneFlowNode>) {
  return (
    <div
      className={cn("rounded-xl border-2 border-dashed", ZONE_STYLES[data.tone])}
      style={{ width, height }}
      aria-hidden
    >
      <div className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-medium text-muted-foreground">
        <span className="text-foreground/80">{data.label}</span>
        <span>· {data.detail}</span>
      </div>
    </div>
  );
});
