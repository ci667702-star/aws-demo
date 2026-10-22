/**
 * 리소스 연결(관계) 유효성 검사.
 * 연결은 단순한 선이 아니라 타입과 규칙이 있는 관계다. 지원되지 않거나 AWS에서 허용되지 않는 관계는
 * 거부하고 이유를 설명한다. (설정값에 따라 나중에 무효가 되는 경우는 validation-engine이 탐지한다.)
 */
import { parseCidr, parseIpv4, tryParseCidr } from "./cidr-utils";
import { createId } from "./ids";
import {
  findRelationSpec,
  RELATION_SPECS,
  RESOURCE_TYPE_INFO,
  relationsForType,
  type Connection,
  type Listener,
  type Project,
  type RelationSpec,
  type Resource,
  type ResourceType,
} from "./resource-models";
import { buildTopology, type Topology } from "./topology-engine";

export interface ConnectionPlan {
  ok: true;
  connection: Connection;
  /** 연결과 함께 적용할 설정 변경 (예: 기본 리스너 생성, EC2 사설 IP 자동 할당) */
  configPatches: { resourceId: string; patch: Record<string, unknown> }[];
  notes: string[];
}

export interface ConnectionRejection {
  ok: false;
  reason: string;
  hint?: string;
}

export type ConnectionCheck = ConnectionPlan | ConnectionRejection;

export interface ConnectionOptions {
  destinationCidr?: string;
  listenerId?: string;
  /** 교체 중인 기존 연결 (중복/개수 검사에서 제외) */
  ignoreConnectionIds?: string[];
}

const typeLabel = (t: ResourceType) => RESOURCE_TYPE_INFO[t].label;

function reject(reason: string, hint?: string): ConnectionRejection {
  return { ok: false, reason, hint };
}

export function describeAllowedRelations(type: ResourceType): string {
  const partners = relationsForType(type).map((s) => typeLabel(s.source === type ? s.target : s.source));
  return [...new Set(partners)].join(", ");
}

function vpcName(topo: Topology, vpcId: string | null): string {
  return vpcId ? topo.name(vpcId) : "(없음)";
}

/** 두 리소스가 결정 가능한 VPC를 가지며 서로 다르면 거부 사유를 만든다. */
function sameVpcCheck(topo: Topology, a: Resource, b: Resource, why: string): ConnectionRejection | null {
  const va = topo.vpcsOf(a.id);
  const vb = topo.vpcsOf(b.id);
  if (!va.length || !vb.length) return null;
  if (va.some((v) => vb.includes(v))) return null;
  return reject(
    `${topo.label(a.id)}(VPC ${va.map((v) => vpcName(topo, v)).join(", ")})와 ${topo.label(b.id)}(VPC ${vb.map((v) => vpcName(topo, v)).join(", ")})은(는) 서로 다른 VPC에 있습니다.`,
    why,
  );
}

function countExcluding(list: Connection[], ignore: string[] | undefined): number {
  return list.filter((c) => !ignore?.includes(c.id)).length;
}

