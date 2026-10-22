/**
 * 프로젝트 변경 연산 (순수 함수).
 * 모든 연산은 새 Project 객체를 반환하며, 잘못된 입력은 이유와 함께 거부한다.
 * 스토어(Undo/Redo, 저장)는 이 함수들을 감싸기만 한다.
 */
import { parseCidr } from "@/lib/engine/cidr-utils";
import { checkConnection, type ConnectionOptions } from "@/lib/engine/connection-rules";
import { createId } from "@/lib/engine/ids";
import {
  configSchemas,
  findRelationSpec,
  RELATION_SPECS,
  type ConfigOf,
  type Connection,
  type CostAssumptions,
  type Ec2State,
  type Project,
  type RelationType,
  type Resource,
  type ResourceType,
  type Viewport,
} from "@/lib/engine/resource-models";
import { buildTopology } from "@/lib/engine/topology-engine";
import { createResource } from "./factory";
import { applyAutoLayout } from "./layout";

export type MutationResult =
  | { ok: true; project: Project; notes: string[]; createdId?: string }
  | { ok: false; error: string; hint?: string };

const ok = (project: Project, notes: string[] = [], createdId?: string): MutationResult => ({
  ok: true,
  project,
  notes,
  createdId,
});
const fail = (error: string, hint?: string): MutationResult => ({ ok: false, error, hint });

export function touch(project: Project): Project {
  return { ...project, updatedAt: new Date().toISOString() };
}

function replaceResource(project: Project, resource: Resource): Project {
  return { ...project, resources: project.resources.map((r) => (r.id === resource.id ? resource : r)) };
}

export function addResource(
  project: Project,
  type: ResourceType,
  position: { x: number; y: number },
): MutationResult {
  if (project.resources.length >= 500) return fail("한 프로젝트에는 리소스를 최대 500개까지 만들 수 있습니다.");
  const resource = createResource(project, type, position) as Resource;
  return ok(touch({ ...project, resources: [...project.resources, resource] }), [], resource.id);
}

export function deleteResources(project: Project, ids: string[]): MutationResult {
  const remove = new Set(ids.filter((id) => project.resources.some((r) => r.id === id)));
  if (!remove.size) return fail("삭제할 리소스가 없습니다.");
  const notes: string[] = [];
  const removedConnections = project.connections.filter((c) => remove.has(c.sourceResourceId) || remove.has(c.targetResourceId));
  if (removedConnections.length) notes.push(`관련 연결 ${removedConnections.length}개를 함께 삭제했습니다.`);
  let strippedRules = 0;
  const resources = project.resources
    .filter((r) => !remove.has(r.id))
    .map((r) => {
      if (r.type !== "security-group") return r;
      const keep = (rule: (typeof r.config.inboundRules)[number]) =>
        !(rule.peer.kind === "security-group" && remove.has(rule.peer.securityGroupId));
      const inboundRules = r.config.inboundRules.filter(keep);
      const outboundRules = r.config.outboundRules.filter(keep);
      const removed = r.config.inboundRules.length - inboundRules.length + r.config.outboundRules.length - outboundRules.length;
      if (!removed) return r;
      strippedRules += removed;
      return { ...r, config: { ...r.config, inboundRules, outboundRules } };
    });
  if (strippedRules) notes.push(`삭제된 보안 그룹을 참조하던 규칙 ${strippedRules}개를 정리했습니다.`);
  return ok(
    touch({
      ...project,
      resources,
      connections: project.connections.filter((c) => !remove.has(c.sourceResourceId) && !remove.has(c.targetResourceId)),
    }),
    notes,
  );
}

export function renameResource(project: Project, id: string, name: string): MutationResult {
  const trimmed = name.trim();
  if (!trimmed) return fail("이름을 입력하세요.");
  if (trimmed.length > 128) return fail("이름은 128자 이하여야 합니다.");
  const r = project.resources.find((x) => x.id === id);
  if (!r) return fail("리소스를 찾을 수 없습니다.");
  if (r.name === trimmed) return ok(project);
  return ok(touch(replaceResource(project, { ...r, name: trimmed })));
}

const EC2_TRANSITIONS: Record<Ec2State, Ec2State[]> = {
  pending: ["running", "stopped", "terminated"],
  running: ["stopped", "terminated"],
  stopped: ["pending", "running", "terminated"],
  terminated: [],
};

export function canTransitionEc2(from: Ec2State, to: Ec2State): boolean {
  return from === to || EC2_TRANSITIONS[from].includes(to);
}

