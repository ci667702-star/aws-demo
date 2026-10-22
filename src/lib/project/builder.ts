/**
 * 코드로 아키텍처를 구성하는 빌더 (샘플, Guided Lab 시작 상태, 테스트용).
 * 연결 규칙 검사를 거치지 않으므로 의도적으로 잘못된 구성도 만들 수 있다.
 */
import { createId } from "@/lib/engine/ids";
import {
  RDS_DEFAULT_PORT,
  type ConfigOf,
  type Connection,
  type HealthCheck,
  type NaclRule,
  type Project,
  type RelationType,
  type Resource,
  type ResourceOfType,
  type ResourceType,
  type SgRule,
} from "@/lib/engine/resource-models";
import { buildTopology } from "@/lib/engine/topology-engine";
import { createEmptyProject, createResource, newListener, SG } from "./factory";
import { applyAutoLayout } from "./layout";

type RouteSpec = { destination: string; igw?: string; nat?: string };

export class ProjectBuilder {
  private project: Project;

  constructor(name: string, options: { description?: string; labId?: string | null } = {}) {
    this.project = createEmptyProject(name, options);
  }

  private add<T extends ResourceType>(type: T, name: string, config: Partial<ConfigOf<T>> = {}): string {
    const resource = createResource(this.project, type, { x: 0, y: 0 }, { name, config });
    this.project = { ...this.project, resources: [...this.project.resources, resource as Resource] };
    return resource.id;
  }

  private get<T extends ResourceType>(id: string, type: T): ResourceOfType<T> {
    const r = this.project.resources.find((x) => x.id === id);
    if (!r || r.type !== type) throw new Error(`ProjectBuilder: ${id}은(는) ${type}이 아닙니다.`);
    return r as ResourceOfType<T>;
  }

  update<T extends ResourceType>(id: string, type: T, patch: Partial<ConfigOf<T>>): this {
    const current = this.get(id, type);
    this.project = {
      ...this.project,
      resources: this.project.resources.map((r) =>
        r.id === id ? ({ ...current, config: { ...current.config, ...patch } } as Resource) : r,
      ),
    };
    return this;
  }

  connect(relationType: RelationType, source: string, target: string, metadata: Record<string, string> = {}): string {
    const connection = {
      id: createId("conn"),
      sourceResourceId: source,
      targetResourceId: target,
      relationType,
      metadata,
    } as Connection;
    this.project = { ...this.project, connections: [...this.project.connections, connection] };
    return connection.id;
  }

  vpc(name: string, cidr: string, config: Partial<ConfigOf<"vpc">> = {}): string {
    return this.add("vpc", name, { cidr, enableDnsSupport: true, enableDnsHostnames: true, ...config });
  }

  subnet(name: string, vpc: string | null, cidr: string, availabilityZone: string, config: Partial<ConfigOf<"subnet">> = {}): string {
    const id = this.add("subnet", name, { cidr, availabilityZone, mapPublicIpOnLaunch: false, ...config });
    if (vpc) this.connect("vpc-subnet", vpc, id);
    return id;
  }

  igw(name: string, vpc?: string | null): string {
    const id = this.add("internet-gateway", name);
    if (vpc) this.connect("vpc-internet-gateway", vpc, id);
    return id;
  }

  routeTable(name: string, vpc: string | null, options: { main?: boolean; subnets?: string[]; routes?: RouteSpec[] } = {}): string {
    const id = this.add("route-table", name, { main: options.main ?? false });
    if (vpc) this.connect("vpc-route-table", vpc, id);
    for (const s of options.subnets ?? []) this.connect("route-table-subnet", id, s);
    for (const r of options.routes ?? []) this.route(id, r);
    return id;
  }

  route(routeTable: string, route: RouteSpec): string {
    if (route.igw) return this.connect("route-table-internet-gateway", routeTable, route.igw, { destinationCidr: route.destination });
    if (route.nat) return this.connect("route-table-nat-gateway", routeTable, route.nat, { destinationCidr: route.destination });
    throw new Error("ProjectBuilder.route: igw 또는 nat 대상이 필요합니다.");
  }

  nat(name: string, subnet: string | null, config: Partial<ConfigOf<"nat-gateway">> = {}): string {
    const id = this.add("nat-gateway", name, { state: "available", ...config });
    if (subnet) this.connect("nat-gateway-subnet", id, subnet);
    return id;
  }

  securityGroup(
    name: string,
    vpc: string | null,
    options: { description?: string; inbound?: SgRule[]; outbound?: SgRule[] } = {},
  ): string {
    const id = this.add("security-group", name, {
      description: options.description ?? "",
      inboundRules: options.inbound ?? [],
      outboundRules: options.outbound ?? [SG.all("0.0.0.0/0")],
    });
    if (vpc) this.connect("vpc-security-group", vpc, id);
    return id;
  }

