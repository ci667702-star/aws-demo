/**
 * 프로젝트 → 캔버스 표시 모델 변환 (순수 함수).
 */
import type { Edge, Node } from "@xyflow/react";
import type { TargetHealth } from "@/lib/engine/alb-engine";
import { formatIpv4 } from "@/lib/engine/cidr-utils";
import {
  RELATION_SPECS,
  RESOURCE_TYPE_INFO,
  type Connection,
  type RelationCategory,
  type Resource,
} from "@/lib/engine/resource-models";
import { displayName, type SubnetKind, type Topology } from "@/lib/engine/topology-engine";
import type { ValidationFinding } from "@/lib/engine/validation-engine";
import type { Tone } from "@/components/resource-visuals";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/project/layout";

export interface NodeBadge {
  label: string;
  tone: Tone;
  title?: string;
}

export type PathState = "active" | "failed" | "pending" | null;

export interface ResourceNodeData extends Record<string, unknown> {
  resource: Resource;
  typeLabel: string;
  subtitle: string;
  badges: NodeBadge[];
  errors: number;
  warnings: number;
  pathState: PathState;
  pathOrder: number | null;
}

export interface ZoneNodeData extends Record<string, unknown> {
  kind: "vpc" | "subnet";
  label: string;
  detail: string;
  tone: SubnetKind | "vpc";
}

export interface RelationEdgeData extends Record<string, unknown> {
  connection: Connection;
  category: RelationCategory;
  label: string;
  alwaysShowLabel: boolean;
  pathActive: boolean;
  faded: boolean;
}

export type ResourceFlowNode = Node<ResourceNodeData, "resource">;
export type ZoneFlowNode = Node<ZoneNodeData, "zone">;
export type RelationFlowEdge = Edge<RelationEdgeData, "relation">;

export const SUBNET_KIND_LABEL: Record<SubnetKind, string> = {
  public: "Public",
  "private-nat": "Private (NAT)",
  "private-isolated": "Private (격리)",
  unattached: "VPC 없음",
};

export const SUBNET_KIND_TONE: Record<SubnetKind, Tone> = {
  public: "ok",
  "private-nat": "info",
  "private-isolated": "muted",
  unattached: "warn",
};

function healthSummary(health: TargetHealth[] | undefined): NodeBadge | null {
  if (!health) return null;
  if (!health.length) return { label: "대상 없음", tone: "warn" };
  const healthy = health.filter((h) => h.state === "healthy").length;
  return {
    label: `Healthy ${healthy}/${health.length}`,
    tone: healthy === health.length ? "ok" : healthy === 0 ? "error" : "warn",
    title: health.map((h) => `${h.targetName}: ${h.state}${h.reason ? ` (${h.reason})` : ""}`).join("\n"),
  };
}

export function describeResource(
  topo: Topology,
  r: Resource,
  health: Map<string, TargetHealth[]>,
): { subtitle: string; badges: NodeBadge[] } {
  switch (r.type) {
    case "vpc":
      return { subtitle: r.config.cidr || "CIDR 없음", badges: topo.igwOfVpc(r.id) ? [] : [{ label: "IGW 없음", tone: "muted" }] };
    case "subnet": {
      const cls = topo.classifySubnet(r.id);
      return {
        subtitle: `${r.config.cidr} · ${r.config.availabilityZone.replace("ap-northeast-", "")}`,
        badges: [{ label: SUBNET_KIND_LABEL[cls.kind], tone: SUBNET_KIND_TONE[cls.kind], title: cls.reason }],
      };
    }
    case "internet-gateway": {
      const vpc = topo.vpcOfIgw(r.id);
      return {
        subtitle: vpc ? `연결: ${topo.name(vpc)}` : "VPC 미연결",
        badges: vpc ? [{ label: "Attached", tone: "ok" }] : [{ label: "Detached", tone: "warn" }],
      };
    }
    case "elastic-ip": {
      const target = topo.elasticIpTarget(r.id);
      return {
        subtitle: `${r.config.publicIp} (가상)`,
        badges: target ? [{ label: `연결: ${topo.name(target.id)}`, tone: "ok" }] : [{ label: "미연결", tone: "warn" }],
      };
    }
    case "route-table": {
      const routes = topo.routesOf(r.id, topo.vpcOf(r.id)).length;
      const subnets = topo.outgoing(r.id, "route-table-subnet").length;
      return {
        subtitle: `경로 ${routes}개 · 서브넷 ${subnets}개`,
        badges: r.config.main ? [{ label: "Main", tone: "accent" }] : [],
      };
    }
    case "nat-gateway": {
      const eni = topo.enisOf(r.id)[0];
      const tone: Tone = r.config.state === "available" ? "ok" : r.config.state === "failed" ? "error" : "info";
      return {
        subtitle: eni?.publicIp != null ? `EIP ${formatIpv4(eni.publicIp)} (가상)` : "서브넷 미배치",
        badges: [{ label: r.config.state, tone }],
      };
    }
    case "security-group":
      return {
        subtitle: `인바운드 ${r.config.inboundRules.length} · 아웃바운드 ${r.config.outboundRules.length}`,
        badges: [],
      };
    case "network-acl":
      return {
        subtitle: `인바운드 ${r.config.inboundRules.length} · 아웃바운드 ${r.config.outboundRules.length}`,
        badges: [{ label: "Stateless", tone: "muted" }],
      };
    case "ec2": {
      const eni = topo.enisOf(r.id)[0];
      const stateTone: Record<string, Tone> = { running: "ok", pending: "info", stopped: "muted", terminated: "error" };
      const ips = [r.config.privateIp || "IP 없음", eni?.publicIp != null ? formatIpv4(eni.publicIp) : null].filter(Boolean).join(" · ");
      return {
        subtitle: `${r.config.instanceType} · ${ips}`,
        badges: [{ label: r.config.state, tone: stateTone[r.config.state] }],
      };
    }
    case "alb":
      return {
        subtitle: r.config.scheme,
        badges: r.config.listeners.length
          ? r.config.listeners.slice(0, 3).map((l) => ({ label: `${l.protocol}:${l.port}`, tone: "accent" as Tone }))
          : [{ label: "리스너 없음", tone: "error" }],
      };
    case "target-group": {
      const badge = healthSummary(health.get(r.id));
      return { subtitle: `${r.config.protocol}:${r.config.port}`, badges: badge ? [badge] : [] };
    }
    case "db-subnet-group": {
      const subnets = topo.dbSubnetGroupSubnets(r.id);
      const azs = new Set(subnets.map((s) => s.config.availabilityZone)).size;
      return { subtitle: `서브넷 ${subnets.length}개 · AZ ${azs}개`, badges: [] };
    }
    case "rds": {
      const badges: NodeBadge[] = [{ label: r.config.state, tone: r.config.state === "available" ? "ok" : "muted" }];
      if (r.config.publiclyAccessible) badges.push({ label: "Public", tone: "warn" });
      return { subtitle: `${r.config.engine === "mysql" ? "MySQL" : "PostgreSQL"} :${r.config.port}`, badges };
    }
  }
}

