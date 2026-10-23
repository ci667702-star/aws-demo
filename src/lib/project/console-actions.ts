/**
 * AWS 콘솔 동작(리소스 생성·수정·삭제)을 흉내 낸 변경 연산.
 *
 * - 사용자가 입력한 값만 사용하며, 앱이 임의의 설정을 대신 채우지 않는다.
 *   (AWS 자체가 하는 동작 — VPC 생성 시 기본 라우팅 테이블/NACL/보안 그룹 생성, 사설 IP 자동 할당 — 만 재현한다.)
 * - 실제 AWS API처럼 입력을 엄격하게 검증하고, 의존 관계가 남아 있으면 삭제를 거부한다.
 * - 오류 메시지는 AWS 오류 코드를 함께 보여준다. 예: [InvalidSubnet.Conflict]
 */
import { awsReservedReason, cidrContainsCidr, cidrContainsIp, cidrsOverlap, parseCidr, parseIpv4, tryParseCidr, validateSubnetCidr, validateVpcCidr } from "@/lib/engine/cidr-utils";
import { checkConnection } from "@/lib/engine/connection-rules";
import { validateHealthCheck } from "@/lib/engine/alb-engine";
import { createId } from "@/lib/engine/ids";
import {
  AVAILABILITY_ZONES,
  RDS_DEFAULT_PORT,
  RESOURCE_TYPE_INFO,
  simulationRequestSchema,
  type ConfigOf,
  type Connection,
  type HealthCheck,
  type Listener,
  type ListenerRule,
  type ListenerRuleAction,
  type NaclRule,
  type NetworkPath,
  type Project,
  type RelationType,
  type Resource,
  type ResourceOfType,
  type ResourceType,
  type SgRule,
} from "@/lib/engine/resource-models";
import type { SimulationResult } from "@/lib/engine/connectivity-engine";
import { buildTopology, displayName, type Topology } from "@/lib/engine/topology-engine";
import { allocateVirtualPublicIp, NACL, SG } from "./factory";
import { findFreePosition, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import { setMainRouteTable, touch, type MutationResult } from "./mutations";

export type ActionResult = MutationResult;

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

/** AWS 오류 코드를 포함한 실패 결과 */
export function awsFail(code: string, message: string, hint?: string): ActionResult {
  return { ok: false, error: `[${code}] ${message}`, hint };
}

// ---------------------------------------------------------------- 공통 도우미

function link(relationType: RelationType, source: string, target: string, metadata: Record<string, string> = {}): Connection {
  return { id: createId("conn"), sourceResourceId: source, targetResourceId: target, relationType, metadata } as Connection;
}

function placeNear(project: Project, anchorId: string | null | undefined): { x: number; y: number } {
  const occupied = project.resources.map((r) => ({ ...r.position, width: NODE_WIDTH, height: NODE_HEIGHT }));
  const anchor = project.resources.find((r) => r.id === anchorId);
  if (anchor) return findFreePosition({ x: anchor.position.x, y: anchor.position.y + NODE_HEIGHT + 48 }, occupied);
  const maxX = project.resources.reduce((m, r) => Math.max(m, r.position.x), -Infinity);
  const start = Number.isFinite(maxX) ? { x: maxX + NODE_WIDTH + 120, y: 0 } : { x: 0, y: 0 };
  return findFreePosition(start, occupied);
}

/** 리소스를 추가한다 (위치는 관련 리소스 근처의 빈 자리). */
function addResource<T extends ResourceType>(
  project: Project,
  type: T,
  name: string,
  config: ConfigOf<T>,
  anchorId?: string | null,
): { project: Project; resource: ResourceOfType<T> } {
  const resource = {
    id: createId(RESOURCE_TYPE_INFO[type].idPrefix),
    type,
    name: name.trim(),
    position: placeNear(project, anchorId),
    config,
  } as unknown as ResourceOfType<T>;
  return { project: { ...project, resources: [...project.resources, resource as Resource] }, resource };
}

function addConnections(project: Project, connections: Connection[]): Project {
  return { ...project, connections: [...project.connections, ...connections] };
}

function updateConfig<T extends ResourceType>(project: Project, id: string, patch: Partial<ConfigOf<T>>): Project {
  return {
    ...project,
    resources: project.resources.map((r) => (r.id === id ? ({ ...r, config: { ...r.config, ...patch } } as Resource) : r)),
  };
}

function removeConnections(project: Project, predicate: (c: Connection) => boolean): Project {
  return { ...project, connections: project.connections.filter((c) => !predicate(c)) };
}

function removeResources(project: Project, ids: string[]): Project {
  const set = new Set(ids);
  return {
    ...project,
    resources: project.resources.filter((r) => !set.has(r.id)),
    connections: project.connections.filter((c) => !set.has(c.sourceResourceId) && !set.has(c.targetResourceId)),
  };
}

function find<T extends ResourceType>(project: Project, id: string | null | undefined, type: T): ResourceOfType<T> | undefined {
  const r = project.resources.find((x) => x.id === id);
  return r && r.type === type ? (r as ResourceOfType<T>) : undefined;
}

function notFound(type: ResourceType, id: string | null | undefined): ActionResult {
  const codes: Partial<Record<ResourceType, string>> = {
    vpc: "InvalidVpcID.NotFound",
    subnet: "InvalidSubnetID.NotFound",
    "internet-gateway": "InvalidInternetGatewayID.NotFound",
    "route-table": "InvalidRouteTableID.NotFound",
    "nat-gateway": "NatGatewayNotFound",
    "elastic-ip": "InvalidAllocationID.NotFound",
    "security-group": "InvalidGroup.NotFound",
    "network-acl": "InvalidNetworkAclID.NotFound",
    ec2: "InvalidInstanceID.NotFound",
    alb: "LoadBalancerNotFound",
    "target-group": "TargetGroupNotFound",
    "db-subnet-group": "DBSubnetGroupNotFoundFault",
    rds: "DBInstanceNotFound",
  };
  return awsFail(codes[type] ?? "NotFound", `${RESOURCE_TYPE_INFO[type].label} '${id ?? ""}'을(를) 찾을 수 없습니다.`);
}

function checkNameTag(name: string): ActionResult | null {
  if (name.trim().length > 128) return awsFail("InvalidParameterValue", "Name 태그는 128자 이하여야 합니다.");
  return null;
}

// ---------------------------------------------------------------- VPC

export interface CreateVpcInput {
  name: string;
  cidr: string;
}

/**
 * VPC 생성. AWS와 동일하게 기본(main) 라우팅 테이블, 기본 네트워크 ACL(모두 허용), 기본 보안 그룹을 함께 만든다.
 * DNS 확인은 켜짐, DNS 호스트 이름은 꺼짐이 AWS 기본값이다.
 */
export function createVpc(project: Project, input: CreateVpcInput): ActionResult {
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const parsed = parseCidr(input.cidr);
  if (!parsed.ok) return awsFail("InvalidParameterValue", `IPv4 CIDR 블록 '${input.cidr}'이(가) 올바르지 않습니다. ${parsed.error}`);
  const sized = validateVpcCidr(input.cidr);
  if (!sized.ok) return awsFail("InvalidVpc.Range", `CIDR '${parsed.value.text}'은(는) 사용할 수 없습니다. ${sized.error}`);

  let p = project;
  const vpc = addResource(p, "vpc", input.name, { cidr: parsed.value.text, enableDnsSupport: true, enableDnsHostnames: false, isDefault: false });
  p = vpc.project;
  const rt = addResource(p, "route-table", "", { main: true }, vpc.resource.id);
  p = rt.project;
  const nacl = addResource(
    p,
    "network-acl",
    "",
    {
      isDefault: true,
      inboundRules: [NACL.allow(100, "all", null, "0.0.0.0/0")],
      outboundRules: [NACL.allow(100, "all", null, "0.0.0.0/0")],
    },
    vpc.resource.id,
  );
  p = nacl.project;
  const sgId = createId("sg");
  const sg = addResource(
    p,
    "security-group",
    "default",
    {
      description: "default VPC security group",
      isDefault: true,
      inboundRules: [SG.all({ sg: sgId }, "같은 보안 그룹의 리소스끼리 모든 트래픽 허용")],
      outboundRules: [SG.all("0.0.0.0/0")],
    },
    vpc.resource.id,
  );
  p = { ...sg.project, resources: sg.project.resources.map((r) => (r.id === sg.resource.id ? { ...r, id: sgId } : r)) };
  p = addConnections(p, [
    link("vpc-route-table", vpc.resource.id, rt.resource.id),
    link("vpc-network-acl", vpc.resource.id, nacl.resource.id),
    link("vpc-security-group", vpc.resource.id, sgId),
  ]);
  return ok(
    touch(p),
    [`기본 라우팅 테이블 ${rt.resource.id}, 기본 네트워크 ACL ${nacl.resource.id}, 기본 보안 그룹 ${sgId}이(가) 함께 생성되었습니다.`],
    vpc.resource.id,
  );
}

/**
 * 기본 VPC 생성 (AWS 콘솔: 작업 → 기본 VPC 생성). 사용자가 직접 선택할 때만 실행한다.
 * 172.31.0.0/16 VPC, 가용 영역마다 /20 기본 서브넷(퍼블릭 IP 자동 할당), 연결된 인터넷 게이트웨이,
 * 기본 라우팅 테이블의 0.0.0.0/0 → IGW 경로를 만든다. 리전당 하나만 만들 수 있다.
 */
export function createDefaultVpc(project: Project): ActionResult {
  if (project.resources.some((r) => r.type === "vpc" && r.config.isDefault)) {
    return awsFail("DefaultVpcAlreadyExists", "이 리전에는 이미 기본 VPC가 있습니다.");
  }
  const created = createVpc(project, { name: "", cidr: "172.31.0.0/16" });
  if (!created.ok) return created;
  const vpcId = created.createdId!;
  let p = updateConfig<"vpc">(created.project, vpcId, { isDefault: true, enableDnsHostnames: true });
  const subnetIds: string[] = [];
  for (const [i, az] of AVAILABILITY_ZONES.entries()) {
    const subnet = createSubnet(p, { vpcId, name: "", availabilityZone: az, cidr: `172.31.${i * 16}.0/20` });
    if (!subnet.ok) return subnet;
    p = updateConfig<"subnet">(subnet.project, subnet.createdId!, { mapPublicIpOnLaunch: true });
    subnetIds.push(subnet.createdId!);
  }
  const igw = createInternetGateway(p, { name: "" });
  if (!igw.ok) return igw;
  const attached = attachInternetGateway(igw.project, igw.createdId!, vpcId);
  if (!attached.ok) return attached;
  p = attached.project;
  const mainRt = buildTopology(p).routeTablesOfVpc(vpcId).find((rt) => rt.config.main);
  if (mainRt) {
    const routed = editRoutes(p, mainRt.id, [{ destination: "0.0.0.0/0", targetId: igw.createdId! }]);
    if (!routed.ok) return routed;
    p = routed.project;
  }
  return ok(
    touch(p),
    [`기본 서브넷 ${subnetIds.length}개(퍼블릭 IP 자동 할당), 인터넷 게이트웨이 ${igw.createdId}, 0.0.0.0/0 → IGW 경로가 함께 생성되었습니다.`],
    vpcId,
  );
}

export function editVpcSettings(project: Project, vpcId: string, settings: { enableDnsSupport: boolean; enableDnsHostnames: boolean }): ActionResult {
  const vpc = find(project, vpcId, "vpc");
  if (!vpc) return notFound("vpc", vpcId);
  if (settings.enableDnsHostnames && !settings.enableDnsSupport) {
    return awsFail("InvalidParameterCombination", "DNS 호스트 이름을 사용하려면 DNS 확인(enableDnsSupport)도 켜야 합니다.");
  }
  const topo = buildTopology(project);
  if (!settings.enableDnsHostnames || !settings.enableDnsSupport) {
    const publicDb = topo.ofType("rds").find((r) => r.config.publiclyAccessible && topo.vpcOf(r.id) === vpcId);
    if (publicDb) {
      return awsFail(
        "InvalidParameterValue",
        `퍼블릭 액세스가 켜진 DB 인스턴스(${displayName(publicDb)})가 있어 DNS 설정을 끌 수 없습니다.`,
        "DB의 퍼블릭 액세스를 먼저 끄세요.",
      );
    }
  }
  return ok(touch(updateConfig<"vpc">(project, vpcId, settings)));
}

/** VPC 삭제: 인스턴스·NAT·로드 밸런서·DB가 남아 있으면 거부한다. 서브넷·라우팅 테이블·NACL·보안 그룹은 함께 삭제하고 IGW는 분리한다. */
export function deleteVpc(project: Project, vpcId: string): ActionResult {
  const vpc = find(project, vpcId, "vpc");
  if (!vpc) return notFound("vpc", vpcId);
  const topo = buildTopology(project);
  const blocking = project.resources.filter(
    (r) =>
      (r.type === "ec2" && r.config.state !== "terminated" && topo.vpcOf(r.id) === vpcId) ||
      ((r.type === "nat-gateway" || r.type === "alb" || r.type === "rds") && topo.vpcsOf(r.id).includes(vpcId)),
  );
  if (blocking.length) {
    return awsFail(
      "DependencyViolation",
      `VPC ${vpcId}에 아직 리소스가 있습니다: ${blocking.slice(0, 5).map((r) => topo.label(r.id)).join(", ")}`,
      "인스턴스를 종료하고 NAT 게이트웨이, 로드 밸런서, DB 인스턴스를 먼저 삭제하세요.",
    );
  }
  const scoped = project.resources
    .filter(
      (r) =>
        (r.type === "subnet" || r.type === "route-table" || r.type === "network-acl" || r.type === "security-group" || (r.type === "ec2" && r.config.state === "terminated")) &&
        topo.vpcOf(r.id) === vpcId,
    )
    .map((r) => r.id);
  const tgs = topo.ofType("target-group").filter((tg) => topo.vpcOf(tg.id) === vpcId);
  if (tgs.length) {
    return awsFail("DependencyViolation", `VPC에 대상 그룹이 남아 있습니다: ${tgs.map((t) => displayName(t)).join(", ")}`, "대상 그룹을 먼저 삭제하세요.");
  }
  const dbsgs = topo.ofType("db-subnet-group").filter((g) => topo.vpcsOf(g.id).includes(vpcId));
  if (dbsgs.length) {
    return awsFail("DependencyViolation", `VPC의 서브넷을 사용하는 DB 서브넷 그룹이 있습니다: ${dbsgs.map((g) => displayName(g)).join(", ")}`, "DB 서브넷 그룹을 먼저 삭제하세요.");
  }
  const igw = topo.igwOfVpc(vpcId);
  const p = removeResources(project, [vpcId, ...scoped]);
  return ok(touch(p), [
    `서브넷·라우팅 테이블·네트워크 ACL·보안 그룹 ${scoped.length}개를 함께 삭제했습니다.`,
    ...(igw ? [`인터넷 게이트웨이 ${displayName(igw)}은(는) 분리(Detached) 상태로 남아 있습니다.`] : []),
  ]);
}

// ---------------------------------------------------------------- Subnet

export interface CreateSubnetInput {
  vpcId: string;
  name: string;
  /** null이면 "기본 설정 없음" — 서브넷이 가장 적은 가용 영역을 고른다 */
  availabilityZone: string | null;
  cidr: string;
}

export function createSubnet(project: Project, input: CreateSubnetInput): ActionResult {
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return notFound("vpc", input.vpcId);
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const parsed = parseCidr(input.cidr);
  if (!parsed.ok) return awsFail("InvalidParameterValue", `IPv4 서브넷 CIDR 블록 '${input.cidr}'이(가) 올바르지 않습니다. ${parsed.error}`);
  const vpcCidr = tryParseCidr(vpc.config.cidr);
  const sized = validateSubnetCidr(input.cidr);
  if (!sized.ok || !vpcCidr || !cidrContainsCidr(vpcCidr, parsed.value)) {
    return awsFail(
      "InvalidSubnet.Range",
      `CIDR '${parsed.value.text}'은(는) 사용할 수 없습니다. ${!sized.ok ? sized.error : `VPC ${displayName(vpc)}의 범위(${vpc.config.cidr}) 안에 있어야 합니다.`}`,
    );
  }
  const topo = buildTopology(project);
  const conflict = topo.subnetsOfVpc(vpc.id).find((s) => {
    const c = tryParseCidr(s.config.cidr);
    return c && cidrsOverlap(c, parsed.value);
  });
  if (conflict) {
    return awsFail("InvalidSubnet.Conflict", `CIDR '${parsed.value.text}'이(가) 서브넷 ${displayName(conflict)}(${conflict.config.cidr})과 겹칩니다.`);
  }
  let az = input.availabilityZone;
  if (az && !(AVAILABILITY_ZONES as readonly string[]).includes(az)) {
    return awsFail("InvalidParameterValue", `가용 영역 '${az}'은(는) 이 리전에 없습니다.`);
  }
  if (!az) {
    const counts = AVAILABILITY_ZONES.map((zone) => ({ zone, n: topo.subnetsOfVpc(vpc.id).filter((s) => s.config.availabilityZone === zone).length }));
    az = counts.sort((a, b) => a.n - b.n)[0].zone;
  }
  const added = addResource(project, "subnet", input.name, { cidr: parsed.value.text, availabilityZone: az, mapPublicIpOnLaunch: false }, vpc.id);
  const defaultNacl = topo.ofType("network-acl").find((n) => n.config.isDefault && topo.vpcOf(n.id) === vpc.id);
  const p = addConnections(added.project, [
    link("vpc-subnet", vpc.id, added.resource.id),
    ...(defaultNacl ? [link("network-acl-subnet", defaultNacl.id, added.resource.id)] : []),
  ]);
  const notes = [`가용 영역 ${az}에 생성했습니다.`];
  if (defaultNacl) notes.push(`VPC의 기본 네트워크 ACL(${defaultNacl.id})과 자동으로 연결되었습니다.`);
  notes.push("명시적으로 연결한 라우팅 테이블이 없으므로 VPC의 기본(main) 라우팅 테이블을 사용합니다.");
  return ok(touch(p), notes, added.resource.id);
}

export function editSubnetSettings(project: Project, subnetId: string, settings: { mapPublicIpOnLaunch: boolean }): ActionResult {
  if (!find(project, subnetId, "subnet")) return notFound("subnet", subnetId);
  return ok(touch(updateConfig<"subnet">(project, subnetId, settings)));
}

export function deleteSubnet(project: Project, subnetId: string): ActionResult {
  const subnet = find(project, subnetId, "subnet");
  if (!subnet) return notFound("subnet", subnetId);
  const topo = buildTopology(project);
  const users = project.resources.filter(
    (r) =>
      ((r.type === "ec2" && r.config.state !== "terminated") || r.type === "nat-gateway") && topo.subnetOf(r.id) === subnetId,
  );
  const albs = topo.ofType("alb").filter((a) => topo.albSubnets(a.id).some((s) => s.id === subnetId));
  const dbsgs = topo.ofType("db-subnet-group").filter((g) => topo.dbSubnetGroupSubnets(g.id).some((s) => s.id === subnetId));
  const deps = [...users, ...albs, ...dbsgs];
  if (deps.length) {
    return awsFail(
      "DependencyViolation",
      `서브넷 ${subnetId}을(를) 사용하는 리소스가 있습니다: ${deps.slice(0, 5).map((r) => topo.label(r.id)).join(", ")}`,
      "인스턴스를 종료하고 NAT 게이트웨이를 삭제하며, 로드 밸런서/DB 서브넷 그룹에서 이 서브넷을 제외하세요.",
    );
  }
  const terminated = project.resources.filter((r) => r.type === "ec2" && r.config.state === "terminated" && topo.subnetOf(r.id) === subnetId).map((r) => r.id);
  return ok(touch(removeResources(project, [subnetId, ...terminated])));
}

// ---------------------------------------------------------------- Internet Gateway

export function createInternetGateway(project: Project, input: { name: string }): ActionResult {
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const added = addResource(project, "internet-gateway", input.name, {});
  return ok(touch(added.project), ["인터넷 게이트웨이는 Detached 상태로 생성됩니다. 작업 → VPC에 연결을 선택하세요."], added.resource.id);
}

export function attachInternetGateway(project: Project, igwId: string, vpcId: string): ActionResult {
  const igw = find(project, igwId, "internet-gateway");
  if (!igw) return notFound("internet-gateway", igwId);
  const vpc = find(project, vpcId, "vpc");
  if (!vpc) return notFound("vpc", vpcId);
  const topo = buildTopology(project);
  const current = topo.vpcOfIgw(igwId);
  if (current) return awsFail("Resource.AlreadyAssociated", `인터넷 게이트웨이 ${igwId}은(는) 이미 ${current}에 연결되어 있습니다.`);
  const existing = topo.igwOfVpc(vpcId);
  if (existing) return awsFail("Resource.AlreadyAssociated", `VPC ${vpcId}에는 이미 인터넷 게이트웨이 ${existing.id}가 연결되어 있습니다. VPC당 하나만 연결할 수 있습니다.`);
  return ok(touch(addConnections(project, [link("vpc-internet-gateway", vpcId, igwId)])));
}

function mappedPublicAddresses(topo: Topology, vpcId: string): string[] {
  const mapped: string[] = [];
  for (const eni of topo.enis()) {
    if (eni.vpcId !== vpcId || eni.publicIp === null) continue;
    mapped.push(eni.label);
  }
  return [...new Set(mapped)];
}

export function detachInternetGateway(project: Project, igwId: string): ActionResult {
  const igw = find(project, igwId, "internet-gateway");
  if (!igw) return notFound("internet-gateway", igwId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOfIgw(igwId);
  if (!vpcId) return awsFail("Gateway.NotAttached", `인터넷 게이트웨이 ${igwId}은(는) VPC에 연결되어 있지 않습니다.`);
  const mapped = mappedPublicAddresses(topo, vpcId);
  if (mapped.length) {
    return awsFail(
      "DependencyViolation",
      `VPC ${vpcId}에 매핑된 퍼블릭 주소가 있어 분리할 수 없습니다: ${mapped.slice(0, 4).join(", ")}`,
      "탄력적 IP 연결을 해제하고, 퍼블릭 IP가 있는 인스턴스를 중지하거나 종료하고, NAT 게이트웨이와 internet-facing 로드 밸런서를 삭제하세요.",
    );
  }
  return ok(touch(removeConnections(project, (c) => c.relationType === "vpc-internet-gateway" && c.targetResourceId === igwId)));
}

export function deleteInternetGateway(project: Project, igwId: string): ActionResult {
  const igw = find(project, igwId, "internet-gateway");
  if (!igw) return notFound("internet-gateway", igwId);
  const vpcId = buildTopology(project).vpcOfIgw(igwId);
  if (vpcId) return awsFail("DependencyViolation", `인터넷 게이트웨이 ${igwId}이(가) ${vpcId}에 연결되어 있습니다.`, "먼저 VPC에서 분리하세요.");
  return ok(touch(removeResources(project, [igwId])));
}

// ---------------------------------------------------------------- Route Table

export function createRouteTable(project: Project, input: { vpcId: string; name: string }): ActionResult {
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return notFound("vpc", input.vpcId);
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const added = addResource(project, "route-table", input.name, { main: false }, vpc.id);
  return ok(touch(addConnections(added.project, [link("vpc-route-table", vpc.id, added.resource.id)])), [
    `local 경로(${vpc.config.cidr})만 있는 라우팅 테이블이 생성되었습니다.`,
  ], added.resource.id);
}

export interface RouteInput {
  destination: string;
  targetId: string;
}

/** 라우팅 편집: local을 제외한 경로 목록 전체를 입력값으로 바꾼다. */
export function editRoutes(project: Project, routeTableId: string, routes: RouteInput[]): ActionResult {
  const rt = find(project, routeTableId, "route-table");
  if (!rt) return notFound("route-table", routeTableId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(rt.id);
  const vpcCidr = topo.vpcCidr(vpcId);
  const seen = new Set<string>();
  const next: Connection[] = [];
  const existing = topo.outgoing(rt.id).filter((c) => c.relationType === "route-table-internet-gateway" || c.relationType === "route-table-nat-gateway");
  for (const [i, route] of routes.entries()) {
    const parsed = parseCidr(route.destination);
    if (!parsed.ok) return awsFail("InvalidParameterValue", `경로 ${i + 1}: 대상 '${route.destination}'이(가) 올바른 CIDR이 아닙니다. ${parsed.error}`);
    const dest = parsed.value.text;
    if (vpcCidr && dest === vpcCidr.text) return awsFail("InvalidParameterValue", `경로 ${i + 1}: ${dest}은(는) local 경로와 같은 대상입니다.`);
    if (vpcCidr && parsed.value.prefix > vpcCidr.prefix && cidrContainsCidr(vpcCidr, parsed.value)) {
      return awsFail(
        "InvalidParameterValue",
        `경로 ${i + 1}: VPC CIDR(${vpcCidr.text})보다 구체적인 경로 ${dest}의 대상으로 인터넷/NAT 게이트웨이를 지정할 수 없습니다.`,
      );
    }
    if (seen.has(dest)) return awsFail("RouteAlreadyExists", `대상 ${dest}에 대한 경로가 두 번 이상 지정되었습니다.`);
    seen.add(dest);
    const target = topo.get(route.targetId);
    if (!target || (target.type !== "internet-gateway" && target.type !== "nat-gateway")) {
      return awsFail("InvalidParameterValue", `경로 ${i + 1}: 대상 리소스를 선택하세요 (인터넷 게이트웨이 또는 NAT 게이트웨이).`);
    }
    if (target.type === "internet-gateway" && topo.vpcOfIgw(target.id) !== vpcId) {
      return awsFail("InvalidParameterValue", `경로 ${i + 1}: 인터넷 게이트웨이 ${target.id}이(가) 이 라우팅 테이블의 VPC(${vpcId})에 연결되어 있지 않습니다.`);
    }
    if (target.type === "nat-gateway" && topo.vpcOf(target.id) !== vpcId) {
      return awsFail("InvalidParameterValue", `경로 ${i + 1}: NAT 게이트웨이 ${target.id}이(가) 다른 VPC에 있습니다.`);
    }
    const relationType: RelationType = target.type === "internet-gateway" ? "route-table-internet-gateway" : "route-table-nat-gateway";
    const keep = existing.find(
      (c) => c.relationType === relationType && c.targetResourceId === target.id && "destinationCidr" in c.metadata && c.metadata.destinationCidr === dest,
    );
    next.push(keep ?? link(relationType, rt.id, target.id, { destinationCidr: dest }));
  }
  const removeIds = new Set(existing.map((c) => c.id));
  const p = { ...project, connections: [...project.connections.filter((c) => !removeIds.has(c.id)), ...next] };
  return ok(touch(p));
}

/** 서브넷 연결 편집: 선택한 서브넷을 이 테이블에 명시적으로 연결하고(다른 테이블에서 이동), 해제된 서브넷은 기본 테이블로 돌아간다. */
export function editRouteTableAssociations(project: Project, routeTableId: string, subnetIds: string[]): ActionResult {
  const rt = find(project, routeTableId, "route-table");
  if (!rt) return notFound("route-table", routeTableId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(rt.id);
  for (const id of subnetIds) {
    const subnet = find(project, id, "subnet");
    if (!subnet) return notFound("subnet", id);
    if (topo.vpcOfSubnet(id) !== vpcId) return awsFail("InvalidParameterValue", `서브넷 ${id}은(는) 라우팅 테이블과 다른 VPC에 있습니다.`);
  }
  const selected = new Set(subnetIds);
  const p = removeConnections(
    project,
    (c) => c.relationType === "route-table-subnet" && (selected.has(c.targetResourceId) || c.sourceResourceId === rt.id),
  );
  return ok(touch(addConnections(p, subnetIds.map((id) => link("route-table-subnet", rt.id, id)))));
}

export function makeMainRouteTable(project: Project, routeTableId: string): ActionResult {
  const rt = find(project, routeTableId, "route-table");
  if (!rt) return notFound("route-table", routeTableId);
  const vpcId = buildTopology(project).vpcOf(rt.id);
  if (!vpcId) return awsFail("InvalidParameterValue", "라우팅 테이블이 VPC에 속해 있지 않습니다.");
  return setMainRouteTable(project, vpcId, routeTableId);
}

export function deleteRouteTable(project: Project, routeTableId: string): ActionResult {
  const rt = find(project, routeTableId, "route-table");
  if (!rt) return notFound("route-table", routeTableId);
  if (rt.config.main) return awsFail("DependencyViolation", `${routeTableId}은(는) VPC의 기본(main) 라우팅 테이블이라 삭제할 수 없습니다.`, "다른 테이블을 기본으로 지정한 뒤 삭제하세요.");
  const associations = buildTopology(project).outgoing(rt.id, "route-table-subnet");
  if (associations.length) {
    return awsFail("DependencyViolation", `라우팅 테이블 ${routeTableId}에 연결된 서브넷이 ${associations.length}개 있습니다.`, "서브넷 연결을 먼저 해제하세요.");
  }
  return ok(touch(removeResources(project, [routeTableId])));
}

// ---------------------------------------------------------------- Elastic IP

export function allocateElasticIp(project: Project, input: { name: string }): ActionResult {
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const ip = allocateVirtualPublicIp(project);
  if (!ip) return awsFail("AddressLimitExceeded", "더 이상 할당할 수 있는 가상 퍼블릭 IPv4 주소가 없습니다.");
  const added = addResource(project, "elastic-ip", input.name, { publicIp: ip });
  return ok(touch(added.project), [`가상 퍼블릭 IPv4 주소 ${ip}을(를) 할당했습니다. (실제 공인 IP 아님)`], added.resource.id);
}

export function associateElasticIp(project: Project, eipId: string, instanceId: string): ActionResult {
  const eip = find(project, eipId, "elastic-ip");
  if (!eip) return notFound("elastic-ip", eipId);
  const ec2 = find(project, instanceId, "ec2");
  if (!ec2) return notFound("ec2", instanceId);
  const topo = buildTopology(project);
  const target = topo.elasticIpTarget(eipId);
  if (target) return awsFail("Resource.AlreadyAssociated", `탄력적 IP ${eip.config.publicIp}은(는) 이미 ${topo.label(target.id)}에 연결되어 있습니다.`);
  if (topo.elasticIpOf(instanceId)) return awsFail("Resource.AlreadyAssociated", `인스턴스 ${instanceId}에는 이미 탄력적 IP가 연결되어 있습니다.`);
  const plan = checkConnection(project, eipId, instanceId, { console: true }, topo);
  if (!plan.ok) return { ok: false, error: plan.reason, hint: plan.hint };
  return ok(touch(addConnections(project, [plan.connection])), [`${eip.config.publicIp}이(가) ${displayName(ec2)}의 퍼블릭 IPv4 주소가 되었습니다.`]);
}

export function disassociateElasticIp(project: Project, eipId: string): ActionResult {
  const eip = find(project, eipId, "elastic-ip");
  if (!eip) return notFound("elastic-ip", eipId);
  const topo = buildTopology(project);
  const target = topo.elasticIpTarget(eipId);
  if (!target) return awsFail("InvalidAssociationID.NotFound", `탄력적 IP ${eip.config.publicIp}은(는) 연결되어 있지 않습니다.`);
  if (target.type === "nat-gateway") {
    return awsFail("InvalidIPAddress.InUse", `탄력적 IP가 NAT 게이트웨이 ${target.id}에서 사용 중입니다.`, "NAT 게이트웨이를 삭제하면 연결이 해제됩니다.");
  }
  return ok(touch(removeConnections(project, (c) => c.relationType === "elastic-ip-ec2" && c.sourceResourceId === eipId)));
}

export function releaseElasticIp(project: Project, eipId: string): ActionResult {
  const eip = find(project, eipId, "elastic-ip");
  if (!eip) return notFound("elastic-ip", eipId);
  const target = buildTopology(project).elasticIpTarget(eipId);
  if (target) return awsFail("InvalidIPAddress.InUse", `탄력적 IP ${eip.config.publicIp}이(가) ${target.id}에 연결되어 있습니다.`, "먼저 연결을 해제하세요.");
  return ok(touch(removeResources(project, [eipId])));
}

// ---------------------------------------------------------------- NAT Gateway

export function createNatGateway(project: Project, input: { name: string; subnetId: string; eipId: string }): ActionResult {
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const subnet = find(project, input.subnetId, "subnet");
  if (!subnet) return notFound("subnet", input.subnetId);
  const eip = find(project, input.eipId, "elastic-ip");
  if (!eip) return awsFail("MissingParameter", "퍼블릭 NAT 게이트웨이에는 탄력적 IP 할당 ID가 필요합니다.", "탄력적 IP를 먼저 할당하세요.");
  const topo = buildTopology(project);
  const vpcId = topo.vpcOfSubnet(subnet.id);
  if (!vpcId || !topo.igwOfVpc(vpcId)) {
    return awsFail("Gateway.NotAttached", `네트워크 ${vpcId ?? "(VPC 없음)"}에 인터넷 게이트웨이가 연결되어 있지 않습니다.`, "VPC에 인터넷 게이트웨이를 먼저 연결하세요.");
  }
  const used = topo.elasticIpTarget(eip.id);
  if (used) return awsFail("Resource.AlreadyAssociated", `탄력적 IP ${eip.config.publicIp}은(는) 이미 ${used.id}에 연결되어 있습니다.`);
  const added = addResource(project, "nat-gateway", input.name, { state: "pending" }, subnet.id);
  const p = addConnections(added.project, [link("nat-gateway-subnet", added.resource.id, subnet.id), link("elastic-ip-nat-gateway", eip.id, added.resource.id)]);
  const notes = ["NAT 게이트웨이는 Pending 상태로 생성되며 잠시 후 Available이 됩니다."];
  if (topo.classifySubnet(subnet.id).kind !== "public") notes.push("주의: 선택한 서브넷은 퍼블릭 서브넷이 아닙니다 (IGW 경로 없음). 이 NAT를 거친 인터넷 통신은 실패합니다.");
  return ok(touch(p), notes, added.resource.id);
}

export function deleteNatGateway(project: Project, natId: string): ActionResult {
  const nat = find(project, natId, "nat-gateway");
  if (!nat) return notFound("nat-gateway", natId);
  const routes = project.connections.filter((c) => c.relationType === "route-table-nat-gateway" && c.targetResourceId === natId).length;
  return ok(touch(removeResources(project, [natId])), [
    "NAT 게이트웨이를 삭제했고 탄력적 IP 연결이 해제되었습니다.",
    ...(routes ? [`이 NAT를 가리키던 경로 ${routes}개가 삭제되었습니다. (실제 AWS에서는 Blackhole 상태로 남습니다.)`] : []),
  ]);
}

// ---------------------------------------------------------------- Security Group

export interface CreateSecurityGroupInput {
  name: string;
  description: string;
  vpcId: string;
  inboundRules: SgRule[];
  outboundRules: SgRule[];
}

const SG_NAME_PATTERN = /^[\w .\-:/()#,@[\]+=&;{}!$*]{1,255}$/;

function ruleKey(r: SgRule) {
  const peer = r.peer.kind === "cidr" ? `cidr:${tryParseCidr(r.peer.cidr)?.text ?? r.peer.cidr}` : `sg:${r.peer.securityGroupId}`;
  const ports = r.protocol === "all" || r.protocol === "icmp" ? "*" : `${r.fromPort}-${r.toPort}`;
  return `${r.protocol}|${ports}|${peer}`;
}

/** 규칙 목록 검증 (형식, 중복, 참조하는 보안 그룹의 VPC) */
export function validateSgRules(project: Project, vpcId: string, rules: SgRule[], direction: "inbound" | "outbound", selfId?: string): ActionResult | null {
  const topo = buildTopology(project);
  const seen = new Set<string>();
  const dirLabel = direction === "inbound" ? "인바운드" : "아웃바운드";
  for (const [i, r] of rules.entries()) {
    if ((r.protocol === "tcp" || r.protocol === "udp") && (r.fromPort > r.toPort || r.toPort > 65535)) {
      return awsFail("InvalidParameterValue", `${dirLabel} 규칙 ${i + 1}: 포트 범위가 올바르지 않습니다.`);
    }
    if (r.peer.kind === "cidr" && !parseCidr(r.peer.cidr).ok) {
      return awsFail("InvalidParameterValue", `${dirLabel} 규칙 ${i + 1}: CIDR '${r.peer.cidr}'이(가) 올바르지 않습니다.`);
    }
    if (r.peer.kind === "security-group" && r.peer.securityGroupId !== selfId) {
      const ref = topo.getOfType(r.peer.securityGroupId, "security-group");
      if (!ref) return awsFail("InvalidGroup.NotFound", `${dirLabel} 규칙 ${i + 1}: 보안 그룹 '${r.peer.securityGroupId}'이(가) 없습니다.`);
      if (topo.vpcOf(ref.id) !== vpcId) return awsFail("InvalidGroup.NotFound", `${dirLabel} 규칙 ${i + 1}: 보안 그룹 ${ref.id}은(는) 다른 VPC에 있습니다.`);
    }
    const key = ruleKey(r);
    if (seen.has(key)) return awsFail("InvalidPermission.Duplicate", `${dirLabel} 규칙 ${i + 1}이(가) 다른 규칙과 중복됩니다.`);
    seen.add(key);
  }
  return null;
}

export function createSecurityGroup(project: Project, input: CreateSecurityGroupInput): ActionResult {
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return notFound("vpc", input.vpcId);
  const name = input.name.trim();
  if (!name) return awsFail("MissingParameter", "보안 그룹 이름을 입력하세요.");
  if (!SG_NAME_PATTERN.test(name)) return awsFail("InvalidParameterValue", "보안 그룹 이름에 사용할 수 없는 문자가 있습니다.");
  if (name.toLowerCase() === "default" || name.toLowerCase().startsWith("sg-")) {
    return awsFail("InvalidParameterValue", `'${name}'은(는) 예약된 이름이거나 'sg-'로 시작해 사용할 수 없습니다.`);
  }
  if (!input.description.trim()) return awsFail("MissingParameter", "보안 그룹 설명을 입력하세요. (AWS에서 필수)");
  const topo = buildTopology(project);
  if (topo.ofType("security-group").some((g) => topo.vpcOf(g.id) === vpc.id && g.name === name)) {
    return awsFail("InvalidGroup.Duplicate", `VPC ${vpc.id}에 '${name}' 보안 그룹이 이미 있습니다.`);
  }
  const id = createId("sg");
  for (const [rules, dir] of [
    [input.inboundRules, "inbound"],
    [input.outboundRules, "outbound"],
  ] as const) {
    const invalid = validateSgRules(project, vpc.id, rules, dir, id);
    if (invalid) return invalid;
  }
  const added = addResource(
    project,
    "security-group",
    name,
    { description: input.description.trim(), inboundRules: input.inboundRules, outboundRules: input.outboundRules, isDefault: false },
    vpc.id,
  );
  const p = {
    ...added.project,
    resources: added.project.resources.map((r) => (r.id === added.resource.id ? { ...r, id } : r)),
  };
  return ok(touch(addConnections(p, [link("vpc-security-group", vpc.id, id)])), [], id);
}

export function editSecurityGroupRules(project: Project, sgId: string, direction: "inbound" | "outbound", rules: SgRule[]): ActionResult {
  const sg = find(project, sgId, "security-group");
  if (!sg) return notFound("security-group", sgId);
  const vpcId = buildTopology(project).vpcOf(sg.id);
  if (!vpcId) return awsFail("InvalidParameterValue", "보안 그룹이 VPC에 속해 있지 않습니다.");
  const invalid = validateSgRules(project, vpcId, rules, direction, sg.id);
  if (invalid) return invalid;
  return ok(touch(updateConfig<"security-group">(project, sg.id, direction === "inbound" ? { inboundRules: rules } : { outboundRules: rules })));
}

export function deleteSecurityGroup(project: Project, sgId: string): ActionResult {
  const sg = find(project, sgId, "security-group");
  if (!sg) return notFound("security-group", sgId);
  if (sg.config.isDefault) return awsFail("CannotDelete", "VPC의 기본(default) 보안 그룹은 삭제할 수 없습니다.");
  const topo = buildTopology(project);
  const users = topo.resourcesUsingSecurityGroup(sg.id).filter((r) => !(r.type === "ec2" && r.config.state === "terminated"));
  if (users.length) {
    return awsFail("DependencyViolation", `보안 그룹 ${sgId}을(를) 사용하는 리소스가 있습니다: ${users.slice(0, 5).map((r) => topo.label(r.id)).join(", ")}`, "리소스에서 이 보안 그룹을 먼저 제거하세요.");
  }
  const referencing = topo
    .ofType("security-group")
    .filter((g) => g.id !== sg.id && [...g.config.inboundRules, ...g.config.outboundRules].some((r) => r.peer.kind === "security-group" && r.peer.securityGroupId === sg.id));
  if (referencing.length) {
    return awsFail("DependencyViolation", `다른 보안 그룹의 규칙이 ${sgId}을(를) 참조합니다: ${referencing.map((g) => displayName(g)).join(", ")}`, "참조하는 규칙을 먼저 삭제하세요.");
  }
  return ok(touch(removeResources(project, [sg.id])));
}

// ---------------------------------------------------------------- Network ACL

export function createNetworkAcl(project: Project, input: { name: string; vpcId: string }): ActionResult {
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return notFound("vpc", input.vpcId);
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const added = addResource(project, "network-acl", input.name, { inboundRules: [], outboundRules: [], isDefault: false }, vpc.id);
  return ok(touch(addConnections(added.project, [link("vpc-network-acl", vpc.id, added.resource.id)])), [
    "새 사용자 지정 네트워크 ACL은 규칙이 없어 모든 인바운드/아웃바운드 트래픽을 거부합니다.",
  ], added.resource.id);
}

export function editNetworkAclRules(project: Project, naclId: string, direction: "inbound" | "outbound", rules: NaclRule[]): ActionResult {
  const nacl = find(project, naclId, "network-acl");
  if (!nacl) return notFound("network-acl", naclId);
  const numbers = new Set<number>();
  for (const r of rules) {
    if (!Number.isInteger(r.ruleNumber) || r.ruleNumber < 1 || r.ruleNumber > 32766) {
      return awsFail("InvalidParameterValue", `규칙 번호 ${r.ruleNumber}은(는) 1~32766 사이여야 합니다.`);
    }
    if (numbers.has(r.ruleNumber)) return awsFail("NetworkAclEntryAlreadyExists", `규칙 번호 ${r.ruleNumber}이(가) 이미 있습니다.`);
    numbers.add(r.ruleNumber);
    if (!parseCidr(r.cidr).ok) return awsFail("InvalidParameterValue", `규칙 #${r.ruleNumber}: CIDR '${r.cidr}'이(가) 올바르지 않습니다.`);
    if ((r.protocol === "tcp" || r.protocol === "udp") && r.fromPort > r.toPort) {
      return awsFail("InvalidParameterValue", `규칙 #${r.ruleNumber}: 포트 범위가 올바르지 않습니다.`);
    }
  }
  return ok(touch(updateConfig<"network-acl">(project, naclId, direction === "inbound" ? { inboundRules: rules } : { outboundRules: rules })));
}

/** 서브넷 연결 편집: 선택한 서브넷을 이 NACL로 옮기고, 해제한 서브넷은 VPC 기본 NACL로 돌아간다. */
export function editNetworkAclAssociations(project: Project, naclId: string, subnetIds: string[]): ActionResult {
  const nacl = find(project, naclId, "network-acl");
  if (!nacl) return notFound("network-acl", naclId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(nacl.id);
  for (const id of subnetIds) {
    if (!find(project, id, "subnet")) return notFound("subnet", id);
    if (topo.vpcOfSubnet(id) !== vpcId) return awsFail("InvalidParameterValue", `서브넷 ${id}은(는) 네트워크 ACL과 다른 VPC에 있습니다.`);
  }
  const defaultNacl = topo.ofType("network-acl").find((n) => n.config.isDefault && topo.vpcOf(n.id) === vpcId);
  const current = topo.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId);
  const removed = current.filter((id) => !subnetIds.includes(id));
  if (removed.length && (!defaultNacl || defaultNacl.id === nacl.id)) {
    return awsFail("InvalidParameterValue", "서브넷은 항상 하나의 네트워크 ACL과 연결되어야 합니다.", "다른 네트워크 ACL에서 이 서브넷을 선택해 연결을 옮기세요.");
  }
  const touched = new Set([...subnetIds, ...removed]);
  let p = removeConnections(project, (c) => c.relationType === "network-acl-subnet" && touched.has(c.targetResourceId));
  p = addConnections(p, [
    ...subnetIds.map((id) => link("network-acl-subnet", nacl.id, id)),
    ...(defaultNacl ? removed.map((id) => link("network-acl-subnet", defaultNacl.id, id)) : []),
  ]);
  return ok(touch(p), removed.length ? [`서브넷 ${removed.length}개가 VPC 기본 네트워크 ACL로 돌아갔습니다.`] : []);
}

/** 서브넷 쪽에서 네트워크 ACL 연결 교체 */
export function replaceSubnetNetworkAcl(project: Project, subnetId: string, naclId: string): ActionResult {
  const nacl = find(project, naclId, "network-acl");
  if (!nacl) return notFound("network-acl", naclId);
  const current = buildTopology(project).outgoing(naclId, "network-acl-subnet").map((c) => c.targetResourceId);
  return editNetworkAclAssociations(project, naclId, [...new Set([...current, subnetId])]);
}

/** 서브넷 쪽에서 라우팅 테이블 연결 교체 (null이면 기본 테이블 사용) */
export function replaceSubnetRouteTable(project: Project, subnetId: string, routeTableId: string | null): ActionResult {
  if (!find(project, subnetId, "subnet")) return notFound("subnet", subnetId);
  if (!routeTableId) {
    return ok(touch(removeConnections(project, (c) => c.relationType === "route-table-subnet" && c.targetResourceId === subnetId)));
  }
  const current = buildTopology(project).outgoing(routeTableId, "route-table-subnet").map((c) => c.targetResourceId);
  return editRouteTableAssociations(project, routeTableId, [...new Set([...current, subnetId])]);
}

export function deleteNetworkAcl(project: Project, naclId: string): ActionResult {
  const nacl = find(project, naclId, "network-acl");
  if (!nacl) return notFound("network-acl", naclId);
  if (nacl.config.isDefault) return awsFail("InvalidParameterValue", "VPC의 기본 네트워크 ACL은 삭제할 수 없습니다.");
  const associations = buildTopology(project).outgoing(nacl.id, "network-acl-subnet");
  if (associations.length) {
    return awsFail("DependencyViolation", `네트워크 ACL ${naclId}에 연결된 서브넷이 ${associations.length}개 있습니다.`, "서브넷 연결을 다른 네트워크 ACL로 옮긴 뒤 삭제하세요.");
  }
  return ok(touch(removeResources(project, [naclId])));
}

// ---------------------------------------------------------------- EC2

export type UserDataTemplate = "none" | "web-server" | "custom";

export const AMI_INFO: Record<ConfigOf<"ec2">["ami"], { label: string; family: "linux" | "windows"; description: string }> = {
  "amazon-linux-2023": { label: "Amazon Linux 2023 (가상)", family: "linux", description: "기본으로 SSH(22) 서비스만 실행된다고 가정" },
  "ubuntu-24.04": { label: "Ubuntu Server 24.04 LTS (가상)", family: "linux", description: "기본으로 SSH(22) 서비스만 실행된다고 가정" },
  "windows-server-2022": { label: "Windows Server 2022 Base (가상)", family: "windows", description: "기본으로 RDP(3389) 서비스만 실행된다고 가정" },
};

export const INSTANCE_TYPE_INFO: Record<ConfigOf<"ec2">["instanceType"], string> = {
  "t3.micro": "vCPU 2개 · 메모리 1GiB",
  "t3.small": "vCPU 2개 · 메모리 2GiB",
  "t3.medium": "vCPU 2개 · 메모리 4GiB",
  "t3.large": "vCPU 2개 · 메모리 8GiB",
  "m5.large": "vCPU 2개 · 메모리 8GiB",
  "c5.large": "vCPU 2개 · 메모리 4GiB",
};

/** 사용자 데이터 템플릿 → 가상 서비스 포트와 표시용 스크립트 */
export function userDataFor(ami: ConfigOf<"ec2">["ami"], template: UserDataTemplate): { listenPorts: number[]; script: string } {
  const family = AMI_INFO[ami].family;
  const base = family === "windows" ? [3389] : [22];
  if (template === "web-server") {
    const script =
      family === "windows"
        ? "<powershell>\nInstall-WindowsFeature -Name Web-Server\n</powershell>"
        : ami === "ubuntu-24.04"
          ? "#!/bin/bash\napt-get update -y\napt-get install -y apache2\nsystemctl enable --now apache2"
          : "#!/bin/bash\ndnf install -y httpd\nsystemctl enable --now httpd";
    return { listenPorts: [...base, 80], script };
  }
  return { listenPorts: base, script: "" };
}

export interface LaunchInstancesInput {
  name: string;
  ami: ConfigOf<"ec2">["ami"];
  instanceType: ConfigOf<"ec2">["instanceType"];
  subnetId: string;
  publicIpMode: ConfigOf<"ec2">["publicIpMode"];
  securityGroupIds: string[];
  /** 비우면 AWS처럼 서브넷에서 자동 할당 */
  privateIp?: string;
  listenPorts: number[];
  httpResponseCode: number;
  userData: string;
  count: number;
  /** 인스턴스 프로파일로 연결할 IAM 역할 (EC2 신뢰 정책 필요) */
  iamRoleId?: string | null;
}

export function launchInstances(project: Project, input: LaunchInstancesInput): ActionResult {
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) {
    return awsFail("InvalidParameterValue", "인스턴스 개수는 1~5 사이여야 합니다. (시뮬레이터 제한)");
  }
  const subnet = find(project, input.subnetId, "subnet");
  if (!subnet) return awsFail("MissingParameter", "서브넷을 선택하세요.");
  const topo = buildTopology(project);
  const vpcId = topo.vpcOfSubnet(subnet.id);
  if (!vpcId) return awsFail("InvalidSubnetID.NotFound", `서브넷 ${subnet.id}이(가) VPC에 속해 있지 않습니다.`);
  if (!input.securityGroupIds.length) return awsFail("MissingParameter", "보안 그룹을 하나 이상 선택하세요.");
  if (input.securityGroupIds.length > 5) return awsFail("SecurityGroupsPerInstanceLimitExceeded", "인스턴스에는 보안 그룹을 최대 5개까지 연결할 수 있습니다.");
  for (const id of input.securityGroupIds) {
    const sg = find(project, id, "security-group");
    if (!sg) return notFound("security-group", id);
    if (topo.vpcOf(sg.id) !== vpcId) {
      return awsFail("InvalidParameter", `보안 그룹 ${sg.id}과(와) 서브넷 ${subnet.id}이(가) 서로 다른 네트워크에 속해 있습니다.`);
    }
  }
  for (const port of input.listenPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return awsFail("InvalidParameterValue", `가상 서비스 포트 ${port}이(가) 올바르지 않습니다.`);
  }
  if (!Number.isInteger(input.httpResponseCode) || input.httpResponseCode < 100 || input.httpResponseCode > 599) {
    return awsFail("InvalidParameterValue", "가상 HTTP 응답 코드는 100~599 사이여야 합니다.");
  }
  const cidr = tryParseCidr(subnet.config.cidr);
  const requested = input.privateIp?.trim();
  if (requested) {
    if (input.count > 1) return awsFail("InvalidParameterCombination", "기본 IP를 지정하면 인스턴스를 하나만 시작할 수 있습니다.");
    const ip = parseIpv4(requested);
    if (ip === null) return awsFail("InvalidParameterValue", `기본 IP '${requested}'이(가) 올바른 IPv4 주소가 아닙니다.`);
    if (!cidr || !cidrContainsIp(cidr, ip)) return awsFail("InvalidParameterValue", `주소 ${requested}이(가) 서브넷 ${subnet.id}(${subnet.config.cidr}) 범위에 없습니다.`);
    const reserved = awsReservedReason(cidr, ip);
    if (reserved) return awsFail("InvalidParameterValue", `주소 ${requested}은(는) AWS 예약 주소(${reserved})입니다.`);
    const taken = topo.enis().find((e) => e.vpcId === vpcId && e.privateIp === ip);
    if (taken) return awsFail("InvalidIPAddress.InUse", `주소 ${requested}은(는) 이미 ${taken.label}이(가) 사용 중입니다.`);
  }

  if (input.iamRoleId) {
    const role = project.services.iam.roles.find((r) => r.id === input.iamRoleId);
    if (!role) return awsFail("InvalidParameterValue", `IAM 역할 ${input.iamRoleId}을(를) 찾을 수 없습니다.`);
    if (role.trustedEntity !== "ec2.amazonaws.com") {
      return awsFail("InvalidParameterValue", `역할 ${role.name}의 신뢰 정책이 EC2(ec2.amazonaws.com)를 허용하지 않습니다.`, "EC2용 역할(AWS 서비스 → EC2)을 고르세요.");
    }
  }

  let p = project;
  const ids: string[] = [];
  for (let i = 0; i < input.count; i++) {
    const privateIp = requested || buildTopology(p).suggestPrivateIp(subnet.id);
    if (!privateIp) return awsFail("InsufficientFreeAddressesInSubnet", `서브넷 ${subnet.id}에 사용할 수 있는 IP 주소가 없습니다.`);
    const added = addResource(
      p,
      "ec2",
      input.name,
      {
        ami: input.ami,
        instanceType: input.instanceType,
        privateIp,
        publicIpMode: input.publicIpMode,
        state: "pending",
        listenPorts: [...new Set(input.listenPorts)].sort((a, b) => a - b),
        httpResponseCode: input.httpResponseCode,
        userData: input.userData,
        iamRoleId: input.iamRoleId ?? null,
      },
      subnet.id,
    );
    p = addConnections(added.project, [
      link("ec2-subnet", added.resource.id, subnet.id),
      ...input.securityGroupIds.map((sg) => link("ec2-security-group", added.resource.id, sg)),
    ]);
    ids.push(added.resource.id);
  }
  return ok(touch(p), [`인스턴스 ${ids.join(", ")}을(를) 시작했습니다. Pending 상태를 거쳐 Running이 됩니다.`], ids[0]);
}

export type InstanceAction = "start" | "stop" | "reboot" | "terminate";

export function changeInstanceState(project: Project, instanceId: string, action: InstanceAction): ActionResult {
  const ec2 = find(project, instanceId, "ec2");
  if (!ec2) return notFound("ec2", instanceId);
  const state = ec2.config.state;
  const incorrect = (what: string) => awsFail("IncorrectInstanceState", `인스턴스 ${instanceId}이(가) ${state} 상태라 ${what}할 수 없습니다.`);
  if (state === "terminated") return incorrect("상태를 변경");
  switch (action) {
    case "start":
      if (state !== "stopped") return incorrect("시작");
      return ok(touch(updateConfig<"ec2">(project, ec2.id, { state: "pending" })), ["Pending 상태를 거쳐 Running이 됩니다."]);
    case "stop":
      if (state !== "running" && state !== "pending") return incorrect("중지");
      return ok(touch(updateConfig<"ec2">(project, ec2.id, { state: "stopped" })), [
        buildTopology(project).elasticIpOf(ec2.id) ? "탄력적 IP는 연결된 상태로 유지됩니다." : "자동 할당된 퍼블릭 IPv4 주소가 해제되었습니다.",
      ]);
    case "reboot":
      if (state !== "running") return incorrect("재부팅");
      return ok(project, ["재부팅을 요청했습니다. (가상 — 상태와 주소는 유지됩니다)"]);
    case "terminate": {
      let p = updateConfig<"ec2">(project, ec2.id, { state: "terminated" });
      const registrations = project.connections.filter((c) => c.relationType === "target-group-ec2" && c.targetResourceId === ec2.id).length;
      const hadEip = project.connections.some((c) => c.relationType === "elastic-ip-ec2" && c.targetResourceId === ec2.id);
      p = removeConnections(p, (c) => (c.relationType === "target-group-ec2" || c.relationType === "elastic-ip-ec2") && c.targetResourceId === ec2.id);
      return ok(touch(p), [
        "인스턴스를 종료했습니다. 종료된 인스턴스는 다시 시작할 수 없습니다.",
        ...(registrations ? [`대상 그룹 ${registrations}개에서 자동으로 등록 해제되었습니다.`] : []),
        ...(hadEip ? ["탄력적 IP 연결이 해제되었습니다 (주소는 계정에 남아 있음)."] : []),
      ]);
    }
  }
}

export function changeInstanceSecurityGroups(project: Project, instanceId: string, securityGroupIds: string[]): ActionResult {
  const ec2 = find(project, instanceId, "ec2");
  if (!ec2) return notFound("ec2", instanceId);
  if (ec2.config.state === "terminated") return awsFail("IncorrectInstanceState", "종료된 인스턴스의 보안 그룹은 변경할 수 없습니다.");
  if (!securityGroupIds.length) return awsFail("MissingParameter", "보안 그룹을 하나 이상 선택하세요.");
  if (securityGroupIds.length > 5) return awsFail("SecurityGroupsPerInstanceLimitExceeded", "보안 그룹은 최대 5개까지 연결할 수 있습니다.");
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(ec2.id);
  for (const id of securityGroupIds) {
    const sg = find(project, id, "security-group");
    if (!sg) return notFound("security-group", id);
    if (topo.vpcOf(sg.id) !== vpcId) return awsFail("InvalidGroup.NotFound", `보안 그룹 ${id}은(는) 인스턴스와 다른 VPC에 있습니다.`);
  }
  let p = removeConnections(project, (c) => c.relationType === "ec2-security-group" && c.sourceResourceId === ec2.id);
  p = addConnections(p, securityGroupIds.map((id) => link("ec2-security-group", ec2.id, id)));
  return ok(touch(p));
}

/** 사용자 데이터(가상 애플리케이션) 편집 — AWS처럼 인스턴스가 중지된 상태에서만 가능하다. */
export function editInstanceUserData(
  project: Project,
  instanceId: string,
  input: { listenPorts: number[]; httpResponseCode: number; userData: string },
): ActionResult {
  const ec2 = find(project, instanceId, "ec2");
  if (!ec2) return notFound("ec2", instanceId);
  if (ec2.config.state !== "stopped") {
    return awsFail("IncorrectInstanceState", `사용자 데이터는 인스턴스가 중지(stopped)된 상태에서만 편집할 수 있습니다. 현재 상태: ${ec2.config.state}`, "인스턴스를 중지한 뒤 편집하고 다시 시작하세요.");
  }
  for (const port of input.listenPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return awsFail("InvalidParameterValue", `가상 서비스 포트 ${port}이(가) 올바르지 않습니다.`);
  }
  if (input.httpResponseCode < 100 || input.httpResponseCode > 599) return awsFail("InvalidParameterValue", "가상 HTTP 응답 코드는 100~599 사이여야 합니다.");
  return ok(
    touch(
      updateConfig<"ec2">(project, ec2.id, {
        listenPorts: [...new Set(input.listenPorts)].sort((a, b) => a - b),
        httpResponseCode: input.httpResponseCode,
        userData: input.userData,
      }),
    ),
  );
}

// ---------------------------------------------------------------- Target Group

const LB_NAME_PATTERN = /^(?!-)[A-Za-z0-9-]{1,32}(?<!-)$/;

export interface CreateTargetGroupInput {
  name: string;
  protocol: "HTTP" | "HTTPS";
  port: number;
  vpcId: string;
  healthCheck: HealthCheck;
  targetIds: string[];
}

export function createTargetGroup(project: Project, input: CreateTargetGroupInput): ActionResult {
  const name = input.name.trim();
  if (!LB_NAME_PATTERN.test(name)) {
    return awsFail("ValidationError", "대상 그룹 이름은 1~32자의 영문자, 숫자, 하이픈만 사용할 수 있고 하이픈으로 시작하거나 끝날 수 없습니다.");
  }
  if (project.resources.some((r) => r.type === "target-group" && r.name === name)) {
    return awsFail("DuplicateTargetGroupName", `'${name}' 이름의 대상 그룹이 이미 있습니다.`);
  }
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return awsFail("MissingParameter", "VPC를 선택하세요.");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return awsFail("ValidationError", "포트는 1~65535 사이여야 합니다.");
  const hcProblems = validateHealthCheck(input.healthCheck);
  if (hcProblems.length) return awsFail("ValidationError", hcProblems[0]);
  const topo = buildTopology(project);
  for (const id of input.targetIds) {
    const ec2 = find(project, id, "ec2");
    if (!ec2) return notFound("ec2", id);
    if (ec2.config.state === "terminated") return awsFail("InvalidTarget", `종료된 인스턴스 ${id}은(는) 등록할 수 없습니다.`);
    if (topo.vpcOf(id) !== vpc.id) return awsFail("InvalidTarget", `인스턴스 ${id}은(는) 대상 그룹의 VPC(${vpc.id})에 있지 않습니다.`);
  }
  const added = addResource(project, "target-group", name, { protocol: input.protocol, port: input.port, healthCheck: input.healthCheck }, vpc.id);
  const p = addConnections(added.project, [
    link("vpc-target-group", vpc.id, added.resource.id),
    ...[...new Set(input.targetIds)].map((id) => link("target-group-ec2", added.resource.id, id)),
  ]);
  return ok(touch(p), [], added.resource.id);
}

export function registerTargets(project: Project, tgId: string, instanceIds: string[]): ActionResult {
  const tg = find(project, tgId, "target-group");
  if (!tg) return notFound("target-group", tgId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(tg.id);
  const registered = new Set(topo.targetGroupTargets(tg.id).map((t) => t.ec2.id));
  const added: Connection[] = [];
  for (const id of instanceIds) {
    const ec2 = find(project, id, "ec2");
    if (!ec2) return notFound("ec2", id);
    if (ec2.config.state === "terminated") return awsFail("InvalidTarget", `종료된 인스턴스 ${id}은(는) 등록할 수 없습니다.`);
    if (vpcId && topo.vpcOf(id) !== vpcId) return awsFail("InvalidTarget", `인스턴스 ${id}은(는) 대상 그룹의 VPC에 있지 않습니다.`);
    if (!registered.has(id)) added.push(link("target-group-ec2", tg.id, id));
    registered.add(id);
  }
  return ok(touch(addConnections(project, added)), [`대상 ${added.length}개를 등록했습니다. 헬스 체크가 끝나면 상태가 표시됩니다.`]);
}

export function deregisterTargets(project: Project, tgId: string, instanceIds: string[]): ActionResult {
  if (!find(project, tgId, "target-group")) return notFound("target-group", tgId);
  const set = new Set(instanceIds);
  return ok(touch(removeConnections(project, (c) => c.relationType === "target-group-ec2" && c.sourceResourceId === tgId && set.has(c.targetResourceId))));
}

export function editTargetGroupHealthCheck(project: Project, tgId: string, healthCheck: HealthCheck): ActionResult {
  if (!find(project, tgId, "target-group")) return notFound("target-group", tgId);
  const problems = validateHealthCheck(healthCheck);
  if (problems.length) return awsFail("ValidationError", problems[0]);
  return ok(touch(updateConfig<"target-group">(project, tgId, { healthCheck })));
}

export function deleteTargetGroup(project: Project, tgId: string): ActionResult {
  const tg = find(project, tgId, "target-group");
  if (!tg) return notFound("target-group", tgId);
  const albs = buildTopology(project).targetGroupAlbs(tg.id);
  if (albs.length) return awsFail("ResourceInUse", `대상 그룹 ${displayName(tg)}이(가) 로드 밸런서 ${displayName(albs[0])}의 리스너에서 사용 중입니다.`, "리스너의 기본 작업이나 이 대상 그룹으로 전달하는 리스너 규칙을 먼저 바꾸거나 삭제하세요.");
  return ok(touch(removeResources(project, [tg.id])));
}

// ---------------------------------------------------------------- Application Load Balancer

export interface ListenerInput {
  protocol: "HTTP" | "HTTPS";
  port: number;
  targetGroupId: string;
}

export interface CreateLoadBalancerInput {
  name: string;
  scheme: "internet-facing" | "internal";
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  listeners: ListenerInput[];
}

function checkLbSubnets(topo: Topology, vpcId: string, subnetIds: string[]): ActionResult | null {
  const subnets = subnetIds.map((id) => topo.getOfType(id, "subnet"));
  if (subnets.some((s) => !s)) return awsFail("SubnetNotFound", "선택한 서브넷을 찾을 수 없습니다.");
  for (const s of subnets) if (topo.vpcOfSubnet(s!.id) !== vpcId) return awsFail("InvalidSubnet", `서브넷 ${s!.id}은(는) 선택한 VPC에 있지 않습니다.`);
  const azs = subnets.map((s) => s!.config.availabilityZone);
  if (new Set(azs).size !== azs.length) return awsFail("InvalidConfigurationRequest", "가용 영역마다 서브넷을 하나만 지정할 수 있습니다.");
  if (new Set(azs).size < 2) return awsFail("ValidationError", "서로 다른 가용 영역의 서브넷을 2개 이상 지정해야 합니다.");
  return null;
}

function checkLbSecurityGroups(topo: Topology, vpcId: string, sgIds: string[]): ActionResult | null {
  if (!sgIds.length) return awsFail("InvalidConfigurationRequest", "보안 그룹을 하나 이상 선택하세요.");
  if (sgIds.length > 5) return awsFail("TooManySecurityGroups", "보안 그룹은 최대 5개까지 지정할 수 있습니다.");
  for (const id of sgIds) {
    if (!topo.getOfType(id, "security-group")) return awsFail("InvalidSecurityGroup", `보안 그룹 ${id}을(를) 찾을 수 없습니다.`);
    if (topo.vpcOf(id) !== vpcId) return awsFail("InvalidSecurityGroup", `보안 그룹 ${id}은(는) 선택한 VPC에 있지 않습니다.`);
  }
  return null;
}

function checkListeners(topo: Topology, vpcId: string, listeners: ListenerInput[], albId?: string): ActionResult | null {
  const ports = new Set<number>();
  for (const l of listeners) {
    if (!Number.isInteger(l.port) || l.port < 1 || l.port > 65535) return awsFail("ValidationError", `리스너 포트 ${l.port}이(가) 올바르지 않습니다.`);
    if (ports.has(l.port)) return awsFail("DuplicateListener", `포트 ${l.port} 리스너가 이미 있습니다.`);
    ports.add(l.port);
    const tg = topo.getOfType(l.targetGroupId, "target-group");
    if (!tg) return awsFail("TargetGroupNotFound", `리스너 ${l.protocol}:${l.port}의 기본 작업에서 대상 그룹을 선택하세요.`);
    if (topo.vpcOf(tg.id) !== vpcId) return awsFail("ValidationError", `대상 그룹 ${displayName(tg)}은(는) 로드 밸런서와 다른 VPC에 있습니다.`);
    const other = topo.targetGroupAlbs(tg.id).find((a) => a.id !== albId);
    if (other) return awsFail("TargetGroupAssociationLimit", `대상 그룹 ${displayName(tg)}은(는) 이미 로드 밸런서 ${displayName(other)}에서 사용 중입니다.`);
  }
  return null;
}

export function createLoadBalancer(project: Project, input: CreateLoadBalancerInput): ActionResult {
  const name = input.name.trim();
  if (!LB_NAME_PATTERN.test(name) || name.startsWith("internal-")) {
    return awsFail("ValidationError", "로드 밸런서 이름은 1~32자의 영문자, 숫자, 하이픈만 사용할 수 있고, 하이픈으로 시작·끝나거나 'internal-'로 시작할 수 없습니다.");
  }
  if (project.resources.some((r) => r.type === "alb" && r.name === name)) return awsFail("DuplicateLoadBalancerName", `'${name}' 로드 밸런서가 이미 있습니다.`);
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return awsFail("ValidationError", "VPC를 선택하세요.");
  const topo = buildTopology(project);
  const errors = checkLbSubnets(topo, vpc.id, input.subnetIds) ?? checkLbSecurityGroups(topo, vpc.id, input.securityGroupIds);
  if (errors) return errors;
  if (!input.listeners.length) return awsFail("ValidationError", "리스너를 하나 이상 추가하세요.");
  const listenerError = checkListeners(topo, vpc.id, input.listeners);
  if (listenerError) return listenerError;
  if (input.scheme === "internet-facing" && !topo.igwOfVpc(vpc.id)) {
    return awsFail("InvalidSubnet", `VPC ${vpc.id}에 인터넷 게이트웨이가 연결되어 있지 않아 internet-facing 로드 밸런서를 만들 수 없습니다.`);
  }
  const listeners: Listener[] = input.listeners.map((l) => ({ id: createId("lsn"), protocol: l.protocol, port: l.port, rules: [] }));
  const added = addResource(project, "alb", name, { scheme: input.scheme, listeners, state: "provisioning" }, input.subnetIds[0]);
  const albId = added.resource.id;
  const p = addConnections(added.project, [
    ...input.subnetIds.map((id) => link("alb-subnet", albId, id)),
    ...input.securityGroupIds.map((id) => link("alb-security-group", albId, id)),
    ...input.listeners.map((l, i) => link("alb-target-group", albId, l.targetGroupId, { listenerId: listeners[i].id })),
  ]);
  const notes = ["로드 밸런서는 Provisioning 상태로 생성되며 잠시 후 Active가 됩니다."];
  if (input.scheme === "internet-facing") {
    const privateSubnets = input.subnetIds.filter((id) => topo.classifySubnet(id).kind !== "public");
    if (privateSubnets.length) notes.push(`주의: 퍼블릭 서브넷이 아닌 서브넷(${privateSubnets.join(", ")})이 포함되어 있습니다. 인터넷에서 오는 요청이 실패할 수 있습니다.`);
  }
  return ok(touch(p), notes, albId);
}

export function editLoadBalancerSubnets(project: Project, albId: string, subnetIds: string[]): ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(alb.id);
  if (!vpcId) return awsFail("ValidationError", "로드 밸런서의 VPC를 알 수 없습니다.");
  const error = checkLbSubnets(topo, vpcId, subnetIds);
  if (error) return error;
  let p = removeConnections(project, (c) => c.relationType === "alb-subnet" && c.sourceResourceId === albId);
  p = addConnections(p, subnetIds.map((id) => link("alb-subnet", albId, id)));
  return ok(touch(p));
}

export function editLoadBalancerSecurityGroups(project: Project, albId: string, sgIds: string[]): ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(alb.id);
  if (!vpcId) return awsFail("ValidationError", "로드 밸런서의 VPC를 알 수 없습니다.");
  const error = checkLbSecurityGroups(topo, vpcId, sgIds);
  if (error) return error;
  let p = removeConnections(project, (c) => c.relationType === "alb-security-group" && c.sourceResourceId === albId);
  p = addConnections(p, sgIds.map((id) => link("alb-security-group", albId, id)));
  return ok(touch(p));
}

export function addListener(project: Project, albId: string, input: ListenerInput): ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(alb.id);
  if (!vpcId) return awsFail("ValidationError", "로드 밸런서의 VPC를 알 수 없습니다.");
  const existing = topo.listenersOf(alb.id).map((b) => ({ protocol: b.listener.protocol, port: b.listener.port, targetGroupId: b.targetGroupId ?? "" }));
  if (existing.some((l) => l.port === input.port)) return awsFail("DuplicateListener", `포트 ${input.port} 리스너가 이미 있습니다.`);
  const error = checkListeners(topo, vpcId, [input], alb.id);
  if (error) return error;
  const listener: Listener = { id: createId("lsn"), protocol: input.protocol, port: input.port, rules: [] };
  let p = updateConfig<"alb">(project, alb.id, { listeners: [...alb.config.listeners, listener] });
  p = addConnections(p, [link("alb-target-group", alb.id, input.targetGroupId, { listenerId: listener.id })]);
  return ok(touch(p), [], listener.id);
}

export function editListenerDefaultAction(project: Project, albId: string, listenerId: string, targetGroupId: string): ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  const listener = alb.config.listeners.find((l) => l.id === listenerId);
  if (!listener) return awsFail("ListenerNotFound", "리스너를 찾을 수 없습니다.");
  const topo = buildTopology(project);
  const vpcId = topo.vpcOf(alb.id);
  if (!vpcId) return awsFail("ValidationError", "로드 밸런서의 VPC를 알 수 없습니다.");
  const error = checkListeners(topo, vpcId, [{ protocol: listener.protocol, port: listener.port, targetGroupId }], alb.id);
  if (error) return error;
  let p = removeConnections(project, (c) => c.relationType === "alb-target-group" && c.sourceResourceId === albId && "listenerId" in c.metadata && c.metadata.listenerId === listenerId);
  p = addConnections(p, [link("alb-target-group", albId, targetGroupId, { listenerId })]);
  return ok(touch(p));
}

export function deleteListener(project: Project, albId: string, listenerId: string): ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  if (!alb.config.listeners.some((l) => l.id === listenerId)) return awsFail("ListenerNotFound", "리스너를 찾을 수 없습니다.");
  let p = updateConfig<"alb">(project, alb.id, { listeners: alb.config.listeners.filter((l) => l.id !== listenerId) });
  p = removeConnections(p, (c) => c.relationType === "alb-target-group" && c.sourceResourceId === albId && "listenerId" in c.metadata && c.metadata.listenerId === listenerId);
  return ok(touch(p));
}

