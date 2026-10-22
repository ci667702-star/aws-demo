"use client";

import { cn } from "cn";
import { ResourceIcon, ToneBadge } from "@/components/resource-visuals";
import type { Project, Resource } from "@/lib/engine/resource-models";
import type { ProjectAnalysis } from "../analysis-context";
import { SUBNET_KIND_LABEL, SUBNET_KIND_TONE } from "../canvas/canvas-model";
import type { ProjectActions } from "./use-project-actions";

export interface FormContext {
  projectId: string;
  project: Project;
  analysis: ProjectAnalysis;
  actions: ProjectActions;
  focus: (id: string) => void;
}

export function ResourceLink({ ctx, id, className }: { ctx: FormContext; id: string | null | undefined; className?: string }) {
  const r = id ? ctx.analysis.topology.get(id) : undefined;
  if (!r) return <span className="text-muted-foreground">(없음)</span>;
  return (
    <button
      type="button"
      onClick={() => ctx.focus(r.id)}
      className={cn("inline-flex max-w-full items-center gap-1 rounded px-0.5 text-left hover:bg-muted hover:underline", className)}
      title={`${r.name}(으)로 이동`}
    >
      <ResourceIcon type={r.type} size="sm" className="size-4 [&_svg]:size-2.5" />
      <span className="truncate">{r.name}</span>
    </button>
  );
}

export function ResourceList({ ctx, resources, empty, extra }: { ctx: FormContext; resources: Resource[]; empty: string; extra?: (r: Resource) => React.ReactNode }) {
  if (!resources.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1">
      {resources.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
          <ResourceLink ctx={ctx} id={r.id} />
          {extra?.(r)}
        </li>
      ))}
    </ul>
  );
}

export function SubnetKindBadge({ ctx, subnetId }: { ctx: FormContext; subnetId: string }) {
  const cls = ctx.analysis.topology.classifySubnet(subnetId);
  return (
    <ToneBadge tone={SUBNET_KIND_TONE[cls.kind]} title={cls.reason}>
      {SUBNET_KIND_LABEL[cls.kind]}
    </ToneBadge>
  );
}

/** 같은 VPC 여부에 따라 선택 가능 상태를 계산한다 */
export function vpcCompatibility(ctx: FormContext, resourceId: string, otherId: string): { ok: boolean; reason?: string } {
  const t = ctx.analysis.topology;
  const mine = t.vpcsOf(resourceId);
  const theirs = t.vpcsOf(otherId);
  if (!mine.length || !theirs.length || mine.some((v) => theirs.includes(v))) return { ok: true };
  return { ok: false, reason: `다른 VPC(${theirs.map((v) => t.name(v)).join(", ")})에 있습니다.` };
}