export function buildResourceNodeData(
  topo: Topology,
  r: Resource,
  health: Map<string, TargetHealth[]>,
  findings: ValidationFinding[] | undefined,
  pathState: PathState,
  pathOrder: number | null,
): ResourceNodeData {
  const { subtitle, badges } = describeResource(topo, r, health);
  return {
    resource: r,
    typeLabel: RESOURCE_TYPE_INFO[r.type].shortLabel,
    subtitle,
    badges,
    errors: findings?.filter((f) => f.severity === "error").length ?? 0,
    warnings: findings?.filter((f) => f.severity === "warning").length ?? 0,
    pathState,
    pathOrder,
  };
}

// ---------------------------------------------------------------- 영역(Zone)

export interface ZoneBox {
  id: string;
  resourceId: string;
  kind: "vpc" | "subnet";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  detail: string;
  tone: SubnetKind | "vpc";
}

type Positions = Map<string, { x: number; y: number }>;
type Sizes = (id: string) => { width: number; height: number };

function bbox(ids: string[], positions: Positions, sizes: Sizes, pad: number, top: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positions.get(id);
    if (!p) continue;
    const s = sizes(id);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - pad, y: minY - pad - top, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 + top };
}

export function computeZones(topo: Topology, positions: Positions, sizes: Sizes): ZoneBox[] {
  const zones: ZoneBox[] = [];
  for (const vpc of topo.ofType("vpc")) {
    const members = topo.project.resources
      .filter((r) => r.id === vpc.id || topo.vpcOf(r.id) === vpc.id || topo.vpcsOf(r.id).includes(vpc.id))
      .map((r) => r.id);
    const box = bbox(members, positions, sizes, 28, 22);
    if (box) {
      zones.push({
        id: `zone:${vpc.id}`,
        resourceId: vpc.id,
        kind: "vpc",
        ...box,
        label: `VPC ${displayName(vpc)}`,
        detail: vpc.config.cidr,
        tone: "vpc",
      });
    }
  }
  for (const subnet of topo.ofType("subnet")) {
    const members = [
      subnet.id,
      ...topo.ofType("ec2").filter((e) => topo.subnetOf(e.id) === subnet.id).map((e) => e.id),
      ...topo.ofType("nat-gateway").filter((n) => topo.subnetOf(n.id) === subnet.id).map((n) => n.id),
    ];
    const box = bbox(members, positions, sizes, 12, 20);
    if (box) {
      const cls = topo.classifySubnet(subnet.id);
      zones.push({
        id: `zone:${subnet.id}`,
        resourceId: subnet.id,
        kind: "subnet",
        ...box,
        label: displayName(subnet),
        detail: `${SUBNET_KIND_LABEL[cls.kind]} · ${subnet.config.cidr}`,
        tone: cls.kind,
      });
    }
  }
  return zones;
}

export const DEFAULT_NODE_SIZE = { width: NODE_WIDTH, height: NODE_HEIGHT };

export { findFreePosition, type Rect } from "@/lib/project/layout";

// ---------------------------------------------------------------- 연결선

export function edgeLabel(c: Connection, topo: Topology): string {
  if (c.relationType === "route-table-internet-gateway" || c.relationType === "route-table-nat-gateway") {
    return c.metadata.destinationCidr;
  }
  if (c.relationType === "alb-target-group") {
    const alb = topo.getOfType(c.sourceResourceId, "alb");
    const listener = alb?.config.listeners.find((l) => l.id === c.metadata.listenerId);
    return listener ? `${listener.protocol}:${listener.port}` : "전달";
  }
  return RELATION_SPECS[c.relationType].label;
}

export function isMembershipEdge(c: Connection): boolean {
  return RELATION_SPECS[c.relationType].category === "membership";
}