export function updateResourceConfig<T extends ResourceType>(
  project: Project,
  id: string,
  patch: Partial<ConfigOf<T>>,
): MutationResult {
  const r = project.resources.find((x) => x.id === id);
  if (!r) return fail("리소스를 찾을 수 없습니다.");
  const next = { ...r.config, ...patch };
  const schema = configSchemas[r.type];
  const parsed = schema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`설정값이 올바르지 않습니다: ${issue?.path.join(".") || "config"} — ${issue?.message ?? "알 수 없는 오류"}`);
  }
  if (r.type === "ec2" && "state" in patch) {
    const from = r.config.state;
    const to = (next as ConfigOf<"ec2">).state;
    if (!canTransitionEc2(from, to)) {
      return fail(
        from === "terminated"
          ? "Terminated 상태의 인스턴스는 다시 시작하거나 상태를 바꿀 수 없습니다."
          : `${from} 상태에서 ${to} 상태로 바로 전환할 수 없습니다.`,
      );
    }
  }
  let connections = project.connections;
  const notes: string[] = [];
  if (r.type === "alb") {
    const listenerIds = new Set((next as ConfigOf<"alb">).listeners.map((l) => l.id));
    const orphaned = connections.filter(
      (c) => c.relationType === "alb-target-group" && c.sourceResourceId === r.id && !listenerIds.has(c.metadata.listenerId),
    );
    if (orphaned.length) {
      connections = connections.filter((c) => !orphaned.includes(c));
      notes.push("삭제된 리스너의 대상 그룹 전달 연결을 함께 삭제했습니다.");
    }
  }
  const updated = { ...r, config: parsed.data } as Resource;
  return ok(touch({ ...replaceResource(project, updated), connections }), notes);
}

export function moveResources(project: Project, positions: Record<string, { x: number; y: number }>): MutationResult {
  let changed = false;
  const resources = project.resources.map((r) => {
    const p = positions[r.id];
    if (!p || (p.x === r.position.x && p.y === r.position.y)) return r;
    changed = true;
    return { ...r, position: { x: Math.round(p.x), y: Math.round(p.y) } };
  });
  return changed ? ok(touch({ ...project, resources })) : ok(project);
}

function applyPlan(
  project: Project,
  plan: Extract<ReturnType<typeof checkConnection>, { ok: true }>,
  removeIds: string[] = [],
): MutationResult {
  let next: Project = {
    ...project,
    connections: [...project.connections.filter((c) => !removeIds.includes(c.id)), plan.connection],
  };
  for (const { resourceId, patch } of plan.configPatches) {
    const r = next.resources.find((x) => x.id === resourceId);
    if (!r) continue;
    next = replaceResource(next, { ...r, config: { ...r.config, ...patch } } as Resource);
  }
  return ok(touch(next), plan.notes, plan.connection.id);
}

export function connectResources(project: Project, aId: string, bId: string, options: ConnectionOptions = {}): MutationResult {
  const plan = checkConnection(project, aId, bId, options);
  if (!plan.ok) return fail(plan.reason, plan.hint);
  return applyPlan(project, plan, options.ignoreConnectionIds);
}

export function disconnect(project: Project, connectionIds: string[]): MutationResult {
  const remove = new Set(connectionIds);
  const connections = project.connections.filter((c) => !remove.has(c.id));
  if (connections.length === project.connections.length) return fail("삭제할 연결이 없습니다.");
  return ok(touch({ ...project, connections }));
}

/** 리소스가 해당 관계에서 source인지 target인지 */
function roleOf(resourceType: ResourceType, relationType: RelationType): "source" | "target" {
  return RELATION_SPECS[relationType].source === resourceType ? "source" : "target";
}

/**
 * 단일 관계를 설정/교체한다 (설정 패널의 선택 상자용).
 * 예: 서브넷의 VPC 선택 → 기존 vpc-subnet 연결을 교체.
 */
export function setSingleRelation(
  project: Project,
  resourceId: string,
  relationType: RelationType,
  otherId: string | null,
): MutationResult {
  const r = project.resources.find((x) => x.id === resourceId);
  if (!r) return fail("리소스를 찾을 수 없습니다.");
  const role = roleOf(r.type, relationType);
  const existing = project.connections.filter((c) =>
    c.relationType === relationType && (role === "source" ? c.sourceResourceId === resourceId : c.targetResourceId === resourceId),
  );
  if (!otherId) {
    if (!existing.length) return ok(project);
    return disconnect(project, existing.map((c) => c.id));
  }
  const already = existing.find((c) => (role === "source" ? c.targetResourceId : c.sourceResourceId) === otherId);
  if (already && existing.length === 1) return ok(project);
  return connectResources(project, resourceId, otherId, { ignoreConnectionIds: existing.map((c) => c.id) });
}

/** 다중 관계(예: 보안 그룹 연결)를 켜거나 끈다. */
export function toggleRelation(project: Project, resourceId: string, otherId: string, enabled: boolean): MutationResult {
  const a = project.resources.find((x) => x.id === resourceId);
  const b = project.resources.find((x) => x.id === otherId);
  if (!a || !b) return fail("리소스를 찾을 수 없습니다.");
  const found = findRelationSpec(a.type, b.type);
  if (!found) return fail("지원되지 않는 관계입니다.");
  const [source, target] = found.reversed ? [b, a] : [a, b];
  const existing = project.connections.filter(
    (c) => c.relationType === found.spec.type && c.sourceResourceId === source.id && c.targetResourceId === target.id,
  );
  if (enabled) return existing.length ? ok(project) : connectResources(project, resourceId, otherId);
  return existing.length ? disconnect(project, existing.map((c) => c.id)) : ok(project);
}

