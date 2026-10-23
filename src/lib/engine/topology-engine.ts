/**
 * 리소스 관계 분석.
 * 프로젝트의 리소스와 연결(Connection)로부터 "누가 어디에 속하고 무엇과 연결되었는지"를 계산한다.
 * 모든 결과는 입력 프로젝트에서만 계산되며 결정적이다.
 */
import {
  RESOURCE_TYPE_INFO,
  VIRTUAL_REGION,
  type Connection,
  type Listener,
  type Project,
  type RelationType,
  type Resource,
  type ResourceOfType,
  type ResourceType,
} from "./resource-models";
import {
  awsReservedIps,
  cidrContainsIp,
  cidrFirst,
  cidrLast,
  formatIpv4,
  parseIpv4,
  tryParseCidr,
  type Cidr,
} from "./cidr-utils";
import { hashString } from "./ids";

export type RouteTargetKind = "local" | "internet-gateway" | "nat-gateway";

export interface EffectiveRoute {
  /** "local" 또는 경로를 정의한 연결 ID */
  key: string;
  destinationCidr: string;
  cidr: Cidr | null;
  targetKind: RouteTargetKind;
  targetId: string | null;
  connectionId: string | null;
}

export type RouteTableRef =
  | { kind: "explicit"; routeTableId: string }
  | { kind: "main"; routeTableId: string }
  | { kind: "implicit-main" }
  | { kind: "none" };

export interface SubnetRouting {
  vpcId: string | null;
  table: RouteTableRef;
  routes: EffectiveRoute[];
}

export type SubnetKind = "public" | "private-nat" | "private-isolated" | "unattached";

export interface SubnetClassification {
  kind: SubnetKind;
  reason: string;
  route: EffectiveRoute | null;
}

export interface Eni {
  id: string;
  ownerId: string;
  ownerType: "ec2" | "alb" | "nat-gateway" | "rds";
  label: string;
  subnetId: string | null;
  vpcId: string | null;
  privateIp: number | null;
  publicIp: number | null;
  /** null이면 보안 그룹이 적용되지 않는 인터페이스 (NAT Gateway) */
  securityGroupIds: string[] | null;
  managed: boolean;
}

export interface ListenerBinding {
  listener: Listener;
  targetGroupId: string | null;
  connectionId: string | null;
}

/** 가상 공인 IP 풀 (RFC 5737 TEST-NET-2). 실제 공인 IP가 아니다. */
export const VIRTUAL_PUBLIC_POOL = "198.51.100.0/24";

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s || "resource";
}

export class Topology {
  readonly project: Project;
  readonly resources: Map<string, Resource>;
  readonly connections: Connection[];
  private readonly outMap = new Map<string, Connection[]>();
  private readonly inMap = new Map<string, Connection[]>();
  private readonly order = new Map<string, number>();
  private readonly cache = new Map<string, unknown>();

  constructor(project: Project) {
    this.project = project;
    this.resources = new Map(project.resources.map((r) => [r.id, r]));
    this.connections = project.connections;
    project.resources.forEach((r, i) => this.order.set(r.id, i));
    for (const c of project.connections) {
      if (!this.outMap.has(c.sourceResourceId)) this.outMap.set(c.sourceResourceId, []);
      if (!this.inMap.has(c.targetResourceId)) this.inMap.set(c.targetResourceId, []);
      this.outMap.get(c.sourceResourceId)!.push(c);
      this.inMap.get(c.targetResourceId)!.push(c);
    }
  }

  private memo<T>(key: string, compute: () => T): T {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const value = compute();
    this.cache.set(key, value);
    return value;
  }

  // ---------------------------------------------------------------- 기본 조회

  get(id: string | null | undefined): Resource | undefined {
    return id ? this.resources.get(id) : undefined;
  }

  getOfType<T extends ResourceType>(id: string | null | undefined, type: T): ResourceOfType<T> | undefined {
    const r = this.get(id);
    return r && r.type === type ? (r as ResourceOfType<T>) : undefined;
  }

  ofType<T extends ResourceType>(type: T): ResourceOfType<T>[] {
    return this.project.resources.filter((r): r is ResourceOfType<T> => r.type === type);
  }

