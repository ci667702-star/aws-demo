/**
 * 검증 엔진: 프로젝트 전체를 분석해 오류/경고/정보를 만든다.
 * - error: 시뮬레이션이나 특정 동작을 차단하는 문제
 * - warning: 보안 위험 또는 일반적인 설계상 문제 (통신 실패와 구분)
 * - info: 개선 권장 사항, 학습에 유용한 정보
 * 모든 규칙은 고유 ID를 가지며 실제 설정값으로부터 계산된다.
 */
import { healthCheckPort, validateHealthCheck, type TargetHealth } from "./alb-engine";
import {
  awsReservedReason,
  cidrContainsCidr,
  cidrContainsIp,
  cidrsOverlap,
  formatIpv4,
  formatPortRange,
  isRfc1918Cidr,
  parseIpv4,
  tryParseCidr,
  validateSubnetCidr,
  validateVpcCidr,
} from "./cidr-utils";
import {
  computeAllTargetHealth,
  DEFAULT_INTERNET_CLIENT_IP,
  simulateWithTopology,
  type SimulationResult,
} from "./connectivity-engine";
import { parseEventPattern } from "./event-pattern";
import { evaluateIam, objectArn } from "./iam-engine";
import { internetPath, ruleCanInvoke, scheduleCanInvoke } from "./lambda-engine";
import { hasNatSoftware, natInstanceScript, natInstanceUsages } from "./nat-instance";
import { evaluateS3Access } from "./s3-engine";
import { nextRunTimes, parseScheduleExpression } from "./schedule-expression";
import { evaluateNacl, findShadowedRules, describeNaclRule } from "./network-acl-engine";
import { evaluateOacAccess, isDefaultBehavior, originTargetName } from "./cloudfront-engine";
import { AVAILABILITY_ZONES, type IamRole, type LambdaCodeTemplate, type NaclRule, type Project, type ResourceOfType, type SgRule } from "./resource-models";
import { findDuplicateDestinations } from "./route-engine";
import { findSecretByName, isPendingDeletion, isPurged, liveSecrets, secretArn } from "./secrets-engine";
import { checkSecretRotation, ROTATION_ROLE_ACTIONS } from "./service-access";
import { describeSgRule, evaluateSecurityGroups, ruleAllowsFromAnywhere } from "./security-group-engine";
import { findParameterByName, managedNodeStatus, parameterArn } from "./ssm-engine";
import { buildTopology, displayName, type Topology } from "./topology-engine";

export type Severity = "error" | "warning" | "info";
export type ValidationCategory = "network" | "security" | "compute" | "load-balancing" | "database" | "general";

export interface ValidationFinding {
  id: string;
  ruleId: string;
  severity: Severity;
  category: ValidationCategory;
  title: string;
  resourceIds: string[];
  /** 문제 원인 */
  cause: string;
  /** 발생 조건 (어떤 설정이 문제인지) */
  condition: string;
  /** 수정 방법 */
  fix: string[];
  /** 관련 AWS 개념 */
  concept: string;
  /** 수정하면 시뮬레이션 결과가 어떻게 달라지는지 */
  impact: string;
}

export interface ValidationReport {
  findings: ValidationFinding[];
  counts: Record<Severity, number>;
  generatedAt: string;
}

interface FindingDraft {
  key?: string;
  title?: string;
  severity?: Severity;
  resourceIds: (string | null | undefined)[];
  cause: string;
  condition: string;
  fix: string[];
  impact: string;
}

export interface ValidationContext {
  topo: Topology;
  health: Map<string, TargetHealth[]>;
  simulate: (request: Parameters<typeof simulateWithTopology>[1]) => SimulationResult;
}

export interface ValidationRule {
  id: string;
  category: ValidationCategory;
  severity: Severity;
  title: string;
  concept: string;
  check: (ctx: ValidationContext) => FindingDraft[];
}

const DB_PORTS: Record<number, string> = {
  3306: "MySQL",
  5432: "PostgreSQL",
  1433: "SQL Server",
  1521: "Oracle",
  27017: "MongoDB",
  6379: "Redis",
};
const ADMIN_PORTS: Record<number, string> = { 22: "SSH", 3389: "RDP" };
const EPHEMERAL_SAMPLES = [1024, 32768, 49152, 65535];

const sgRuleText = (topo: Topology, rule: SgRule) => describeSgRule(rule, (id) => topo.name(id));
const rulePortsLabel = (rule: { protocol: string; fromPort: number; toPort: number }) =>
  rule.protocol === "all" ? "모든 트래픽" : rule.protocol === "icmp" ? "ICMP" : `${rule.protocol.toUpperCase()} ${formatPortRange(rule.fromPort, rule.toPort)}`;

function representativeIp(cidrText: string): number | null {
  const cidr = tryParseCidr(cidrText);
  if (!cidr) return null;
  if (cidr.prefix === 0) return parseIpv4(DEFAULT_INTERNET_CLIENT_IP);
  return cidr.prefix >= 31 ? cidr.network : cidr.network + 1;
}

/** Lambda가 맡을 수 있는 실행 역할 (없거나 신뢰 정책이 맞지 않으면 undefined) */
function lambdaRole(project: Project, fn: ResourceOfType<"lambda">): IamRole | undefined {
  const role = project.services.iam.roles.find((r) => r.id === fn.config.roleId);
  return role?.trustedEntity === "lambda.amazonaws.com" ? role : undefined;
}

const roleAllows = (project: Project, role: IamRole, action: string, resource = "*") => evaluateIam(project, { kind: "role", role }, action, resource).decision === "allowed";

/** VPC 밖(인터넷·AWS 퍼블릭 엔드포인트)에 닿아야 하는 코드 템플릿 */
const INTERNET_TEMPLATES: Partial<Record<LambdaCodeTemplate, string>> = {
  "s3-list": "S3 읽기",
  "http-get": "외부 API 호출",
  "secret-get": "Secrets Manager 보안 암호 읽기",
  "ssm-get": "Parameter Store 파라미터 읽기",
};

const LAMBDA_FIX_ROLE = [
  "심화 모드: Lambda → 함수 → 구성 → 권한에서 역할을 바꾸거나, IAM → 역할에서 그 역할에 정책을 연결하세요.",
  "쉬운 모드: 함수 설정의 '실행 역할'에서 역할을 고르거나 '기본 실행 역할 만들기'를 누르세요.",
];

function isServiceLikeRule(rule: NaclRule): boolean {
  if (rule.action !== "allow") return false;
  if (rule.protocol === "all") return true;
  if (rule.protocol === "icmp") return false;
  const coversEphemeral = rule.fromPort <= 1024 && rule.toPort >= 65535;
  const isEphemeralRange = rule.fromPort >= 1024 && rule.toPort - rule.fromPort > 1000;
  return !coversEphemeral && !isEphemeralRange;
}

// ---------------------------------------------------------------------------
// 규칙 정의
// ---------------------------------------------------------------------------

