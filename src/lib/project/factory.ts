/**
 * 리소스와 프로젝트 기본값 생성.
 * 기본값은 AWS 콘솔의 일반적인 기본 동작을 따른다
 * (예: 새 보안 그룹은 아웃바운드 전체 허용, 새 사용자 지정 NACL은 모든 트래픽 거부).
 */
import { formatIpv4, nextAvailableSubnet, nextAvailableVpcCidr, parseIpv4, tryParseCidr, type Cidr } from "@/lib/engine/cidr-utils";
import { createId } from "@/lib/engine/ids";
import {
  AVAILABILITY_ZONES,
  EMPTY_SERVICES,
  PROJECT_SCHEMA_VERSION,
  RDS_DEFAULT_PORT,
  RESOURCE_TYPE_INFO,
  type ConfigOf,
  type HealthCheck,
  type Listener,
  type NaclRule,
  type Project,
  type Resource,
  type ResourceOfType,
  type ResourceType,
  type RuleProtocol,
  type SgRule,
} from "@/lib/engine/resource-models";
import { buildTopology, VIRTUAL_PUBLIC_POOL } from "@/lib/engine/topology-engine";

export const DEFAULT_NAME_BASE: Record<ResourceType, string> = {
  vpc: "vpc",
  subnet: "subnet",
  "internet-gateway": "igw",
  "elastic-ip": "eip",
  "route-table": "rtb",
  "nat-gateway": "nat",
  "security-group": "sg",
  "network-acl": "nacl",
  ec2: "ec2",
  alb: "alb",
  "target-group": "tg",
  "db-subnet-group": "db-subnets",
  rds: "database",
};

