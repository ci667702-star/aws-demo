"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import type { ConfigOf, Project, RelationType, Resource, ResourceType } from "@/lib/engine/resource-models";
import {
  renameResource,
  setSingleRelation,
  toggleRelation,
  updateResourceConfig,
  type MutationResult,
} from "@/lib/project/mutations";
import { useProjectStore } from "@/lib/store/project-store";

export interface ProjectActions {
  /** 변경을 적용한다. 실패하면 토스트로 알리고 오류 메시지를 반환한다. */
  run: (label: string, mutate: (p: Project) => MutationResult) => string | null;
  updateConfig: <T extends ResourceType>(resource: Resource, patch: Partial<ConfigOf<T>>, label?: string) => string | null;
  rename: (resource: Resource, name: string) => string | null;
  setRelation: (resourceId: string, relation: RelationType, otherId: string | null, label?: string) => string | null;
  toggle: (resourceId: string, otherId: string, enabled: boolean, label?: string) => string | null;
}

export function useProjectActions(projectId: string): ProjectActions {
  const apply = useProjectStore((s) => s.apply);
  return useMemo(() => {
    const run: ProjectActions["run"] = (label, mutate) => {
      const r = apply(projectId, label, mutate);
      if (!r.ok) {
        toast.error(r.error, r.hint ? { description: r.hint } : undefined);
        return r.error;
      }
      for (const note of r.notes) toast.info(note);
      return null;
    };
    return {
      run,
      updateConfig: (resource, patch, label) =>
        run(label ?? `${resource.name} 설정 변경`, (p) => updateResourceConfig(p, resource.id, patch)),
      rename: (resource, name) => run(`${resource.name} 이름 변경`, (p) => renameResource(p, resource.id, name)),
      setRelation: (resourceId, relation, otherId, label) =>
        run(label ?? "관계 변경", (p) => setSingleRelation(p, resourceId, relation, otherId)),
      toggle: (resourceId, otherId, enabled, label) =>
        run(label ?? (enabled ? "연결 추가" : "연결 해제"), (p) => toggleRelation(p, resourceId, otherId, enabled)),
    };
  }, [apply, projectId]);
}
