/**
 * 검증 규칙 → 관련 설정 항목.
 * 검증 센터에서 "설정으로 이동"을 누르면, 문제 리소스의 유형에 맞는 설정 항목으로 이동한다.
 * (모든 규칙이 매핑되어 있는지, 설정 키가 실제 도움말에 있는지는 단위 테스트가 확인한다)
 */
import type { ResourceType } from "@/lib/engine/resource-models";
import type { SimStep } from "@/lib/engine/simulation-log";
import type { ValidationFinding } from "@/lib/engine/validation-engine";
import type { FailureInfo } from "@/lib/engine/simulation-log";

export type FieldTarget = Partial<Record<ResourceType, string>>;

export const RULE_FIELDS: Record<string, FieldTarget> = {
  "NET-001": { vpc: "cidr" },
  "NET-002": { subnet: "cidr" },
  "NET-003": { subnet: "vpc" },
  "NET-004": { subnet: "cidr", vpc: "cidr" },
  "NET-005": { subnet: "cidr" },
  "NET-006": { vpc: "cidr" },
  "NET-007": { subnet: "availabilityZone" },
  "NET-008": { "internet-gateway": "vpc", vpc: "internetGateway" },
  "NET-009": { "route-table": "destinationCidr" },
  "NET-010": { "route-table": "target", "internet-gateway": "vpc" },
  "NET-011": { "route-table": "target", "nat-gateway": "subnet" },
  "NET-012": { "route-table": "routes" },
  "NET-013": { "route-table": "vpc" },
  "NET-014": { "route-table": "subnets", "network-acl": "subnets", subnet: "routeTable" },
  "NET-015": { subnet: "routeTable", "route-table": "routes" },
  "NET-016": { "nat-gateway": "subnet" },
  "NET-017": { "nat-gateway": "subnet" },
  "NET-018": { "route-table": "destinationCidr" },
  "NET-019": { ec2: "publicIpMode", subnet: "routeTable" },
  "NET-020": { subnet: "routeTable", "route-table": "main" },
  "NET-021": { subnet: "networkAcl" },
  "NET-022": { "route-table": "main" },
  "NET-023": { vpc: "cidr" },
  "NET-024": { "nat-gateway": "elasticIp" },
  "NET-025": { "nat-gateway": "state" },
  "EIP-001": { "elastic-ip": "association" },
  "SEC-001": { "security-group": "inboundRules" },
  "SEC-002": { "security-group": "inboundRules" },
  "SEC-003": { "security-group": "inboundRules" },
  "SEC-004": { "security-group": "portRange" },
  "SEC-005": { "security-group": "peer" },
  "SEC-006": { ec2: "securityGroups", alb: "securityGroups", rds: "securityGroups" },
  "SEC-007": { ec2: "securityGroups", alb: "securityGroups", rds: "securityGroups", "security-group": "vpc" },
  "SEC-008": { "security-group": "vpc", "network-acl": "vpc" },
  "SEC-009": { "security-group": "attachedTo" },
  "SEC-010": { "network-acl": "outboundRules", subnet: "networkAcl" },
  "SEC-011": { "network-acl": "cidr" },
  "SEC-012": { "network-acl": "ruleNumber" },
  "SEC-013": { "network-acl": "inboundRules" },
  "EC2-001": { ec2: "subnet" },
  "EC2-002": { ec2: "privateIp" },
  "EC2-003": { ec2: "privateIp" },
  "EC2-004": { ec2: "state" },
  "EC2-005": { "target-group": "targets", ec2: "state" },
  "EC2-006": { ec2: "sourceDestCheck" },
  "EC2-007": { ec2: "userData" },
  "EC2-008": { ec2: "subnet", subnet: "routeTable" },
  "EC2-009": { ec2: "publicIpMode", "elastic-ip": "association" },
  "EC2-010": { ec2: "state", "route-table": "target" },
  "EC2-011": { ec2: "securityGroups", "security-group": "inboundRules", subnet: "cidr" },
  "EC2-012": { ec2: "state" },
  "ELB-001": { alb: "listeners" },
  "ELB-002": { alb: "defaultTargetGroup" },
  "ELB-003": { "target-group": "targets" },
  "ELB-004": { "target-group": "targets", ec2: "state" },
  "ELB-005": { alb: "securityGroups", ec2: "securityGroups", "security-group": "inboundRules" },
  "ELB-006": { alb: "subnets" },
  "ELB-007": { alb: "subnets" },
  "ELB-008": { alb: "scheme" },
  "ELB-009": { alb: "securityGroups", "security-group": "inboundRules" },
  "ELB-010": { alb: "subnets", ec2: "subnet" },
  "ELB-011": { alb: "listenerPort" },
  "ELB-012": { "target-group": "healthCheckPath" },
  "ELB-013": { "target-group": "targets", alb: "defaultTargetGroup" },
  "ELB-014": { alb: "listenerProtocol" },
  "ELB-015": { "target-group": "matcher", ec2: "httpResponseCode" },
  "ELB-016": { alb: "state" },
  "RDS-001": { rds: "dbSubnetGroup" },
  "RDS-002": { "db-subnet-group": "subnets" },
  "RDS-003": { "db-subnet-group": "subnets" },
  "RDS-004": { rds: "securityGroups", ec2: "securityGroups", "security-group": "inboundRules" },
  "RDS-005": { rds: "publiclyAccessible" },
  "RDS-006": { rds: "securityGroups", "security-group": "peer" },
  "RDS-007": { rds: "publiclyAccessible" },
  "RDS-008": { vpc: "enableDnsHostnames", rds: "publiclyAccessible" },
  "RDS-009": { rds: "multiAz" },
  "RDS-010": { rds: "state" },
  "RDS-011": { "db-subnet-group": "subnets" },
  "GEN-001": {},
};