  orderOf(id: string): number {
    return this.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  /** Name 태그 (없으면 리소스 ID) */
  name(id: string | null | undefined): string {
    const r = this.get(id);
    return r ? displayName(r) : (id ?? "(없음)");
  }

  /** 예: "web-1 (EC2)" */
  label(id: string | null | undefined): string {
    const r = this.get(id);
    if (!r) return id ?? "(없음)";
    return `${displayName(r)} (${RESOURCE_TYPE_INFO[r.type].shortLabel})`;
  }

  outgoing(id: string, relation?: RelationType): Connection[] {
    const list = this.outMap.get(id) ?? [];
    return relation ? list.filter((c) => c.relationType === relation) : list;
  }

  incoming(id: string, relation?: RelationType): Connection[] {
    const list = this.inMap.get(id) ?? [];
    return relation ? list.filter((c) => c.relationType === relation) : list;
  }

  connectionsOf(id: string): Connection[] {
    return [...this.outgoing(id), ...this.incoming(id)];
  }

  private firstTarget(id: string, relation: RelationType): string | null {
    const c = this.outgoing(id, relation).find((x) => this.resources.has(x.targetResourceId));
    return c ? c.targetResourceId : null;
  }

  private firstSource(id: string, relation: RelationType): string | null {
    const c = this.incoming(id, relation).find((x) => this.resources.has(x.sourceResourceId));
    return c ? c.sourceResourceId : null;
  }

  private targets(id: string, relation: RelationType): string[] {
    return this.outgoing(id, relation)
      .map((c) => c.targetResourceId)
      .filter((t) => this.resources.has(t));
  }

  // ---------------------------------------------------------------- 소속 관계

  vpcOfSubnet(subnetId: string): string | null {
    return this.firstSource(subnetId, "vpc-subnet");
  }

  subnetsOfVpc(vpcId: string): ResourceOfType<"subnet">[] {
    return this.targets(vpcId, "vpc-subnet")
      .map((id) => this.getOfType(id, "subnet"))
      .filter((s): s is ResourceOfType<"subnet"> => !!s);
  }

  igwOfVpc(vpcId: string): ResourceOfType<"internet-gateway"> | undefined {
    return this.getOfType(this.firstTarget(vpcId, "vpc-internet-gateway"), "internet-gateway");
  }

  vpcOfIgw(igwId: string): string | null {
    return this.firstSource(igwId, "vpc-internet-gateway");
  }

  /** 리소스에 연결된 탄력적 IP (EC2, NAT Gateway) */
  elasticIpOf(resourceId: string): ResourceOfType<"elastic-ip"> | undefined {
    const c = this.incoming(resourceId).find(
      (x) => x.relationType === "elastic-ip-ec2" || x.relationType === "elastic-ip-nat-gateway",
    );
    return this.getOfType(c?.sourceResourceId, "elastic-ip");
  }

  /** 탄력적 IP가 연결된 대상 (없으면 undefined) */
  elasticIpTarget(eipId: string): Resource | undefined {
    const c = this.outgoing(eipId).find(
      (x) => x.relationType === "elastic-ip-ec2" || x.relationType === "elastic-ip-nat-gateway",
    );
    return this.get(c?.targetResourceId);
  }

  subnetOf(resourceId: string): string | null {
    const r = this.get(resourceId);
    if (!r) return null;
    if (r.type === "ec2") return this.firstTarget(r.id, "ec2-subnet");
    if (r.type === "nat-gateway") return this.firstTarget(r.id, "nat-gateway-subnet");
    return null;
  }

  securityGroupsOf(resourceId: string): ResourceOfType<"security-group">[] {
    const r = this.get(resourceId);
    if (!r) return [];
    const relation: RelationType | null =
      r.type === "ec2"
        ? "ec2-security-group"
        : r.type === "alb"
          ? "alb-security-group"
          : r.type === "rds"
            ? "rds-security-group"
            : null;
    if (!relation) return [];
    return this.targets(r.id, relation)
      .map((id) => this.getOfType(id, "security-group"))
      .filter((s): s is ResourceOfType<"security-group"> => !!s);
  }

  resourcesUsingSecurityGroup(sgId: string): Resource[] {
    return this.incoming(sgId)
      .filter((c) => c.relationType.endsWith("-security-group") && c.relationType !== "vpc-security-group")
      .map((c) => this.get(c.sourceResourceId))
      .filter((r): r is Resource => !!r);
  }

  private sortSubnets(ids: string[]): ResourceOfType<"subnet">[] {
    return ids
      .map((id) => this.getOfType(id, "subnet"))
      .filter((s): s is ResourceOfType<"subnet"> => !!s)
      .sort(
        (a, b) =>
          a.config.availabilityZone.localeCompare(b.config.availabilityZone) || this.orderOf(a.id) - this.orderOf(b.id),
      );
  }

  albSubnets(albId: string): ResourceOfType<"subnet">[] {
    return this.memo(`albSubnets:${albId}`, () => this.sortSubnets(this.targets(albId, "alb-subnet")));
  }

  listenersOf(albId: string): ListenerBinding[] {
    const alb = this.getOfType(albId, "alb");
    if (!alb) return [];
    const forwards = this.outgoing(albId, "alb-target-group");
    return alb.config.listeners.map((listener) => {
      const conn = forwards.find(
        (c) => c.relationType === "alb-target-group" && c.metadata.listenerId === listener.id,
      );
      const tgId = conn && this.resources.has(conn.targetResourceId) ? conn.targetResourceId : null;
      return { listener, targetGroupId: tgId, connectionId: conn?.id ?? null };
    });
  }

  targetGroupTargets(tgId: string): { connectionId: string; ec2: ResourceOfType<"ec2"> }[] {
    return this.outgoing(tgId, "target-group-ec2")
      .map((c) => ({ connectionId: c.id, ec2: this.getOfType(c.targetResourceId, "ec2") }))
      .filter((x): x is { connectionId: string; ec2: ResourceOfType<"ec2"> } => !!x.ec2);
  }

  targetGroupAlbs(tgId: string): ResourceOfType<"alb">[] {
    const ids = [...new Set(this.incoming(tgId, "alb-target-group").map((c) => c.sourceResourceId))];
    return ids.map((id) => this.getOfType(id, "alb")).filter((a): a is ResourceOfType<"alb"> => !!a);
  }

  dbSubnetGroupOf(rdsId: string): ResourceOfType<"db-subnet-group"> | undefined {
    return this.getOfType(this.firstTarget(rdsId, "rds-db-subnet-group"), "db-subnet-group");
  }

  dbSubnetGroupSubnets(dbsgId: string): ResourceOfType<"subnet">[] {
    return this.memo(`dbsgSubnets:${dbsgId}`, () => this.sortSubnets(this.targets(dbsgId, "db-subnet-group-subnet")));
  }

  /** RDS 기본(primary) 인스턴스가 위치한다고 가정하는 서브넷: 서브넷 그룹에서 가용 영역 순으로 첫 번째. */
  rdsPlacement(rdsId: string): { primary: ResourceOfType<"subnet"> | null; standby: ResourceOfType<"subnet"> | null } {
    return this.memo(`rdsPlacement:${rdsId}`, () => {
      const rds = this.getOfType(rdsId, "rds");
      const group = this.dbSubnetGroupOf(rdsId);
      if (!rds || !group) return { primary: null, standby: null };
      const subnets = this.dbSubnetGroupSubnets(group.id);
      const primary = subnets[0] ?? null;
      const standby = rds.config.multiAz
        ? (subnets.find((s) => primary && s.config.availabilityZone !== primary.config.availabilityZone) ?? null)
        : null;
      return { primary, standby };
    });
  }

  routeTablesOfVpc(vpcId: string): ResourceOfType<"route-table">[] {
    return this.targets(vpcId, "vpc-route-table")
      .map((id) => this.getOfType(id, "route-table"))
      .filter((r): r is ResourceOfType<"route-table"> => !!r);
  }

  mainRouteTableOf(vpcId: string): ResourceOfType<"route-table"> | undefined {
    return this.routeTablesOfVpc(vpcId).find((rt) => rt.config.main);
  }

  naclOf(subnetId: string): ResourceOfType<"network-acl"> | undefined {
    return this.getOfType(this.firstSource(subnetId, "network-acl-subnet"), "network-acl");
  }

  /** 리소스가 속한 VPC (결정할 수 없으면 null). */
  vpcOf(resourceId: string): string | null {
    const r = this.get(resourceId);
    if (!r) return null;
    switch (r.type) {
      case "vpc":
        return r.id;
      case "subnet":
        return this.vpcOfSubnet(r.id);
      case "internet-gateway":
        return this.vpcOfIgw(r.id);
      case "route-table":
        return this.firstSource(r.id, "vpc-route-table");
      case "security-group":
        return this.firstSource(r.id, "vpc-security-group");
      case "network-acl":
        return this.firstSource(r.id, "vpc-network-acl");
      case "elastic-ip":
        return null;
      case "target-group":
        return this.firstSource(r.id, "vpc-target-group") ?? this.vpcsOf(r.id)[0] ?? null;
      case "nat-gateway":
      case "ec2": {
        const subnet = this.subnetOf(r.id);
        return subnet ? this.vpcOfSubnet(subnet) : null;
      }
      default:
        return this.vpcsOf(r.id)[0] ?? null;
    }
  }

  /** 여러 서브넷/대상에 걸치는 리소스가 관련된 VPC 목록. */
  vpcsOf(resourceId: string): string[] {
    const r = this.get(resourceId);
    if (!r) return [];
    const uniq = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => !!x))];
    switch (r.type) {
      case "alb": {
        const fromSubnets = uniq(this.albSubnets(r.id).map((s) => this.vpcOfSubnet(s.id)));
        return fromSubnets.length ? fromSubnets : uniq(this.securityGroupsOf(r.id).map((sg) => this.vpcOf(sg.id)));
      }
      case "target-group":
        return uniq([
          this.firstSource(r.id, "vpc-target-group"),
          ...this.targetGroupTargets(r.id).map((t) => this.vpcOf(t.ec2.id)),
          ...this.targetGroupAlbs(r.id).flatMap((a) => this.vpcsOf(a.id)),
        ]);
      case "db-subnet-group":
        return uniq(this.dbSubnetGroupSubnets(r.id).map((s) => this.vpcOfSubnet(s.id)));
      case "rds": {
        const group = this.dbSubnetGroupOf(r.id);
        const fromGroup = group ? this.vpcsOf(group.id) : [];
        return fromGroup.length ? fromGroup : uniq(this.securityGroupsOf(r.id).map((sg) => this.vpcOf(sg.id)));
      }
      default:
        return uniq([this.vpcOf(r.id)]);
    }
  }

  vpcCidr(vpcId: string | null): Cidr | null {
    const vpc = this.getOfType(vpcId, "vpc");
    return vpc ? tryParseCidr(vpc.config.cidr) : null;
  }

  // ---------------------------------------------------------------- 라우팅

  routeTableRefFor(subnetId: string): RouteTableRef {
    const vpcId = this.vpcOfSubnet(subnetId);
    const explicit = this.getOfType(this.firstSource(subnetId, "route-table-subnet"), "route-table");
    if (explicit) return { kind: "explicit", routeTableId: explicit.id };
    if (!vpcId) return { kind: "none" };
    const main = this.mainRouteTableOf(vpcId);
    return main ? { kind: "main", routeTableId: main.id } : { kind: "implicit-main" };
  }

  /** 라우팅 테이블의 경로 목록. 첫 항목은 항상 VPC CIDR → local. */
  routesOf(routeTableId: string | null, vpcId: string | null): EffectiveRoute[] {
    const routes: EffectiveRoute[] = [];
    const vpc = this.getOfType(vpcId, "vpc");
    if (vpc) {
      routes.push({
        key: "local",
        destinationCidr: vpc.config.cidr,
        cidr: tryParseCidr(vpc.config.cidr),
        targetKind: "local",
        targetId: null,
        connectionId: null,
      });
    }
    if (routeTableId) {
      for (const c of this.outgoing(routeTableId)) {
        if (c.relationType === "route-table-internet-gateway" || c.relationType === "route-table-nat-gateway") {
          routes.push({
            key: c.id,
            destinationCidr: c.metadata.destinationCidr,
            cidr: tryParseCidr(c.metadata.destinationCidr),
            targetKind: c.relationType === "route-table-internet-gateway" ? "internet-gateway" : "nat-gateway",
            targetId: c.targetResourceId,
            connectionId: c.id,
          });
        }
      }
    }
    return routes;
  }

  subnetRouting(subnetId: string): SubnetRouting {
    return this.memo(`routing:${subnetId}`, () => {
      const vpcId = this.vpcOfSubnet(subnetId);
      const table = this.routeTableRefFor(subnetId);
      const rtId = table.kind === "explicit" || table.kind === "main" ? table.routeTableId : null;
      const rtVpc = rtId ? (this.vpcOf(rtId) ?? vpcId) : vpcId;
      return { vpcId, table, routes: this.routesOf(rtId, rtVpc) };
    });
  }

  routeTableLabel(ref: RouteTableRef): string {
    switch (ref.kind) {
      case "explicit":
        return `${this.name(ref.routeTableId)} (명시적 연결)`;
      case "main":
        return `${this.name(ref.routeTableId)} (기본 라우팅 테이블)`;
      case "implicit-main":
        return "암묵적 기본 라우팅 테이블 (local 경로만 존재)";
      case "none":
        return "라우팅 테이블 없음 (서브넷이 VPC에 속하지 않음)";
    }
  }

  routeTargetLabel(route: EffectiveRoute): string {
    if (route.targetKind === "local") return "local";
    return this.label(route.targetId);
  }

  /** IGW가 해당 VPC에 연결되어 있는지 확인한다. */
  igwAttachedTo(igwId: string | null, vpcId: string | null): boolean {
    return !!igwId && !!vpcId && this.vpcOfIgw(igwId) === vpcId;
  }

  /**
   * 서브넷 분류. 이름이나 사용자의 선택이 아니라 실제 라우팅으로 판정한다.
   * - public: VPC에 연결된 IGW로 향하는 경로가 있음
   * - private-nat: IGW 경로는 없고 NAT Gateway 경로가 있음
   * - private-isolated: 외부로 향하는 경로가 없음
   */
  classifySubnet(subnetId: string): SubnetClassification {
    return this.memo(`classify:${subnetId}`, () => {
      const routing = this.subnetRouting(subnetId);
      if (!routing.vpcId) {
        return { kind: "unattached" as const, reason: "서브넷이 VPC에 속해 있지 않습니다.", route: null };
      }
      const tableLabel = this.routeTableLabel(routing.table);
      const igwRoute = routing.routes.find(
        (r) => r.targetKind === "internet-gateway" && r.cidr && this.igwAttachedTo(r.targetId, routing.vpcId),
      );
      if (igwRoute) {
        return {
          kind: "public" as const,
          reason: `${tableLabel}에 ${igwRoute.destinationCidr} → ${this.label(igwRoute.targetId)} 경로가 있습니다.`,
          route: igwRoute,
        };
      }
      const natRoute = routing.routes.find(
        (r) => r.targetKind === "nat-gateway" && r.cidr && this.getOfType(r.targetId, "nat-gateway"),
      );
      if (natRoute) {
        return {
          kind: "private-nat" as const,
          reason: `인터넷 게이트웨이 경로가 없고, ${natRoute.destinationCidr} → ${this.label(natRoute.targetId)} 경로가 있습니다.`,
          route: natRoute,
        };
      }
      return {
        kind: "private-isolated" as const,
        reason: `${tableLabel}에 VPC 외부로 향하는 경로(IGW/NAT)가 없습니다.`,
        route: null,
      };
    });
  }

  // ---------------------------------------------------------------- 인터페이스와 IP

  ec2PublicIpEnabled(ec2: ResourceOfType<"ec2">): boolean {
    if (ec2.config.publicIpMode === "enabled") return true;
    if (ec2.config.publicIpMode === "disabled") return false;
    const subnet = this.getOfType(this.subnetOf(ec2.id), "subnet");
    return !!subnet?.config.mapPublicIpOnLaunch;
  }

  /**
   * 가상 퍼블릭 IP 배정. 키 → IP
   * - 탄력적 IP는 할당 시 정해진 주소를 그대로 사용한다.
   * - 자동 할당 퍼블릭 IP는 결정적 해시 + 선형 탐색으로 정한다 (탄력적 IP 주소는 피한다).
   */
  private publicIpTable(): Map<string, number> {
    return this.memo("publicIps", () => {
      const pool = tryParseCidr(VIRTUAL_PUBLIC_POOL)!;
      const used = new Set<number>();
      const table = new Map<string, number>();
      for (const eip of this.ofType("elastic-ip")) {
        const ip = parseIpv4(eip.config.publicIp);
        if (ip !== null) used.add(ip);
      }
      const assign = (key: string) => {
        const start = (hashString(key) % 254) + 1;
        for (let i = 0; i < 254; i++) {
          const offset = ((start - 1 + i) % 254) + 1;
          const ip = (pool.network + offset) >>> 0;
          if (!used.has(ip)) {
            used.add(ip);
            table.set(key, ip);
            return;
          }
        }
      };
      const fromEip = (resourceId: string) => {
        const eip = this.elasticIpOf(resourceId);
        const ip = eip ? parseIpv4(eip.config.publicIp) : null;
        if (ip === null) return false;
        table.set(resourceId, ip);
        return true;
      };
      for (const r of this.project.resources) {
        if (r.type === "ec2") {
          if (!fromEip(r.id) && this.ec2PublicIpEnabled(r)) assign(r.id);
        } else if (r.type === "nat-gateway") {
          // 레거시 프로젝트(탄력적 IP 리소스가 없는 NAT)는 가상 주소를 자동 배정한다.
          if (!fromEip(r.id)) assign(r.id);
        } else if (r.type === "alb" && r.config.scheme === "internet-facing") {
          for (const s of this.albSubnets(r.id)) assign(`${r.id}@${s.id}`);
        } else if (r.type === "rds" && r.config.publiclyAccessible) assign(r.id);
      }
      return table;
    });
  }

  /** 관리형 인터페이스(ALB 노드, NAT, RDS)의 가상 사설 IP: 서브넷 상단 주소부터 배정. */
  private managedIpTable(): Map<string, number> {
    return this.memo("managedIps", () => {
      const table = new Map<string, number>();
      const ec2Ips = new Map<string, Set<number>>();
      for (const ec2 of this.ofType("ec2")) {
        const subnetId = this.subnetOf(ec2.id);
        const ip = parseIpv4(ec2.config.privateIp);
        if (!subnetId || ip === null) continue;
        if (!ec2Ips.has(subnetId)) ec2Ips.set(subnetId, new Set());
        ec2Ips.get(subnetId)!.add(ip);
      }
      const owners = new Map<string, string[]>();
      const push = (subnetId: string | null | undefined, key: string) => {
        if (!subnetId) return;
        if (!owners.has(subnetId)) owners.set(subnetId, []);
        owners.get(subnetId)!.push(key);
      };
      for (const r of this.project.resources) {
        if (r.type === "nat-gateway") push(this.subnetOf(r.id), r.id);
        else if (r.type === "alb") for (const s of this.albSubnets(r.id)) push(s.id, `${r.id}@${s.id}`);
        else if (r.type === "rds") push(this.rdsPlacement(r.id).primary?.id, r.id);
      }
      for (const [subnetId, keys] of owners) {
        const subnet = this.getOfType(subnetId, "subnet");
        const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
        if (!cidr) continue;
        const reserved = new Set(awsReservedIps(cidr));
        const used = ec2Ips.get(subnetId) ?? new Set<number>();
        let next = cidrLast(cidr) - 1;
        for (const key of keys) {
          while (next >= cidrFirst(cidr) && (used.has(next >>> 0) || reserved.has(next >>> 0))) next--;
          if (next < cidrFirst(cidr) + 4) break;
          table.set(key, next >>> 0);
          used.add(next >>> 0);
          next--;
        }
      }
      return table;
    });
  }

  enis(): Eni[] {
    return this.memo("enis", () => {
      const publicIps = this.publicIpTable();
      const managedIps = this.managedIpTable();
      const result: Eni[] = [];
      for (const r of this.project.resources) {
        if (r.type === "ec2") {
          const subnetId = this.subnetOf(r.id);
          const active = r.config.state === "running" || r.config.state === "pending";
          // 자동 할당 퍼블릭 IP는 중지 시 해제되지만, 탄력적 IP는 연결된 상태로 남는다.
          const keepsPublicIp = active || (!!this.elasticIpOf(r.id) && r.config.state !== "terminated");
          result.push({
            id: r.id,
            ownerId: r.id,
            ownerType: "ec2",
            label: this.label(r.id),
            subnetId,
            vpcId: subnetId ? this.vpcOfSubnet(subnetId) : null,
            privateIp: parseIpv4(r.config.privateIp),
            publicIp: keepsPublicIp ? (publicIps.get(r.id) ?? null) : null,
            securityGroupIds: this.securityGroupsOf(r.id).map((sg) => sg.id),
            managed: false,
          });
        } else if (r.type === "nat-gateway") {
          const subnetId = this.subnetOf(r.id);
          result.push({
            id: r.id,
            ownerId: r.id,
            ownerType: "nat-gateway",
            label: this.label(r.id),
            subnetId,
            vpcId: subnetId ? this.vpcOfSubnet(subnetId) : null,
            privateIp: managedIps.get(r.id) ?? null,
            publicIp: publicIps.get(r.id) ?? null,
            securityGroupIds: null,
            managed: true,
          });
        } else if (r.type === "alb") {
          for (const s of this.albSubnets(r.id)) {
            const key = `${r.id}@${s.id}`;
            result.push({
              id: key,
              ownerId: r.id,
              ownerType: "alb",
              label: `${displayName(r)} 노드 (${s.config.availabilityZone})`,
              subnetId: s.id,
              vpcId: this.vpcOfSubnet(s.id),
              privateIp: managedIps.get(key) ?? null,
              publicIp: publicIps.get(key) ?? null,
              securityGroupIds: this.securityGroupsOf(r.id).map((sg) => sg.id),
              managed: true,
            });
          }
        } else if (r.type === "rds") {
          const primary = this.rdsPlacement(r.id).primary;
          result.push({
            id: r.id,
            ownerId: r.id,
            ownerType: "rds",
            label: this.label(r.id),
            subnetId: primary?.id ?? null,
            vpcId: primary ? this.vpcOfSubnet(primary.id) : null,
            privateIp: managedIps.get(r.id) ?? null,
            publicIp: publicIps.get(r.id) ?? null,
            securityGroupIds: this.securityGroupsOf(r.id).map((sg) => sg.id),
            managed: true,
          });
        }
      }
      return result;
    });
  }

  enisOf(ownerId: string): Eni[] {
    return this.enis().filter((e) => e.ownerId === ownerId);
  }

  eniByPrivateIp(vpcId: string, ip: number): Eni | undefined {
    return this.enis().find((e) => e.vpcId === vpcId && e.privateIp === ip);
  }

  eniByPublicIp(ip: number): Eni | undefined {
    return this.enis().find((e) => e.publicIp === ip);
  }

  /** 서브넷에서 아직 사용되지 않은 첫 사설 IP (가능하면 .10부터). */
  suggestPrivateIp(subnetId: string, excludeOwnerId?: string): string | null {
    const subnet = this.getOfType(subnetId, "subnet");
    const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
    if (!cidr) return null;
    const used = new Set<number>(awsReservedIps(cidr));
    for (const e of this.enis()) {
      if (e.subnetId === subnetId && e.privateIp !== null && e.ownerId !== excludeOwnerId) used.add(e.privateIp);
    }
    const first = cidrFirst(cidr);
    const last = cidrLast(cidr);
    const start = last - first > 20 ? first + 10 : first + 4;
    for (let ip = start; ip < last; ip++) if (!used.has(ip >>> 0)) return formatIpv4(ip);
    for (let ip = first + 4; ip < start; ip++) if (!used.has(ip >>> 0)) return formatIpv4(ip);
    return null;
  }

  /** 서브넷 CIDR 안에 IP가 포함되는지 확인. */
  ipInSubnet(subnetId: string | null, ip: number | null): boolean {
    if (!subnetId || ip === null) return false;
    const subnet = this.getOfType(subnetId, "subnet");
    const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
    return !!cidr && cidrContainsIp(cidr, ip);
  }

  // ---------------------------------------------------------------- DNS (가상)

  dnsName(resourceId: string): string | null {
    const r = this.get(resourceId);
    if (!r) return null;
    const suffix = (hashString(r.id) % 900000) + 100000;
    if (r.type === "alb") {
      const prefix = r.config.scheme === "internal" ? "internal-" : "";
      return `${prefix}${slug(displayName(r))}-${suffix}.${VIRTUAL_REGION}.elb.playground.local`;
    }
    if (r.type === "rds") return `${slug(displayName(r))}.c${suffix}.${VIRTUAL_REGION}.rds.playground.local`;
    if (r.type === "ec2") {
      const eni = this.enisOf(r.id)[0];
      return eni?.privateIp !== null && eni?.privateIp !== undefined
        ? `ip-${formatIpv4(eni.privateIp).replaceAll(".", "-")}.${VIRTUAL_REGION}.compute.playground.local`
        : null;
    }
    return null;
  }
}

/** Name 태그가 비어 있으면 리소스 ID를 표시 이름으로 쓴다 (AWS 콘솔과 동일). */
export function displayName(r: Pick<Resource, "id" | "name">): string {
  return r.name?.trim() ? r.name : r.id;
}

export function buildTopology(project: Project): Topology {
  return new Topology(project);
}
