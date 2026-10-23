/**
 * 코드로 아키텍처를 구성하는 빌더 (예제 환경, Guided Lab 시작 상태, 테스트용).
 * 연결 규칙 검사를 거치지 않으므로 의도적으로 잘못된 구성도 만들 수 있다.
 *
 * awsDefaults를 켜면 실제 AWS처럼 VPC마다 기본(main) 라우팅 테이블, 기본 네트워크 ACL,
 * 기본 보안 그룹을 함께 만들고, 새 서브넷을 기본 네트워크 ACL에 연결한다.
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
import { createEmptyProject, createResource, newListener, NACL, SG } from "./factory";
import { applyAutoLayout } from "./layout";

type RouteSpec = { destination: string; igw?: string; nat?: string };

export interface BuilderOptions {
  description?: string;
  labId?: string | null;
  /** VPC 생성 시 AWS 기본 리소스(main 라우팅 테이블, 기본 NACL, 기본 보안 그룹)를 함께 만든다 */
  awsDefaults?: boolean;
}

export class ProjectBuilder {
  private project: Project;
  private readonly awsDefaults: boolean;

  constructor(name: string, options: BuilderOptions = {}) {
    this.project = createEmptyProject(name, options);
    this.awsDefaults = options.awsDefaults ?? false;
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

  private disconnectWhere(predicate: (c: Connection) => boolean) {
    this.project = { ...this.project, connections: this.project.connections.filter((c) => !predicate(c)) };
  }

  /** VPC의 기본 네트워크 ACL (awsDefaults로 만든 경우) */
  defaultNaclOf(vpc: string): string | undefined {
    return this.project.resources.find(
      (r) =>
        r.type === "network-acl" &&
        r.config.isDefault &&
        this.project.connections.some((c) => c.relationType === "vpc-network-acl" && c.sourceResourceId === vpc && c.targetResourceId === r.id),
    )?.id;
  }

  /** VPC의 기본 보안 그룹 (awsDefaults로 만든 경우) */
  defaultSecurityGroupOf(vpc: string): string | undefined {
    return this.project.resources.find(
      (r) =>
        r.type === "security-group" &&
        r.config.isDefault &&
        this.project.connections.some((c) => c.relationType === "vpc-security-group" && c.sourceResourceId === vpc && c.targetResourceId === r.id),
    )?.id;
  }

  vpc(name: string, cidr: string, config: Partial<ConfigOf<"vpc">> = {}): string {
    const id = this.add("vpc", name, { cidr, enableDnsSupport: true, enableDnsHostnames: true, isDefault: false, ...config });
    if (this.awsDefaults) {
      const mainRt = this.add("route-table", "", { main: true });
      this.connect("vpc-route-table", id, mainRt);
      const nacl = this.add("network-acl", "", {
        isDefault: true,
        inboundRules: [NACL.allow(100, "all", null, "0.0.0.0/0")],
        outboundRules: [NACL.allow(100, "all", null, "0.0.0.0/0")],
      });
      this.connect("vpc-network-acl", id, nacl);
      const sg = this.add("security-group", "default", {
        description: "default VPC security group",
        isDefault: true,
        inboundRules: [],
        outboundRules: [SG.all("0.0.0.0/0")],
      });
      this.update(sg, "security-group", { inboundRules: [SG.all({ sg })] });
      this.connect("vpc-security-group", id, sg);
    }
    return id;
  }

  subnet(name: string, vpc: string | null, cidr: string, availabilityZone: string, config: Partial<ConfigOf<"subnet">> = {}): string {
    const id = this.add("subnet", name, { cidr, availabilityZone, mapPublicIpOnLaunch: false, ...config });
    if (vpc) {
      this.connect("vpc-subnet", vpc, id);
      const defaultNacl = this.awsDefaults ? this.defaultNaclOf(vpc) : undefined;
      if (defaultNacl) this.connect("network-acl-subnet", defaultNacl, id);
    }
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

  elasticIp(name: string): string {
    return this.add("elastic-ip", name);
  }

  associateElasticIp(eip: string, ec2: string): this {
    this.connect("elastic-ip-ec2", eip, ec2);
    return this;
  }

  /** NAT Gateway. 기본적으로 탄력적 IP를 함께 할당해 연결한다 (eip: false면 생략 — 레거시 구성 재현용). */
  nat(name: string, subnet: string | null, config: Partial<ConfigOf<"nat-gateway">> & { eip?: boolean } = {}): string {
    const { eip = true, ...rest } = config;
    const id = this.add("nat-gateway", name, { state: "available", ...rest });
    if (subnet) this.connect("nat-gateway-subnet", id, subnet);
    if (eip) this.connect("elastic-ip-nat-gateway", this.elasticIp(`${name}-eip`), id);
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
      isDefault: false,
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

  /** 사용자 지정 NACL. 연결하는 서브넷은 기존 NACL 연결(기본 NACL 포함)을 대체한다. */
  networkAcl(name: string, vpc: string | null, options: { subnets?: string[]; inbound?: NaclRule[]; outbound?: NaclRule[] } = {}): string {
    const id = this.add("network-acl", name, {
      inboundRules: options.inbound ?? [],
      outboundRules: options.outbound ?? [],
      isDefault: false,
    });
    if (vpc) this.connect("vpc-network-acl", vpc, id);
    for (const s of options.subnets ?? []) {
      this.disconnectWhere((c) => c.relationType === "network-acl-subnet" && c.targetResourceId === s);
      this.connect("network-acl-subnet", id, s);
    }
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
      userData?: string;
    } = {},
  ): string {
    const id = this.add("ec2", name, {
      privateIp: options.ip ?? "",
      publicIpMode: options.publicIp ?? "disabled",
      state: options.state ?? "running",
      listenPorts: options.listenPorts ?? [22, 80],
      instanceType: options.instanceType ?? "t3.micro",
      httpResponseCode: options.httpResponseCode ?? 200,
      userData: options.userData ?? "",
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
    options: { protocol?: "HTTP" | "HTTPS"; port?: number; vpc?: string; targets?: string[]; healthCheck?: Partial<HealthCheck> } = {},
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
    if (options.vpc) this.connect("vpc-target-group", options.vpc, id);
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
    const id = this.add("alb", name, { scheme: options.scheme ?? "internet-facing", listeners, state: "active" });
    for (const s of options.subnets ?? []) this.connect("alb-subnet", id, s);
    for (const sg of options.sgs ?? []) this.connect("alb-security-group", id, sg);
    listenerSpecs.forEach((spec, i) => {
      if (spec.targetGroup) this.connect("alb-target-group", id, spec.targetGroup, { listenerId: listeners[i].id });
    });
    return id;
  }

  dbSubnetGroup(name: string, subnets: string[], description = ""): string {
    const id = this.add("db-subnet-group", name, { description });
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
      state?: "creating" | "available" | "stopped";
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
