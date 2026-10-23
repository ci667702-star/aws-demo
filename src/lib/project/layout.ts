/**
 * 자동 정렬: VPC별 블록으로 리소스를 배치한다.
 *  행 0: Internet Gateway, VPC, Route Table, Network ACL
 *  행 1: ALB, Target Group
 *  행 2: Subnet (열) — 아래로 해당 서브넷의 NAT Gateway, EC2
 *  다음 행: Security Group
 *  다음 행: DB Subnet Group, RDS
 * VPC에 속하지 않은 리소스는 오른쪽에 격자로 배치한다.
 */
import { buildTopology } from "@/lib/engine/topology-engine";
import type { Project, Resource } from "@/lib/engine/resource-models";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;
const COL = NODE_WIDTH + 48;
const ROW = NODE_HEIGHT + 64;
const VPC_GAP = 160;

export function computeAutoLayout(project: Project): Record<string, { x: number; y: number }> {
  const topo = buildTopology(project);
  const positions: Record<string, { x: number; y: number }> = {};
  const placed = new Set<string>();
  let originX = 0;

  const place = (id: string | undefined | null, x: number, y: number) => {
    if (!id || placed.has(id) || !topo.resources.has(id)) return false;
    positions[id] = { x: Math.round(x), y: Math.round(y) };
    placed.add(id);
    return true;
  };

  const placeRow = (ids: string[], y: number, startX: number): number => {
    let col = 0;
    for (const id of ids) if (place(id, startX + col * COL, y)) col++;
    return col;
  };

  for (const vpc of topo.ofType("vpc")) {
    const inVpc = (r: Resource) => topo.vpcOf(r.id) === vpc.id || topo.vpcsOf(r.id).includes(vpc.id);
    let width = 1;

    const row0 = [
      topo.igwOfVpc(vpc.id)?.id,
      vpc.id,
      ...topo.routeTablesOfVpc(vpc.id).map((r) => r.id),
      ...topo.ofType("network-acl").filter(inVpc).map((r) => r.id),
    ].filter((x): x is string => !!x);
    width = Math.max(width, placeRow(row0, 0, originX));

    const albs = topo.ofType("alb").filter(inVpc);
    const tgs = topo
      .ofType("target-group")
      .filter((tg) => inVpc(tg) || albs.some((a) => topo.listenersOf(a.id).some((b) => b.targetGroupId === tg.id)));
    width = Math.max(width, placeRow([...albs.map((a) => a.id), ...tgs.map((t) => t.id)], ROW, originX));

    const rank = { public: 0, "private-nat": 1, "private-isolated": 2, unattached: 3 } as const;
    const subnets = topo
      .subnetsOfVpc(vpc.id)
      .sort(
        (a, b) =>
          rank[topo.classifySubnet(a.id).kind] - rank[topo.classifySubnet(b.id).kind] ||
          a.config.availabilityZone.localeCompare(b.config.availabilityZone) ||
          topo.orderOf(a.id) - topo.orderOf(b.id),
      );
    let deepest = 0;
    subnets.forEach((subnet, i) => {
      const x = originX + i * COL;
      place(subnet.id, x, ROW * 2);
      const members = [
        ...topo.ofType("nat-gateway").filter((n) => topo.subnetOf(n.id) === subnet.id),
        ...topo.ofType("ec2").filter((e) => topo.subnetOf(e.id) === subnet.id),
      ];
      let depth = 0;
      for (const m of members) if (place(m.id, x, ROW * (3 + depth))) depth++;
      deepest = Math.max(deepest, depth);
    });
    width = Math.max(width, subnets.length);

    let y = ROW * (3 + Math.max(deepest, 0));
    const sgs = topo.ofType("security-group").filter(inVpc).map((r) => r.id);
    if (sgs.length) {
      width = Math.max(width, placeRow(sgs, y, originX));
      y += ROW;
    }
    const db = [
      ...topo.ofType("db-subnet-group").filter(inVpc).map((r) => r.id),
      ...topo.ofType("rds").filter(inVpc).map((r) => r.id),
    ];
    if (db.length) width = Math.max(width, placeRow(db, y, originX));

    originX += width * COL + VPC_GAP;
  }

  const rest = project.resources.filter((r) => !placed.has(r.id));
  rest.forEach((r, i) => {
    place(r.id, originX + (i % 3) * COL, Math.floor(i / 3) * ROW);
  });
  return positions;
}

export function applyAutoLayout(project: Project): Project {
  const positions = computeAutoLayout(project);
  return {
    ...project,
    resources: project.resources.map((r) => (positions[r.id] ? { ...r, position: positions[r.id] } : r)),
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** anchor 주변에서 기존 노드와 겹치지 않는 가장 가까운 격자 위치를 찾는다. */
export function findFreePosition(anchor: { x: number; y: number }, occupied: Rect[], size = { width: NODE_WIDTH, height: NODE_HEIGHT }): { x: number; y: number } {
  const gapX = size.width + 32;
  const gapY = size.height + 32;
  const margin = 12;
  const overlaps = (x: number, y: number) =>
    occupied.some(
      (r) => x < r.x + r.width + margin && x + size.width + margin > r.x && y < r.y + r.height + margin && y + size.height + margin > r.y,
    );
  for (let ring = 0; ring <= 10; ring++) {
    const candidates: [number, number][] = [];
    for (let j = -ring; j <= ring; j++) {
      for (let i = -ring; i <= ring; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        candidates.push([i, j]);
      }
    }
    // 오른쪽/아래쪽을 먼저 시도한다
    candidates.sort((a, b) => b[1] - a[1] || b[0] - a[0]).sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    for (const [i, j] of candidates) {
      const x = anchor.x + i * gapX;
      const y = anchor.y + j * gapY;
      if (!overlaps(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round(anchor.x), y: Math.round(anchor.y) };
}