// ---------------------------------------------------------------- 리스너 규칙 (경로 기반 라우팅)

export interface ListenerRuleInput {
  priority: number;
  pathPatterns: string[];
  action: ListenerRuleAction;
}

export const MAX_RULES_PER_LISTENER = 10;
const PATH_PATTERN_CHARS = /^[A-Za-z0-9_\-.$/~"'@:+&()!,;=*?%]+$/;

function checkListenerRule(project: Project, alb: ResourceOfType<"alb">, listener: Listener, input: ListenerRuleInput, ruleId?: string): ActionResult | null {
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 50000) return awsFail("ValidationError", "우선순위는 1~50000 사이의 정수여야 합니다.");
  if ((listener.rules ?? []).some((r) => r.priority === input.priority && r.id !== ruleId)) {
    return awsFail("PriorityInUse", `우선순위 ${input.priority}은(는) 이 리스너의 다른 규칙이 쓰고 있습니다.`, "규칙마다 다른 우선순위 숫자를 쓰세요. 숫자가 작을수록 먼저 평가됩니다.");
  }
  const patterns = input.pathPatterns.map((p) => p.trim()).filter(Boolean);
  if (!patterns.length) return awsFail("ValidationError", "경로 패턴을 하나 이상 입력하세요. 예: /api/*");
  if (patterns.length > 5) return awsFail("ValidationError", "규칙 하나에는 경로 패턴을 5개까지 넣을 수 있습니다.");
  for (const p of patterns) {
    if (p.length > 128) return awsFail("ValidationError", `경로 패턴 "${p.slice(0, 20)}…"이(가) 128자를 넘습니다.`);
    if (!PATH_PATTERN_CHARS.test(p)) return awsFail("ValidationError", `경로 패턴 "${p}"에 쓸 수 없는 문자가 있습니다. (공백·한글 등 불가)`);
    if (!p.startsWith("/") && !p.startsWith("*")) return awsFail("ValidationError", `경로 패턴 "${p}"은(는) /로 시작해야 합니다. 예: /images/*`);
  }
  const topo = buildTopology(project);
  if (input.action.type === "forward") {
    const tg = topo.getOfType(input.action.targetGroupId, "target-group");
    if (!tg) return awsFail("TargetGroupNotFound", "전달할 대상 그룹을 선택하세요.");
    if (topo.vpcOf(tg.id) !== topo.vpcOf(alb.id)) return awsFail("ValidationError", `대상 그룹 ${displayName(tg)}은(는) 로드 밸런서와 다른 VPC에 있습니다.`);
    const other = topo.targetGroupAlbs(tg.id).find((a) => a.id !== alb.id);
    if (other) return awsFail("TargetGroupAssociationLimit", `대상 그룹 ${displayName(tg)}은(는) 이미 로드 밸런서 ${displayName(other)}에서 사용 중입니다.`);
  } else {
    const code = input.action.statusCode;
    if (!Number.isInteger(code) || code < 200 || code > 599 || (code >= 300 && code < 400)) return awsFail("ValidationError", "고정 응답 상태 코드는 2XX, 4XX, 5XX 중 하나여야 합니다.");
    if (input.action.body.length > 1024) return awsFail("ValidationError", "고정 응답 본문은 1024자 이하여야 합니다.");
  }
  return null;
}