  /** 보안 그룹에 규칙을 추가한다 (다른 SG를 참조하는 규칙을 나중에 넣을 때 사용). */
  addSgRules(sg: string, rules: { inbound?: SgRule[]; outbound?: SgRule[] }): this {
    const current = this.get(sg, "security-group");
    return this.update(sg, "security-group", {
      inboundRules: [...current.config.inboundRules, ...(rules.inbound ?? [])],
      outboundRules: [...current.config.outboundRules, ...(rules.outbound ?? [])],
    });
  }

  networkAcl(name: string, vpc: string | null, options: { subnets?: string[]; inbound?: NaclRule[]; outbound?: NaclRule[] } = {}): string {
    const id = this.add("network-acl", name, { inboundRules: options.inbound ?? [], outboundRules: options.outbound ?? [] });
    if (vpc) this.connect("vpc-network-acl", vpc, id);
    for (const s of options.subnets ?? []) this.connect("network-acl-subnet", id, s);
    return id;
  }

  ec2(
    name: string,
    subnet: string | null,
    options: {
      ip?: string;
      publicIp?: ConfigOf<"ec2">["publicIpMode"];
      sgs?: string[];
      state?: ConfigOf<"ec2">["state"];
      listenPorts?: number[];
      instanceType?: ConfigOf<"ec2">["instanceType"];
      httpResponseCode?: number;
    } = {},
  ): string {
    const id = this.add("ec2", name, {
      privateIp: options.ip ?? "",
      publicIpMode: options.publicIp ?? "disabled",
      state: options.state ?? "running",
      listenPorts: options.listenPorts ?? [22, 80],
      instanceType: options.instanceType ?? "t3.micro",
      httpResponseCode: options.httpResponseCode ?? 200,
    });
    if (subnet) {
      this.connect("ec2-subnet", id, subnet);
      if (!options.ip) {
        const suggestion = buildTopology(this.project).suggestPrivateIp(subnet, id);
        if (suggestion) this.update(id, "ec2", { privateIp: suggestion });
      }
    }
    for (const sg of options.sgs ?? []) this.connect("ec2-security-group", id, sg);
    return id;
  }

  targetGroup(
    name: string,
    options: { protocol?: "HTTP" | "HTTPS"; port?: number; targets?: string[]; healthCheck?: Partial<HealthCheck> } = {},
  ): string {
    const id = this.add("target-group", name, {
      protocol: options.protocol ?? "HTTP",
      port: options.port ?? 80,
      healthCheck: {
        protocol: "HTTP",
        path: "/",
        port: "traffic-port",
        healthyThreshold: 5,
        unhealthyThreshold: 2,
        timeoutSeconds: 5,
        intervalSeconds: 30,
        matcher: "200",
        ...(options.healthCheck ?? {}),
      },
    });
    for (const t of options.targets ?? []) this.connect("target-group-ec2", id, t);
    return id;
  }

  alb(
    name: string,
    options: {
      scheme?: "internet-facing" | "internal";
      subnets?: string[];
      sgs?: string[];
      listeners?: { protocol?: "HTTP" | "HTTPS"; port: number; targetGroup?: string }[];
    } = {},
  ): string {
    const listenerSpecs = options.listeners ?? [{ protocol: "HTTP" as const, port: 80 }];
    const listeners = listenerSpecs.map((l) => newListener(l.protocol ?? "HTTP", l.port));
    const id = this.add("alb", name, { scheme: options.scheme ?? "internet-facing", listeners });
    for (const s of options.subnets ?? []) this.connect("alb-subnet", id, s);
    for (const sg of options.sgs ?? []) this.connect("alb-security-group", id, sg);
    listenerSpecs.forEach((spec, i) => {
      if (spec.targetGroup) this.connect("alb-target-group", id, spec.targetGroup, { listenerId: listeners[i].id });
    });
    return id;
  }

  dbSubnetGroup(name: string, subnets: string[]): string {
    const id = this.add("db-subnet-group", name, { description: "" });
    for (const s of subnets) this.connect("db-subnet-group-subnet", id, s);
    return id;
  }

  rds(
    name: string,
    options: {
      subnetGroup?: string;
      sgs?: string[];
      engine?: "mysql" | "postgres";
      port?: number;
      publiclyAccessible?: boolean;
      multiAz?: boolean;
      state?: "available" | "stopped";
    } = {},
  ): string {
    const engine = options.engine ?? "mysql";
    const id = this.add("rds", name, {
      engine,
      port: options.port ?? RDS_DEFAULT_PORT[engine],
      publiclyAccessible: options.publiclyAccessible ?? false,
      multiAz: options.multiAz ?? false,
      state: options.state ?? "available",
    });
    if (options.subnetGroup) this.connect("rds-db-subnet-group", id, options.subnetGroup);
    for (const sg of options.sgs ?? []) this.connect("rds-security-group", id, sg);
    return id;
  }

  /** 현재 상태의 프로젝트 (자동 정렬 없이) */
  snapshot(): Project {
    return this.project;
  }

  build(options: { layout?: boolean } = {}): Project {
    return options.layout === false ? this.project : applyAutoLayout(this.project);
  }
}
