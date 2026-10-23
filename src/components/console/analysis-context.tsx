"use client";

import { createContext, useContext } from "react";
import type { TargetHealth } from "@/lib/engine/alb-engine";
import { buildTopology, type Topology } from "@/lib/engine/topology-engine";
import type { Project } from "@/lib/engine/resource-models";
import {
  createValidationContext,
  runValidationRules,
  type Severity,
  type ValidationFinding,
} from "@/lib/engine/validation-engine";

export interface ProjectAnalysis {
  project: Project;
  topology: Topology;
  findings: ValidationFinding[];
  counts: Record<Severity, number>;
  health: Map<string, TargetHealth[]>;
  findingsByResource: Map<string, ValidationFinding[]>;
  analyzedAt: string;
  durationMs: number;
}

/** 프로젝트 전체 분석 (토폴로지 + 검증 + 대상 헬스). 결과는 입력 프로젝트로부터 결정적이다. */
export function analyzeProject(project: Project): ProjectAnalysis {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const topology = buildTopology(project);
  const ctx = createValidationContext(topology);
  const findings = runValidationRules(ctx);
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const findingsByResource = new Map<string, ValidationFinding[]>();
  for (const f of findings) {
    counts[f.severity] += 1;
    for (const id of f.resourceIds) {
      if (!findingsByResource.has(id)) findingsByResource.set(id, []);
      findingsByResource.get(id)!.push(f);
    }
  }
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    project,
    topology,
    findings,
    counts,
    health: ctx.health,
    findingsByResource,
    analyzedAt: new Date().toISOString(),
    durationMs: Math.round(ended - started),
  };
}

const AnalysisContext = createContext<ProjectAnalysis | null>(null);

export const AnalysisProvider = AnalysisContext.Provider;

export function useAnalysis(): ProjectAnalysis {
  const value = useContext(AnalysisContext);
  if (!value) throw new Error("useAnalysis는 AnalysisProvider 안에서만 사용할 수 있습니다.");
  return value;
}