export function checkConnection(
  project: Project,
  aId: string,
  bId: string,
  options: ConnectionOptions = {},
  topology?: Topology,
): ConnectionCheck {
  const topo = topology ?? buildTopology(project);
  const a = topo.get(aId);
  const b = topo.get(bId);
  if (!a || !b) return reject("연결하려는 리소스를 찾을 수 없습니다.");
  if (a.id === b.id) return reject("리소스를 자기 자신과 연결할 수 없습니다.");

  const found = findRelationSpec(a.type, b.type);
  if (!found) {
    return reject(
      `${typeLabel(a.type)}와(과) ${typeLabel(b.type)} 사이에는 지원되는 관계가 없습니다.`,
      `${typeLabel(a.type)}은(는) ${describeAllowedRelations(a.type)}와(과) 연결할 수 있습니다.`,
    );
  }
  const spec: RelationSpec = found.spec;
  const source = found.reversed ? b : a;
  const target = found.reversed ? a : b;
  const ignore = options.ignoreConnectionIds;
  const existingSame = topo
    .outgoing(source.id, spec.type)
    .filter((c) => c.targetResourceId === target.id && !ignore?.includes(c.id));

  const isRoute = spec.type === "route-table-internet-gateway" || spec.type === "route-table-nat-gateway";
  if (existingSame.length && !isRoute && spec.type !== "alb-target-group") {
    return reject(`${topo.label(source.id)}와(과) ${topo.label(target.id)}은(는) 이미 '${spec.label}' 관계로 연결되어 있습니다.`);
  }

  // ---- 개수 제한
  if (spec.maxPerSource !== undefined) {
    const n = countExcluding(topo.outgoing(source.id, spec.type), ignore);
    if (n >= spec.maxPerSource) {
      const current = topo.outgoing(source.id, spec.type).find((c) => !ignore?.includes(c.id));
      const messages: Partial<Record<string, string>> = {
        "vpc-internet-gateway": `VPC ${source.name}에는 이미 Internet Gateway(${topo.name(current?.targetResourceId)})가 연결되어 있습니다. VPC당 IGW는 하나입니다.`,
        "nat-gateway-subnet": `NAT Gateway ${source.name}은(는) 이미 서브넷 ${topo.name(current?.targetResourceId)}에 배치되어 있습니다.`,
        "ec2-subnet": `EC2 ${source.name}은(는) 이미 서브넷 ${topo.name(current?.targetResourceId)}에 배치되어 있습니다. 기존 배치 연결을 먼저 삭제하세요.`,
        "rds-db-subnet-group": `RDS ${source.name}은(는) 이미 DB 서브넷 그룹 ${topo.name(current?.targetResourceId)}에 배치되어 있습니다.`,
      };
      return reject(
        messages[spec.type] ?? `${topo.label(source.id)}의 '${spec.label}' 연결은 최대 ${spec.maxPerSource}개입니다.`,
        "기존 연결을 삭제하거나 설정 패널에서 교체하세요.",
      );
    }
  }
  if (spec.maxPerTarget !== undefined) {
    const n = countExcluding(topo.incoming(target.id, spec.type), ignore);
    if (n >= spec.maxPerTarget) {
      const current = topo.incoming(target.id, spec.type).find((c) => !ignore?.includes(c.id));
      const messages: Partial<Record<string, string>> = {
        "vpc-subnet": `서브넷 ${target.name}은(는) 이미 VPC ${topo.name(current?.sourceResourceId)}에 속해 있습니다. 서브넷은 하나의 VPC에만 속할 수 있습니다.`,
        "vpc-internet-gateway": `Internet Gateway ${target.name}은(는) 이미 VPC ${topo.name(current?.sourceResourceId)}에 연결되어 있습니다. IGW는 한 번에 하나의 VPC에만 연결됩니다.`,
        "route-table-subnet": `서브넷 ${target.name}은(는) 이미 라우팅 테이블 ${topo.name(current?.sourceResourceId)}과(와) 연결되어 있습니다. 서브넷은 하나의 라우팅 테이블만 사용합니다.`,
        "network-acl-subnet": `서브넷 ${target.name}은(는) 이미 NACL ${topo.name(current?.sourceResourceId)}과(와) 연결되어 있습니다. 서브넷은 하나의 NACL만 사용합니다.`,
      };
      return reject(
        messages[spec.type] ?? `${topo.label(target.id)}은(는) 이미 '${spec.label}' 관계를 가지고 있습니다.`,
        "기존 연결을 삭제하거나 설정 패널에서 교체하세요.",
      );
    }
  }

  // ---- 같은 VPC 규칙 및 관계별 규칙
  const configPatches: ConnectionPlan["configPatches"] = [];
  const notes: string[] = [];
  let metadata: Record<string, string> = {};

  switch (spec.type) {
    case "route-table-subnet":
    case "network-acl-subnet": {
      const r = sameVpcCheck(topo, source, target, `${typeLabel(source.type)}은(는) 같은 VPC의 서브넷과만 연결할 수 있습니다.`);
      if (r) return r;
      break;
    }
    case "ec2-security-group":
    case "alb-security-group":
    case "rds-security-group": {
      const r = sameVpcCheck(topo, source, target, "보안 그룹은 같은 VPC의 리소스에만 연결할 수 있습니다.");
      if (r) return r;
      break;
    }
    case "route-table-internet-gateway":
    case "route-table-nat-gateway": {
      const destination = options.destinationCidr ?? "0.0.0.0/0";
      const parsed = parseCidr(destination);
      if (!parsed.ok) return reject(`경로 대상 CIDR이 올바르지 않습니다: ${parsed.error}`);
      const rtVpc = topo.vpcOf(source.id);
      if (spec.type === "route-table-internet-gateway") {
        const igwVpc = topo.vpcOfIgw(target.id);
        if (rtVpc && igwVpc && rtVpc !== igwVpc) {
          return reject(
            `Internet Gateway ${target.name}은(는) 다른 VPC(${topo.name(igwVpc)})에 연결되어 있습니다.`,
            "라우팅 테이블의 IGW 대상은 같은 VPC에 연결된 IGW여야 합니다.",
          );
        }
      } else {
        const r = sameVpcCheck(topo, source, target, "라우팅 테이블의 NAT Gateway 대상은 같은 VPC에 있어야 합니다.");
        if (r) return r;
      }
      const conflict = topo
        .routesOf(source.id, rtVpc)
        .find((route) => route.cidr && route.cidr.text === parsed.value.text && !ignore?.includes(route.key));
      if (conflict) {
        return reject(
          `라우팅 테이블 ${source.name}에 이미 ${parsed.value.text} 경로가 있습니다 (대상: ${topo.routeTargetLabel(conflict)}).`,
          "같은 Destination의 경로는 하나만 둘 수 있습니다. 설정 패널에서 기존 경로를 수정하세요.",
        );
      }
      metadata = { destinationCidr: parsed.value.text };
      break;
    }
    case "alb-subnet": {
      const r = sameVpcCheck(topo, source, target, "ALB의 서브넷은 모두 같은 VPC에 있어야 합니다.");
      if (r) return r;
      const subnet = target as Extract<Resource, { type: "subnet" }>;
      const sameAz = topo
        .outgoing(source.id, "alb-subnet")
        .filter((c) => !ignore?.includes(c.id))
        .map((c) => topo.getOfType(c.targetResourceId, "subnet"))
        .find((s) => s && s.config.availabilityZone === subnet.config.availabilityZone);
      if (sameAz) {
        return reject(
          `ALB ${source.name}에는 이미 가용 영역 ${subnet.config.availabilityZone}의 서브넷 ${sameAz.name}이(가) 있습니다.`,
          "ALB는 가용 영역당 하나의 서브넷만 사용할 수 있습니다.",
        );
      }
      break;
    }
    case "target-group-ec2": {
      const ec2 = target as Extract<Resource, { type: "ec2" }>;
      if (ec2.config.state === "terminated") return reject(`종료(Terminated)된 인스턴스 ${ec2.name}은(는) 대상으로 등록할 수 없습니다.`);
      const r = sameVpcCheck(topo, source, target, "대상 그룹의 대상은 모두 같은 VPC에 있어야 합니다.");
      if (r) return r;
      break;
    }
    case "alb-target-group": {
      const otherAlb = topo.targetGroupAlbs(target.id).find((x) => x.id !== source.id);
      if (otherAlb) {
        return reject(
          `대상 그룹 ${target.name}은(는) 이미 다른 로드 밸런서 ${otherAlb.name}에서 사용 중입니다.`,
          "대상 그룹은 하나의 로드 밸런서에서만 사용할 수 있습니다.",
        );
      }
      const r = sameVpcCheck(topo, source, target, "ALB와 대상 그룹의 대상은 같은 VPC에 있어야 합니다.");
      if (r) return r;
      const alb = source as Extract<Resource, { type: "alb" }>;
      const bindings = topo.listenersOf(alb.id).filter((bnd) => !ignore?.includes(bnd.connectionId ?? ""));
      let listenerId = options.listenerId;
      if (listenerId) {
        const binding = topo.listenersOf(alb.id).find((bnd) => bnd.listener.id === listenerId);
        if (!binding) return reject("선택한 리스너를 찾을 수 없습니다.");
        if (binding.targetGroupId && !ignore?.includes(binding.connectionId ?? "")) {
          return reject(`리스너 ${binding.listener.protocol}:${binding.listener.port}에는 이미 대상 그룹 ${topo.name(binding.targetGroupId)}이(가) 있습니다.`);
        }
      } else {
        const free = bindings.find((bnd) => !bnd.targetGroupId);
        if (free) {
          listenerId = free.listener.id;
          notes.push(`리스너 ${free.listener.protocol}:${free.listener.port}이(가) 대상 그룹 ${target.name}(으)로 전달하도록 설정했습니다.`);
        } else if (alb.config.listeners.length === 0) {
          const listener: Listener = { id: createId("lsn"), protocol: "HTTP", port: 80 };
          listenerId = listener.id;
          configPatches.push({ resourceId: alb.id, patch: { listeners: [listener] } });
          notes.push(`ALB에 리스너가 없어 기본 리스너 HTTP:80을 만들고 대상 그룹 ${target.name}(으)로 전달하도록 설정했습니다.`);
        } else {
          return reject(
            `ALB ${alb.name}의 모든 리스너에 이미 대상 그룹이 있습니다.`,
            "ALB 설정에서 새 리스너를 추가하거나 기존 리스너의 대상 그룹을 변경하세요.",
          );
        }
      }
      metadata = { listenerId };
      break;
    }
    case "db-subnet-group-subnet": {
      const r = sameVpcCheck(topo, source, target, "DB 서브넷 그룹의 서브넷은 모두 같은 VPC에 있어야 합니다.");
      if (r) return r;
      break;
    }
    case "rds-db-subnet-group": {
      const r = sameVpcCheck(topo, source, target, "RDS의 보안 그룹과 DB 서브넷 그룹은 같은 VPC에 있어야 합니다.");
      if (r) return r;
      break;
    }
    case "ec2-subnet": {
      const ec2 = source as Extract<Resource, { type: "ec2" }>;
      const subnet = target as Extract<Resource, { type: "subnet" }>;
      const sgVpcs = topo.securityGroupsOf(ec2.id).map((sg) => topo.vpcOf(sg.id)).filter(Boolean);
      const subnetVpc = topo.vpcOfSubnet(subnet.id);
      if (subnetVpc && sgVpcs.length && !sgVpcs.includes(subnetVpc)) {
        return reject(
          `EC2 ${ec2.name}에 연결된 보안 그룹은 VPC ${topo.name(sgVpcs[0] ?? null)}에 있지만 서브넷 ${subnet.name}은(는) VPC ${topo.name(subnetVpc)}에 있습니다.`,
          "다른 VPC로 옮기려면 먼저 보안 그룹 연결을 해제하세요.",
        );
      }
      const cidr = tryParseCidr(subnet.config.cidr);
      const currentIp = ec2.config.privateIp;
      const ipInRange = !!cidr && topo.ipInSubnet(subnet.id, parseIpv4(currentIp));
      if (!ipInRange && cidr) {
        const suggestion = topo.suggestPrivateIp(subnet.id, ec2.id);
        if (suggestion) {
          configPatches.push({ resourceId: ec2.id, patch: { privateIp: suggestion } });
          notes.push(`서브넷 ${subnet.name}(${cidr.text})에서 사설 IP ${suggestion}을(를) 자동으로 할당했습니다.`);
        }
      }
      break;
    }
    default:
      break;
  }

  const connection = {
    id: createId("conn"),
    sourceResourceId: source.id,
    targetResourceId: target.id,
    relationType: spec.type,
    metadata,
  } as Connection;

  return { ok: true, connection, configPatches, notes };
}

export function relationLabel(connection: Connection): string {
  if (connection.relationType === "route-table-internet-gateway" || connection.relationType === "route-table-nat-gateway") {
    return connection.metadata.destinationCidr;
  }
  return RELATION_SPECS[connection.relationType].label;
}