function withListener(project: Project, albId: string, listenerId: string): { alb: ResourceOfType<"alb">; listener: Listener } | ActionResult {
  const alb = find(project, albId, "alb");
  if (!alb) return notFound("alb", albId);
  const listener = alb.config.listeners.find((l) => l.id === listenerId);
  if (!listener) return awsFail("ListenerNotFound", "리스너를 찾을 수 없습니다.");
  return { alb, listener };
}

function saveRules(project: Project, alb: ResourceOfType<"alb">, listenerId: string, rules: ListenerRule[]): Project {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  return touch(updateConfig<"alb">(project, alb.id, { listeners: alb.config.listeners.map((l) => (l.id === listenerId ? { ...l, rules: sorted } : l)) }));
}

export function addListenerRule(project: Project, albId: string, listenerId: string, input: ListenerRuleInput): ActionResult {
  const found = withListener(project, albId, listenerId);
  if ("ok" in found) return found;
  const { alb, listener } = found;
  if ((listener.rules ?? []).length >= MAX_RULES_PER_LISTENER) return awsFail("TooManyRules", `이 시뮬레이터에서는 리스너마다 규칙을 ${MAX_RULES_PER_LISTENER}개까지 만들 수 있습니다. (실제 AWS 기본 한도는 100개)`);
  const invalid = checkListenerRule(project, alb, listener, input);
  if (invalid) return invalid;
  const rule: ListenerRule = { id: createId("rule"), priority: input.priority, pathPatterns: input.pathPatterns.map((p) => p.trim()).filter(Boolean), action: input.action };
  return ok(saveRules(project, alb, listenerId, [...(listener.rules ?? []), rule]), [], rule.id);
}

