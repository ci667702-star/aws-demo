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
import { evaluateNacl, findShadowedRules, describeNaclRule } from "./network-acl-engine";
import { AVAILABILITY_ZONES, type NaclRule, type Project, type SgRule } from "./resource-models";
import { findDuplicateDestinations } from "./route-engine";
import { describeSgRule, evaluateSecurityGroups, ruleAllowsFromAnywhere } from "./security-group-engine";
import { buildTopology, type Topology } from "./topology-engine";

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
            condition: `VPC ${vpc.name}의 CIDR = "${vpc.config.cidr}"`,
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
            condition: `서브넷 ${s.name}의 CIDR = "${s.config.cidr}"`,
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
          cause: `서브넷 ${s.name}이(가) 어떤 VPC와도 연결되어 있지 않습니다.`,
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
            cause: `서브넷 ${s.name}(${cidr.text})이 VPC ${topo.name(vpcId)}(${vpcCidr.text}) 범위 밖에 있습니다.`,
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
                cause: `${subnets[i].name}(${a.text})과 ${subnets[j].name}(${b.text})의 주소 범위가 겹칩니다.`,
                condition: `VPC ${vpc.name} 내부 서브넷 CIDR 충돌`,
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
              cause: `${vpcs[i].name}(${a.text})과 ${vpcs[j].name}(${b.text})의 범위가 겹칩니다.`,
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
          cause: `서브넷 ${s.name}의 가용 영역 "${s.config.availabilityZone}"은(는) 가상 리전에 없습니다.`,
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
          cause: `${igw.name}이(가) 어떤 VPC에도 연결되어 있지 않습니다.`,
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
            cause: `라우팅 테이블 ${rt.name}의 경로 대상 CIDR "${r.destinationCidr}"이(가) 올바르지 않습니다.`,
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
              condition: `${rt.name}: ${r.destinationCidr} → ${topo.name(r.targetId)}`,
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
                condition: `${rt.name}: ${r.destinationCidr} → ${topo.name(r.targetId)}`,
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
          cause: `${rt.name}에 Destination ${group[0].cidr?.text} 경로가 ${group.length}개 있습니다: ${group.map((g) => topo.routeTargetLabel(g)).join(", ")}`,
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
          cause: `라우팅 테이블 ${rt.name}이(가) VPC에 속해 있지 않습니다.`,
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
            cause: `${cls.reason}${instances.length ? ` 이 서브넷의 EC2 ${instances.map((i) => i.name).join(", ")}은(는) 외부와 통신할 수 없습니다.` : ""}`,
            condition: "서브넷 라우팅 테이블에 IGW/NAT 경로 없음",
            fix: [
              "외부 통신이 필요한 프라이빗 서브넷: 퍼블릭 서브넷에 NAT Gateway를 만들고 0.0.0.0/0 → NAT 경로를 추가하세요.",
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
            cause: `${nat.name}이(가) 배치된 서브넷 ${topo.name(subnetId)}은(는) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
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
          cause: `${nat.name}이(가) 서브넷에 배치되어 있지 않습니다.`,
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
            cause: `${rt.name}의 경로 ${r.destinationCidr} → ${topo.routeTargetLabel(r)}이(가) VPC 범위(${vpcCidr.text}) 안의 주소를 외부 게이트웨이로 보냅니다.`,
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
            cause: `${ec2.name}에는 퍼블릭 IP가 할당되지만 서브넷 ${topo.name(subnetId)}은(는) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
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
                ? `서브넷 ${s.name}은(는) 기본 라우팅 테이블 ${topo.name(ref.routeTableId)}을(를) 사용합니다.`
                : `서브넷 ${s.name}은(는) 명시적 라우팅 테이블이 없고, VPC에 기본 라우팅 테이블도 지정되지 않아 local 경로만 사용합니다.`,
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
          cause: `서브넷 ${s.name}은(는) 기본 NACL(모두 허용)을 사용한다고 가정합니다.`,
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
            cause: `VPC ${vpc.name}에 기본 라우팅 테이블로 지정된 테이블이 ${mains.length}개 있습니다: ${mains.map((m) => m.name).join(", ")}`,
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
            cause: `VPC ${vpc.name}의 CIDR ${cidr.text}은(는) RFC 1918 사설 대역이 아닙니다.`,
            condition: "VPC CIDR ⊄ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16",
            fix: ["가능하면 10.0.0.0/16 같은 사설 대역을 사용하세요."],
            impact: "사설 대역을 사용하면 인터넷 주소와의 충돌 가능성이 없어집니다.",
          },
        ];
      }),
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
            cause: `${sg.name}의 인바운드 규칙 "${sgRuleText(topo, r)}"이(가) 모든 IPv4 주소에서 모든 포트를 허용합니다.`,
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
                cause: `${sg.name}이(가) ${name}(TCP ${port})을 0.0.0.0/0에 허용합니다.`,
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
                cause: `${sg.name}이(가) ${name} 포트(TCP ${port})를 0.0.0.0/0에 허용합니다.`,
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
                cause: `${sg.name}의 ${dir} 규칙: ${problems.join(" ")}`,
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
                ? `${sg.name}의 규칙이 다른 VPC(${topo.name(refVpc)})의 보안 그룹 ${ref.name}을(를) 참조합니다.`
                : `${sg.name}의 규칙이 존재하지 않는 보안 그룹을 참조합니다.`,
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
          fix: [`같은 VPC의 보안 그룹을 만들어 ${r.name}에 연결하세요.`],
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
            cause: `${topo.label(r.id)}(VPC ${topo.name(vpcId)})에 다른 VPC(${topo.name(topo.vpcOf(sg.id))})의 보안 그룹 ${sg.name}이(가) 연결되어 있습니다.`,
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
        .filter((sg) => topo.resourcesUsingSecurityGroup(sg.id).length === 0)
        .map((sg) => ({
          resourceIds: [sg.id],
          cause: `${sg.name}이(가) 어떤 EC2/ALB/RDS에도 연결되어 있지 않습니다.`,
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
              cause: `${nacl.name}의 ${label} 규칙 ${describeNaclRule(rule)}은(는) 허용되지만, ${responseDir === "outbound" ? "아웃바운드" : "인바운드"} 규칙이 ${rule.cidr} 방향의 응답 임시 포트(${blocked.join(", ")})를 허용하지 않습니다.`,
              condition: `${responseDir === "outbound" ? "아웃바운드" : "인바운드"} ${protocol.toUpperCase()} 1024-65535 ↔ ${rule.cidr} 허용 규칙 없음`,
              fix: [
                `${nacl.name}의 ${responseDir === "outbound" ? "아웃바운드" : "인바운드"} 규칙에 ${protocol.toUpperCase()} 1024-65535 (${rule.cidr}) ALLOW 규칙을 추가하세요.`,
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
              cause: `${nacl.name} ${dir === "inbound" ? "인바운드" : "아웃바운드"}: ${problems.join(" ")}`,
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
            cause: `${nacl.name} ${dir === "inbound" ? "인바운드" : "아웃바운드"} 규칙 ${describeNaclRule(rule)}은(는) 앞선 ${describeNaclRule(shadowedBy)}에 가려져 적용되지 않습니다.`,
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
              cause: `${nacl.name}의 ${dir === "inbound" ? "인바운드" : "아웃바운드"} 규칙에 ALLOW가 없어 연결된 서브넷의 모든 트래픽이 거부됩니다.`,
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
          cause: `${e.name}이(가) 서브넷에 배치되어 있지 않습니다.`,
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
        else if (!cidrContainsIp(cidr, value)) cause = `사설 IP ${e.config.privateIp}이(가) 서브넷 ${subnet.name}(${cidr.text}) 범위 밖입니다.`;
        else {
          const reserved = awsReservedReason(cidr, value);
          if (reserved) cause = `사설 IP ${e.config.privateIp}은(는) AWS 예약 주소(${reserved})입니다.`;
        }
        if (!cause) return [];
        return [
          {
            resourceIds: [e.id, subnet.id],
            cause,
            condition: `${e.name}.privateIp = "${e.config.privateIp}"`,
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
          cause: `${e.name}이(가) ${e.config.state} 상태입니다.`,
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
          cause: `${a.name}에 리스너가 없습니다.`,
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
            cause: `${a.name}의 리스너 ${b.listener.protocol}:${b.listener.port}에 전달할 대상 그룹이 없습니다.`,
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
          cause: `대상 그룹 ${tg.name}에 등록된 EC2가 없습니다.`,
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
            cause: `대상 그룹 ${tg.name}의 정상 대상이 없습니다: ${entries.map((h) => `${h.targetName} — ${h.reason}`).join(" / ")}`,
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
            cause: `${a.name}이(가) ${subnets.length}개 서브넷(가용 영역 ${azs.size}개)에만 배치되어 있습니다.`,
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
        for (const s of subnets) byAz.set(s.config.availabilityZone, [...(byAz.get(s.config.availabilityZone) ?? []), s.name]);
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
              cause: `internet-facing ALB ${a.name}의 서브넷 ${privateSubnets.map((s) => s.name).join(", ")}이(가) 퍼블릭 서브넷이 아닙니다.`,
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
              cause: `${a.name}의 보안 그룹(${groups.map((g) => g.name).join(", ")})이 리스너 포트 TCP ${l.port}을(를) ${a.config.scheme === "internet-facing" ? "인터넷 클라이언트" : "어떤 출발지"}에게도 허용하지 않습니다.`,
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
            cause: `${a.name}에 포트 ${port} 리스너가 ${n}개 있습니다.`,
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
            condition: `대상 그룹 ${tg.name} 헬스 체크 설정`,
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
          cause: `대상 그룹 ${tg.name}이(가) 어떤 ALB 리스너에도 연결되어 있지 않습니다.`,
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
            cause: `${a.name}의 HTTPS:${l.port} 리스너는 인증서 없이 포트 수준으로만 시뮬레이션됩니다.`,
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
          cause: `${r.name}에 DB 서브넷 그룹이 연결되어 있지 않습니다.`,
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
            cause: `DB 서브넷 그룹 ${g.name}에 서브넷 ${subnets.length}개(가용 영역 ${azs.size}개)만 있습니다.`,
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
            cause: `DB 서브넷 그룹 ${g.name}의 서브넷이 여러 VPC(${vpcs.map((v) => topo.name(v)).join(", ")})에 있습니다.`,
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
              cause: `${rds.name}과(와) 같은 VPC에 Running 상태의 애플리케이션 서버(EC2)가 없습니다.`,
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
            cause: `어떤 EC2도 ${rds.name}의 TCP ${rds.config.port}에 연결할 수 없습니다. 예: ${results[0].app.name} → ${first.failure?.reason ?? first.summary}`,
            condition: `EC2 ${apps.map((a) => a.name).join(", ")} → ${rds.name}:${rds.config.port}`,
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
              cause: `${r.name}은(는) Publicly Accessible이지만 배치된 서브넷 ${primary.name}이(가) 퍼블릭 서브넷이 아닙니다. ${cls.reason}`,
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
            cause: `${r.name}의 보안 그룹이 DB 포트 TCP ${r.config.port}을(를) 0.0.0.0/0에 허용합니다 (${open.map((o) => `${o.g.name}: ${sgRuleText(topo, o.rule)}`).join(", ")}).`,
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
              cause: `시뮬레이션 결과 인터넷 클라이언트(${DEFAULT_INTERNET_CLIENT_IP})가 ${r.name}의 TCP ${r.config.port}에 연결할 수 있습니다.`,
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
              cause: `VPC ${vpc.name}의 DNS 확인=${vpc.config.enableDnsSupport ? "켬" : "끔"}, DNS 호스트 이름=${vpc.config.enableDnsHostnames ? "켬" : "끔"}입니다.`,
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
          cause: `${r.name}은(는) 단일 가용 영역에 배치됩니다.`,
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
          cause: `${r.name}이(가) ${r.config.state} 상태입니다.`,
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
            cause: `DB 서브넷 그룹 ${g.name}에 퍼블릭 서브넷(${publicSubnets.map((s) => s.name).join(", ")})이 포함되어 있습니다.`,
            condition: "DB 서브넷 그룹 ⊃ 퍼블릭 서브넷",
            fix: ["DB 전용 프라이빗 서브넷을 만들어 그룹을 구성하세요."],
            impact: "DB가 프라이빗 서브넷에 있으면 Publicly Accessible을 잘못 켜도 인터넷에서 접근할 수 없습니다.",
          },
        ];
      }),
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
        .filter((r) => r.type !== "vpc" && topo.connectionsOf(r.id).length === 0)
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

