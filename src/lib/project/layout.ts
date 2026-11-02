/**
 * 자동 정렬: AWS 아키텍처 그림처럼 VPC마다 가용 영역을 열로, 서브넷 종류를 행으로 배치한다.
 *  맨 위: Internet Gateway, ALB
 *  서브넷 행: 퍼블릭 → (대상 그룹) → 프라이빗(NAT) → 프라이빗(격리). 서브넷 아래로 NAT Gateway, EC2, 탄력적 IP
 *  그 아래: DB Subnet Group, RDS
 *  오른쪽 1열: VPC, 라우팅 테이블, Network ACL (연결된 서브넷과 같은 높이)
 *  오른쪽 2열: Security Group (연결된 리소스와 같은 높이)
 * VPC에 속하지 않은 리소스는 오른쪽에 격자로 배치한다.
 */
import { buildTopology } from "@/lib/engine/topology-engine";
import type { Project, Resource } from "@/lib/engine/resource-models";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;
const COL = NODE_WIDTH + 48;
const ROW = NODE_HEIGHT + 40;
/** 서브넷 행 위의 여백 (서브넷 영역 제목이 들어간다) */
const TIER_GAP = 28;
/** 오른쪽 열의 노드 간격 */
const SIDE_ROW = NODE_HEIGHT + 24;
const VPC_GAP = 160;
const SUBNET_TIERS = ["public", "private-nat", "private-isolated", "unattached"] as const;

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
  const occupied = (x: number, y: number) => Object.values(positions).some((p) => p.x === Math.round(x) && p.y === Math.round(y));

  for (const vpc of topo.ofType("vpc")) {
    const inVpc = (r: Resource) => topo.vpcOf(r.id) === vpc.id || topo.vpcsOf(r.id).includes(vpc.id);
    const subnets = topo.subnetsOfVpc(vpc.id);
    const azs = [...new Set(subnets.map((s) => s.config.availabilityZone))].sort();
    const tiers = SUBNET_TIERS.map((kind) => subnets.filter((s) => topo.classifySubnet(s.id).kind === kind)).filter((tier) => tier.length > 0);

    const albs = topo.ofType("alb").filter(inVpc);
    const tgs = topo
      .ofType("target-group")
      .filter((tg) => inVpc(tg) || albs.some((a) => topo.listenersOf(a.id).some((b) => b.targetGroupId === tg.id)));
    // 대상 그룹은 대상(EC2)이 있는 서브넷 행 바로 위에 둔다. 대상이 없거나 첫 행에 있으면 ALB 옆에 둔다
    const tierOfTargetGroup = (tgId: string) => {
      const found = topo
        .targetGroupTargets(tgId)
        .map((t) => tiers.findIndex((tier) => tier.some((s) => s.id === topo.subnetOf(t.ec2.id))))
        .filter((i) => i >= 0);
      return found.length ? Math.min(...found) : 0;
    };
    const topRow = [
      topo.igwOfVpc(vpc.id)?.id,
      ...albs.map((a) => a.id),
      ...tgs.filter((tg) => tierOfTargetGroup(tg.id) === 0).map((tg) => tg.id),
    ].filter((x): x is string => !!x);
    const targetRows = tiers.map((_, i) => (i === 0 ? [] : tgs.filter((tg) => tierOfTargetGroup(tg.id) === i).map((tg) => tg.id)));
    const dbRow = [...topo.ofType("db-subnet-group").filter(inVpc), ...topo.ofType("rds").filter(inVpc)].map((r) => r.id);

    const columns = Math.max(1, azs.length, topRow.length, dbRow.length, ...targetRows.map((row) => row.length));
    /** 한 줄에 count개를 놓을 때 i번째의 x (가운데 정렬) */
    const rowX = (count: number, i: number) => originX + ((columns - count) / 2 + i) * COL;
    const sideX = originX + columns * COL;

    let y = 0;
    const placeRow = (ids: string[]) => {
      if (!ids.length) return;
      ids.forEach((id, i) => place(id, rowX(ids.length, i), y));
      y += ROW;
    };

    placeRow(topRow);
    tiers.forEach((tier, t) => {
      placeRow(targetRows[t]);
      y += TIER_GAP;
      let bottom = y;
      const attached: { memberId: string; x: number; y: number }[] = [];
      azs.forEach((az, c) => {
        const x = rowX(azs.length, c);
        let cy = y;
        for (const subnet of tier.filter((s) => s.config.availabilityZone === az)) {
          place(subnet.id, x, cy);
          cy += ROW;
          const members = [
            ...topo.ofType("nat-gateway").filter((n) => topo.subnetOf(n.id) === subnet.id),
            ...topo.ofType("ec2").filter((e) => topo.subnetOf(e.id) === subnet.id),
          ];
          for (const m of members) {
            if (place(m.id, x, cy)) {
              attached.push({ memberId: m.id, x, y: cy });
              cy += ROW;
            }
          }
        }
        bottom = Math.max(bottom, cy);
      });
      // 탄력적 IP는 연결된 리소스 옆 빈 칸에 둔다 (빈 칸이 없으면 그 행 아래)
      for (const a of attached) {
        const eip = topo.elasticIpOf(a.memberId);
        if (!eip) continue;
        const free = [a.x + COL, a.x - COL].find((x) => x >= originX && x < sideX && !occupied(x, a.y));
        if (free !== undefined) place(eip.id, free, a.y);
        else if (place(eip.id, a.x, bottom)) bottom += ROW;
      }
      y = bottom;
    });
    placeRow(dbRow);

    const nextSideY = [0, 0];
    const placeSide = (id: string, col: number, wantedY: number) => {
      const sideY = Math.max(wantedY, nextSideY[col]);
      if (place(id, sideX + col * COL, sideY)) nextSideY[col] = sideY + SIDE_ROW;
    };
    const topOf = (ids: string[]) => {
      const ys = ids.flatMap((id) => (positions[id] ? [positions[id].y] : []));
      return ys.length ? Math.min(...ys) : 0;
    };
    const usersOfRouteTable = (rtId: string) =>
      subnets
        .filter((s) => {
          const ref = topo.routeTableRefFor(s.id);
          return (ref.kind === "explicit" || ref.kind === "main") && ref.routeTableId === rtId;
        })
        .map((s) => s.id);

    placeSide(vpc.id, 0, 0);
    [
      ...topo.routeTablesOfVpc(vpc.id).map((rt) => ({ id: rt.id, y: topOf(usersOfRouteTable(rt.id)) })),
      ...topo
        .ofType("network-acl")
        .filter(inVpc)
        // 기본 NACL은 모든 서브넷에 적용되므로 맨 위에 둔다
        .map((n) => ({ id: n.id, y: n.config.isDefault ? 0 : topOf(topo.outgoing(n.id, "network-acl-subnet").map((c) => c.targetResourceId)) })),
    ]
      .sort((a, b) => a.y - b.y)
      .forEach((item) => placeSide(item.id, 0, item.y));

    const sgs = topo
      .ofType("security-group")
      .filter(inVpc)
      .map((sg) => ({ id: sg.id, y: topOf(topo.resourcesUsingSecurityGroup(sg.id).map((r) => r.id)) }))
      .sort((a, b) => a.y - b.y);
    sgs.forEach((item) => placeSide(item.id, 1, item.y));

    originX = sideX + (sgs.length ? 2 : 1) * COL + VPC_GAP;
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