export function updateListenerRule(project: Project, albId: string, listenerId: string, ruleId: string, input: ListenerRuleInput): ActionResult {
  const found = withListener(project, albId, listenerId);
  if ("ok" in found) return found;
  const { alb, listener } = found;
  if (!(listener.rules ?? []).some((r) => r.id === ruleId)) return awsFail("RuleNotFound", "규칙을 찾을 수 없습니다.");
  const invalid = checkListenerRule(project, alb, listener, input, ruleId);
  if (invalid) return invalid;
  const rules = (listener.rules ?? []).map((r) => (r.id === ruleId ? { ...r, priority: input.priority, pathPatterns: input.pathPatterns.map((p) => p.trim()).filter(Boolean), action: input.action } : r));
  return ok(saveRules(project, alb, listenerId, rules));
}

export function deleteListenerRule(project: Project, albId: string, listenerId: string, ruleId: string): ActionResult {
  const found = withListener(project, albId, listenerId);
  if ("ok" in found) return found;
  const { alb, listener } = found;
  if (!(listener.rules ?? []).some((r) => r.id === ruleId)) return awsFail("RuleNotFound", "규칙을 찾을 수 없습니다.");
  return ok(saveRules(project, alb, listenerId, (listener.rules ?? []).filter((r) => r.id !== ruleId)));
}