export const VALIDATION_RULES: ValidationRule[] = [
  // ------------------------------------------------------------ 네트워크
  {
    id: "NET-001",
    category: "network",
    severity: "error",
    title: "유효하지 않은 VPC CIDR",
    concept: "VPC는 /16 ~ /28 크기의 IPv4 CIDR 블록으로 주소 범위를 정의합니다. 서브넷과 local 경로는 이 범위를 기준으로 계산됩니다.",
    check: ({ topo }) =>
      topo.ofType("vpc").flatMap((vpc) => {
        const r = validateVpcCidr(vpc.config.cidr);
        if (r.ok) return [];
        return [
          {
            resourceIds: [vpc.id],
            cause: r.error,
            condition: `VPC ${displayName(vpc)}의 CIDR = "${vpc.config.cidr}"`,
            fix: ["VPC 설정에서 CIDR을 a.b.c.d/n 형식, /16~/28 범위로 입력하세요. 예: 10.0.0.0/16"],
            impact: "CIDR이 올바르면 서브넷 포함 여부 검사와 VPC 내부(local) 라우팅이 계산되어 VPC 내부 통신을 시뮬레이션할 수 있습니다.",
          },
        ];
      }),
  },
  {
    id: "NET-002",
    category: "network",
    severity: "error",
    title: "유효하지 않은 Subnet CIDR",
    concept: "서브넷 CIDR은 VPC CIDR의 일부여야 하며 /16 ~ /28 크기만 허용됩니다. AWS는 각 서브넷에서 5개의 주소를 예약합니다.",
    check: ({ topo }) =>
      topo.ofType("subnet").flatMap((s) => {
        const r = validateSubnetCidr(s.config.cidr);
        if (r.ok) return [];
        return [
          {
            resourceIds: [s.id],
            cause: r.error,
            condition: `서브넷 ${displayName(s)}의 CIDR = "${s.config.cidr}"`,
            fix: ["서브넷 설정에서 VPC 범위 안의 CIDR(/16~/28)을 입력하세요. 예: 10.0.1.0/24"],
            impact: "CIDR이 올바르면 이 서브넷의 리소스에 IP가 배정되고 통신 시뮬레이션이 가능해집니다.",
          },
        ];
      }),
  },
  {
    id: "NET-003",
    category: "network",
    severity: "error",
    title: "VPC에 속하지 않은 Subnet",
    concept: "모든 서브넷은 정확히 하나의 VPC에 속합니다.",
    check: ({ topo }) =>
      topo
        .ofType("subnet")
        .filter((s) => !topo.vpcOfSubnet(s.id))
        .map((s) => ({
          resourceIds: [s.id],
          cause: `서브넷 ${displayName(s)}이(가) 어떤 VPC와도 연결되어 있지 않습니다.`,
          condition: "VPC → Subnet 소속 연결이 없음",
          fix: ["캔버스에서 VPC와 서브넷을 연결하거나 서브넷 설정에서 VPC를 선택하세요."],
          impact: "VPC에 속하면 라우팅 테이블과 NACL이 적용되고 이 서브넷의 리소스가 통신할 수 있습니다.",
        })),
  },
  {
    id: "NET-004",
    category: "network",
    severity: "error",
    title: "VPC 범위를 벗어난 Subnet",
    concept: "서브넷의 CIDR 블록은 소속 VPC의 CIDR 블록에 완전히 포함되어야 합니다.",
    check: ({ topo }) =>
      topo.ofType("subnet").flatMap((s) => {
        const vpcId = topo.vpcOfSubnet(s.id);
        const vpcCidr = topo.vpcCidr(vpcId);
        const cidr = tryParseCidr(s.config.cidr);
        if (!vpcId || !vpcCidr || !cidr || cidrContainsCidr(vpcCidr, cidr)) return [];
        return [
          {
            resourceIds: [s.id, vpcId],
            cause: `서브넷 ${displayName(s)}(${cidr.text})이 VPC ${topo.name(vpcId)}(${vpcCidr.text}) 범위 밖에 있습니다.`,
            condition: `${cidr.text} ⊄ ${vpcCidr.text}`,
            fix: [`서브넷 CIDR을 ${vpcCidr.text} 안의 범위로 변경하세요.`],
            impact: "범위를 맞추면 서브넷의 리소스가 VPC local 경로로 서로 통신할 수 있습니다.",
          },
        ];
      }),
  },
  {
    id: "NET-005",
    category: "network",
    severity: "error",
    title: "같은 VPC에서 겹치는 Subnet CIDR",
    concept: "같은 VPC 안의 서브넷 CIDR은 서로 겹칠 수 없습니다. 겹치면 어느 서브넷으로 트래픽을 보낼지 결정할 수 없습니다.",
    check: ({ topo }) => {
      const drafts: FindingDraft[] = [];
      for (const vpc of topo.ofType("vpc")) {
        const subnets = topo.subnetsOfVpc(vpc.id);
        for (let i = 0; i < subnets.length; i++) {
          for (let j = i + 1; j < subnets.length; j++) {
            const a = tryParseCidr(subnets[i].config.cidr);
            const b = tryParseCidr(subnets[j].config.cidr);
            if (a && b && cidrsOverlap(a, b)) {
              drafts.push({
                key: `${subnets[i].id}-${subnets[j].id}`,
                resourceIds: [subnets[i].id, subnets[j].id],
                cause: `${displayName(subnets[i])}(${a.text})과 ${displayName(subnets[j])}(${b.text})의 주소 범위가 겹칩니다.`,
                condition: `VPC ${displayName(vpc)} 내부 서브넷 CIDR 충돌`,
                fix: ["겹치지 않는 CIDR로 서브넷 중 하나를 변경하세요. 예: 10.0.1.0/24, 10.0.2.0/24"],
                impact: "충돌을 없애면 각 IP가 하나의 서브넷에만 속하게 되어 경로 계산이 명확해집니다.",
              });
            }
          }
        }
      }
      return drafts;
    },
  },
  {
    id: "NET-006",
    category: "network",
    severity: "warning",
    title: "VPC 간 CIDR 범위 중복",
    concept: "VPC끼리 CIDR이 겹치면 피어링이나 VPN 등으로 서로 연결할 수 없습니다. 이 시뮬레이터는 피어링을 지원하지 않지만 설계 단계에서 겹치지 않게 계획하는 것이 좋습니다.",
    check: ({ topo }) => {
      const vpcs = topo.ofType("vpc");
      const drafts: FindingDraft[] = [];
      for (let i = 0; i < vpcs.length; i++) {
        for (let j = i + 1; j < vpcs.length; j++) {
          const a = tryParseCidr(vpcs[i].config.cidr);
          const b = tryParseCidr(vpcs[j].config.cidr);
          if (a && b && cidrsOverlap(a, b)) {
            drafts.push({
              key: `${vpcs[i].id}-${vpcs[j].id}`,
              resourceIds: [vpcs[i].id, vpcs[j].id],
              cause: `${displayName(vpcs[i])}(${a.text})과 ${displayName(vpcs[j])}(${b.text})의 범위가 겹칩니다.`,
              condition: "서로 다른 VPC의 CIDR 중복",
              fix: ["한쪽 VPC의 CIDR을 겹치지 않는 범위로 변경하세요. 예: 10.0.0.0/16과 10.1.0.0/16"],
              impact: "현재 시뮬레이션 결과에는 영향이 없지만, 실제 환경에서 VPC 간 연결이 가능해집니다.",
            });
          }
        }
      }
      return drafts;
    },
  },
  {
    id: "NET-007",
    category: "network",
    severity: "error",
    title: "지원하지 않는 가용 영역",
    concept: `서브넷은 리전의 가용 영역 하나에 속합니다. 시뮬레이터의 가상 리전은 ${AVAILABILITY_ZONES.join(", ")}을(를) 제공합니다.`,
    check: ({ topo }) =>
      topo
        .ofType("subnet")
        .filter((s) => !(AVAILABILITY_ZONES as readonly string[]).includes(s.config.availabilityZone))
        .map((s) => ({
          resourceIds: [s.id],
          cause: `서브넷 ${displayName(s)}의 가용 영역 "${s.config.availabilityZone}"은(는) 가상 리전에 없습니다.`,
          condition: "availabilityZone 값이 목록에 없음",
          fix: [`가용 영역을 ${AVAILABILITY_ZONES.join(", ")} 중에서 선택하세요.`],
          impact: "올바른 가용 영역을 지정하면 ALB와 DB 서브넷 그룹의 가용 영역 요구 사항을 검사할 수 있습니다.",
        })),
  },
  {
    id: "NET-008",
    category: "network",
    severity: "warning",
    title: "VPC에 연결되지 않은 Internet Gateway",
    concept: "Internet Gateway는 VPC에 연결(Attach)되어야 동작합니다. 연결되지 않은 IGW를 가리키는 경로는 블랙홀이 됩니다.",
    check: ({ topo }) =>
      topo
        .ofType("internet-gateway")
        .filter((igw) => !topo.vpcOfIgw(igw.id))
        .map((igw) => ({
          resourceIds: [igw.id],
          cause: `${displayName(igw)}이(가) 어떤 VPC에도 연결되어 있지 않습니다.`,
          condition: "VPC → Internet Gateway 연결 없음",
          fix: ["캔버스에서 VPC와 Internet Gateway를 연결하세요. (VPC당 IGW는 하나)"],
          impact: "VPC에 연결하면 이 IGW를 대상으로 하는 경로가 실제로 인터넷과 통신할 수 있게 됩니다.",
        })),
  },
  {
    id: "NET-009",
    category: "network",
    severity: "error",
    title: "유효하지 않은 경로 대상 CIDR",
    concept: "라우팅 규칙의 Destination은 올바른 IPv4 CIDR이어야 합니다. 인터넷 기본 경로는 0.0.0.0/0입니다.",
    check: ({ topo }) =>
      topo.ofType("route-table").flatMap((rt) =>
        topo
          .routesOf(rt.id, topo.vpcOf(rt.id))
          .filter((r) => r.connectionId && !r.cidr)
          .map((r) => ({
            key: r.key,
            resourceIds: [rt.id, r.targetId],
            cause: `라우팅 테이블 ${displayName(rt)}의 경로 대상 CIDR "${r.destinationCidr}"이(가) 올바르지 않습니다.`,
            condition: `${r.destinationCidr} → ${topo.routeTargetLabel(r)}`,
            fix: ["경로의 Destination을 올바른 CIDR로 수정하세요. 예: 0.0.0.0/0"],
            impact: "유효한 경로가 되면 라우팅 결정(Longest Prefix Match)에 포함됩니다.",
          })),
      ),
  },
  {
    id: "NET-010",
    category: "network",
    severity: "error",
    title: "연결되지 않은 Internet Gateway로 향하는 경로 (블랙홀)",
    concept: "라우팅 테이블의 IGW 대상은 같은 VPC에 연결된 IGW여야 합니다. 그렇지 않으면 경로는 블랙홀이 되어 트래픽이 버려집니다.",
    check: ({ topo }) =>
      topo.ofType("route-table").flatMap((rt) => {
        const vpcId = topo.vpcOf(rt.id);
        return topo
          .routesOf(rt.id, vpcId)
          .filter((r) => r.targetKind === "internet-gateway" && !topo.igwAttachedTo(r.targetId, vpcId))
          .map((r) => {
            const attached = r.targetId ? topo.vpcOfIgw(r.targetId) : null;
            return {
              key: r.key,
              resourceIds: [rt.id, r.targetId],
              cause: attached
                ? `${topo.name(r.targetId)}은(는) 다른 VPC(${topo.name(attached)})에 연결되어 있습니다.`
                : `${topo.name(r.targetId)}이(가) VPC에 연결되지 않은 상태에서 인터넷 경로가 정의되었습니다.`,
              condition: `${displayName(rt)}: ${r.destinationCidr} → ${topo.name(r.targetId)}`,
              fix: [`${topo.name(r.targetId)}을(를) ${vpcId ? `VPC ${topo.name(vpcId)}` : "라우팅 테이블의 VPC"}에 연결하세요.`],
              impact: "IGW가 연결되면 이 경로를 사용하는 서브넷이 퍼블릭 서브넷이 되어 인터넷 통신이 가능해집니다.",
            };
          });
      }),
  },
  {
    id: "NET-011",
    category: "network",
    severity: "error",
    title: "잘못된 NAT Gateway 경로 대상",
    concept: "라우팅 테이블의 NAT Gateway 대상은 같은 VPC의 서브넷에 배치된 NAT Gateway여야 합니다.",
    check: ({ topo }) =>
      topo.ofType("route-table").flatMap((rt) => {
        const vpcId = topo.vpcOf(rt.id);
        return topo
          .routesOf(rt.id, vpcId)
          .filter((r) => r.targetKind === "nat-gateway")
          .flatMap((r) => {
            const natVpc = r.targetId ? topo.vpcOf(r.targetId) : null;
            if (natVpc && natVpc === vpcId) return [];
            return [
              {
                key: r.key,
                resourceIds: [rt.id, r.targetId],
                cause: !natVpc
                  ? `${topo.name(r.targetId)}이(가) 서브넷에 배치되지 않아 VPC를 알 수 없습니다.`
                  : `${topo.name(r.targetId)}은(는) 다른 VPC(${topo.name(natVpc)})에 있습니다.`,
                condition: `${displayName(rt)}: ${r.destinationCidr} → ${topo.name(r.targetId)}`,
                fix: ["같은 VPC의 퍼블릭 서브넷에 배치된 NAT Gateway를 경로 대상으로 지정하세요."],
                impact: "올바른 NAT를 지정하면 프라이빗 서브넷의 아웃바운드 인터넷 통신이 가능해집니다.",
              },
            ];
          });
      }),
  },
  {
    id: "NET-012",
    category: "network",
    severity: "error",
    title: "라우팅 테이블의 중복 경로 (충돌)",
    concept: "하나의 라우팅 테이블에 같은 Destination CIDR을 두 번 정의할 수 없습니다. local 경로의 VPC CIDR도 다른 대상으로 다시 정의할 수 없습니다.",
    check: ({ topo }) =>
      topo.ofType("route-table").flatMap((rt) =>
        findDuplicateDestinations(topo.routesOf(rt.id, topo.vpcOf(rt.id))).map((group) => ({
          key: group[0].cidr?.text,
          resourceIds: [rt.id, ...group.map((g) => g.targetId)],
          cause: `${displayName(rt)}에 Destination ${group[0].cidr?.text} 경로가 ${group.length}개 있습니다: ${group.map((g) => topo.routeTargetLabel(g)).join(", ")}`,
          condition: "같은 Destination의 경로 중복",
          fix: ["중복된 경로 중 하나를 삭제하거나 Destination을 변경하세요."],
          impact: "충돌을 없애면 해당 목적지로 가는 경로가 하나로 결정됩니다. (현재 시뮬레이터는 local → 정의 순서로 선택)",
        })),
      ),
  },
  {
    id: "NET-013",
    category: "network",
    severity: "warning",
    title: "VPC에 속하지 않은 라우팅 테이블",
    concept: "라우팅 테이블은 하나의 VPC에 속하며, 같은 VPC의 서브넷과만 연결할 수 있습니다.",
    check: ({ topo }) =>
      topo
        .ofType("route-table")
        .filter((rt) => !topo.vpcOf(rt.id))
        .map((rt) => ({
          resourceIds: [rt.id],
          cause: `라우팅 테이블 ${displayName(rt)}이(가) VPC에 속해 있지 않습니다.`,
          condition: "VPC → Route Table 소속 연결 없음",
          fix: ["캔버스에서 VPC와 라우팅 테이블을 연결하세요."],
          impact: "VPC에 속하면 local 경로가 생기고 서브넷과 연결해 사용할 수 있습니다.",
        })),
  },
  {
    id: "NET-014",
    category: "network",
    severity: "error",
    title: "다른 VPC의 서브넷과 연결된 라우팅 테이블 또는 NACL",
    concept: "라우팅 테이블과 네트워크 ACL은 같은 VPC의 서브넷에만 연결할 수 있습니다.",
    check: ({ topo }) => {
      const drafts: FindingDraft[] = [];
      for (const c of topo.connections) {
        if (c.relationType !== "route-table-subnet" && c.relationType !== "network-acl-subnet") continue;
        const a = topo.vpcOf(c.sourceResourceId);
        const b = topo.vpcOfSubnet(c.targetResourceId);
        if (a && b && a !== b) {
          drafts.push({
            key: c.id,
            resourceIds: [c.sourceResourceId, c.targetResourceId],
            cause: `${topo.label(c.sourceResourceId)}(VPC ${topo.name(a)})이(가) 다른 VPC(${topo.name(b)})의 서브넷 ${topo.name(c.targetResourceId)}과 연결되어 있습니다.`,
            condition: "연결된 리소스의 VPC 불일치",
            fix: ["같은 VPC의 라우팅 테이블/NACL과 연결하세요."],
            impact: "같은 VPC로 맞추면 서브넷이 올바른 경로와 방화벽 규칙을 사용합니다.",
          });
        }
      }
      return drafts;
    },
  },
  {
    id: "NET-015",
    category: "network",
    severity: "warning",
    title: "외부로 나가는 경로가 없는 Private Subnet",
    concept: "프라이빗 서브넷의 리소스가 외부(IPv4 인터넷)와 통신하려면 퍼블릭 서브넷의 NAT Gateway와 0.0.0.0/0 → NAT 경로가 필요합니다. DB 전용 서브넷처럼 의도적으로 격리한 경우는 문제가 아닙니다.",
    check: ({ topo }) =>
      topo.ofType("subnet").flatMap((s) => {
        const cls = topo.classifySubnet(s.id);
        if (cls.kind !== "private-isolated") return [];
        const instances = topo.ofType("ec2").filter((e) => topo.subnetOf(e.id) === s.id && e.config.state !== "terminated");
        return [
          {
            severity: instances.length ? "warning" : "info",
            resourceIds: [s.id, ...instances.map((i) => i.id)],
            cause: `${cls.reason}${instances.length ? ` 이 서브넷의 EC2 ${instances.map((i) => displayName(i)).join(", ")}은(는) 외부와 통신할 수 없습니다.` : ""}`,
            condition: "서브넷 라우팅 테이블에 IGW/NAT 경로 없음",
            fix: [
              "외부 통신이 필요한 프라이빗 서브넷: 퍼블릭 서브넷에 NAT Gateway(비용을 줄이려면 NAT 인스턴스)를 만들고 0.0.0.0/0 → NAT 경로를 추가하세요.",
              "인터넷에 직접 노출할 서브넷: 0.0.0.0/0 → Internet Gateway 경로를 추가하세요.",
            ],
            impact: "경로를 추가하면 'EC2 → 인터넷' 시뮬레이션이 NAT 또는 IGW를 거쳐 성공하게 됩니다.",
          },
        ];
      }),
  },
  {
    id: "NET-016",
    category: "network",
    severity: "error",
    title: "프라이빗 서브넷에 배치된 NAT Gateway",
    concept: "퍼블릭 NAT Gateway는 IGW 경로가 있는 퍼블릭 서브넷에 있어야 인터넷으로 트래픽을 보낼 수 있습니다.",
    check: ({ topo }) =>
      topo.ofType("nat-gateway").flatMap((nat) => {
        const subnetId = topo.subnetOf(nat.id);
        if (!subnetId) return [];
        const cls = topo.classifySubnet(subnetId);
        if (cls.kind === "public") return [];
        return [
          {
            resourceIds: [nat.id, subnetId],
            cause: `${displayName(nat)}이(가) 배치된 서브넷 ${topo.name(subnetId)}은(는) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
            condition: "NAT Gateway 서브넷에 IGW 경로 없음",
            fix: ["NAT Gateway를 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷으로 옮기세요."],
            impact: "NAT를 퍼블릭 서브넷에 두면 NAT를 경유하는 프라이빗 서브넷의 인터넷 통신이 성공합니다.",
          },
        ];
      }),
  },
  {
    id: "NET-017",
    category: "network",
    severity: "error",
    title: "서브넷에 배치되지 않은 NAT Gateway",
    concept: "NAT Gateway는 특정 서브넷(보통 퍼블릭 서브넷)에 생성됩니다.",
    check: ({ topo }) =>
      topo
        .ofType("nat-gateway")
        .filter((nat) => !topo.subnetOf(nat.id))
        .map((nat) => ({
          resourceIds: [nat.id],
          cause: `${displayName(nat)}이(가) 서브넷에 배치되어 있지 않습니다.`,
          condition: "NAT Gateway → Subnet 배치 연결 없음",
          fix: ["캔버스에서 NAT Gateway를 퍼블릭 서브넷과 연결하세요."],
          impact: "서브넷에 배치하면 NAT의 가상 사설 IP와 Elastic IP가 결정되어 경로 대상으로 사용할 수 있습니다.",
        })),
  },
  {
    id: "NET-018",
    category: "network",
    severity: "error",
    title: "VPC 내부 주소를 IGW/NAT로 보내는 경로",
    concept: "VPC CIDR보다 더 구체적인 경로는 IGW나 NAT Gateway를 대상으로 할 수 없습니다. 이런 경로는 VPC 내부 통신을 가로채 도달할 수 없게 만듭니다.",
    check: ({ topo }) =>
      topo.ofType("route-table").flatMap((rt) => {
        const vpcId = topo.vpcOf(rt.id);
        const vpcCidr = topo.vpcCidr(vpcId);
        if (!vpcCidr) return [];
        return topo
          .routesOf(rt.id, vpcId)
          .filter((r) => r.connectionId && r.cidr && r.cidr.prefix > vpcCidr.prefix && cidrContainsCidr(vpcCidr, r.cidr))
          .map((r) => ({
            key: r.key,
            resourceIds: [rt.id, r.targetId],
            cause: `${displayName(rt)}의 경로 ${r.destinationCidr} → ${topo.routeTargetLabel(r)}이(가) VPC 범위(${vpcCidr.text}) 안의 주소를 외부 게이트웨이로 보냅니다.`,
            condition: `${r.destinationCidr} ⊂ ${vpcCidr.text}`,
            fix: ["이 경로를 삭제하세요. VPC 내부 통신은 local 경로가 처리합니다."],
            impact: "경로를 삭제하면 해당 범위의 VPC 내부 통신이 local로 전달됩니다.",
          }));
      }),
  },
  {
    id: "NET-019",
    category: "network",
    severity: "warning",
    title: "퍼블릭 IP가 있지만 인터넷 경로가 없는 인스턴스",
    concept: "퍼블릭 IP만으로는 인터넷과 통신할 수 없습니다. 인스턴스가 있는 서브넷의 라우팅 테이블에 VPC에 연결된 IGW로 향하는 경로가 있어야 합니다.",
    check: ({ topo }) =>
      topo.ofType("ec2").flatMap((ec2) => {
        const subnetId = topo.subnetOf(ec2.id);
        if (!subnetId || !topo.ec2PublicIpEnabled(ec2) || ec2.config.state === "terminated") return [];
        const cls = topo.classifySubnet(subnetId);
        if (cls.kind === "public") return [];
        return [
          {
            resourceIds: [ec2.id, subnetId],
            cause: `${displayName(ec2)}에는 퍼블릭 IP가 할당되지만 서브넷 ${topo.name(subnetId)}은(는) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
            condition: "퍼블릭 IP 활성화 + IGW 경로 없음",
            fix: [
              "서브넷의 라우팅 테이블에 0.0.0.0/0 → Internet Gateway 경로를 추가하세요.",
              "또는 인스턴스를 프라이빗하게 운영하려면 퍼블릭 IP 할당을 끄세요.",
            ],
            impact: "IGW 경로를 추가하면 '인터넷 → EC2 퍼블릭 IP' 시뮬레이션의 응답 경로가 성립합니다.",
          },
        ];
      }),
  },
  {
    id: "NET-020",
    category: "network",
    severity: "info",
    title: "기본(main) 라우팅 테이블을 사용하는 서브넷",
    concept: "명시적으로 라우팅 테이블과 연결되지 않은 서브넷은 VPC의 기본(main) 라우팅 테이블을 사용합니다.",
    check: ({ topo }) =>
      topo.ofType("subnet").flatMap((s) => {
        const ref = topo.routeTableRefFor(s.id);
        if (ref.kind !== "main" && ref.kind !== "implicit-main") return [];
        return [
          {
            resourceIds: ref.kind === "main" ? [s.id, ref.routeTableId] : [s.id],
            cause:
              ref.kind === "main"
                ? `서브넷 ${displayName(s)}은(는) 기본 라우팅 테이블 ${topo.name(ref.routeTableId)}을(를) 사용합니다.`
                : `서브넷 ${displayName(s)}은(는) 명시적 라우팅 테이블이 없고, VPC에 기본 라우팅 테이블도 지정되지 않아 local 경로만 사용합니다.`,
            condition: "Route Table → Subnet 명시적 연결 없음",
            fix: ["의도한 라우팅을 명확히 하려면 서브넷을 라우팅 테이블과 명시적으로 연결하세요."],
            impact: "명시적으로 연결하면 그 라우팅 테이블의 경로가 이 서브넷에 적용됩니다.",
          },
        ];
      }),
  },
  {
    id: "NET-021",
    category: "network",
    severity: "info",
    title: "기본 NACL을 사용하는 서브넷",
    concept: "명시적으로 연결된 네트워크 ACL이 없는 서브넷은 VPC 기본 NACL을 사용합니다. 기본 NACL은 모든 인바운드/아웃바운드 트래픽을 허용합니다.",
    check: ({ topo }) =>
      topo
        .ofType("subnet")
        .filter((s) => topo.vpcOfSubnet(s.id) && !topo.naclOf(s.id))
        .map((s) => ({
          resourceIds: [s.id],
          cause: `서브넷 ${displayName(s)}은(는) 기본 NACL(모두 허용)을 사용한다고 가정합니다.`,
          condition: "Network ACL → Subnet 연결 없음",
          fix: ["서브넷 경계에서 트래픽을 제한하려면 NACL을 만들고 서브넷과 연결하세요."],
          impact: "NACL을 연결하면 그 규칙(요청과 응답 각각)이 시뮬레이션에 적용됩니다.",
        })),
  },
  {
    id: "NET-022",
    category: "network",
    severity: "error",
    title: "기본 라우팅 테이블이 여러 개인 VPC",
    concept: "VPC에는 기본(main) 라우팅 테이블이 정확히 하나만 있을 수 있습니다.",
    check: ({ topo }) =>
      topo.ofType("vpc").flatMap((vpc) => {
        const mains = topo.routeTablesOfVpc(vpc.id).filter((rt) => rt.config.main);
        if (mains.length <= 1) return [];
        return [
          {
            resourceIds: [vpc.id, ...mains.map((m) => m.id)],
            cause: `VPC ${displayName(vpc)}에 기본 라우팅 테이블로 지정된 테이블이 ${mains.length}개 있습니다: ${mains.map((m) => displayName(m)).join(", ")}`,
            condition: "main = true인 라우팅 테이블 중복",
            fix: ["하나를 제외한 라우팅 테이블의 '기본 라우팅 테이블' 설정을 끄세요."],
            impact: "하나로 정리하면 명시적 연결이 없는 서브넷이 사용할 테이블이 명확해집니다. (현재는 첫 번째 테이블 사용)",
          },
        ];
      }),
  },
  {
    id: "NET-023",
    category: "network",
    severity: "info",
    title: "RFC 1918 사설 대역이 아닌 VPC CIDR",
    concept: "VPC CIDR에는 보통 RFC 1918 사설 대역(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)을 사용합니다. 공인 대역을 쓰면 해당 주소의 실제 인터넷 서비스에 접근할 수 없게 될 수 있습니다.",
    check: ({ topo }) =>
      topo.ofType("vpc").flatMap((vpc) => {
        const cidr = tryParseCidr(vpc.config.cidr);
        if (!cidr || isRfc1918Cidr(cidr)) return [];
        return [
          {
            resourceIds: [vpc.id],
            cause: `VPC ${displayName(vpc)}의 CIDR ${cidr.text}은(는) RFC 1918 사설 대역이 아닙니다.`,
            condition: "VPC CIDR ⊄ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16",
            fix: ["가능하면 10.0.0.0/16 같은 사설 대역을 사용하세요."],
            impact: "사설 대역을 사용하면 인터넷 주소와의 충돌 가능성이 없어집니다.",
          },
        ];
      }),
  },

  {
    id: "NET-024",
    category: "network",
    severity: "warning",
    title: "탄력적 IP가 없는 NAT Gateway",
    concept: "퍼블릭 NAT 게이트웨이는 만들 때 탄력적 IP 하나를 지정해야 하며, 프라이빗 서브넷의 트래픽을 이 주소로 변환합니다.",
    check: ({ topo }) =>
      topo
        .ofType("nat-gateway")
        .filter((nat) => !topo.elasticIpOf(nat.id))
        .map((nat) => ({
          resourceIds: [nat.id],
          cause: `${topo.name(nat.id)}에 연결된 탄력적 IP가 없습니다. (이전 버전에서 만든 프로젝트는 가상 주소를 자동으로 사용합니다.)`,
          condition: "Elastic IP → NAT Gateway 연결 없음",
          fix: ["탄력적 IP를 할당한 뒤 그 주소를 지정해 NAT 게이트웨이를 다시 만드세요."],
          impact: "탄력적 IP를 사용하면 NAT를 거친 트래픽의 출발지 주소가 고정된 할당 주소로 표시됩니다.",
        })),
  },
  {
    id: "NET-025",
    category: "network",
    severity: "warning",
    title: "사용할 수 없는 상태의 NAT Gateway",
    concept: "NAT 게이트웨이는 Available 상태에서만 트래픽을 처리합니다. 생성 직후에는 Pending 상태이며, Failed 상태의 NAT는 사용할 수 없습니다.",
    check: ({ topo }) =>
      topo
        .ofType("nat-gateway")
        .filter((nat) => nat.config.state !== "available")
        .map((nat) => ({
          severity: nat.config.state === "pending" ? ("info" as const) : ("warning" as const),
          resourceIds: [nat.id],
          cause: `${topo.name(nat.id)}의 상태가 ${nat.config.state}입니다.`,
          condition: `state = ${nat.config.state}`,
          fix: nat.config.state === "pending" ? ["잠시 기다리면 Available 상태가 됩니다."] : ["NAT 게이트웨이를 삭제하고 다시 만드세요."],
          impact: "Available 상태가 되면 이 NAT를 경유하는 아웃바운드 통신이 가능해집니다.",
        })),
  },
  {
    id: "EIP-001",
    category: "network",
    severity: "info",
    title: "연결되지 않은 탄력적 IP",
    concept: "탄력적 IP는 인스턴스나 NAT 게이트웨이에 연결해야 사용됩니다. 실제 AWS에서는 사용하지 않는 퍼블릭 IPv4 주소도 요금이 발생하므로 필요 없으면 릴리스합니다.",
    check: ({ topo }) =>
      topo
        .ofType("elastic-ip")
        .filter((eip) => !topo.elasticIpTarget(eip.id))
        .map((eip) => ({
          resourceIds: [eip.id],
          cause: `탄력적 IP ${eip.config.publicIp}(${topo.name(eip.id)})이(가) 어떤 리소스에도 연결되어 있지 않습니다.`,
          condition: "Elastic IP 연결 없음",
          fix: ["인스턴스에 연결하거나(작업 → 탄력적 IP 주소 연결), 필요 없으면 릴리스하세요."],
          impact: "시뮬레이션 결과에는 영향이 없고, 가상 비용 추정치에서 퍼블릭 IPv4 비용이 줄어듭니다.",
        })),
  },

  // ------------------------------------------------------------ 보안
  {
    id: "SEC-001",
    category: "security",
    severity: "warning",
    title: "모든 IPv4 주소에 모든 트래픽을 허용하는 인바운드 규칙",
    concept: "보안 그룹 인바운드 규칙은 필요한 포트와 출발지만 허용하는 것이 원칙입니다(최소 권한). 0.0.0.0/0에 모든 트래픽을 열면 모든 포트가 인터넷에 노출됩니다.",
    check: ({ topo }) =>
      topo.ofType("security-group").flatMap((sg) =>
        sg.config.inboundRules
          .filter((r) => ruleAllowsFromAnywhere(r) && (r.protocol === "all" || (r.fromPort === 0 && r.toPort === 65535)))
          .map((r) => ({
            key: r.id,
            resourceIds: [sg.id],
            cause: `${displayName(sg)}의 인바운드 규칙 "${sgRuleText(topo, r)}"이(가) 모든 IPv4 주소에서 모든 포트를 허용합니다.`,
            condition: "출발지 0.0.0.0/0 + 모든 포트",
            fix: ["필요한 포트(예: TCP 80, 443)만 허용하도록 규칙을 좁히세요.", "내부 통신은 보안 그룹 참조 규칙을 사용하세요."],
            impact: "통신 성공 여부에는 영향이 없을 수 있지만, 불필요한 포트가 외부에 노출되는 보안 위험이 줄어듭니다.",
          })),
      ),
  },
  {
    id: "SEC-002",
    category: "security",
    severity: "warning",
    title: "관리용 포트(SSH/RDP)를 전체 공개",
    concept: "SSH(22)와 RDP(3389) 같은 관리용 포트는 특정 관리자 IP 대역이나 Bastion 보안 그룹에서만 허용해야 합니다.",
    check: ({ topo }) =>
      topo.ofType("security-group").flatMap((sg) =>
        sg.config.inboundRules
          .filter((r) => ruleAllowsFromAnywhere(r) && r.protocol === "tcp" && !(r.fromPort === 0 && r.toPort === 65535))
          .flatMap((r) =>
            Object.entries(ADMIN_PORTS)
              .filter(([port]) => Number(port) >= r.fromPort && Number(port) <= r.toPort)
              .map(([port, name]) => ({
                key: `${r.id}-${port}`,
                resourceIds: [sg.id],
                cause: `${displayName(sg)}이(가) ${name}(TCP ${port})을 0.0.0.0/0에 허용합니다.`,
                condition: `인바운드 TCP ${formatPortRange(r.fromPort, r.toPort)} ← 0.0.0.0/0`,
                fix: [`출발지를 관리자 IP(예: 203.0.113.0/24)나 Bastion 보안 그룹으로 제한하세요.`],
                impact: "통신 성공 여부와 별개로, 외부에서 관리 포트로의 무차별 접속 위험이 사라집니다.",
              })),
          ),
      ),
  },
  {
    id: "SEC-003",
    category: "security",
    severity: "warning",
    title: "데이터베이스 포트를 전체 공개",
    concept: "데이터베이스 포트는 애플리케이션 서버의 보안 그룹에서만 허용하는 것이 일반적입니다.",
    check: ({ topo }) =>
      topo.ofType("security-group").flatMap((sg) =>
        sg.config.inboundRules
          .filter((r) => ruleAllowsFromAnywhere(r) && r.protocol === "tcp" && !(r.fromPort === 0 && r.toPort === 65535))
          .flatMap((r) =>
            Object.entries(DB_PORTS)
              .filter(([port]) => Number(port) >= r.fromPort && Number(port) <= r.toPort)
              .map(([port, name]) => ({
                key: `${r.id}-${port}`,
                resourceIds: [sg.id],
                cause: `${displayName(sg)}이(가) ${name} 포트(TCP ${port})를 0.0.0.0/0에 허용합니다.`,
                condition: `인바운드 TCP ${formatPortRange(r.fromPort, r.toPort)} ← 0.0.0.0/0`,
                fix: ["출발지를 애플리케이션 서버의 보안 그룹(SG 참조 규칙)으로 바꾸세요."],
                impact: "애플리케이션 → DB 통신은 그대로 유지하면서 외부 노출을 막을 수 있습니다.",
              })),
          ),
      ),
  },
  {
    id: "SEC-004",
    category: "security",
    severity: "error",
    title: "유효하지 않은 보안 그룹 규칙",
    concept: "보안 그룹 규칙은 올바른 프로토콜, 포트 범위(시작 ≤ 끝), CIDR 또는 보안 그룹 참조를 가져야 합니다.",
    check: ({ topo }) =>
      topo.ofType("security-group").flatMap((sg) =>
        [...sg.config.inboundRules.map((r) => ["인바운드", r] as const), ...sg.config.outboundRules.map((r) => ["아웃바운드", r] as const)].flatMap(
          ([dir, r]) => {
            const problems: string[] = [];
            if ((r.protocol === "tcp" || r.protocol === "udp") && r.fromPort > r.toPort) problems.push(`포트 범위 시작(${r.fromPort})이 끝(${r.toPort})보다 큽니다.`);
            if (r.peer.kind === "cidr" && !tryParseCidr(r.peer.cidr)) problems.push(`CIDR "${r.peer.cidr}"이(가) 올바르지 않습니다.`);
            if (!problems.length) return [];
            return [
              {
                key: r.id,
                resourceIds: [sg.id],
                cause: `${displayName(sg)}의 ${dir} 규칙: ${problems.join(" ")}`,
                condition: `${dir} 규칙 ${rulePortsLabel(r)}`,
                fix: ["규칙을 수정하거나 삭제하세요."],
                impact: "잘못된 규칙은 평가에서 제외됩니다. 수정하면 의도한 트래픽이 허용됩니다.",
              },
            ];
          },
        ),
      ),
  },
  {
    id: "SEC-005",
    category: "security",
    severity: "error",
    title: "다른 VPC의 보안 그룹을 참조하는 규칙",
    concept: "보안 그룹 참조 규칙은 같은 VPC(또는 피어링된 VPC)의 보안 그룹만 참조할 수 있습니다. 이 시뮬레이터는 피어링을 지원하지 않습니다.",
    check: ({ topo }) =>
      topo.ofType("security-group").flatMap((sg) => {
        const vpcId = topo.vpcOf(sg.id);
        return [...sg.config.inboundRules, ...sg.config.outboundRules].flatMap((r) => {
          if (r.peer.kind !== "security-group") return [];
          const ref = topo.getOfType(r.peer.securityGroupId, "security-group");
          const refVpc = ref ? topo.vpcOf(ref.id) : null;
          if (ref && (!vpcId || !refVpc || refVpc === vpcId)) return [];
          return [
            {
              key: r.id,
              resourceIds: [sg.id, ref?.id],
              cause: ref
                ? `${displayName(sg)}의 규칙이 다른 VPC(${topo.name(refVpc)})의 보안 그룹 ${displayName(ref)}을(를) 참조합니다.`
                : `${displayName(sg)}의 규칙이 존재하지 않는 보안 그룹을 참조합니다.`,
              condition: `규칙 ${sgRuleText(topo, r)}`,
              fix: ["같은 VPC의 보안 그룹을 참조하거나 CIDR 규칙으로 바꾸세요."],
              impact: "같은 VPC의 보안 그룹을 참조하면 해당 그룹이 연결된 리소스의 트래픽이 허용됩니다.",
            },
          ];
        });
      }),
  },
  {
    id: "SEC-006",
    category: "security",
    severity: "error",
    title: "보안 그룹이 연결되지 않은 리소스",
    concept: "EC2, ALB, RDS의 네트워크 인터페이스에는 하나 이상의 보안 그룹이 연결되어야 합니다. 시뮬레이터는 보안 그룹이 없는 인터페이스의 트래픽을 모두 거부합니다.",
    check: ({ topo }) =>
      [...topo.ofType("ec2"), ...topo.ofType("alb"), ...topo.ofType("rds")]
        .filter((r) => !(r.type === "ec2" && r.config.state === "terminated"))
        .filter((r) => topo.securityGroupsOf(r.id).length === 0)
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${topo.label(r.id)}에 연결된 보안 그룹이 없습니다.`,
          condition: "리소스 → Security Group 연결 없음",
          fix: [`같은 VPC의 보안 그룹을 만들어 ${displayName(r)}에 연결하세요.`],
          impact: "보안 그룹을 연결하고 필요한 규칙을 추가하면 해당 리소스와의 통신이 허용됩니다.",
        })),
  },
  {
    id: "SEC-007",
    category: "security",
    severity: "error",
    title: "다른 VPC의 보안 그룹이 연결된 리소스",
    concept: "보안 그룹은 자신이 속한 VPC의 리소스에만 연결할 수 있습니다.",
    check: ({ topo }) =>
      [...topo.ofType("ec2"), ...topo.ofType("alb"), ...topo.ofType("rds")].flatMap((r) => {
        const vpcId = topo.vpcOf(r.id);
        if (!vpcId) return [];
        return topo
          .securityGroupsOf(r.id)
          .filter((sg) => topo.vpcOf(sg.id) && topo.vpcOf(sg.id) !== vpcId)
          .map((sg) => ({
            key: sg.id,
            resourceIds: [r.id, sg.id],
            cause: `${topo.label(r.id)}(VPC ${topo.name(vpcId)})에 다른 VPC(${topo.name(topo.vpcOf(sg.id))})의 보안 그룹 ${displayName(sg)}이(가) 연결되어 있습니다.`,
            condition: "리소스와 보안 그룹의 VPC 불일치",
            fix: ["리소스와 같은 VPC의 보안 그룹으로 교체하세요."],
            impact: "같은 VPC의 보안 그룹을 연결하면 규칙이 의도대로 평가됩니다.",
          }));
      }),
  },
  {
    id: "SEC-008",
    category: "security",
    severity: "warning",
    title: "VPC에 속하지 않은 보안 그룹 또는 NACL",
    concept: "보안 그룹과 네트워크 ACL은 하나의 VPC에 속합니다.",
    check: ({ topo }) =>
      [...topo.ofType("security-group"), ...topo.ofType("network-acl")]
        .filter((r) => !topo.vpcOf(r.id))
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${topo.label(r.id)}이(가) VPC에 속해 있지 않습니다.`,
          condition: "VPC → 리소스 소속 연결 없음",
          fix: ["캔버스에서 VPC와 연결하세요."],
          impact: "VPC에 속하면 같은 VPC의 리소스/서브넷과 연결할 수 있습니다.",
        })),
  },
  {
    id: "SEC-009",
    category: "security",
    severity: "info",
    title: "사용되지 않는 보안 그룹",
    concept: "어떤 리소스에도 연결되지 않은 보안 그룹은 트래픽에 영향을 주지 않습니다.",
    check: ({ topo }) =>
      topo
        .ofType("security-group")
        .filter((sg) => !sg.config.isDefault && topo.resourcesUsingSecurityGroup(sg.id).length === 0)
        .map((sg) => ({
          resourceIds: [sg.id],
          cause: `${displayName(sg)}이(가) 어떤 EC2/ALB/RDS에도 연결되어 있지 않습니다.`,
          condition: "리소스 → Security Group 연결 없음",
          fix: ["필요한 리소스에 연결하거나, 사용하지 않는다면 삭제하세요."],
          impact: "연결하면 해당 리소스의 트래픽에 이 그룹의 규칙이 적용됩니다.",
        })),
  },
  {
    id: "SEC-010",
    category: "security",
    severity: "warning",
    title: "응답 트래픽이 Network ACL에 의해 차단되는 구성",
    concept: "NACL은 상태 비저장형이라 요청을 허용해도 응답은 반대 방향 규칙으로 다시 평가됩니다. 응답은 임시 포트(1024-65535)를 사용하므로 반대 방향에 임시 포트 허용 규칙이 필요합니다.",
    check: ({ topo }) => {
      const drafts: FindingDraft[] = [];
      for (const nacl of topo.ofType("network-acl")) {
        const subnets = topo.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId);
        if (!subnets.length) continue;
        const pairs: [string, NaclRule[], NaclRule[], "inbound" | "outbound"][] = [
          ["인바운드 요청", nacl.config.inboundRules, nacl.config.outboundRules, "outbound"],
          ["아웃바운드 요청", nacl.config.outboundRules, nacl.config.inboundRules, "inbound"],
        ];
        for (const [label, requestRules, responseRules, responseDir] of pairs) {
          const sorted = [...requestRules].sort((a, b) => a.ruleNumber - b.ruleNumber);
          for (const rule of sorted.filter(isServiceLikeRule)) {
            const peer = representativeIp(rule.cidr);
            if (peer === null) continue;
            const protocol = rule.protocol === "all" ? "tcp" : rule.protocol === "udp" ? "udp" : "tcp";
            const blocked = EPHEMERAL_SAMPLES.filter(
              (port) => !evaluateNacl(responseRules, responseDir, { protocol, port, peerIp: peer }).allowed,
            );
            if (!blocked.length) continue;
            const all = blocked.length === EPHEMERAL_SAMPLES.length;
            drafts.push({
              key: `${rule.id}-${responseDir}`,
              severity: all ? "warning" : "info",
              resourceIds: [nacl.id, ...subnets],
              title: all ? undefined : "일부 임시 포트의 응답이 Network ACL에 의해 차단될 수 있음",
              cause: `${displayName(nacl)}의 ${label} 규칙 ${describeNaclRule(rule)}은(는) 허용되지만, ${responseDir === "outbound" ? "아웃바운드" : "인바운드"} 규칙이 ${rule.cidr} 방향의 응답 임시 포트(${blocked.join(", ")})를 허용하지 않습니다.`,
              condition: `${responseDir === "outbound" ? "아웃바운드" : "인바운드"} ${protocol.toUpperCase()} 1024-65535 ↔ ${rule.cidr} 허용 규칙 없음`,
              fix: [
                `${displayName(nacl)}의 ${responseDir === "outbound" ? "아웃바운드" : "인바운드"} 규칙에 ${protocol.toUpperCase()} 1024-65535 (${rule.cidr}) ALLOW 규칙을 추가하세요.`,
              ],
              impact: "임시 포트를 허용하면 요청은 통과했지만 응답이 막혀 실패하던 시뮬레이션이 성공합니다.",
            });
          }
        }
      }
      return drafts;
    },
  },
  {
    id: "SEC-011",
    category: "security",
    severity: "error",
    title: "유효하지 않은 NACL 규칙",
    concept: "NACL 규칙 번호는 방향별로 고유해야 하며(1~32766), 올바른 CIDR과 포트 범위를 가져야 합니다.",
    check: ({ topo }) =>
      topo.ofType("network-acl").flatMap((nacl) =>
        (["inbound", "outbound"] as const).flatMap((dir) => {
          const rules = dir === "inbound" ? nacl.config.inboundRules : nacl.config.outboundRules;
          const problems: string[] = [];
          const seen = new Map<number, number>();
          for (const r of rules) seen.set(r.ruleNumber, (seen.get(r.ruleNumber) ?? 0) + 1);
          for (const [num, count] of seen) if (count > 1) problems.push(`규칙 번호 ${num}이(가) ${count}번 사용되었습니다.`);
          for (const r of rules) {
            if (!tryParseCidr(r.cidr)) problems.push(`규칙 #${r.ruleNumber}의 CIDR "${r.cidr}"이(가) 올바르지 않습니다.`);
            if ((r.protocol === "tcp" || r.protocol === "udp") && r.fromPort > r.toPort) problems.push(`규칙 #${r.ruleNumber}의 포트 범위가 올바르지 않습니다.`);
          }
          if (!problems.length) return [];
          return [
            {
              key: dir,
              resourceIds: [nacl.id],
              cause: `${displayName(nacl)} ${dir === "inbound" ? "인바운드" : "아웃바운드"}: ${problems.join(" ")}`,
              condition: "규칙 번호 중복 또는 잘못된 값",
              fix: ["규칙 번호를 고유하게 바꾸고 CIDR/포트를 수정하세요."],
              impact: "잘못된 규칙은 평가에서 제외되거나 순서가 모호해집니다. 수정하면 평가 순서가 명확해집니다.",
            },
          ];
        }),
      ),
  },
  {
    id: "SEC-012",
    category: "security",
    severity: "info",
    title: "앞선 규칙에 가려져 적용되지 않는 NACL 규칙",
    concept: "NACL은 번호가 낮은 규칙부터 평가해 처음 일치한 규칙을 적용합니다. 앞선 규칙이 같은 트래픽을 이미 결정하면 뒤의 규칙은 효과가 없습니다.",
    check: ({ topo }) =>
      topo.ofType("network-acl").flatMap((nacl) =>
        (["inbound", "outbound"] as const).flatMap((dir) =>
          findShadowedRules(dir === "inbound" ? nacl.config.inboundRules : nacl.config.outboundRules).map(({ rule, shadowedBy }) => ({
            key: `${dir}-${rule.id}`,
            resourceIds: [nacl.id],
            cause: `${displayName(nacl)} ${dir === "inbound" ? "인바운드" : "아웃바운드"} 규칙 ${describeNaclRule(rule)}은(는) 앞선 ${describeNaclRule(shadowedBy)}에 가려져 적용되지 않습니다.`,
            condition: "더 낮은 번호의 규칙이 같은 트래픽을 먼저 결정",
            fix: [`의도한 규칙이라면 #${shadowedBy.ruleNumber}보다 낮은 번호로 바꾸세요.`],
            impact: "번호를 조정하면 해당 규칙이 먼저 평가되어 시뮬레이션 결과가 달라질 수 있습니다.",
          })),
        ),
      ),
  },
  {
    id: "SEC-013",
    category: "security",
    severity: "warning",
    title: "모든 트래픽을 거부하는 NACL",
    concept: "새로 만든 사용자 지정 NACL은 허용 규칙이 없어서 모든 트래픽을 거부합니다(마지막 * 규칙).",
    check: ({ topo }) =>
      topo.ofType("network-acl").flatMap((nacl) => {
        const subnets = topo.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId);
        if (!subnets.length) return [];
        return (["inbound", "outbound"] as const).flatMap((dir) => {
          const rules = dir === "inbound" ? nacl.config.inboundRules : nacl.config.outboundRules;
          if (rules.some((r) => r.action === "allow")) return [];
          return [
            {
              key: dir,
              resourceIds: [nacl.id, ...subnets],
              cause: `${displayName(nacl)}의 ${dir === "inbound" ? "인바운드" : "아웃바운드"} 규칙에 ALLOW가 없어 연결된 서브넷의 모든 트래픽이 거부됩니다.`,
              condition: "ALLOW 규칙 0개",
              fix: ["필요한 트래픽(서비스 포트와 응답용 임시 포트)을 허용하는 규칙을 추가하세요."],
              impact: "허용 규칙을 추가하면 해당 서브넷을 지나는 통신이 가능해집니다.",
            },
          ];
        });
      }),
  },

  // ------------------------------------------------------------ 컴퓨팅
  {
    id: "EC2-001",
    category: "compute",
    severity: "error",
    title: "서브넷에 배치되지 않은 EC2",
    concept: "EC2 인스턴스의 네트워크 인터페이스는 하나의 서브넷에 배치되어 그 서브넷의 IP를 사용합니다.",
    check: ({ topo }) =>
      topo
        .ofType("ec2")
        .filter((e) => !topo.subnetOf(e.id))
        .map((e) => ({
          resourceIds: [e.id],
          cause: `${displayName(e)}이(가) 서브넷에 배치되어 있지 않습니다.`,
          condition: "EC2 → Subnet 배치 연결 없음",
          fix: ["캔버스에서 EC2와 서브넷을 연결하거나 EC2 설정에서 서브넷을 선택하세요."],
          impact: "서브넷에 배치하면 사설 IP가 정해지고 통신 시뮬레이션의 출발지/목적지로 사용할 수 있습니다.",
        })),
  },
  {
    id: "EC2-002",
    category: "compute",
    severity: "error",
    title: "올바르지 않은 EC2 사설 IP",
    concept: "인스턴스의 사설 IP는 서브넷 CIDR 범위 안에 있어야 하며, AWS가 예약한 처음 4개와 마지막 1개 주소는 사용할 수 없습니다.",
    check: ({ topo }) =>
      topo.ofType("ec2").flatMap((e) => {
        const subnetId = topo.subnetOf(e.id);
        const subnet = topo.getOfType(subnetId, "subnet");
        const cidr = subnet ? tryParseCidr(subnet.config.cidr) : null;
        if (!subnet || !cidr) return [];
        const value = parseIpv4(e.config.privateIp);
        let cause: string | null = null;
        if (value === null) cause = `사설 IP "${e.config.privateIp}"이(가) 올바른 IPv4 주소가 아닙니다.`;
        else if (!cidrContainsIp(cidr, value)) cause = `사설 IP ${e.config.privateIp}이(가) 서브넷 ${displayName(subnet)}(${cidr.text}) 범위 밖입니다.`;
        else {
          const reserved = awsReservedReason(cidr, value);
          if (reserved) cause = `사설 IP ${e.config.privateIp}은(는) AWS 예약 주소(${reserved})입니다.`;
        }
        if (!cause) return [];
        return [
          {
            resourceIds: [e.id, subnet.id],
            cause,
            condition: `${displayName(e)}.privateIp = "${e.config.privateIp}"`,
            fix: [`${cidr.text} 범위에서 예약되지 않은 주소를 사용하세요. ${topo.suggestPrivateIp(subnet.id, e.id) ? `예: ${topo.suggestPrivateIp(subnet.id, e.id)}` : ""}`.trim()],
            impact: "올바른 IP를 지정하면 이 인스턴스를 출발지/목적지로 한 시뮬레이션이 가능해집니다.",
          },
        ];
      }),
  },
  {
    id: "EC2-003",
    category: "compute",
    severity: "error",
    title: "중복된 사설 IP",
    concept: "같은 VPC 안에서 두 네트워크 인터페이스가 같은 사설 IP를 가질 수 없습니다.",
    check: ({ topo }) => {
      const drafts: FindingDraft[] = [];
      const seen = new Map<string, string>();
      for (const eni of topo.enis()) {
        if (eni.privateIp === null || !eni.vpcId) continue;
        const key = `${eni.vpcId}|${eni.privateIp}`;
        const other = seen.get(key);
        if (other && other !== eni.ownerId) {
          drafts.push({
            key,
            resourceIds: [other, eni.ownerId],
            cause: `${topo.label(other)}와 ${topo.label(eni.ownerId)}이(가) 같은 사설 IP ${formatIpv4(eni.privateIp)}을(를) 사용합니다.`,
            condition: "VPC 내 사설 IP 중복",
            fix: ["둘 중 하나의 IP를 같은 서브넷의 다른 주소로 바꾸세요."],
            impact: "IP 중복을 없애면 해당 주소로의 통신이 하나의 리소스로 정확히 전달됩니다.",
          });
        } else seen.set(key, eni.ownerId);
      }
      return drafts;
    },
  },
  {
    id: "EC2-004",
    category: "compute",
    severity: "info",
    title: "Running 상태가 아닌 인스턴스",
    concept: "인스턴스는 Running 상태에서만 요청을 처리합니다. Stopped 상태에서는 퍼블릭 IP가 해제되고, Terminated 인스턴스는 다시 시작할 수 없습니다.",
    check: ({ topo }) =>
      topo
        .ofType("ec2")
        .filter((e) => e.config.state !== "running")
        .map((e) => ({
          resourceIds: [e.id],
          cause: `${displayName(e)}이(가) ${e.config.state} 상태입니다.`,
          condition: `state = ${e.config.state}`,
          fix: e.config.state === "terminated" ? ["종료된 인스턴스는 다시 시작할 수 없습니다. 필요하면 새 인스턴스를 만드세요."] : ["EC2 설정에서 인스턴스를 시작하세요."],
          impact: "Running으로 바꾸면 이 인스턴스로의 요청과 헬스 체크가 성공할 수 있습니다.",
        })),
  },
  {
    id: "EC2-005",
    category: "compute",
    severity: "warning",
    title: "종료된 인스턴스가 대상 그룹에 등록됨",
    concept: "종료(Terminated)된 인스턴스는 대상 그룹에서 자동으로 등록 해제됩니다.",
    check: ({ topo }) =>
      topo.connections
        .filter((c) => c.relationType === "target-group-ec2" && topo.getOfType(c.targetResourceId, "ec2")?.config.state === "terminated")
        .map((c) => ({
          key: c.id,
          resourceIds: [c.sourceResourceId, c.targetResourceId],
          cause: `종료된 ${topo.name(c.targetResourceId)}이(가) 대상 그룹 ${topo.name(c.sourceResourceId)}에 남아 있습니다.`,
          condition: "Target Group → 종료된 EC2",
          fix: ["대상 등록을 해제하세요."],
          impact: "등록을 해제하면 대상 상태 목록이 실제 사용 가능한 대상만 보여줍니다.",
        })),
  },

  // ------------------------------------------------------------ NAT 인스턴스 (경로 대상이 된 EC2)
  {
    id: "EC2-006",
    category: "compute",
    severity: "error",
    title: "소스/대상 확인이 켜진 NAT 인스턴스",
    concept:
      "인스턴스는 기본적으로 자기 주소가 출발지나 목적지가 아닌 트래픽을 버립니다(소스/대상 확인). NAT 인스턴스처럼 다른 리소스의 트래픽을 전달하는 인스턴스는 이 기능을 꺼야 합니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo)
        .filter((u) => u.ec2.config.state !== "terminated" && u.ec2.config.sourceDestCheck !== false)
        .map((u) => ({
          key: u.ec2.id,
          resourceIds: [u.ec2.id, ...u.routeTableIds],
          cause: `${displayName(u.ec2)}은(는) ${u.routeLabels.join(", ")} 경로의 대상이지만 소스/대상 확인이 켜져 있어, 프라이빗 서브넷에서 온 트래픽을 버립니다.`,
          condition: `${displayName(u.ec2)}.sourceDestCheck = 켜짐`,
          fix: ["심화 모드: EC2 → 인스턴스 → 작업 → 네트워킹 → '소스/대상 확인 변경'에서 중지하세요.", "쉬운 모드: 인스턴스 설정의 '소스/대상 확인' 스위치를 끄세요."],
          impact: "끄면 이 인스턴스가 프라이빗 서브넷의 트래픽을 받아 인터넷으로 전달할 수 있습니다.",
        })),
  },
  {
    id: "EC2-007",
    category: "compute",
    severity: "error",
    title: "NAT 설정(IP 포워딩·MASQUERADE)이 없는 NAT 인스턴스",
    concept:
      "NAT 인스턴스는 운영체제 안에서 IP 포워딩을 켜고 iptables MASQUERADE로 출발지 주소를 자기 주소로 바꿔야 합니다. 실제 운영체제는 실행되지 않으므로, 이 시뮬레이터는 사용자 데이터 스크립트에 두 설정이 들어 있는지로 판단합니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo)
        .filter((u) => u.ec2.config.state !== "terminated" && !hasNatSoftware(u.ec2.config.userData))
        .map((u) => {
          const missing = [
            /ip_forward\s*=\s*1/.test(u.ec2.config.userData) ? null : "IP 포워딩(net.ipv4.ip_forward=1)",
            /MASQUERADE/.test(u.ec2.config.userData) ? null : "iptables MASQUERADE",
          ].filter((x): x is string => !!x);
          return {
            key: u.ec2.id,
            resourceIds: [u.ec2.id],
            cause: `${displayName(u.ec2)}은(는) 경로의 대상이지만 사용자 데이터에 ${missing.join("과 ")} 설정이 없어 받은 트래픽을 전달하지 못합니다.`,
            condition: "사용자 데이터에 NAT 설정 없음",
            fix: natInstanceScript(u.ec2.config.ami)
              ? ["심화 모드: 인스턴스를 중지한 뒤 '사용자 데이터 편집'에서 템플릿 'NAT 인스턴스'를 넣으세요.", "쉬운 모드: 인스턴스 설정의 'NAT 설정 스크립트 넣기'를 누르세요."]
              : ["Windows 인스턴스는 NAT 인스턴스로 쓰지 않습니다. Amazon Linux 2023 인스턴스를 NAT 인스턴스로 사용하세요."],
            impact: "설정이 들어가면 인스턴스가 받은 트래픽의 출발지를 자기 주소로 바꿔 인터넷으로 내보냅니다.",
          };
        }),
  },
  {
    id: "EC2-008",
    category: "compute",
    severity: "error",
    title: "퍼블릭 서브넷에 있지 않은 NAT 인스턴스",
    concept: "NAT 인스턴스 자신도 인터넷 게이트웨이를 통해 나가야 하므로, 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷에 있어야 합니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo).flatMap((u) => {
        const subnetId = topo.subnetOf(u.ec2.id);
        if (!subnetId || u.ec2.config.state === "terminated") return [];
        const cls = topo.classifySubnet(subnetId);
        if (cls.kind === "public") return [];
        const loop = u.subnetIds.includes(subnetId);
        return [
          {
            key: u.ec2.id,
            resourceIds: [u.ec2.id, subnetId],
            cause: loop
              ? `${displayName(u.ec2)}이(가) 있는 서브넷 ${topo.name(subnetId)}도 자기 자신을 대상으로 하는 경로를 써서, 트래픽이 인터넷으로 나가지 못하고 다시 돌아옵니다.`
              : `${displayName(u.ec2)}이(가) 있는 서브넷 ${topo.name(subnetId)}은(는) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
            condition: "NAT 인스턴스 서브넷에 IGW 경로 없음",
            fix: ["NAT 인스턴스를 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷에 두고, 프라이빗 서브넷만 NAT 인스턴스 경로를 쓰게 하세요."],
            impact: "퍼블릭 서브넷에 두면 NAT 인스턴스를 거친 프라이빗 서브넷의 인터넷 통신이 가능해집니다.",
          },
        ];
      }),
  },
  {
    id: "EC2-009",
    category: "compute",
    severity: "error",
    title: "퍼블릭 IP가 없는 NAT 인스턴스",
    concept: "NAT 인스턴스는 퍼블릭 IPv4 주소(자동 할당 퍼블릭 IP 또는 탄력적 IP)가 있어야 인터넷 게이트웨이를 통해 나갈 수 있습니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo)
        .filter((u) => u.ec2.config.state === "running" && topo.subnetOf(u.ec2.id) && topo.enisOf(u.ec2.id)[0]?.publicIp == null)
        .map((u) => ({
          key: u.ec2.id,
          resourceIds: [u.ec2.id],
          cause: `${displayName(u.ec2)}에 퍼블릭 IPv4 주소가 없습니다.`,
          condition: `publicIpMode = ${u.ec2.config.publicIpMode}, 탄력적 IP 없음`,
          fix: ["퍼블릭 IP 자동 할당을 켜거나, 탄력적 IP를 할당해 이 인스턴스에 연결하세요."],
          impact: "퍼블릭 IP가 생기면 인터넷 게이트웨이가 NAT 인스턴스의 주소를 바꿔 내보낼 수 있습니다.",
        })),
  },
  {
    id: "EC2-010",
    category: "compute",
    severity: "error",
    title: "실행 중이 아닌 NAT 인스턴스 (블랙홀 경로)",
    concept:
      "경로의 대상 인스턴스가 중지되거나 종료되면 그 경로는 Blackhole 상태가 되어 트래픽이 버려집니다. NAT 인스턴스 하나에 의존하면 그 인스턴스가 멈추는 순간 프라이빗 서브넷의 외부 통신이 모두 끊깁니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo)
        .filter((u) => u.ec2.config.state !== "running")
        .map((u) => ({
          key: u.ec2.id,
          resourceIds: [u.ec2.id, ...u.routeTableIds],
          cause: `${displayName(u.ec2)}이(가) ${u.ec2.config.state} 상태라 ${u.routeLabels.join(", ")} 경로가 Blackhole입니다.`,
          condition: `경로 대상 인스턴스 state = ${u.ec2.config.state}`,
          fix:
            u.ec2.config.state === "terminated"
              ? ["종료된 인스턴스는 되돌릴 수 없습니다. 경로 대상을 실행 중인 NAT 인스턴스나 NAT 게이트웨이로 바꾸세요."]
              : [`${displayName(u.ec2)}을(를) 시작하세요.`],
          impact: "대상이 실행 중이 되면 경로가 Active가 되어 프라이빗 서브넷의 외부 통신이 다시 가능해집니다.",
        })),
  },
  {
    id: "EC2-011",
    category: "compute",
    severity: "warning",
    title: "프라이빗 서브넷 트래픽을 막는 NAT 인스턴스 보안 그룹",
    concept:
      "NAT 인스턴스의 보안 그룹은 프라이빗 서브넷에서 들어오는 트래픽(예: HTTP 80, HTTPS 443)을 인바운드로 허용하고, 같은 포트로 인터넷에 나가는 아웃바운드를 허용해야 합니다. AWS 문서의 예시는 프라이빗 서브넷 CIDR에서 오는 80·443을 허용합니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo).flatMap((u) => {
        if (u.ec2.config.state !== "running") return [];
        const natSubnet = topo.subnetOf(u.ec2.id);
        const sgs = topo.securityGroupsOf(u.ec2.id);
        const allows = (direction: "inbound" | "outbound", peerIp: number, peerSgs: string[]) =>
          [80, 443].some((port) => evaluateSecurityGroups(sgs, direction, { protocol: "tcp", port, peerIp, peerSecurityGroupIds: peerSgs }).allowed);
        const drafts: FindingDraft[] = [];
        for (const subnetId of u.subnetIds) {
          if (subnetId === natSubnet) continue;
          const sources = topo
            .ofType("ec2")
            .filter((e) => e.id !== u.ec2.id && e.config.state === "running" && topo.subnetOf(e.id) === subnetId)
            .flatMap((e) => topo.enisOf(e.id))
            .filter((eni) => eni.privateIp !== null);
          const sample = parseIpv4(topo.suggestPrivateIp(subnetId) ?? "");
          const blocked = sources.length
            ? sources.filter((eni) => !allows("inbound", eni.privateIp!, eni.securityGroupIds ?? [])).map((eni) => eni.ownerId)
            : sample !== null && !allows("inbound", sample, [])
              ? [subnetId]
              : [];
          if (!blocked.length) continue;
          drafts.push({
            key: `${u.ec2.id}:${subnetId}`,
            resourceIds: [u.ec2.id, ...sgs.map((sg) => sg.id), subnetId],
            cause: `${displayName(u.ec2)}의 보안 그룹이 서브넷 ${topo.name(subnetId)}에서 오는 HTTP(80)·HTTPS(443)를 인바운드로 허용하지 않습니다.`,
            condition: "NAT 인스턴스 보안 그룹 인바운드에 프라이빗 서브넷 허용 규칙 없음",
            fix: [`${sgs[0] ? displayName(sgs[0]) : "보안 그룹"}에 인바운드 HTTP·HTTPS, 소스 ${topo.getOfType(subnetId, "subnet")?.config.cidr ?? "프라이빗 서브넷 CIDR"} 규칙을 추가하세요.`],
            impact: "허용하면 이 서브넷의 서버가 NAT 인스턴스를 거쳐 패키지 설치·외부 API 호출을 할 수 있습니다.",
          });
        }
        const internet = parseIpv4("203.0.113.10")!;
        if (u.subnetIds.length && !allows("outbound", internet, [])) {
          drafts.push({
            key: `${u.ec2.id}:outbound`,
            resourceIds: [u.ec2.id, ...sgs.map((sg) => sg.id)],
            cause: `${displayName(u.ec2)}의 보안 그룹이 인터넷으로 나가는 HTTP(80)·HTTPS(443)를 허용하지 않습니다.`,
            condition: "NAT 인스턴스 보안 그룹 아웃바운드에 80·443 허용 규칙 없음",
            fix: ["아웃바운드에 HTTP·HTTPS, 대상 0.0.0.0/0 규칙을 추가하세요."],
            impact: "허용하면 NAT 인스턴스가 주소를 바꾼 트래픽을 인터넷으로 내보낼 수 있습니다.",
          });
        }
        return drafts;
      }),
  },
  {
    id: "EC2-012",
    category: "compute",
    severity: "info",
    title: "NAT 인스턴스는 직접 관리하는 단일 장애 지점",
    concept:
      "NAT 인스턴스는 인스턴스 요금만 들어 실습·소규모 환경에서 비용을 줄일 수 있지만, 인스턴스가 멈추면 외부 통신이 끊기고 패치·대역폭·장애 복구를 직접 챙겨야 합니다. AWS는 가용성이 높고 관리가 필요 없는 NAT 게이트웨이를 권장합니다.",
    check: ({ topo }) =>
      natInstanceUsages(topo)
        .filter((u) => u.ec2.config.state === "running" && u.subnetIds.length > 0)
        .map((u) => {
          const azs = [...new Set(u.subnetIds.map((id) => topo.getOfType(id, "subnet")?.config.availabilityZone).filter((x): x is string => !!x))];
          return {
            key: u.ec2.id,
            resourceIds: [u.ec2.id],
            cause: `프라이빗 서브넷 ${u.subnetIds.length}개(${u.subnetIds.map((id) => topo.name(id)).join(", ")}${azs.length ? ` · 가용 영역 ${azs.join(", ")}` : ""})가 NAT 인스턴스 ${displayName(u.ec2)} 하나에 의존합니다.`,
            condition: "NAT 인스턴스 1대가 외부 통신을 모두 처리",
            fix: ["실습·비용 절감 목적이면 그대로 두어도 됩니다.", "중요한 서비스라면 NAT 게이트웨이(AZ마다 하나)로 바꾸는 것을 고려하세요."],
            impact: "정보 항목입니다. 비용과 가용성의 균형을 이해하는 데 참고하세요.",
          };
        }),
  },

  // ------------------------------------------------------------ 로드 밸런싱
  {
    id: "ELB-001",
    category: "load-balancing",
    severity: "error",
    title: "리스너가 없는 ALB",
    concept: "ALB는 리스너(프로토콜:포트)를 통해서만 연결을 받습니다. 리스너가 없으면 어떤 요청도 처리하지 않습니다.",
    check: ({ topo }) =>
      topo
        .ofType("alb")
        .filter((a) => a.config.listeners.length === 0)
        .map((a) => ({
          resourceIds: [a.id],
          cause: `${displayName(a)}에 리스너가 없습니다.`,
          condition: "listeners = []",
          fix: ["ALB 설정에서 리스너(예: HTTP:80)를 추가하고 대상 그룹을 지정하세요."],
          impact: "리스너를 추가하면 '인터넷 → ALB' 요청이 리스너 단계를 통과합니다.",
        })),
  },
  {
    id: "ELB-002",
    category: "load-balancing",
    severity: "error",
    title: "대상 그룹이 없는 리스너",
    concept: "리스너의 기본 작업(default action)은 요청을 대상 그룹으로 전달(forward)합니다. 대상 그룹이 없으면 요청을 처리할 수 없습니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) =>
        topo
          .listenersOf(a.id)
          .filter((b) => !b.targetGroupId)
          .map((b) => ({
            key: b.listener.id,
            resourceIds: [a.id],
            cause: `${displayName(a)}의 리스너 ${b.listener.protocol}:${b.listener.port}에 전달할 대상 그룹이 없습니다.`,
            condition: "ALB → Target Group 전달 연결 없음",
            fix: ["캔버스에서 ALB와 대상 그룹을 연결하거나 ALB 설정의 리스너에서 대상 그룹을 선택하세요."],
            impact: "대상 그룹을 지정하면 요청이 등록된 EC2로 전달됩니다.",
          })),
      ),
  },
  {
    id: "ELB-003",
    category: "load-balancing",
    severity: "warning",
    title: "등록된 대상이 없는 대상 그룹",
    concept: "대상 그룹에 등록된 대상이 없으면 ALB는 503 Service Unavailable을 반환합니다.",
    check: ({ topo }) =>
      topo
        .ofType("target-group")
        .filter((tg) => topo.targetGroupTargets(tg.id).length === 0)
        .map((tg) => ({
          resourceIds: [tg.id],
          cause: `대상 그룹 ${displayName(tg)}에 등록된 EC2가 없습니다.`,
          condition: "Target Group → EC2 등록 없음",
          fix: ["캔버스에서 대상 그룹과 EC2를 연결해 대상을 등록하세요."],
          impact: "대상을 등록하면 ALB 요청이 그 대상으로 분산됩니다.",
        })),
  },
  {
    id: "ELB-004",
    category: "load-balancing",
    severity: "error",
    title: "모든 대상이 비정상이거나 사용할 수 없음",
    concept: "ALB는 정상(Healthy) 대상에만 요청을 보냅니다. 정상 대상이 없으면 요청이 실패하거나(503), 비정상 대상에 fail-open으로 전달됩니다.",
    check: ({ topo, health }) =>
      topo.ofType("target-group").flatMap((tg) => {
        const entries = health.get(tg.id) ?? [];
        const used = topo.targetGroupAlbs(tg.id).length > 0;
        if (!used || !entries.length || entries.some((h) => h.state === "healthy")) return [];
        return [
          {
            resourceIds: [tg.id, ...entries.map((h) => h.targetId)],
            cause: `대상 그룹 ${displayName(tg)}의 정상 대상이 없습니다: ${entries.map((h) => `${h.targetName} — ${h.reason}`).join(" / ")}`,
            condition: "Healthy 대상 0개",
            fix: [
              "대상 인스턴스를 Running 상태로 만드세요.",
              "대상 보안 그룹이 ALB 보안 그룹에서 오는 대상 포트 트래픽을 허용하는지 확인하세요.",
              "헬스 체크 포트/경로/성공 코드와 대상의 가상 서비스 설정을 확인하세요.",
            ],
            impact: "정상 대상이 생기면 '인터넷 → ALB' 요청이 해당 대상으로 전달되어 성공합니다.",
          },
        ];
      }),
  },
  {
    id: "ELB-005",
    category: "load-balancing",
    severity: "error",
    title: "ALB와 대상 간 통신을 차단하는 규칙",
    concept: "ALB 노드는 자신의 사설 IP와 보안 그룹으로 대상에 연결합니다. 대상 보안 그룹은 ALB 보안 그룹(또는 ALB 서브넷 CIDR)에서 오는 대상 포트를 허용해야 하고, NACL은 요청과 응답을 모두 허용해야 합니다.",
    check: ({ topo, health }) =>
      topo.ofType("target-group").flatMap((tg) =>
        (health.get(tg.id) ?? [])
          .filter((h) => h.state === "unhealthy" && h.reasonCode === "Target.Timeout" && h.probe?.failure)
          .map((h) => ({
            key: h.targetId,
            resourceIds: [tg.id, h.targetId, ...(h.probe?.failure?.resourceIds ?? [])],
            cause: h.probe!.failure!.reason,
            condition: `헬스 체크 ${tg.config.healthCheck.protocol}:${healthCheckPort(tg)} → ${h.targetName} 경로 차단`,
            fix: h.probe!.failure!.fixes.length ? h.probe!.failure!.fixes : ["대상 보안 그룹에 ALB 보안 그룹으로부터의 대상 포트 인바운드 규칙을 추가하세요."],
            impact: "규칙을 수정하면 헬스 체크가 성공해 대상이 Healthy가 되고, ALB 요청이 이 대상으로 전달됩니다.",
          })),
      ),
  },
  {
    id: "ELB-006",
    category: "load-balancing",
    severity: "error",
    title: "ALB 서브넷/가용 영역 부족",
    concept: "ALB는 서로 다른 가용 영역의 서브넷을 최소 2개 지정해야 합니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) => {
        const subnets = topo.albSubnets(a.id);
        const azs = new Set(subnets.map((s) => s.config.availabilityZone));
        if (azs.size >= 2) return [];
        return [
          {
            resourceIds: [a.id, ...subnets.map((s) => s.id)],
            cause: `${displayName(a)}이(가) ${subnets.length}개 서브넷(가용 영역 ${azs.size}개)에만 배치되어 있습니다.`,
            condition: "서로 다른 가용 영역의 서브넷 2개 미만",
            fix: ["서로 다른 가용 영역의 서브넷을 2개 이상 ALB와 연결하세요."],
            impact: "가용 영역을 2개 이상 지정하면 ALB 구성이 유효해지고 해당 영역의 대상이 사용 가능(In use) 상태가 됩니다.",
          },
        ];
      }),
  },
  {
    id: "ELB-007",
    category: "load-balancing",
    severity: "error",
    title: "ALB 서브넷 구성 오류",
    concept: "ALB는 가용 영역당 하나의 서브넷만 사용할 수 있고, 모든 서브넷은 같은 VPC에 있어야 합니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) => {
        const subnets = topo.albSubnets(a.id);
        const problems: string[] = [];
        const byAz = new Map<string, string[]>();
        for (const s of subnets) byAz.set(s.config.availabilityZone, [...(byAz.get(s.config.availabilityZone) ?? []), displayName(s)]);
        for (const [az, names] of byAz) if (names.length > 1) problems.push(`가용 영역 ${az}에 서브넷이 ${names.length}개(${names.join(", ")}) 지정되었습니다.`);
        const vpcs = topo.vpcsOf(a.id);
        if (vpcs.length > 1) problems.push(`서브넷이 여러 VPC(${vpcs.map((v) => topo.name(v)).join(", ")})에 걸쳐 있습니다.`);
        if (!problems.length) return [];
        return [
          {
            resourceIds: [a.id, ...subnets.map((s) => s.id)],
            cause: problems.join(" "),
            condition: "ALB 서브넷 구성",
            fix: ["가용 영역마다 하나씩, 같은 VPC의 서브넷만 연결하세요."],
            impact: "구성을 정리하면 ALB 노드 배치가 명확해집니다.",
          },
        ];
      }),
  },
  {
    id: "ELB-008",
    category: "load-balancing",
    severity: "error",
    title: "프라이빗 서브넷에 배치된 internet-facing ALB",
    concept: "internet-facing ALB의 노드는 퍼블릭 서브넷(IGW 경로가 있는 서브넷)에 있어야 인터넷 클라이언트의 요청을 받고 응답할 수 있습니다.",
    check: ({ topo }) =>
      topo
        .ofType("alb")
        .filter((a) => a.config.scheme === "internet-facing")
        .flatMap((a) => {
          const privateSubnets = topo.albSubnets(a.id).filter((s) => topo.classifySubnet(s.id).kind !== "public");
          if (!privateSubnets.length) return [];
          return [
            {
              resourceIds: [a.id, ...privateSubnets.map((s) => s.id)],
              cause: `internet-facing ALB ${displayName(a)}의 서브넷 ${privateSubnets.map((s) => displayName(s)).join(", ")}이(가) 퍼블릭 서브넷이 아닙니다.`,
              condition: "ALB 서브넷에 IGW 경로 없음",
              fix: ["ALB를 0.0.0.0/0 → IGW 경로가 있는 퍼블릭 서브넷에 배치하세요."],
              impact: "퍼블릭 서브넷에 배치하면 '인터넷 → ALB' 요청과 응답 경로가 성립합니다.",
            },
          ];
        }),
  },
  {
    id: "ELB-009",
    category: "load-balancing",
    severity: "warning",
    title: "ALB 보안 그룹에 리스너 포트 허용 규칙 누락",
    concept: "ALB 보안 그룹의 인바운드 규칙이 리스너 포트를 클라이언트(internet-facing이면 0.0.0.0/0)에게 허용해야 요청이 ALB에 도달합니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) => {
        const groups = topo.securityGroupsOf(a.id);
        if (!groups.length) return [];
        const clientIp = parseIpv4(DEFAULT_INTERNET_CLIENT_IP)!;
        return a.config.listeners.flatMap((l) => {
          const allowed =
            a.config.scheme === "internet-facing"
              ? evaluateSecurityGroups(groups, "inbound", { protocol: "tcp", port: l.port, peerIp: clientIp, peerSecurityGroupIds: [] }).allowed
              : groups.some((g) => g.config.inboundRules.some((r) => (r.protocol === "all" || r.protocol === "tcp") && (r.protocol === "all" || (l.port >= r.fromPort && l.port <= r.toPort))));
          if (allowed) return [];
          return [
            {
              key: l.id,
              resourceIds: [a.id, ...groups.map((g) => g.id)],
              cause: `${displayName(a)}의 보안 그룹(${groups.map((g) => displayName(g)).join(", ")})이 리스너 포트 TCP ${l.port}을(를) ${a.config.scheme === "internet-facing" ? "인터넷 클라이언트" : "어떤 출발지"}에게도 허용하지 않습니다.`,
              condition: `리스너 ${l.protocol}:${l.port} / 인바운드 규칙 없음`,
              fix: [`ALB 보안 그룹 인바운드에 TCP ${l.port} ← ${a.config.scheme === "internet-facing" ? "0.0.0.0/0" : "클라이언트 CIDR 또는 보안 그룹"} 규칙을 추가하세요.`],
              impact: "규칙을 추가하면 요청이 ALB 보안 그룹 단계를 통과합니다.",
            },
          ];
        });
      }),
  },
  {
    id: "ELB-010",
    category: "load-balancing",
    severity: "warning",
    title: "ALB에서 활성화되지 않은 가용 영역의 대상",
    concept: "ALB가 서브넷을 가지지 않은 가용 영역의 대상은 사용되지 않습니다(Unused).",
    check: ({ topo, health }) =>
      topo.ofType("target-group").flatMap((tg) =>
        (health.get(tg.id) ?? [])
          .filter((h) => h.state === "unused" && h.reason.includes("가용 영역"))
          .map((h) => ({
            key: h.targetId,
            resourceIds: [tg.id, h.targetId],
            cause: `${h.targetName}: ${h.reason}`,
            condition: `대상 가용 영역 ${h.availabilityZone}`,
            fix: [`ALB에 ${h.availabilityZone} 가용 영역의 (퍼블릭) 서브넷을 추가하거나 대상을 활성화된 가용 영역으로 옮기세요.`],
            impact: "가용 영역을 맞추면 이 대상이 헬스 체크를 받고 요청 분산에 포함됩니다.",
          })),
      ),
  },
  {
    id: "ELB-011",
    category: "load-balancing",
    severity: "error",
    title: "중복된 리스너 포트",
    concept: "하나의 로드 밸런서에서 같은 포트의 리스너는 하나만 만들 수 있습니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) => {
        const counts = new Map<number, number>();
        for (const l of a.config.listeners) counts.set(l.port, (counts.get(l.port) ?? 0) + 1);
        return [...counts.entries()]
          .filter(([, n]) => n > 1)
          .map(([port, n]) => ({
            key: String(port),
            resourceIds: [a.id],
            cause: `${displayName(a)}에 포트 ${port} 리스너가 ${n}개 있습니다.`,
            condition: "리스너 포트 중복",
            fix: ["중복된 리스너를 삭제하세요."],
            impact: "중복을 없애면 요청을 처리할 리스너가 하나로 결정됩니다. (현재는 첫 번째 리스너 사용)",
          }));
      }),
  },
  {
    id: "ELB-012",
    category: "load-balancing",
    severity: "error",
    title: "헬스 체크 설정 오류",
    concept: "헬스 체크 경로는 /로 시작하고, 임계값은 2~10, 간격은 5~300초, 제한 시간은 2~120초이며 간격보다 짧아야 합니다. 성공 코드는 200~499 범위입니다.",
    check: ({ topo }) =>
      topo.ofType("target-group").flatMap((tg) => {
        const problems = validateHealthCheck(tg.config.healthCheck);
        if (!problems.length) return [];
        return [
          {
            resourceIds: [tg.id],
            cause: problems.join(" "),
            condition: `대상 그룹 ${displayName(tg)} 헬스 체크 설정`,
            fix: ["대상 그룹 설정에서 헬스 체크 값을 허용 범위로 수정하세요."],
            impact: "유효한 설정이 되면 헬스 상태 계산이 AWS 규칙과 일치합니다.",
          },
        ];
      }),
  },
  {
    id: "ELB-013",
    category: "load-balancing",
    severity: "info",
    title: "리스너에 연결되지 않은 대상 그룹",
    concept: "대상 그룹은 ALB 리스너가 요청을 전달할 때만 사용되며, 그 전까지 대상은 Unused 상태입니다.",
    check: ({ topo }) =>
      topo
        .ofType("target-group")
        .filter((tg) => topo.targetGroupAlbs(tg.id).length === 0)
        .map((tg) => ({
          resourceIds: [tg.id],
          cause: `대상 그룹 ${displayName(tg)}이(가) 어떤 ALB 리스너에도 연결되어 있지 않습니다.`,
          condition: "ALB → Target Group 전달 연결 없음",
          fix: ["ALB와 대상 그룹을 연결하세요."],
          impact: "연결하면 대상에 헬스 체크가 수행되고 요청을 받을 수 있습니다.",
        })),
  },
  {
    id: "ELB-014",
    category: "load-balancing",
    severity: "info",
    title: "HTTPS 리스너 (인증서 미시뮬레이션)",
    concept: "실제 HTTPS 리스너에는 ACM 등의 TLS 인증서가 필요합니다. 이 시뮬레이터는 인증서와 암호화를 시뮬레이션하지 않고 포트 수준의 통신만 계산합니다.",
    check: ({ topo }) =>
      topo.ofType("alb").flatMap((a) =>
        a.config.listeners
          .filter((l) => l.protocol === "HTTPS")
          .map((l) => ({
            key: l.id,
            resourceIds: [a.id],
            cause: `${displayName(a)}의 HTTPS:${l.port} 리스너는 인증서 없이 포트 수준으로만 시뮬레이션됩니다.`,
            condition: "리스너 프로토콜 HTTPS",
            fix: ["실제 환경에서는 인증서를 연결해야 합니다."],
            impact: "시뮬레이션 결과에는 영향이 없습니다.",
          })),
      ),
  },
  {
    id: "ELB-015",
    category: "load-balancing",
    severity: "error",
    title: "헬스 체크 실패 (포트 또는 응답 코드)",
    concept: "네트워크가 열려 있어도 대상이 헬스 체크 포트에서 응답하지 않거나, 응답 코드가 성공 코드(matcher)와 다르면 대상은 Unhealthy가 됩니다.",
    check: ({ topo, health }) =>
      topo.ofType("target-group").flatMap((tg) =>
        (health.get(tg.id) ?? [])
          .filter((h) => h.state === "unhealthy" && h.reasonCode !== "Target.Timeout")
          .map((h) => ({
            key: h.targetId,
            resourceIds: [tg.id, h.targetId],
            cause: `${h.targetName}: ${h.reason}`,
            condition: `${h.reasonCode} (헬스 체크 ${tg.config.healthCheck.protocol}:${healthCheckPort(tg)}${tg.config.healthCheck.path}, 성공 코드 ${tg.config.healthCheck.matcher})`,
            fix: [
              "EC2의 가상 서비스 포트에 헬스 체크 포트를 추가하거나 대상 그룹 포트를 맞추세요.",
              "EC2의 가상 응답 코드 또는 대상 그룹의 성공 코드(matcher)를 맞추세요.",
            ],
            impact: "헬스 체크가 성공하면 대상이 Healthy가 되어 요청 분산에 포함됩니다.",
          })),
      ),
  },

  {
    id: "ELB-016",
    category: "load-balancing",
    severity: "info",
    title: "프로비저닝 중인 로드 밸런서",
    concept: "로드 밸런서는 생성 직후 Provisioning 상태이며, Active가 된 뒤부터 요청을 받습니다.",
    check: ({ topo }) =>
      topo
        .ofType("alb")
        .filter((a) => a.config.state !== "active")
        .map((a) => ({
          resourceIds: [a.id],
          cause: `${topo.name(a.id)}이(가) 아직 프로비저닝 중입니다.`,
          condition: `state = ${a.config.state}`,
          fix: ["잠시 기다리면 Active 상태가 됩니다."],
          impact: "Active가 되면 DNS 이름이 해석되고 리스너가 요청을 받습니다.",
        })),
  },

  // ------------------------------------------------------------ 데이터베이스
  {
    id: "RDS-001",
    category: "database",
    severity: "error",
    title: "DB 서브넷 그룹이 없는 RDS",
    concept: "RDS 인스턴스는 DB 서브넷 그룹의 서브넷에 배치됩니다.",
    check: ({ topo }) =>
      topo
        .ofType("rds")
        .filter((r) => !topo.dbSubnetGroupOf(r.id))
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${displayName(r)}에 DB 서브넷 그룹이 연결되어 있지 않습니다.`,
          condition: "RDS → DB Subnet Group 연결 없음",
          fix: ["DB 서브넷 그룹을 만들고 서로 다른 가용 영역의 서브넷 2개 이상을 추가한 뒤 RDS와 연결하세요."],
          impact: "배치되면 RDS 엔드포인트가 사설 IP로 해석되어 연결 시뮬레이션이 가능해집니다.",
        })),
  },
  {
    id: "RDS-002",
    category: "database",
    severity: "error",
    title: "DB 서브넷 그룹 구성 부족",
    concept: "DB 서브넷 그룹은 최소 2개의 서로 다른 가용 영역에 있는 서브넷을 포함해야 합니다.",
    check: ({ topo }) =>
      topo.ofType("db-subnet-group").flatMap((g) => {
        const subnets = topo.dbSubnetGroupSubnets(g.id);
        const azs = new Set(subnets.map((s) => s.config.availabilityZone));
        if (subnets.length >= 2 && azs.size >= 2) return [];
        return [
          {
            resourceIds: [g.id, ...subnets.map((s) => s.id)],
            cause: `DB 서브넷 그룹 ${displayName(g)}에 서브넷 ${subnets.length}개(가용 영역 ${azs.size}개)만 있습니다.`,
            condition: "서브넷 2개 미만 또는 가용 영역 2개 미만",
            fix: ["서로 다른 가용 영역의 서브넷을 2개 이상 추가하세요."],
            impact: "요구 사항을 충족하면 Multi-AZ 구성과 장애 조치를 준비할 수 있습니다.",
          },
        ];
      }),
  },
  {
    id: "RDS-003",
    category: "database",
    severity: "error",
    title: "여러 VPC에 걸친 DB 서브넷 그룹",
    concept: "DB 서브넷 그룹의 서브넷은 모두 같은 VPC에 있어야 합니다.",
    check: ({ topo }) =>
      topo.ofType("db-subnet-group").flatMap((g) => {
        const vpcs = topo.vpcsOf(g.id);
        if (vpcs.length <= 1) return [];
        return [
          {
            resourceIds: [g.id, ...topo.dbSubnetGroupSubnets(g.id).map((s) => s.id)],
            cause: `DB 서브넷 그룹 ${displayName(g)}의 서브넷이 여러 VPC(${vpcs.map((v) => topo.name(v)).join(", ")})에 있습니다.`,
            condition: "서브넷 VPC 불일치",
            fix: ["같은 VPC의 서브넷만 남기세요."],
            impact: "같은 VPC로 정리하면 RDS의 네트워크 위치가 명확해집니다.",
          },
        ];
      }),
  },
  {
    id: "RDS-004",
    category: "database",
    severity: "warning",
    title: "애플리케이션에서 DB 포트로 연결할 수 없는 구성",
    concept: "애플리케이션 서버(EC2)에서 RDS 포트로 연결하려면 경로, NACL, EC2 아웃바운드 규칙, RDS 보안 그룹 인바운드 규칙이 모두 허용해야 합니다.",
    check: ({ topo, simulate }) =>
      topo.ofType("rds").flatMap((rds) => {
        const vpcId = topo.vpcOf(rds.id);
        if (!vpcId || !topo.dbSubnetGroupOf(rds.id)) return [];
        const apps = topo.ofType("ec2").filter((e) => topo.vpcOf(e.id) === vpcId && e.config.state === "running");
        if (!apps.length) {
          return [
            {
              severity: "info",
              resourceIds: [rds.id],
              cause: `${displayName(rds)}과(와) 같은 VPC에 Running 상태의 애플리케이션 서버(EC2)가 없습니다.`,
              condition: "같은 VPC의 EC2 없음",
              fix: ["애플리케이션 서버를 추가하고 RDS 보안 그룹에서 그 서버의 보안 그룹을 허용하세요."],
              impact: "EC2를 추가하면 애플리케이션 → DB 연결을 시뮬레이션할 수 있습니다.",
            },
          ];
        }
        const results = apps.map((app) => ({
          app,
          result: simulate({
            source: { kind: "resource", resourceId: app.id },
            destination: { kind: "resource", resourceId: rds.id },
            protocol: "tcp",
            port: rds.config.port,
          }),
        }));
        if (results.some((r) => r.result.outcome === "success")) return [];
        const first = results[0].result;
        return [
          {
            resourceIds: [rds.id, ...apps.map((a) => a.id), ...(first.failure?.resourceIds ?? [])],
            cause: `어떤 EC2도 ${displayName(rds)}의 TCP ${rds.config.port}에 연결할 수 없습니다. 예: ${displayName(results[0].app)} → ${first.failure?.reason ?? first.summary}`,
            condition: `EC2 ${apps.map((a) => displayName(a)).join(", ")} → ${displayName(rds)}:${rds.config.port}`,
            fix: first.failure?.fixes.length
              ? first.failure.fixes
              : [`RDS 보안 그룹 인바운드에 TCP ${rds.config.port} ← 애플리케이션 보안 그룹 규칙을 추가하세요.`],
            impact: "수정하면 시뮬레이션 콘솔의 'EC2 → RDS' 연결 검사가 성공합니다.",
          },
        ];
      }),
  },
  {
    id: "RDS-005",
    category: "database",
    severity: "warning",
    title: "Publicly Accessible이지만 인터넷에서 접근할 수 없는 구성",
    concept: "Publicly Accessible은 엔드포인트가 퍼블릭 IP로 해석되게 할 뿐입니다. 실제로 인터넷에서 접근하려면 DB가 퍼블릭 서브넷(IGW 경로)에 있고 보안 그룹이 허용해야 합니다.",
    check: ({ topo }) =>
      topo
        .ofType("rds")
        .filter((r) => r.config.publiclyAccessible)
        .flatMap((r) => {
          const primary = topo.rdsPlacement(r.id).primary;
          if (!primary) return [];
          const cls = topo.classifySubnet(primary.id);
          if (cls.kind === "public") return [];
          return [
            {
              resourceIds: [r.id, primary.id],
              cause: `${displayName(r)}은(는) Publicly Accessible이지만 배치된 서브넷 ${displayName(primary)}이(가) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
              condition: "publiclyAccessible = true + 프라이빗 서브넷",
              fix: [
                "외부 접근이 필요 없다면 Publicly Accessible을 끄세요 (권장).",
                "필요하다면 DB 서브넷 그룹에 퍼블릭 서브넷을 사용해야 합니다.",
              ],
              impact: "설정과 네트워크 경로가 일치하게 되어 '인터넷 → RDS' 결과를 예측할 수 있습니다.",
            },
          ];
        }),
  },
  {
    id: "RDS-006",
    category: "database",
    severity: "warning",
    title: "필요 이상으로 넓은 DB 접근 허용",
    concept: "DB 보안 그룹은 애플리케이션 서버의 보안 그룹만 허용하는 것이 좋습니다. 0.0.0.0/0 허용은 DB가 비공개 서브넷에 있어도 불필요한 노출 위험을 남깁니다.",
    check: ({ topo }) =>
      topo.ofType("rds").flatMap((r) => {
        const groups = topo.securityGroupsOf(r.id);
        const open = groups.flatMap((g) =>
          g.config.inboundRules
            .filter((rule) => ruleAllowsFromAnywhere(rule) && (rule.protocol === "all" || (rule.protocol === "tcp" && r.config.port >= rule.fromPort && r.config.port <= rule.toPort)))
            .map((rule) => ({ g, rule })),
        );
        if (!open.length) return [];
        return [
          {
            resourceIds: [r.id, ...open.map((o) => o.g.id)],
            cause: `${displayName(r)}의 보안 그룹이 DB 포트 TCP ${r.config.port}을(를) 0.0.0.0/0에 허용합니다 (${open.map((o) => `${displayName(o.g)}: ${sgRuleText(topo, o.rule)}`).join(", ")}).`,
            condition: `인바운드 TCP ${r.config.port} ← 0.0.0.0/0`,
            fix: ["출발지를 애플리케이션 서버의 보안 그룹으로 제한하세요."],
            impact: "애플리케이션 → DB 연결은 유지하면서 외부 노출 위험을 줄입니다.",
          },
        ];
      }),
  },
  {
    id: "RDS-007",
    category: "database",
    severity: "warning",
    title: "인터넷에 노출된 데이터베이스",
    concept: "Publicly Accessible + 퍼블릭 서브넷 + 0.0.0.0/0 허용 규칙이 모두 겹치면 DB가 인터넷에서 직접 접근 가능한 상태가 됩니다.",
    check: ({ topo, simulate }) =>
      topo
        .ofType("rds")
        .filter((r) => r.config.publiclyAccessible)
        .flatMap((r) => {
          const result = simulate({
            source: { kind: "internet", ip: DEFAULT_INTERNET_CLIENT_IP },
            destination: { kind: "resource", resourceId: r.id },
            protocol: "tcp",
            port: r.config.port,
          });
          if (result.outcome !== "success") return [];
          return [
            {
              resourceIds: [r.id],
              cause: `시뮬레이션 결과 인터넷 클라이언트(${DEFAULT_INTERNET_CLIENT_IP})가 ${displayName(r)}의 TCP ${r.config.port}에 연결할 수 있습니다.`,
              condition: "Publicly Accessible + 퍼블릭 서브넷 + 보안 그룹 허용",
              fix: ["Publicly Accessible을 끄고, DB 서브넷 그룹을 프라이빗 서브넷으로 구성하세요.", "보안 그룹 출발지를 애플리케이션 보안 그룹으로 제한하세요."],
              impact: "수정하면 '인터넷 → RDS' 시뮬레이션이 실패(차단)하게 됩니다.",
            },
          ];
        }),
  },
  {
    id: "RDS-008",
    category: "database",
    severity: "error",
    title: "Publicly Accessible에 필요한 VPC DNS 설정 누락",
    concept: "DB 인스턴스를 Publicly Accessible로 만들려면 VPC의 DNS 확인(enableDnsSupport)과 DNS 호스트 이름(enableDnsHostnames)이 모두 켜져 있어야 합니다.",
    check: ({ topo }) =>
      topo
        .ofType("rds")
        .filter((r) => r.config.publiclyAccessible)
        .flatMap((r) => {
          const vpc = topo.getOfType(topo.vpcOf(r.id), "vpc");
          if (!vpc || (vpc.config.enableDnsSupport && vpc.config.enableDnsHostnames)) return [];
          return [
            {
              resourceIds: [r.id, vpc.id],
              cause: `VPC ${displayName(vpc)}의 DNS 확인=${vpc.config.enableDnsSupport ? "켬" : "끔"}, DNS 호스트 이름=${vpc.config.enableDnsHostnames ? "켬" : "끔"}입니다.`,
              condition: "publiclyAccessible = true + VPC DNS 설정 꺼짐",
              fix: ["VPC 설정에서 DNS 확인과 DNS 호스트 이름을 모두 켜거나 Publicly Accessible을 끄세요."],
              impact: "설정을 맞추면 AWS에서 허용되는 구성이 됩니다.",
            },
          ];
        }),
  },
  {
    id: "RDS-009",
    category: "database",
    severity: "info",
    title: "Multi-AZ가 꺼진 RDS",
    concept: "Multi-AZ 배포는 다른 가용 영역에 대기(standby) 인스턴스를 두어 장애 시 자동으로 전환합니다.",
    check: ({ topo }) =>
      topo
        .ofType("rds")
        .filter((r) => !r.config.multiAz)
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${displayName(r)}은(는) 단일 가용 영역에 배치됩니다.`,
          condition: "multiAz = false",
          fix: ["운영 환경이라면 Multi-AZ를 켜는 것을 고려하세요."],
          impact: "연결 시뮬레이션 결과에는 영향이 없고, 가상 비용 추정치가 증가합니다.",
        })),
  },
  {
    id: "RDS-010",
    category: "database",
    severity: "info",
    title: "Available 상태가 아닌 RDS",
    concept: "중지된 DB 인스턴스는 연결을 받지 않습니다.",
    check: ({ topo }) =>
      topo
        .ofType("rds")
        .filter((r) => r.config.state !== "available")
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${displayName(r)}이(가) ${r.config.state} 상태입니다.`,
          condition: `state = ${r.config.state}`,
          fix: ["RDS 설정에서 상태를 Available로 변경하세요."],
          impact: "Available로 바꾸면 DB 포트 연결 검사가 성공할 수 있습니다.",
        })),
  },
  {
    id: "RDS-011",
    category: "database",
    severity: "info",
    title: "퍼블릭 서브넷이 포함된 DB 서브넷 그룹",
    concept: "데이터베이스는 보통 인터넷 경로가 없는 프라이빗 서브넷에 둡니다.",
    check: ({ topo }) =>
      topo.ofType("db-subnet-group").flatMap((g) => {
        const publicSubnets = topo.dbSubnetGroupSubnets(g.id).filter((s) => topo.classifySubnet(s.id).kind === "public");
        if (!publicSubnets.length) return [];
        return [
          {
            resourceIds: [g.id, ...publicSubnets.map((s) => s.id)],
            cause: `DB 서브넷 그룹 ${displayName(g)}에 퍼블릭 서브넷(${publicSubnets.map((s) => displayName(s)).join(", ")})이 포함되어 있습니다.`,
            condition: "DB 서브넷 그룹 ⊃ 퍼블릭 서브넷",
            fix: ["DB 전용 프라이빗 서브넷을 만들어 그룹을 구성하세요."],
            impact: "DB가 프라이빗 서브넷에 있으면 Publicly Accessible을 잘못 켜도 인터넷에서 접근할 수 없습니다.",
          },
        ];
      }),
  },

  // ------------------------------------------------------------ Lambda
  {
    id: "LAM-001",
    category: "compute",
    severity: "error",
    title: "Lambda가 맡을 수 없는 실행 역할",
    concept: "Lambda 함수는 실행 역할(IAM 역할)을 맡아 그 임시 자격 증명으로 실행됩니다. 역할의 신뢰 정책이 lambda.amazonaws.com을 허용해야 Lambda가 역할을 맡을 수 있습니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (lambdaRole(topo.project, fn)) return [];
        const role = topo.project.services.iam.roles.find((r) => r.id === fn.config.roleId);
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: !fn.config.roleId
              ? `${displayName(fn)}에 실행 역할이 없어 함수를 실행할 수 없습니다.`
              : !role
                ? `${displayName(fn)}의 실행 역할이 삭제되어 함수를 실행할 수 없습니다.`
                : `${displayName(fn)}의 실행 역할 ${role.name}은(는) ${role.trustedEntity}를 신뢰해 Lambda가 맡을 수 없습니다.`,
            condition: `${displayName(fn)}.roleId = ${role ? role.name : "없음"}`,
            fix: LAMBDA_FIX_ROLE,
            impact: "lambda.amazonaws.com을 신뢰하는 역할을 연결하면 호출이 실행 단계로 넘어갑니다. (실제 AWS에서는 이런 함수를 만들 수 없습니다)",
          },
        ];
      }),
  },
  {
    id: "LAM-002",
    category: "compute",
    severity: "error",
    title: "VPC에 연결했지만 보안 그룹이 없는 Lambda",
    concept: "VPC에 연결한 Lambda는 서브넷에 네트워크 인터페이스를 만들고, 그 인터페이스에 보안 그룹을 적용합니다. 서브넷을 지정하면 보안 그룹도 하나 이상 지정해야 합니다.",
    check: ({ topo }) =>
      topo
        .ofType("lambda")
        .filter((fn) => topo.lambdaSubnets(fn.id).length > 0 && topo.securityGroupsOf(fn.id).length === 0)
        .map((fn) => ({
          key: fn.id,
          resourceIds: [fn.id],
          cause: `${displayName(fn)}은(는) 서브넷 ${topo.lambdaSubnets(fn.id).length}개에 연결되어 있지만 보안 그룹이 없습니다.`,
          condition: `${displayName(fn)}: 서브넷 있음, 보안 그룹 0개`,
          fix: ["심화 모드: Lambda → 함수 → 구성 → VPC → 편집에서 보안 그룹을 고르세요.", "쉬운 모드: 함수 설정의 'VPC 연결'에서 같은 VPC의 보안 그룹을 체크하세요."],
          impact: "보안 그룹을 연결하면 함수가 VPC 안에서 실행될 수 있습니다.",
        })),
  },
  {
    id: "LAM-003",
    category: "compute",
    severity: "error",
    title: "VPC 연결 권한이 없는 실행 역할",
    concept: "VPC에 연결한 Lambda는 실행 역할의 권한으로 서브넷에 네트워크 인터페이스를 만듭니다. 역할에 ec2:CreateNetworkInterface 같은 권한(AWSLambdaVPCAccessExecutionRole)이 있어야 합니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        const role = lambdaRole(topo.project, fn);
        if (!role || !topo.lambdaSubnets(fn.id).length || roleAllows(topo.project, role, "ec2:CreateNetworkInterface")) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}은(는) VPC에 연결되어 있지만 실행 역할 ${role.name}에 ec2:CreateNetworkInterface 권한이 없습니다.`,
            condition: `${role.name}: ec2:CreateNetworkInterface 허용 안 함`,
            fix: ["실행 역할에 AWS 관리형 정책 AWSLambdaVPCAccessExecutionRole을 연결하세요 (심화 모드: IAM → 역할 → 권한 추가).", "VPC 안의 리소스가 필요 없다면 함수의 VPC 연결을 해제하세요."],
            impact: "권한을 주면 함수가 서브넷에 네트워크 인터페이스를 만들어 실행됩니다. (실제 AWS에서는 이 상태로 함수를 만들거나 VPC를 바꿀 수 없습니다)",
          },
        ];
      }),
  },
  {
    id: "LAM-004",
    category: "compute",
    severity: "warning",
    title: "인터넷이 필요한데 NAT 경로가 없는 VPC Lambda",
    concept:
      "VPC에 연결한 Lambda는 퍼블릭 서브넷에 두어도 퍼블릭 IP를 받지 않습니다. 인터넷이나 S3 같은 AWS 퍼블릭 엔드포인트에 닿으려면 NAT 게이트웨이(또는 NAT 인스턴스) 경로가 있는 프라이빗 서브넷이 필요합니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        const need = INTERNET_TEMPLATES[fn.config.codeTemplate];
        if (!need) return [];
        const subnets = topo.lambdaSubnets(fn.id);
        if (!subnets.length) return [];
        const path = internetPath(topo, fn);
        if (path.ok && !path.partial) return [];
        return [
          {
            key: fn.id,
            severity: path.ok ? ("info" as const) : undefined,
            title: path.ok ? "일부 서브넷에만 NAT 경로가 있는 VPC Lambda" : undefined,
            resourceIds: [fn.id, ...subnets.map((s) => s.id)],
            cause: `${displayName(fn)}의 코드(${need})는 인터넷이나 AWS 서비스의 퍼블릭 엔드포인트가 필요합니다. ${path.detail}`,
            condition: `${displayName(fn)}: VPC 연결, 외부 접근 필요`,
            fix: ["NAT 게이트웨이 경로(0.0.0.0/0 → NAT)가 있는 프라이빗 서브넷에 함수를 연결하세요.", "VPC 안의 리소스가 필요 없다면 VPC 연결을 해제하세요 (VPC 밖 Lambda는 인터넷에 닿습니다)."],
            impact: "NAT 경로가 있으면 호출이 시간 초과 없이 외부에 닿습니다.",
          },
        ];
      }),
  },
  {
    id: "LAM-005",
    category: "compute",
    severity: "warning",
    title: "RDS에 닿지 않는 Lambda",
    concept: "RDS는 VPC 안에만 있습니다. Lambda가 RDS에 접속하려면 RDS와 같은 VPC의 서브넷에 연결해야 하고, 보안 그룹이 DB 포트를 허용해야 합니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "rds-query") return [];
        const rds = topo.getOfType(fn.config.templateTarget, "rds");
        const subnets = topo.lambdaSubnets(fn.id);
        if (rds && subnets.some((s) => topo.vpcOfSubnet(s.id) === topo.vpcOf(rds.id))) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id, rds?.id],
            cause: !rds
              ? `${displayName(fn)}은(는) RDS 조회 코드지만 접속할 DB 인스턴스가 없습니다.`
              : subnets.length
                ? `${displayName(fn)}은(는) ${displayName(rds)}과(와) 다른 VPC에 연결되어 있습니다.`
                : `${displayName(fn)}은(는) VPC에 연결되어 있지 않아 VPC 안의 ${displayName(rds)}에 닿지 않습니다.`,
            condition: `${displayName(fn)}: 코드 = RDS 조회`,
            fix: ["함수를 RDS와 같은 VPC의 프라이빗 서브넷에 연결하고 보안 그룹을 지정하세요.", "RDS 보안 그룹의 인바운드에 함수 보안 그룹을 소스로 DB 포트를 허용하세요."],
            impact: "같은 VPC에 연결하면 함수가 DB 포트까지 닿습니다 (SQL은 실행하지 않음).",
          },
        ];
      }),
  },
  {
    id: "LAM-006",
    category: "compute",
    severity: "warning",
    title: "제한 시간보다 긴 가상 실행 시간",
    concept: "Lambda는 제한 시간(기본 3초, 최대 900초)을 넘긴 실행을 강제로 끝내고 오류(Task timed out)로 처리합니다. 끝날 때까지 쓴 시간은 모두 과금됩니다.",
    check: ({ topo }) =>
      topo
        .ofType("lambda")
        .filter((fn) => fn.config.virtualDurationMs > fn.config.timeoutSeconds * 1000)
        .map((fn) => ({
          key: fn.id,
          resourceIds: [fn.id],
          cause: `${displayName(fn)}의 가상 실행 시간 ${fn.config.virtualDurationMs}ms가 제한 시간 ${fn.config.timeoutSeconds}초보다 깁니다.`,
          condition: `virtualDurationMs ${fn.config.virtualDurationMs} > timeout ${fn.config.timeoutSeconds * 1000}`,
          fix: ["제한 시간을 실행 시간보다 넉넉하게 늘리거나, 코드가 빨리 끝나게 하세요 (가상 실행 시간 줄이기)."],
          impact: "제한 시간 안에 끝나면 호출이 시간 초과 없이 성공합니다.",
        })),
  },
  {
    id: "LAM-007",
    category: "compute",
    severity: "info",
    title: "로그 권한이 없는 실행 역할",
    concept: "Lambda는 실행 로그를 CloudWatch Logs에 씁니다. 실행 역할에 logs:CreateLogStream·logs:PutLogEvents 권한(AWSLambdaBasicExecutionRole)이 없으면 함수는 실행되지만 로그가 남지 않아 문제를 찾기 어렵습니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        const role = lambdaRole(topo.project, fn);
        if (!role || (roleAllows(topo.project, role, "logs:CreateLogStream") && roleAllows(topo.project, role, "logs:PutLogEvents"))) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}의 실행 역할 ${role.name}에 CloudWatch Logs 권한이 없습니다.`,
            condition: `${role.name}: logs:PutLogEvents 허용 안 함`,
            fix: ["실행 역할에 AWS 관리형 정책 AWSLambdaBasicExecutionRole을 연결하세요."],
            impact: "권한을 주면 실행 로그(START·END·REPORT)가 남습니다.",
          },
        ];
      }),
  },
  {
    id: "LAM-008",
    category: "compute",
    severity: "info",
    title: "한 가용 영역의 서브넷에만 연결한 Lambda",
    concept: "VPC에 연결한 Lambda는 고른 서브넷 중 하나에서 실행됩니다. 서브넷이 한 가용 영역에만 있으면 그 가용 영역에 장애가 났을 때 함수가 실행되지 못합니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        const subnets = topo.lambdaSubnets(fn.id);
        if (!subnets.length || new Set(subnets.map((s) => s.config.availabilityZone)).size >= 2) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}은(는) 가용 영역 ${subnets[0].config.availabilityZone}의 서브넷에만 연결되어 있습니다.`,
            condition: "VPC 서브넷의 가용 영역 1개",
            fix: ["다른 가용 영역의 서브넷도 함께 고르세요 (AWS 권장: 2개 이상)."],
            impact: "여러 가용 영역에 연결하면 한 곳에 장애가 나도 함수가 실행됩니다.",
          },
        ];
      }),
  },
  {
    id: "LAM-009",
    category: "compute",
    severity: "warning",
    title: "예약 동시성이 0인 Lambda (모든 호출 제한)",
    concept: "예약 동시성은 함수가 동시에 실행될 수 있는 최대 개수입니다. 0으로 두면 모든 호출이 제한(throttle)되어 실행되지 않습니다. 함수를 잠시 멈출 때 쓰는 설정입니다.",
    check: ({ topo }) =>
      topo
        .ofType("lambda")
        .filter((fn) => fn.config.reservedConcurrency === 0)
        .map((fn) => ({
          key: fn.id,
          resourceIds: [fn.id],
          cause: `${displayName(fn)}의 예약 동시성이 0이라 모든 호출이 TooManyRequestsException으로 제한됩니다.`,
          condition: "reservedConcurrency = 0",
          fix: ["멈출 의도가 아니라면 예약 동시성을 해제하거나 1 이상으로 바꾸세요 (심화 모드: 구성 → 동시성)."],
          impact: "해제하면 일정·테스트 호출이 다시 실행됩니다.",
        })),
  },
  {
    id: "LAM-010",
    category: "compute",
    severity: "warning",
    title: "S3를 읽는 코드인데 실행 역할에 S3 권한이 없음",
    concept: "Lambda 코드가 AWS 서비스를 호출할 때는 실행 역할의 권한이 적용됩니다. 버킷의 객체 목록을 읽으려면 그 버킷에 대한 s3:ListBucket 허용이 필요합니다 (최소 권한: 필요한 버킷만).",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "s3-list") return [];
        const role = lambdaRole(topo.project, fn);
        const bucket = topo.project.services.s3.buckets.find((b) => b.name === fn.config.templateTarget.trim());
        if (!role || !bucket) return [];
        const access = evaluateS3Access(topo.project, { bucketId: bucket.id, key: null, action: "s3:ListBucket", caller: { kind: "role", roleId: role.id } });
        if (access.ok) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}의 실행 역할 ${role.name}은(는) 버킷 ${bucket.name}의 s3:ListBucket이 허용되지 않아 AccessDenied가 납니다.`,
            condition: `${role.name}: s3:ListBucket on ${bucket.name} 거부`,
            fix: [`실행 역할에 arn:aws:s3:::${bucket.name}에 대한 s3:ListBucket을 허용하는 정책을 연결하세요 (예: AmazonS3ReadOnlyAccess, 또는 이 버킷만 허용하는 고객 관리형 정책).`],
            impact: "권한을 주면 호출이 버킷의 객체 목록을 돌려줍니다.",
          },
        ];
      }),
  },

  // ------------------------------------------------------------ EventBridge
  {
    id: "EVB-001",
    category: "general",
    severity: "error",
    title: "Lambda를 호출할 수 없는 일정",
    concept: "EventBridge Scheduler 일정은 실행 역할을 맡아 대상을 호출합니다. 역할이 scheduler.amazonaws.com을 신뢰하고 대상 함수의 lambda:InvokeFunction을 허용해야 합니다.",
    check: ({ topo }) =>
      topo.project.services.eventbridge.schedules.flatMap((s) => {
        if (s.state !== "ENABLED" || !parseScheduleExpression(s.expression).ok) return [];
        const can = scheduleCanInvoke(topo.project, s, topo.getOfType(s.targetLambdaId, "lambda") ?? undefined);
        if (can.ok) return [];
        return [
          {
            key: s.id,
            resourceIds: [s.targetLambdaId],
            cause: `일정 ${s.name}: ${can.reason}`,
            condition: `일정 ${s.name} (${s.expression}) 활성`,
            fix: ["심화 모드: EventBridge → 일정 → 편집에서 '이 일정에 대한 새 역할 만들기'를 고르거나, 실행 역할에 대상 함수의 lambda:InvokeFunction을 허용하세요.", "대상 함수가 삭제되었다면 일정의 대상을 바꾸거나 일정을 삭제하세요."],
            impact: "고치면 실행 시각마다 함수가 호출되고 Invocations 지표가 늘어납니다.",
          },
        ];
      }),
  },
  {
    id: "EVB-002",
    category: "general",
    severity: "error",
    title: "Lambda를 호출할 수 없는 규칙 (리소스 기반 정책 없음)",
    concept: "EventBridge 규칙은 역할이 아니라 대상 함수의 리소스 기반 정책으로 호출 권한을 얻습니다. 함수 정책에 events.amazonaws.com과 이 규칙의 ARN을 허용하는 문이 있어야 합니다 (콘솔은 자동으로 추가).",
    check: ({ topo }) =>
      topo.project.services.eventbridge.rules.flatMap((rule) => {
        if (rule.state !== "ENABLED") return [];
        return rule.targetLambdaIds.flatMap((id) => {
          const can = ruleCanInvoke(rule, topo.getOfType(id, "lambda") ?? undefined);
          if (can.ok) return [];
          return [
            {
              key: `${rule.id}:${id}`,
              resourceIds: [id],
              cause: `규칙 ${rule.name}: ${can.reason}`,
              condition: `규칙 ${rule.name}의 대상 ${topo.name(id)}`,
              fix: ["심화 모드: Lambda → 함수 → 구성 → 권한 → 권한 추가에서 주체 events.amazonaws.com, 소스 ARN에 규칙 ARN을 넣으세요.", "또는 규칙 편집에서 'Lambda 호출 권한 자동 추가'를 켜고 대상을 다시 저장하세요."],
              impact: "고치면 패턴과 일치하는 이벤트가 올 때 함수가 호출됩니다.",
            },
          ];
        });
      }),
  },
  {
    id: "EVB-003",
    category: "general",
    severity: "warning",
    title: "표현식·패턴이 올바르지 않은 일정·규칙",
    concept: "일정 표현식(rate·cron·at)과 이벤트 패턴(JSON)은 AWS가 정한 형식을 따라야 합니다. 형식이 틀리면 일정이 실행되지 않고 규칙이 어떤 이벤트와도 일치하지 않습니다.",
    check: ({ topo }) => {
      const { schedules, rules } = topo.project.services.eventbridge;
      return [
        ...schedules.flatMap((s) => {
          const parsed = parseScheduleExpression(s.expression);
          return parsed.ok
            ? []
            : [
                {
                  key: s.id,
                  resourceIds: [s.targetLambdaId],
                  cause: `일정 ${s.name}의 표현식 ${s.expression}이(가) 올바르지 않습니다: ${parsed.error}`,
                  condition: `일정 ${s.name}`,
                  fix: ["일정 편집에서 '자주 쓰는 일정' 버튼으로 표현식을 다시 채우세요. 예: rate(5 minutes), cron(0 9 * * ? *)"],
                  impact: "고치면 다음 실행 시각이 계산되고 함수가 호출됩니다.",
                },
              ];
        }),
        ...rules.flatMap((r) => {
          const parsed = parseEventPattern(r.eventPattern);
          return parsed.ok
            ? []
            : [
                {
                  key: r.id,
                  resourceIds: r.targetLambdaIds,
                  cause: `규칙 ${r.name}의 이벤트 패턴이 올바르지 않습니다: ${parsed.error}`,
                  condition: `규칙 ${r.name}`,
                  fix: ["규칙 편집에서 예시 패턴을 고른 뒤 필요한 값만 바꾸세요. 값은 항상 배열로 씁니다."],
                  impact: "고치면 테스트 이벤트로 일치 여부를 확인할 수 있습니다.",
                },
              ];
        }),
      ];
    },
  },
  {
    id: "EVB-004",
    category: "general",
    severity: "info",
    title: "이미 지난 일회성 일정",
    concept: "at() 일정은 지정한 시각에 한 번만 실행됩니다. 그 시각이 지나면 다시 실행되지 않으므로 지워도 됩니다 (실제 AWS는 완료 후 자동 삭제를 고를 수 있습니다).",
    check: ({ topo }) =>
      topo.project.services.eventbridge.schedules.flatMap((s) => {
        const parsed = parseScheduleExpression(s.expression);
        if (s.state !== "ENABLED" || !parsed.ok || parsed.value.kind !== "at") return [];
        if (nextRunTimes(parsed.value, s.timezone, Date.parse(s.createdAt), Date.now(), 1).length) return [];
        return [
          {
            key: s.id,
            resourceIds: [s.targetLambdaId],
            cause: `일정 ${s.name}의 시각(${s.expression}, ${s.timezone})이 이미 지나 더 이상 실행되지 않습니다.`,
            condition: `일정 ${s.name}: 다음 실행 없음`,
            fix: ["필요 없다면 일정을 삭제하고, 다시 실행하려면 시각을 바꾸세요."],
            impact: "정리하면 일정 목록에서 실제로 동작하는 일정만 보입니다.",
          },
        ];
      }),
  },
  {
    id: "EVB-005",
    category: "general",
    severity: "info",
    title: "대상이 없는 규칙",
    concept: "규칙은 이벤트를 골라 대상에 보내는 역할만 합니다. 대상이 없으면 일치한 이벤트가 어디에도 전달되지 않습니다.",
    check: ({ topo }) =>
      topo.project.services.eventbridge.rules
        .filter((r) => r.state === "ENABLED" && r.targetLambdaIds.length === 0)
        .map((r) => ({
          key: r.id,
          resourceIds: [],
          cause: `규칙 ${r.name}에 대상이 없습니다.`,
          condition: `규칙 ${r.name}: 대상 0개`,
          fix: ["규칙 편집에서 대상 Lambda 함수를 고르세요."],
          impact: "대상을 추가하면 일치한 이벤트가 함수로 전달됩니다.",
        })),
  },

  // ------------------------------------------------------------ Secrets Manager
  {
    id: "SMR-001",
    category: "security",
    severity: "error",
    title: "없거나 삭제가 예약된 보안 암호를 읽는 Lambda",
    concept:
      "보안 암호는 이름이나 ARN으로 읽습니다. 보안 암호가 없으면 ResourceNotFoundException이 나고, 삭제가 예약된 보안 암호는 복구 기간 동안 값을 읽을 수 없어 InvalidRequestException이 납니다.",
    check: ({ topo }) => {
      const now = Date.now();
      return topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "secret-get") return [];
        const name = fn.config.templateTarget.trim();
        const found = findSecretByName(topo.project, name);
        const secret = found && !isPurged(found, now) ? found : undefined;
        if (secret && !isPendingDeletion(secret)) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: !name
              ? `${displayName(fn)}은(는) 보안 암호를 읽는 코드인데 읽을 보안 암호를 정하지 않았습니다.`
              : secret
                ? `${displayName(fn)}이(가) 읽는 보안 암호 ${secret.name}은(는) 삭제가 예약되어 값을 읽을 수 없습니다.`
                : `${displayName(fn)}이(가) 읽는 보안 암호 ${name}이(가) 없습니다.`,
            condition: `${displayName(fn)}: 코드 = 보안 암호 읽기, 대상 = ${name || "(없음)"}`,
            fix: secret
              ? ["심화 모드: Secrets Manager → 보안 암호에서 '삭제 취소'로 복원하세요.", "더 쓰지 않는 보안 암호라면 함수의 코드 대상을 다른 보안 암호로 바꾸세요."]
              : ["심화 모드: Secrets Manager에서 보안 암호를 만들고, 함수의 코드 탭에서 대상으로 고르세요."],
            impact: "고치면 함수가 실행 중에 보안 암호의 값을 읽습니다.",
          },
        ];
      });
    },
  },
  {
    id: "SMR-002",
    category: "security",
    severity: "warning",
    title: "보안 암호를 읽는 코드인데 실행 역할에 권한이 없음",
    concept: "Lambda가 보안 암호를 읽을 때는 실행 역할의 권한이 적용됩니다. 그 보안 암호의 ARN에 대한 secretsmanager:GetSecretValue 허용이 필요합니다 (최소 권한: 필요한 보안 암호만).",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "secret-get") return [];
        const role = lambdaRole(topo.project, fn);
        const secret = findSecretByName(topo.project, fn.config.templateTarget);
        if (!role || !secret) return [];
        const arn = secretArn(secret);
        if (roleAllows(topo.project, role, "secretsmanager:GetSecretValue", arn)) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}의 실행 역할 ${role.name}에 보안 암호 ${secret.name}의 secretsmanager:GetSecretValue 권한이 없어 AccessDeniedException이 납니다.`,
            condition: `${role.name}: secretsmanager:GetSecretValue on ${secret.name} 거부`,
            fix: [`실행 역할에 Resource가 ${arn}인 secretsmanager:GetSecretValue 허용 정책을 연결하세요.`, "심화 모드: 보안 암호의 '접근 테스트' 탭에서 이 함수를 골라 결과를 확인할 수 있습니다."],
            impact: "권한을 주면 코드에 암호를 넣지 않고도 함수가 실행 중에 값을 읽습니다.",
          },
        ];
      }),
  },
  {
    id: "SMR-003",
    category: "security",
    severity: "warning",
    title: "자동 교체가 실패하는 보안 암호",
    concept:
      "교체는 Secrets Manager가 교체 함수(Lambda)를 호출해 새 암호를 만들고 적용하는 작업입니다. 함수의 리소스 기반 정책이 secretsmanager.amazonaws.com의 호출을 허용하고, 실행 역할이 그 보안 암호를 읽고 새 버전을 쓸 수 있어야 합니다.",
    check: ({ topo }) =>
      liveSecrets(topo.project, Date.now()).flatMap((s) => {
        if (!s.rotation.enabled || isPendingDeletion(s)) return [];
        const result = checkSecretRotation(topo.project, topo, s);
        const failed = result.checks.find((c) => c.status === "fail");
        if (result.ok || !failed) return [];
        return [
          {
            key: s.id,
            resourceIds: [s.rotation.lambdaId],
            cause: `보안 암호 ${s.name}의 자동 교체가 실패합니다 — ${failed.title}: ${failed.detail}`,
            condition: `보안 암호 ${s.name}: 자동 교체 켜짐 (${s.rotation.days}일)`,
            fix: [
              "심화 모드: Secrets Manager → 보안 암호 → 교체 탭의 '교체가 성공할 조건'에서 실패한 항목을 고치세요.",
              `교체 함수의 실행 역할에 ${ROTATION_ROLE_ACTIONS.join(", ")}을(를), 함수의 리소스 기반 정책에 secretsmanager.amazonaws.com 호출 허용을 주세요.`,
            ],
            impact: "고치면 '즉시 교체'가 성공하고 새 버전이 AWSCURRENT가 됩니다.",
          },
        ];
      }),
  },
  {
    id: "SMR-004",
    category: "security",
    severity: "info",
    title: "자동 교체가 꺼진 DB 자격 증명",
    concept: "DB 암호를 오래 그대로 쓰면 새어 나갔을 때 피해가 커집니다. Secrets Manager의 자동 교체를 켜면 정해진 주기마다 암호를 바꿉니다.",
    check: ({ topo }) =>
      liveSecrets(topo.project, Date.now())
        .filter((s) => s.kind === "rds" && !s.rotation.enabled && !isPendingDeletion(s))
        .map((s) => ({
          key: s.id,
          resourceIds: [s.rdsId],
          cause: `DB 자격 증명 보안 암호 ${s.name}의 자동 교체가 꺼져 있습니다.`,
          condition: `보안 암호 ${s.name}: 유형 RDS 자격 증명, 교체 꺼짐`,
          fix: ["심화 모드: 보안 암호 → 교체 탭 → 교체 편집에서 자동 교체를 켜고 교체 함수를 고르세요."],
          impact: "주기적으로 바꾸면 암호가 새어 나가도 쓸 수 있는 기간이 짧아집니다.",
        })),
  },

  // ------------------------------------------------------------ Systems Manager
  {
    id: "SSM-001",
    category: "general",
    severity: "error",
    title: "없는 파라미터를 읽는 Lambda",
    concept: "파라미터는 이름(계층 경로 포함, 대소문자 구분)으로 읽습니다. 이름이 정확히 같은 파라미터가 없으면 ParameterNotFound 오류가 납니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "ssm-get") return [];
        const name = fn.config.templateTarget.trim();
        if (findParameterByName(topo.project, name)) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: name ? `${displayName(fn)}이(가) 읽는 파라미터 ${name}이(가) 없습니다.` : `${displayName(fn)}은(는) 파라미터를 읽는 코드인데 읽을 파라미터를 정하지 않았습니다.`,
            condition: `${displayName(fn)}: 코드 = 파라미터 읽기, 대상 = ${name || "(없음)"}`,
            fix: ["심화 모드: Systems Manager → Parameter Store에서 파라미터를 만들고, 함수의 코드 탭에서 대상으로 고르세요."],
            impact: "고치면 함수가 실행 중에 설정 값을 읽습니다.",
          },
        ];
      }),
  },
  {
    id: "SSM-002",
    category: "security",
    severity: "warning",
    title: "파라미터를 읽는 코드인데 실행 역할에 권한이 없음",
    concept: "Lambda가 파라미터를 읽을 때는 실행 역할의 권한이 적용됩니다. 그 파라미터(또는 경로, 예: parameter/my-app/prod/*)에 대한 ssm:GetParameter 허용이 필요합니다.",
    check: ({ topo }) =>
      topo.ofType("lambda").flatMap((fn) => {
        if (fn.config.codeTemplate !== "ssm-get") return [];
        const role = lambdaRole(topo.project, fn);
        const param = findParameterByName(topo.project, fn.config.templateTarget);
        if (!role || !param) return [];
        const arn = parameterArn(param.name);
        if (roleAllows(topo.project, role, "ssm:GetParameter", arn)) return [];
        return [
          {
            key: fn.id,
            resourceIds: [fn.id],
            cause: `${displayName(fn)}의 실행 역할 ${role.name}에 파라미터 ${param.name}의 ssm:GetParameter 권한이 없어 AccessDeniedException이 납니다.`,
            condition: `${role.name}: ssm:GetParameter on ${param.name} 거부`,
            fix: [`실행 역할에 Resource가 ${arn}(또는 그 경로의 /*)인 ssm:GetParameter 허용 정책을 연결하세요.`],
            impact: "권한을 주면 함수가 설정 값을 읽습니다.",
          },
        ];
      }),
  },
  {
    id: "SSM-003",
    category: "compute",
    severity: "warning",
    title: "Systems Manager 역할은 있는데 관리형 노드가 되지 못한 인스턴스",
    concept:
      "SSM Agent는 밖으로 HTTPS(443) 연결을 맺어 Systems Manager에 자신을 등록합니다. 인스턴스 프로파일 권한이 있어도 엔드포인트로 나가는 경로(퍼블릭 IP와 IGW, 또는 NAT)가 없으면 관리형 노드가 되지 않아 Session Manager로 접속할 수 없습니다.",
    check: ({ topo }) =>
      topo
        .ofType("ec2")
        .filter((inst) => inst.config.state === "running")
        .flatMap((inst) => {
          const status = managedNodeStatus(topo.project, topo, inst);
          const profileOk = status.checks.find((c) => c.id === "profile")?.status === "pass";
          const failed = status.checks.find((c) => c.status === "fail");
          if (status.managed || !profileOk || !failed) return [];
          return [
            {
              key: inst.id,
              resourceIds: [inst.id],
              cause: `${displayName(inst)}에는 Systems Manager 권한이 있는 역할(${status.role?.name ?? ""})이 있지만 관리형 노드가 되지 못합니다: ${failed.detail}`,
              condition: `${displayName(inst)}: ${failed.title} 실패`,
              fix: [failed.fix ?? "인스턴스가 Systems Manager 엔드포인트(HTTPS 443)로 나갈 수 있게 라우팅과 보안 그룹 아웃바운드를 고치세요."],
              impact: "고치면 관리형 노드가 되어 SSH 키나 22번 포트 없이 Session Manager로 접속할 수 있습니다.",
            },
          ];
        }),
  },
  {
    id: "SSM-004",
    category: "security",
    severity: "info",
    title: "Session Manager를 쓸 수 있는데 SSH를 전체 공개한 인스턴스",
    concept: "관리형 노드는 Session Manager로 접속하면 되므로 SSH(22) 인바운드가 필요 없습니다. 22번 포트를 닫으면 무차별 대입 공격을 받을 위험이 사라집니다.",
    check: ({ topo }) =>
      topo
        .ofType("ec2")
        .filter((inst) => inst.config.state === "running")
        .flatMap((inst) => {
          const open = topo.securityGroupsOf(inst.id).filter((sg) => sg.config.inboundRules.some((r) => ruleAllowsFromAnywhere(r) && (r.protocol === "all" || (r.protocol === "tcp" && r.fromPort <= 22 && r.toPort >= 22))));
          if (!open.length || !managedNodeStatus(topo.project, topo, inst).managed) return [];
          return [
            {
              key: inst.id,
              resourceIds: [inst.id, ...open.map((sg) => sg.id)],
              cause: `${displayName(inst)}은(는) Session Manager로 접속할 수 있는 관리형 노드인데, 보안 그룹 ${open.map((sg) => displayName(sg)).join(", ")}이(가) SSH(22)를 0.0.0.0/0에 엽니다.`,
              condition: `${displayName(inst)}: 관리형 노드 + 인바운드 TCP 22 ← 0.0.0.0/0`,
              fix: ["보안 그룹에서 SSH(22) 인바운드 규칙을 지우고, 접속은 Systems Manager → Session Manager로 하세요."],
              impact: "통신 결과와 별개로, 인터넷에서 22번 포트로 들어오는 접속 시도가 차단됩니다.",
            },
          ];
        }),
  },

  // ------------------------------------------------------------ CloudFront
  {
    id: "CDN-001",
    category: "security",
    severity: "error",
    title: "버킷 정책이 OAC 요청을 허용하지 않는 배포",
    concept:
      "원본 액세스 제어(OAC)를 쓰면 CloudFront는 서명한 요청을 S3에 보냅니다. 버킷 정책에 cloudfront.amazonaws.com과 이 배포의 ARN(AWS:SourceArn)을 허용하는 문이 없으면 S3가 403(AccessDenied)으로 거부합니다.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled)
        .flatMap((d) =>
          d.origins.flatMap((o) => {
            if (o.kind !== "s3" || o.originAccess !== "oac") return [];
            const bucket = topo.project.services.s3.buckets.find((b) => b.id === o.targetId);
            if (!bucket) return [];
            const read = evaluateOacAccess(bucket, d.id, "s3:GetObject", objectArn(bucket.name, d.defaultRootObject || "index.html"));
            if (read.allowed) return [];
            return [
              {
                key: `${d.id}:${o.id}`,
                resourceIds: [],
                cause: `배포 ${d.id}의 원본 ${o.id}: ${read.detail}`,
                condition: `배포 ${d.id} → 버킷 ${bucket.name} (OAC)`,
                fix: ["심화 모드: CloudFront → 배포 → 원본 탭에서 '버킷 정책에 추가'를 누르거나, 정책 문을 복사해 버킷 정책에 넣으세요."],
                impact: "고치면 버킷은 비공개 그대로 두고 CloudFront로만 객체를 읽을 수 있습니다.",
              },
            ];
          }),
        ),
  },
  {
    id: "CDN-002",
    category: "general",
    severity: "warning",
    title: "기본 루트 객체가 없는 S3 원본 배포",
    concept:
      "S3 버킷(REST 엔드포인트)을 원본으로 쓰면 루트(/) 요청을 index.html로 바꿔 주지 않습니다. 기본 루트 객체를 지정하지 않으면 사이트 주소로 들어온 요청이 403(AccessDenied)이 됩니다.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled && !d.defaultRootObject.trim())
        .flatMap((d) => {
          const def = d.behaviors.find(isDefaultBehavior);
          const origin = d.origins.find((o) => o.id === def?.originId);
          if (origin?.kind !== "s3") return [];
          return [
            {
              key: d.id,
              resourceIds: [],
              cause: `배포 ${d.id}의 기본 동작이 S3 버킷(${originTargetName(topo.project, origin)})을 가리키는데 기본 루트 객체가 없어 / 요청이 403이 됩니다.`,
              condition: `배포 ${d.id}: defaultRootObject 없음`,
              fix: ["심화 모드: CloudFront → 배포 → 편집 → 설정에서 기본 루트 객체를 index.html로 지정하세요."],
              impact: "고치면 사이트 주소(/)로 들어온 요청이 index.html을 돌려줍니다.",
            },
          ];
        }),
  },
  {
    id: "CDN-003",
    category: "security",
    severity: "warning",
    title: "HTTP 요청을 그대로 허용하는 CloudFront 동작",
    concept: "뷰어 프로토콜 정책이 'HTTP and HTTPS'이면 암호화되지 않은 HTTP 요청도 그대로 처리합니다. 'Redirect HTTP to HTTPS'로 두면 HTTP 요청을 HTTPS로 리디렉션합니다.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled)
        .flatMap((d) =>
          d.behaviors
            .filter((b) => b.viewerProtocolPolicy === "allow-all")
            .map((b) => ({
              key: `${d.id}:${b.id}`,
              resourceIds: [],
              cause: `배포 ${d.id}의 동작 ${isDefaultBehavior(b) ? "기본(*)" : b.pathPattern}이(가) HTTP 요청을 암호화 없이 처리합니다.`,
              condition: `동작 ${isDefaultBehavior(b) ? "*" : b.pathPattern}: viewerProtocolPolicy = allow-all`,
              fix: ["심화 모드: CloudFront → 배포 → 편집 → 동작에서 뷰어 프로토콜 정책을 'Redirect HTTP to HTTPS'로 바꾸세요."],
              impact: "고치면 HTTP 요청이 301로 HTTPS 주소에 리디렉션됩니다.",
            })),
        ),
  },
  {
    id: "CDN-004",
    category: "security",
    severity: "warning",
    title: "버킷을 공개해야 하는 S3 원본",
    concept: "원본 액세스가 '퍼블릭'이면 CloudFront가 서명하지 않은 요청을 보내므로 버킷이 공개되어 있어야 하고, 누구나 S3 주소로 직접 객체를 읽을 수 있습니다. OAC를 쓰면 버킷을 비공개로 둘 수 있습니다.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled)
        .flatMap((d) =>
          d.origins
            .filter((o) => o.kind === "s3" && o.originAccess === "public")
            .map((o) => ({
              key: `${d.id}:${o.id}`,
              resourceIds: [],
              cause: `배포 ${d.id}의 원본 ${originTargetName(topo.project, o)}은(는) 퍼블릭 원본 액세스를 씁니다.`,
              condition: `원본 ${o.id}: originAccess = public`,
              fix: ["심화 모드: CloudFront → 배포 → 편집 → 원본에서 '원본 액세스 제어 설정(권장)'을 고르고, 버킷 정책에 OAC 허용을 넣은 뒤 버킷의 퍼블릭 액세스를 막으세요."],
              impact: "고치면 CloudFront를 거친 요청만 객체를 읽을 수 있습니다.",
            })),
        ),
  },
  {
    id: "CDN-005",
    category: "general",
    severity: "error",
    title: "CloudFront가 닿을 수 없는 원본",
    concept:
      "CloudFront는 인터넷을 통해 원본에 접속합니다. 내부(internal) 로드 밸런서에는 닿을 수 없고, 삭제된 원본이나 정적 웹 사이트 호스팅이 꺼진 버킷의 웹 사이트 엔드포인트는 응답하지 않습니다.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled)
        .flatMap((d) =>
          d.origins.flatMap((o) => {
            let problem: string | null = null;
            if (o.kind === "alb") {
              const alb = topo.getOfType(o.targetId, "alb");
              problem = !alb ? "원본 로드 밸런서가 삭제되었습니다." : alb.config.scheme === "internal" ? `${displayName(alb)}은(는) 내부(internal) 로드 밸런서라 인터넷에서 접속하는 CloudFront가 닿지 못합니다 (504).` : null;
            } else {
              const bucket = topo.project.services.s3.buckets.find((b) => b.id === o.targetId);
              problem = !bucket ? "원본 버킷이 삭제되었습니다." : o.kind === "s3-website" && !bucket.website.enabled ? `버킷 ${bucket.name}의 정적 웹 사이트 호스팅이 꺼져 있어 웹 사이트 엔드포인트가 404를 돌려줍니다.` : null;
            }
            if (!problem) return [];
            return [
              {
                key: `${d.id}:${o.id}`,
                resourceIds: [o.kind === "alb" ? o.targetId : null],
                cause: `배포 ${d.id}의 원본 ${o.id}: ${problem}`,
                condition: `원본 ${o.id} (${o.kind})`,
                fix: ["원본을 인터넷 경계(internet-facing) 로드 밸런서나 있는 버킷으로 바꾸거나, 버킷의 정적 웹 사이트 호스팅을 켜세요 (심화 모드: CloudFront → 배포 → 편집)."],
                impact: "고치면 캐시에 없는 요청이 원본에서 응답을 받아 옵니다.",
              },
            ];
          }),
        ),
  },
  {
    id: "CDN-006",
    category: "security",
    severity: "info",
    title: "AWS:SourceArn 조건 없이 CloudFront를 허용하는 버킷 정책",
    concept:
      "버킷 정책이 cloudfront.amazonaws.com을 조건 없이 허용하면 다른 계정의 CloudFront 배포도 이 버킷을 원본으로 읽을 수 있습니다(혼동된 대리자 문제). AWS:SourceArn 조건으로 내 배포만 허용하세요.",
    check: ({ topo }) =>
      topo.project.services.cloudfront.distributions
        .filter((d) => d.enabled)
        .flatMap((d) =>
          d.origins.flatMap((o) => {
            if (o.kind !== "s3" || o.originAccess !== "oac") return [];
            const bucket = topo.project.services.s3.buckets.find((b) => b.id === o.targetId);
            if (!bucket) return [];
            const read = evaluateOacAccess(bucket, d.id, "s3:GetObject", objectArn(bucket.name, d.defaultRootObject || "index.html"));
            if (!read.allowed || read.scoped) return [];
            return [
              {
                key: `${d.id}:${o.id}`,
                resourceIds: [],
                cause: `버킷 ${bucket.name}의 정책이 CloudFront를 AWS:SourceArn 조건 없이 허용합니다.`,
                condition: `버킷 ${bucket.name}: Principal Service cloudfront.amazonaws.com, Condition 없음`,
                fix: [`버킷 정책의 그 문에 "Condition": {"StringEquals": {"AWS:SourceArn": "배포 ARN"}}을 넣으세요. 배포의 원본 탭에 있는 정책 문을 그대로 쓰면 됩니다.`],
                impact: "통신 결과는 같고, 이 배포만 버킷을 읽도록 범위가 좁아집니다.",
              },
            ];
          }),
        ),
  },

  // ------------------------------------------------------------ 일반
  {
    id: "GEN-001",
    category: "general",
    severity: "info",
    title: "다른 리소스와 연결되지 않은 리소스",
    concept: "리소스는 관계(소속, 배치, 연결)를 통해 아키텍처에 참여합니다. 연결이 없는 리소스는 시뮬레이션에 영향을 주지 않습니다.",
    check: ({ topo }) =>
      topo.project.resources
        .filter((r) => r.type !== "vpc" && r.type !== "elastic-ip" && r.type !== "lambda" && topo.connectionsOf(r.id).length === 0)
        .map((r) => ({
          resourceIds: [r.id],
          cause: `${topo.label(r.id)}이(가) 다른 리소스와 연결되어 있지 않습니다.`,
          condition: "연결 0개",
          fix: ["캔버스에서 리소스의 연결점을 드래그해 관련 리소스와 연결하세요."],
          impact: "연결하면 검증과 시뮬레이션에 이 리소스가 반영됩니다.",
        })),
  },
];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function createValidationContext(topo: Topology): ValidationContext {
  return {
    topo,
    health: computeAllTargetHealth(topo),
    simulate: (request) => simulateWithTopology(topo, request),
  };
}

