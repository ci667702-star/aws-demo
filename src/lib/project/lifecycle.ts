/**
 * 가상 리소스 수명 주기.
 * AWS처럼 새로 만든 리소스는 준비 상태(pending / provisioning / creating)를 거친 뒤 잠시 후 사용 가능 상태가 된다.
 * 대기 시간은 학습용 가상 시간이며 실제로 만들어지는 리소스는 없다.
 */
import type { Project, ResourceType } from "@/lib/engine/resource-models";

export interface LifecycleTransition {
  type: ResourceType;
  from: string;
  to: string;
  delayMs: number;
}

export const TRANSITIONS: LifecycleTransition[] = [
  { type: "ec2", from: "pending", to: "running", delayMs: 1500 },
  { type: "nat-gateway", from: "pending", to: "available", delayMs: 2500 },
  { type: "alb", from: "provisioning", to: "active", delayMs: 2500 },
  { type: "rds", from: "creating", to: "available", delayMs: 3500 },
];

/** 테스트에서 대기 시간을 줄이기 위한 배율 */
export const lifecycleTiming = { scale: 1 };

export interface PendingTransition {
  resourceId: string;
  from: string;
  to: string;
  delayMs: number;
}

function stateOf(config: unknown): string | undefined {
  const state = (config as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

/** 프로젝트에서 상태 전이를 기다리는 리소스 목록 */
export function pendingTransitions(project: Project): PendingTransition[] {
  const result: PendingTransition[] = [];
  for (const r of project.resources) {
    const state = stateOf(r.config);
    const t = TRANSITIONS.find((x) => x.type === r.type && x.from === state);
    if (t) result.push({ resourceId: r.id, from: t.from, to: t.to, delayMs: Math.round(t.delayMs * lifecycleTiming.scale) });
  }
  return result;
}

/** 리소스가 아직 from 상태이면 to 상태로 바꾼 프로젝트를, 아니면 null을 돌려준다. */
export function advanceLifecycle(project: Project, resourceId: string, from: string, to: string): Project | null {
  const r = project.resources.find((x) => x.id === resourceId);
  if (!r || stateOf(r.config) !== from) return null;
  return {
    ...project,
    resources: project.resources.map((x) => (x.id === resourceId ? ({ ...x, config: { ...x.config, state: to } } as typeof x) : x)),
  };
}

/** 모든 대기 중인 전이를 즉시 완료한 프로젝트 (테스트·가져오기 미리보기용) */
export function settleLifecycle(project: Project): Project {
  let p = project;
  for (const t of pendingTransitions(project)) p = advanceLifecycle(p, t.resourceId, t.from, t.to) ?? p;
  return p;
}