export function deleteLoadBalancer(project: Project, albId: string): ActionResult {
  if (!find(project, albId, "alb")) return notFound("alb", albId);
  return ok(touch(removeResources(project, [albId])), ["리스너도 함께 삭제되었습니다. 대상 그룹은 남아 있습니다."]);
}

// ---------------------------------------------------------------- RDS

const DB_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function createDbSubnetGroup(project: Project, input: { name: string; description: string; vpcId: string; subnetIds: string[] }): ActionResult {
  const name = input.name.trim().toLowerCase();
  if (!name || name.length > 255 || !/^[a-z0-9 ._-]+$/.test(name) || name === "default") {
    return awsFail("InvalidParameterValue", "DB 서브넷 그룹 이름은 영문 소문자, 숫자, 공백, 마침표, 밑줄, 하이픈만 사용할 수 있고 'default'는 쓸 수 없습니다.");
  }
  if (project.resources.some((r) => r.type === "db-subnet-group" && r.name === name)) {
    return awsFail("DBSubnetGroupAlreadyExists", `'${name}' DB 서브넷 그룹이 이미 있습니다.`);
  }
  if (!input.description.trim()) return awsFail("MissingParameter", "설명을 입력하세요. (AWS에서 필수)");
  const vpc = find(project, input.vpcId, "vpc");
  if (!vpc) return awsFail("MissingParameter", "VPC를 선택하세요.");
  const error = checkDbSubnets(buildTopology(project), vpc.id, input.subnetIds);
  if (error) return error;
  const added = addResource(project, "db-subnet-group", name, { description: input.description.trim() }, input.subnetIds[0]);
  const p = addConnections(added.project, input.subnetIds.map((id) => link("db-subnet-group-subnet", added.resource.id, id)));
  return ok(touch(p), [], added.resource.id);
}