export function nextResourceName(project: Project, type: ResourceType): string {
  const base = DEFAULT_NAME_BASE[type];
  const pattern = new RegExp(`^${base.replace(/[-]/g, "\\-")}-(\\d+)$`);
  let max = 0;
  for (const r of project.resources) {
    const m = pattern.exec(r.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base}-${max + 1}`;
}

export const DEFAULT_HEALTH_CHECK: HealthCheck = {
  protocol: "HTTP",
  path: "/",
  port: "traffic-port",
  healthyThreshold: 5,
  unhealthyThreshold: 2,
  timeoutSeconds: 5,
  intervalSeconds: 30,
  matcher: "200",
};

export type PeerSpec = string | { sg: string };

function makeSgRule(protocol: RuleProtocol, ports: number | [number, number] | null, peer: PeerSpec, description = ""): SgRule {
  const [fromPort, toPort] =
    protocol === "all" || protocol === "icmp" || ports === null
      ? [0, 65535]
      : Array.isArray(ports)
        ? ports
        : [ports, ports];
  return {
    id: createId("sgr"),
    protocol,
    fromPort,
    toPort,
    peer: typeof peer === "string" ? { kind: "cidr", cidr: peer } : { kind: "security-group", securityGroupId: peer.sg },
    description,
  };
}

/** 보안 그룹 규칙 생성 도우미 */
export const SG = {
  tcp: (ports: number | [number, number], peer: PeerSpec, description = "") => makeSgRule("tcp", ports, peer, description),
  udp: (ports: number | [number, number], peer: PeerSpec, description = "") => makeSgRule("udp", ports, peer, description),
  icmp: (peer: PeerSpec, description = "") => makeSgRule("icmp", null, peer, description),
  all: (peer: PeerSpec, description = "") => makeSgRule("all", null, peer, description),
};

function makeNaclRule(
  action: "allow" | "deny",
  ruleNumber: number,
  protocol: RuleProtocol,
  ports: number | [number, number] | null,
  cidr: string,
): NaclRule {
  const [fromPort, toPort] =
    protocol === "all" || protocol === "icmp" || ports === null ? [0, 65535] : Array.isArray(ports) ? ports : [ports, ports];
  return { id: createId("aclr"), ruleNumber, protocol, fromPort, toPort, cidr, action };
}

/** NACL 규칙 생성 도우미 */
export const NACL = {
  allow: (ruleNumber: number, protocol: RuleProtocol, ports: number | [number, number] | null, cidr: string) =>
    makeNaclRule("allow", ruleNumber, protocol, ports, cidr),
  deny: (ruleNumber: number, protocol: RuleProtocol, ports: number | [number, number] | null, cidr: string) =>
    makeNaclRule("deny", ruleNumber, protocol, ports, cidr),
};

export function newListener(protocol: Listener["protocol"] = "HTTP", port = 80): Listener {
  return { id: createId("lsn"), protocol, port, rules: [] };
}

/**
 * 아직 쓰이지 않은 가상 퍼블릭 IPv4 주소 (탄력적 IP 할당용).
 * 기존 탄력적 IP와 현재 자동 할당된 퍼블릭 IP를 피해서, 198.51.100.10부터 차례로 고른다.
 */
export function allocateVirtualPublicIp(project: Project): string | null {
  const pool = tryParseCidr(VIRTUAL_PUBLIC_POOL)!;
  const used = new Set<number>();
  for (const r of project.resources) {
    if (r.type === "elastic-ip") {
      const ip = parseIpv4(r.config.publicIp);
      if (ip !== null) used.add(ip);
    }
  }
  for (const eni of buildTopology(project).enis()) if (eni.publicIp !== null) used.add(eni.publicIp);
  for (let offset = 10; offset < 255; offset++) {
    const ip = (pool.network + offset) >>> 0;
    if (!used.has(ip)) return formatIpv4(ip);
  }
  for (let offset = 1; offset < 10; offset++) {
    const ip = (pool.network + offset) >>> 0;
    if (!used.has(ip)) return formatIpv4(ip);
  }
  return null;
}

function existingCidrs(project: Project, type: "vpc" | "subnet"): Cidr[] {
  return project.resources
    .filter((r) => r.type === type)
    .map((r) => tryParseCidr((r as ResourceOfType<"vpc" | "subnet">).config.cidr))
    .filter((c): c is Cidr => !!c);
}

export function defaultConfig<T extends ResourceType>(type: T, project: Project): ConfigOf<T> {
  const configs: { [K in ResourceType]: () => ConfigOf<K> } = {
    vpc: () => ({
      cidr: nextAvailableVpcCidr(existingCidrs(project, "vpc")).text,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      isDefault: false,
    }),
    subnet: () => {
      const vpcs = project.resources.filter((r): r is ResourceOfType<"vpc"> => r.type === "vpc");
      const vpcCidr = vpcs.length ? tryParseCidr(vpcs[0].config.cidr) : null;
      const next = vpcCidr ? nextAvailableSubnet(vpcCidr, existingCidrs(project, "subnet"), 24) : null;
      const count = project.resources.filter((r) => r.type === "subnet").length;
      return {
        cidr: next?.text ?? "10.0.1.0/24",
        availabilityZone: AVAILABILITY_ZONES[count % AVAILABILITY_ZONES.length],
        mapPublicIpOnLaunch: false,
      };
    },
    "internet-gateway": () => ({}),
    "elastic-ip": () => ({ publicIp: allocateVirtualPublicIp(project) ?? "" }),
    "route-table": () => ({ main: false }),
    "nat-gateway": () => ({ state: "available" as const }),
    "security-group": () => ({
      description: "",
      inboundRules: [],
      outboundRules: [SG.all("0.0.0.0/0", "기본 아웃바운드 전체 허용")],
      isDefault: false,
    }),
    "network-acl": () => ({ inboundRules: [], outboundRules: [], isDefault: false }),
    ec2: () => ({
      ami: "amazon-linux-2023" as const,
      instanceType: "t3.micro" as const,
      privateIp: "",
      publicIpMode: "subnet-default" as const,
      state: "running" as const,
      listenPorts: [22, 80],
      httpResponseCode: 200,
      userData: "",
      iamRoleId: null,
    }),
    alb: () => ({ scheme: "internet-facing" as const, listeners: [newListener("HTTP", 80)], state: "active" as const }),
    "target-group": () => ({ protocol: "HTTP" as const, port: 80, healthCheck: { ...DEFAULT_HEALTH_CHECK } }),
    "db-subnet-group": () => ({ description: "" }),
    rds: () => ({
      engine: "mysql" as const,
      instanceClass: "db.t3.micro" as const,
      port: RDS_DEFAULT_PORT.mysql,
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorageGb: 20,
      state: "available" as const,
    }),
  };
  return configs[type]() as ConfigOf<T>;
}

export function createResource<T extends ResourceType>(
  project: Project,
  type: T,
  position: { x: number; y: number },
  overrides: { name?: string; config?: Partial<ConfigOf<T>> } = {},
): ResourceOfType<T> {
  const config: Record<string, unknown> = {
    ...(defaultConfig(type, project) as Record<string, unknown>),
    ...((overrides.config ?? {}) as Record<string, unknown>),
  };
  return {
    id: createId(RESOURCE_TYPE_INFO[type].idPrefix),
    type,
    name: overrides.name ?? nextResourceName(project, type),
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    config,
  } as unknown as ResourceOfType<T>;
}

export function createEmptyProject(name: string, options: { description?: string; labId?: string | null } = {}): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId("proj"),
    name: name.trim() || "새 프로젝트",
    description: options.description ?? "",
    resources: [],
    connections: [],
    viewport: null,
    createdAt: now,
    updatedAt: now,
    labId: options.labId ?? null,
    costAssumptions: null,
    networkPaths: [],
    services: structuredClone(EMPTY_SERVICES),
    preferredMode: "console",
  };
}

export function isResourceOf<T extends ResourceType>(r: Resource | undefined, type: T): r is ResourceOfType<T> {
  return !!r && r.type === type;
}