export function runValidationRules(ctx: ValidationContext, rules: ValidationRule[] = VALIDATION_RULES): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    let drafts: FindingDraft[];
    try {
      drafts = rule.check(ctx);
    } catch (e) {
      drafts = [];
      findings.push({
        id: `${rule.id}:engine-error`,
        ruleId: rule.id,
        severity: "info",
        category: rule.category,
        title: `검증 규칙 실행 오류 (${rule.id})`,
        resourceIds: [],
        cause: `검증 엔진 내부 오류: ${e instanceof Error ? e.message : String(e)}`,
        condition: "엔진 오류 — 아키텍처 문제가 아닙니다.",
        fix: [],
        concept: rule.concept,
        impact: "",
      });
    }
    for (const d of drafts) {
      const resourceIds = [...new Set(d.resourceIds.filter((x): x is string => !!x && ctx.topo.resources.has(x)))];
      const id = `${rule.id}:${resourceIds.join("+")}:${d.key ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        id,
        ruleId: rule.id,
        severity: d.severity ?? rule.severity,
        category: rule.category,
        title: d.title ?? rule.title,
        resourceIds,
        cause: d.cause,
        condition: d.condition,
        fix: d.fix,
        concept: rule.concept,
        impact: d.impact,
      });
    }
  }
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id),
  );
}

export function validateProject(project: Project): ValidationReport {
  const topo = buildTopology(project);
  const findings = runValidationRules(createValidationContext(topo));
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { findings, counts, generatedAt: new Date().toISOString() };
}

export function findingsForResource(report: ValidationReport, resourceId: string): ValidationFinding[] {
  return report.findings.filter((f) => f.resourceIds.includes(resourceId));
}

export function ruleById(id: string): ValidationRule | undefined {
  return VALIDATION_RULES.find((r) => r.id === id);
}