function checkDbSubnets(topo: Topology, vpcId: string, subnetIds: string[]): ActionResult | null {
  const subnets = subnetIds.map((id) => topo.getOfType(id, "subnet"));
  if (subnets.some((s) => !s)) return awsFail("InvalidSubnet", "선택한 서브넷을 찾을 수 없습니다.");
  for (const s of subnets) if (topo.vpcOfSubnet(s!.id) !== vpcId) return awsFail("InvalidSubnet", `서브넷 ${s!.id}은(는) 선택한 VPC에 있지 않습니다.`);
  if (new Set(subnets.map((s) => s!.config.availabilityZone)).size < 2) {
    return awsFail("DBSubnetGroupDoesNotCoverEnoughAZs", "DB 서브넷 그룹에는 최소 2개 가용 영역의 서브넷이 있어야 합니다.");
  }
  return null;
}

export function editDbSubnetGroup(project: Project, groupId: string, input: { description: string; subnetIds: string[] }): ActionResult {
  const group = find(project, groupId, "db-subnet-group");
  if (!group) return notFound("db-subnet-group", groupId);
  if (!input.description.trim()) return awsFail("MissingParameter", "설명을 입력하세요.");
  const topo = buildTopology(project);
  const vpcId = topo.vpcsOf(group.id)[0];
  if (!vpcId) return awsFail("InvalidParameterValue", "DB 서브넷 그룹의 VPC를 알 수 없습니다.");
  const error = checkDbSubnets(topo, vpcId, input.subnetIds);
  if (error) return error;
  const inUse = topo.ofType("rds").filter((r) => topo.dbSubnetGroupOf(r.id)?.id === group.id).map((r) => topo.rdsPlacement(r.id).primary?.id);
  const removedInUse = inUse.find((id) => id && !input.subnetIds.includes(id));
  if (removedInUse) return awsFail("InvalidDBSubnetGroupStateFault", `서브넷 ${removedInUse}은(는) DB 인스턴스가 사용 중이라 제거할 수 없습니다.`);
  let p = updateConfig<"db-subnet-group">(project, group.id, { description: input.description.trim() });
  p = removeConnections(p, (c) => c.relationType === "db-subnet-group-subnet" && c.sourceResourceId === group.id);
  p = addConnections(p, input.subnetIds.map((id) => link("db-subnet-group-subnet", group.id, id)));
  return ok(touch(p));
}