/** 라우팅 경로 추가 */
export function addRoute(project: Project, routeTableId: string, targetId: string, destinationCidr: string): MutationResult {
  return connectResources(project, routeTableId, targetId, { destinationCidr });
}

/** 라우팅 경로의 Destination 수정 */
export function updateRouteDestination(project: Project, connectionId: string, destinationCidr: string): MutationResult {
  const conn = project.connections.find((c) => c.id === connectionId);
  if (!conn || (conn.relationType !== "route-table-internet-gateway" && conn.relationType !== "route-table-nat-gateway")) {
    return fail("경로를 찾을 수 없습니다.");
  }
  const parsed = parseCidr(destinationCidr);
  if (!parsed.ok) return fail(parsed.error);
  const topo = buildTopology(project);
  const duplicate = topo
    .routesOf(conn.sourceResourceId, topo.vpcOf(conn.sourceResourceId))
    .find((r) => r.key !== conn.id && r.cidr?.text === parsed.value.text);
  if (duplicate) {
    return fail(`이미 ${parsed.value.text} 경로가 있습니다 (대상: ${topo.routeTargetLabel(duplicate)}).`, "같은 Destination의 경로는 하나만 둘 수 있습니다.");
  }
  const updated = { ...conn, metadata: { destinationCidr: parsed.value.text } } as Connection;
  return ok(touch({ ...project, connections: project.connections.map((c) => (c.id === conn.id ? updated : c)) }));
}

/** 라우팅 경로의 대상(IGW/NAT) 변경 */
export function updateRouteTarget(project: Project, connectionId: string, targetId: string): MutationResult {
  const conn = project.connections.find((c) => c.id === connectionId);
  if (!conn || (conn.relationType !== "route-table-internet-gateway" && conn.relationType !== "route-table-nat-gateway")) {
    return fail("경로를 찾을 수 없습니다.");
  }
  return connectResources(project, conn.sourceResourceId, targetId, {
    destinationCidr: conn.metadata.destinationCidr,
    ignoreConnectionIds: [conn.id],
  });
}

/** ALB 리스너의 대상 그룹 설정 (null이면 전달 해제) */
export function setListenerTargetGroup(project: Project, albId: string, listenerId: string, targetGroupId: string | null): MutationResult {
  const existing = project.connections.filter(
    (c) => c.relationType === "alb-target-group" && c.sourceResourceId === albId && c.metadata.listenerId === listenerId,
  );
  if (!targetGroupId) return existing.length ? disconnect(project, existing.map((c) => c.id)) : ok(project);
  return connectResources(project, albId, targetGroupId, { listenerId, ignoreConnectionIds: existing.map((c) => c.id) });
}

/** VPC의 기본(main) 라우팅 테이블 지정 (null이면 해제). VPC당 하나만 유지한다. */
export function setMainRouteTable(project: Project, vpcId: string, routeTableId: string | null): MutationResult {
  const topo = buildTopology(project);
  const tables = topo.routeTablesOfVpc(vpcId);
  if (routeTableId && !tables.some((t) => t.id === routeTableId)) {
    return fail("기본 라우팅 테이블은 같은 VPC에 속한 라우팅 테이블이어야 합니다.");
  }
  const ids = new Set(tables.map((t) => t.id));
  let changed = false;
  const resources = project.resources.map((r) => {
    if (r.type !== "route-table" || !ids.has(r.id)) return r;
    const main = r.id === routeTableId;
    if (r.config.main === main) return r;
    changed = true;
    return { ...r, config: { ...r.config, main } };
  });
  return changed ? ok(touch({ ...project, resources })) : ok(project);
}

export function setViewport(project: Project, viewport: Viewport): Project {
  return { ...project, viewport };
}

export function setCostAssumptions(project: Project, assumptions: CostAssumptions | null): MutationResult {
  return ok(touch({ ...project, costAssumptions: assumptions }));
}

export function autoLayout(project: Project): MutationResult {
  return ok(touch(applyAutoLayout(project)));
}

export function renameProject(project: Project, name: string): MutationResult {
  const trimmed = name.trim();
  if (!trimmed) return fail("프로젝트 이름을 입력하세요.");
  if (trimmed.length > 100) return fail("프로젝트 이름은 100자 이하여야 합니다.");
  return ok(touch({ ...project, name: trimmed }));
}

export function duplicateProject(project: Project, name?: string): Project {
  const now = new Date().toISOString();
  return {
    ...structuredClone(project),
    id: createId("proj"),
    name: name ?? `${project.name} (복사본)`.slice(0, 100),
    createdAt: now,
    updatedAt: now,
  };
}