/** 검증 결과에서, 주어진 리소스 유형의 관련 설정 항목 */
export function fieldForFinding(finding: Pick<ValidationFinding, "ruleId">, type: ResourceType): string | null {
  return RULE_FIELDS[finding.ruleId]?.[type] ?? null;
}

/** 통신 시뮬레이션 실패 분류 → 리소스 유형별 관련 설정 */
const FAILURE_FIELDS: Record<FailureInfo["category"], FieldTarget> = {
  configuration: { ec2: "privateIp", subnet: "vpc" },
  state: { ec2: "state", rds: "state", alb: "state", "nat-gateway": "state" },
  dns: { vpc: "enableDnsSupport" },
  routing: { "route-table": "routes", subnet: "routeTable", ec2: "subnet", "nat-gateway": "subnet" },
  "security-group": { "security-group": "inboundRules", ec2: "securityGroups", alb: "securityGroups", rds: "securityGroups" },
  "network-acl": { "network-acl": "inboundRules", subnet: "networkAcl" },
  gateway: { "internet-gateway": "vpc", ec2: "publicIpMode", "elastic-ip": "association" },
  listener: { alb: "listeners" },
  target: { "target-group": "targets", ec2: "state" },
  service: { ec2: "listenPorts", rds: "port" },
};

export function fieldForFailure(category: FailureInfo["category"], type: ResourceType, overrides?: FailureInfo["fields"]): string | null {
  return overrides?.[type] ?? FAILURE_FIELDS[category]?.[type] ?? null;
}

/** 시뮬레이션 단계 종류 → 관련 설정 (단계별 도움말 링크) */
export function fieldForStep(step: Pick<SimStep, "kind">, type: ResourceType): string | null {
  const byKind: Partial<Record<SimStep["kind"], FieldTarget>> = {
    route: FAILURE_FIELDS.routing,
    "security-group": FAILURE_FIELDS["security-group"],
    "network-acl": FAILURE_FIELDS["network-acl"],
    gateway: FAILURE_FIELDS.gateway,
    listener: FAILURE_FIELDS.listener,
    target: FAILURE_FIELDS.target,
    service: FAILURE_FIELDS.service,
    state: FAILURE_FIELDS.state,
    dns: FAILURE_FIELDS.dns,
  };
  return byKind[step.kind]?.[type] ?? null;
}