export function deleteDbSubnetGroup(project: Project, groupId: string): ActionResult {
  const group = find(project, groupId, "db-subnet-group");
  if (!group) return notFound("db-subnet-group", groupId);
  const topo = buildTopology(project);
  const users = topo.ofType("rds").filter((r) => topo.dbSubnetGroupOf(r.id)?.id === group.id);
  if (users.length) return awsFail("InvalidDBSubnetGroupStateFault", `DB 인스턴스 ${displayName(users[0])}이(가) 이 서브넷 그룹을 사용 중입니다.`);
  return ok(touch(removeResources(project, [group.id])));
}

export interface CreateDatabaseInput {
  identifier: string;
  engine: "mysql" | "postgres";
  instanceClass: ConfigOf<"rds">["instanceClass"];
  allocatedStorageGb: number;
  multiAz: boolean;
  dbSubnetGroupId: string;
  publiclyAccessible: boolean;
  securityGroupIds: string[];
  port: number;
}

function checkRdsNetwork(topo: Topology, groupId: string, sgIds: string[], publiclyAccessible: boolean): ActionResult | null {
  const group = topo.getOfType(groupId, "db-subnet-group");
  if (!group) return awsFail("DBSubnetGroupNotFoundFault", "DB 서브넷 그룹을 선택하세요.");
  const vpcId = topo.vpcsOf(group.id)[0];
  if (!sgIds.length) return awsFail("InvalidParameterCombination", "VPC 보안 그룹을 하나 이상 선택하세요.");
  for (const id of sgIds) {
    if (!topo.getOfType(id, "security-group")) return awsFail("InvalidParameterValue", `보안 그룹 ${id}을(를) 찾을 수 없습니다.`);
    if (topo.vpcOf(id) !== vpcId) return awsFail("InvalidParameterCombination", `보안 그룹 ${id}은(는) DB 서브넷 그룹과 다른 VPC에 있습니다.`);
  }
  if (publiclyAccessible) {
    const vpc = topo.getOfType(vpcId, "vpc");
    if (!vpc?.config.enableDnsSupport || !vpc.config.enableDnsHostnames) {
      return awsFail(
        "InvalidVPCNetworkStateFault",
        "퍼블릭 액세스가 가능한 DB 인스턴스를 만들 수 없습니다. 지정한 VPC가 DNS 확인 또는 DNS 호스트 이름을 지원하지 않습니다.",
        "VPC 설정 편집에서 DNS 확인과 DNS 호스트 이름을 모두 켜세요.",
      );
    }
  }
  return null;
}

export function createDatabase(project: Project, input: CreateDatabaseInput): ActionResult {
  const identifier = input.identifier.trim();
  if (!DB_IDENTIFIER_PATTERN.test(identifier) || identifier.length > 63) {
    return awsFail("InvalidParameterValue", "DB 인스턴스 식별자는 1~63자의 영문 소문자, 숫자, 하이픈으로 영문자로 시작해야 하며 하이픈으로 끝나거나 연속 하이픈을 쓸 수 없습니다.");
  }
  if (project.resources.some((r) => r.type === "rds" && r.name === identifier)) return awsFail("DBInstanceAlreadyExists", `'${identifier}' DB 인스턴스가 이미 있습니다.`);
  if (!Number.isInteger(input.allocatedStorageGb) || input.allocatedStorageGb < 20 || input.allocatedStorageGb > 65536) {
    return awsFail("InvalidParameterValue", "할당된 스토리지는 20~65536GiB 사이여야 합니다.");
  }
  if (!Number.isInteger(input.port) || input.port < 1150 || input.port > 65535) return awsFail("InvalidParameterValue", "데이터베이스 포트는 1150~65535 사이여야 합니다.");
  const topo = buildTopology(project);
  const error = checkRdsNetwork(topo, input.dbSubnetGroupId, input.securityGroupIds, input.publiclyAccessible);
  if (error) return error;
  const added = addResource(
    project,
    "rds",
    identifier,
    {
      engine: input.engine,
      instanceClass: input.instanceClass,
      port: input.port,
      publiclyAccessible: input.publiclyAccessible,
      multiAz: input.multiAz,
      allocatedStorageGb: input.allocatedStorageGb,
      state: "creating",
    },
    input.dbSubnetGroupId,
  );
  const p = addConnections(added.project, [
    link("rds-db-subnet-group", added.resource.id, input.dbSubnetGroupId),
    ...input.securityGroupIds.map((id) => link("rds-security-group", added.resource.id, id)),
  ]);
  return ok(touch(p), ["DB 인스턴스는 '생성 중' 상태를 거쳐 '사용 가능'이 됩니다. (실제 데이터베이스는 실행되지 않습니다)"], added.resource.id);
}

export interface ModifyDatabaseInput {
  instanceClass: ConfigOf<"rds">["instanceClass"];
  allocatedStorageGb: number;
  multiAz: boolean;
  publiclyAccessible: boolean;
  securityGroupIds: string[];
  port: number;
}

export function modifyDatabase(project: Project, rdsId: string, input: ModifyDatabaseInput): ActionResult {
  const rds = find(project, rdsId, "rds");
  if (!rds) return notFound("rds", rdsId);
  if (rds.config.state !== "available") return awsFail("InvalidDBInstanceState", `DB 인스턴스가 ${rds.config.state} 상태라 수정할 수 없습니다.`);
  if (input.allocatedStorageGb < rds.config.allocatedStorageGb) return awsFail("InvalidParameterCombination", "할당된 스토리지는 줄일 수 없습니다.");
  if (input.allocatedStorageGb > 65536) return awsFail("InvalidParameterValue", "할당된 스토리지는 65536GiB 이하여야 합니다.");
  if (!Number.isInteger(input.port) || input.port < 1150 || input.port > 65535) return awsFail("InvalidParameterValue", "데이터베이스 포트는 1150~65535 사이여야 합니다.");
  const topo = buildTopology(project);
  const group = topo.dbSubnetGroupOf(rds.id);
  if (!group) return awsFail("InvalidDBInstanceState", "DB 인스턴스에 서브넷 그룹이 없습니다.");
  const error = checkRdsNetwork(topo, group.id, input.securityGroupIds, input.publiclyAccessible);
  if (error) return error;
  let p = updateConfig<"rds">(project, rds.id, {
    instanceClass: input.instanceClass,
    allocatedStorageGb: input.allocatedStorageGb,
    multiAz: input.multiAz,
    publiclyAccessible: input.publiclyAccessible,
    port: input.port,
  });
  p = removeConnections(p, (c) => c.relationType === "rds-security-group" && c.sourceResourceId === rds.id);
  p = addConnections(p, input.securityGroupIds.map((id) => link("rds-security-group", rds.id, id)));
  return ok(touch(p));
}

export function changeDatabaseState(project: Project, rdsId: string, action: "stop" | "start"): ActionResult {
  const rds = find(project, rdsId, "rds");
  if (!rds) return notFound("rds", rdsId);
  if (action === "stop") {
    if (rds.config.state !== "available") return awsFail("InvalidDBInstanceState", "사용 가능 상태의 DB만 중지할 수 있습니다.");
    return ok(touch(updateConfig<"rds">(project, rds.id, { state: "stopped" })));
  }
  if (rds.config.state !== "stopped") return awsFail("InvalidDBInstanceState", "중지된 DB만 시작할 수 있습니다.");
  return ok(touch(updateConfig<"rds">(project, rds.id, { state: "creating" })), ["DB를 시작하는 중입니다. 잠시 후 사용 가능 상태가 됩니다."]);
}

export function deleteDatabase(project: Project, rdsId: string): ActionResult {
  if (!find(project, rdsId, "rds")) return notFound("rds", rdsId);
  return ok(touch(removeResources(project, [rdsId])));
}

// ---------------------------------------------------------------- 공통 삭제 / 이름

/** 리소스 유형에 맞는 AWS 방식 삭제 (의존성 검사 포함) */
export function deleteResourceAws(project: Project, resourceId: string): ActionResult {
  const r = project.resources.find((x) => x.id === resourceId);
  if (!r) return awsFail("NotFound", `리소스 ${resourceId}을(를) 찾을 수 없습니다.`);
  switch (r.type) {
    case "vpc":
      return deleteVpc(project, r.id);
    case "subnet":
      return deleteSubnet(project, r.id);
    case "internet-gateway":
      return deleteInternetGateway(project, r.id);
    case "elastic-ip":
      return releaseElasticIp(project, r.id);
    case "route-table":
      return deleteRouteTable(project, r.id);
    case "nat-gateway":
      return deleteNatGateway(project, r.id);
    case "security-group":
      return deleteSecurityGroup(project, r.id);
    case "network-acl":
      return deleteNetworkAcl(project, r.id);
    case "ec2":
      return r.config.state === "terminated" ? ok(touch(removeResources(project, [r.id]))) : changeInstanceState(project, r.id, "terminate");
    case "alb":
      return deleteLoadBalancer(project, r.id);
    case "target-group":
      return deleteTargetGroup(project, r.id);
    case "db-subnet-group":
      return deleteDbSubnetGroup(project, r.id);
    case "rds":
      return deleteDatabase(project, r.id);
  }
}

/** Name 태그 변경 (보안 그룹 이름, 로드 밸런서·대상 그룹 이름, DB 식별자는 AWS처럼 변경 불가) */
export function editNameTag(project: Project, resourceId: string, name: string): ActionResult {
  const r = project.resources.find((x) => x.id === resourceId);
  if (!r) return awsFail("NotFound", `리소스 ${resourceId}을(를) 찾을 수 없습니다.`);
  if (r.type === "security-group" || r.type === "alb" || r.type === "target-group" || r.type === "rds" || r.type === "db-subnet-group") {
    return awsFail("InvalidParameterValue", `${RESOURCE_TYPE_INFO[r.type].label}의 이름은 만든 뒤 변경할 수 없습니다.`);
  }
  const error = checkNameTag(name);
  if (error) return error;
  return ok(touch({ ...project, resources: project.resources.map((x) => (x.id === r.id ? { ...x, name: name.trim() } : x)) }));
}

// ---------------------------------------------------------------- Reachability Analyzer 경로

export function createNetworkPath(project: Project, input: { name: string; request: unknown }): ActionResult {
  const parsed = simulationRequestSchema.safeParse(input.request);
  if (!parsed.success) return awsFail("InvalidParameterValue", `경로 설정이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? ""}`);
  const nameError = checkNameTag(input.name);
  if (nameError) return nameError;
  const path: NetworkPath = { id: createId("nip"), name: input.name.trim(), request: parsed.data, createdAt: new Date().toISOString(), lastAnalysis: null };
  return ok(touch({ ...project, networkPaths: [path, ...project.networkPaths] }), [], path.id);
}

/** 분석 결과 기록 (설정 변경이 아니므로 실행 취소 기록 없이 적용한다) */
export function recordPathAnalysis(project: Project, pathId: string, result: Pick<SimulationResult, "outcome" | "summary">): Project {
  return {
    ...project,
    networkPaths: project.networkPaths.map((p) =>
      p.id === pathId ? { ...p, lastAnalysis: { at: new Date().toISOString(), outcome: result.outcome, summary: result.summary.slice(0, 2000) } } : p,
    ),
  };
}

/** 같은 요청의 경로가 있으면 결과만 갱신하고, 없으면 새 경로로 기록한다 (쉬운 모드 시뮬레이션용) */
export function upsertAnalyzedPath(project: Project, request: unknown, result: Pick<SimulationResult, "outcome" | "summary">, name: string): Project {
  const parsed = simulationRequestSchema.safeParse(request);
  if (!parsed.success) return project;
  const key = JSON.stringify(parsed.data);
  const existing = project.networkPaths.find((p) => JSON.stringify(simulationRequestSchema.parse(p.request)) === key);
  if (existing) return recordPathAnalysis(project, existing.id, result);
  const path: NetworkPath = { id: createId("nip"), name, request: parsed.data, createdAt: new Date().toISOString(), lastAnalysis: null };
  return recordPathAnalysis({ ...project, networkPaths: [path, ...project.networkPaths].slice(0, 200) }, path.id, result);
}

export function deleteNetworkPaths(project: Project, pathIds: string[]): ActionResult {
  const set = new Set(pathIds);
  return ok(touch({ ...project, networkPaths: project.networkPaths.filter((p) => !set.has(p.id)) }));
}

export { RDS_DEFAULT_PORT };
