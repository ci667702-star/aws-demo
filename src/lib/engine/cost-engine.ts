/**
 * 교육용 가상 비용 계산.
 * 실제 AWS 요금표를 사용하지 않는다. 모든 단가는 "교육용 가정값"이며 사용자가 프로젝트별로 수정할 수 있다.
 * 결과는 실제 청구 금액이 아니다.
 */
import { analyzeInvocation, monthlyScheduledInvocations } from "./lambda-engine";
import { isPendingDeletion, isPurged } from "./secrets-engine";
import { isNatInstanceTarget } from "./nat-instance";
import {
  EC2_INSTANCE_TYPES,
  RDS_INSTANCE_CLASSES,
  type ConfigOf,
  type CostAssumptions,
  type Project,
  type ResourceType,
} from "./resource-models";
import { buildTopology, displayName } from "./topology-engine";

/** 나중에 추가한 단가까지 모두 채운 가정값 (저장된 값에 없으면 기본값) */
export type ResolvedCostAssumptions = Required<CostAssumptions>;

/** 교육용 가정 단가 (가상 USD). 실제 요금과 다를 수 있습니다. */
export const DEFAULT_COST_ASSUMPTIONS: ResolvedCostAssumptions = {
  hoursPerMonth: 730,
  dataProcessedGb: 100,
  dataTransferOutGb: 50,
  ec2Hourly: {
    "t3.micro": 0.01,
    "t3.small": 0.02,
    "t3.medium": 0.04,
    "t3.large": 0.08,
    "m5.large": 0.1,
    "c5.large": 0.09,
  },
  rdsHourly: {
    "db.t3.micro": 0.02,
    "db.t3.small": 0.04,
    "db.t3.medium": 0.08,
    "db.m5.large": 0.18,
  },
  rdsStorageGbMonth: 0.12,
  natHourly: 0.05,
  natPerGb: 0.05,
  albHourly: 0.025,
  albPerGb: 0.01,
  publicIpv4Hourly: 0.005,
  dataTransferOutPerGb: 0.09,
  lambdaPerMillionRequests: 0.2,
  lambdaPerGbSecond: 0.0000166667,
  schedulerPerMillion: 1,
  secretPerMonth: 0.4,
  ssmAdvancedParameterPerMonth: 0.05,
  cloudfrontDataGb: 10,
  cloudfrontRequestsMillion: 1,
  cloudfrontPerGb: 0.12,
  cloudfrontPerMillionRequests: 1.2,
};

/** 교육용 가정: arm64의 실행 시간 단가는 x86_64 가정 단가의 80% */
export const ARM64_DURATION_FACTOR = 0.8;

export interface CostItem {
  label: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

/** VPC 밖 서비스 항목의 종류 (비용 표의 '유형' 표시용) */
export type ServiceCostType = "secret" | "ssm-parameter" | "cloudfront";

export interface CostLine {
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType | ServiceCostType;
  items: CostItem[];
  subtotal: number;
  note?: string;
}

export const SERVICE_COST_LABEL: Record<ServiceCostType, string> = {
  secret: "Secrets Manager",
  "ssm-parameter": "Parameter Store",
  cloudfront: "CloudFront",
};

export const isServiceCostType = (type: CostLine["resourceType"]): type is ServiceCostType => type in SERVICE_COST_LABEL;

/** 서비스 항목의 설명 키와 콘솔 경로 */
export const SERVICE_COST_DOC_KEY = { secret: "secretsmanager", "ssm-parameter": "ssm", cloudfront: "cloudfront" } as const satisfies Record<ServiceCostType, string>;
export const serviceCostPath = (type: ServiceCostType, id: string) => (type === "secret" ? `/secretsmanager/secrets/${id}` : type === "ssm-parameter" ? `/ssm/parameters/${id}` : `/cloudfront/distributions/${id}`);

export interface CostReport {
  lines: CostLine[];
  total: number;
  assumptions: ResolvedCostAssumptions;
  notes: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;

function item(label: string, quantity: number, unit: string, rate: number): CostItem {
  return { label, quantity, unit, rate, amount: round(quantity * rate) };
}

export function resolveCostAssumptions(project: Project): ResolvedCostAssumptions {
  const custom = project.costAssumptions;
  if (!custom) return DEFAULT_COST_ASSUMPTIONS;
  return {
    ...DEFAULT_COST_ASSUMPTIONS,
    ...custom,
    ec2Hourly: { ...DEFAULT_COST_ASSUMPTIONS.ec2Hourly, ...custom.ec2Hourly },
    rdsHourly: { ...DEFAULT_COST_ASSUMPTIONS.rdsHourly, ...custom.rdsHourly },
  };
}

export function estimateCost(project: Project, assumptions: ResolvedCostAssumptions = resolveCostAssumptions(project), now = Date.now()): CostReport {
  const topo = buildTopology(project);
  const a = assumptions;
  const hours = a.hoursPerMonth;
  const lines: CostLine[] = [];
  const hasLambda = project.resources.some((r) => r.type === "lambda");

  for (const r of project.resources) {
    const items: CostItem[] = [];
    let note: string | undefined;
    switch (r.type) {
      case "ec2": {
        if (r.config.state === "running" || r.config.state === "pending") {
          items.push(item(`${r.config.instanceType} 인스턴스 사용 시간`, hours, "시간", a.ec2Hourly[r.config.instanceType] ?? 0));
          // 탄력적 IP의 비용은 탄력적 IP 항목에서 계산한다.
          if (topo.enisOf(r.id)[0]?.publicIp !== null && !topo.elasticIpOf(r.id)) {
            items.push(item("퍼블릭 IPv4 주소 (자동 할당)", hours, "시간", a.publicIpv4Hourly));
          }
          if (isNatInstanceTarget(topo, r.id)) note = "NAT 인스턴스로 사용 중: NAT 게이트웨이와 달리 처리 데이터(GB) 요금 없이 인스턴스 사용 시간만 계산합니다.";
        } else {
          note = `${r.config.state} 상태: 인스턴스 사용 시간 비용 없음으로 가정 (스토리지는 모델링하지 않음)`;
        }
        break;
      }
      case "nat-gateway":
        if (r.config.state === "available") {
          items.push(item("NAT Gateway 사용 시간", hours, "시간", a.natHourly));
          items.push(item("NAT 처리 데이터", a.dataProcessedGb, "GB", a.natPerGb));
          if (!topo.elasticIpOf(r.id)) items.push(item("퍼블릭 IPv4 (레거시 자동 주소)", hours, "시간", a.publicIpv4Hourly));
        } else {
          note = `${r.config.state} 상태: 비용 없음으로 가정`;
        }
        break;
      case "elastic-ip":
        items.push(item(`탄력적 IP ${r.config.publicIp}${topo.elasticIpTarget(r.id) ? "" : " (미사용)"}`, hours, "시간", a.publicIpv4Hourly));
        break;
      case "alb":
        items.push(item("ALB 사용 시간", hours, "시간", a.albHourly));
        items.push(item("ALB 처리 데이터 (LCU 단순화)", a.dataProcessedGb, "GB", a.albPerGb));
        break;
      case "rds": {
        if (r.config.state === "available") {
          const multiplier = r.config.multiAz ? 2 : 1;
          items.push(
            item(
              `${r.config.instanceClass}${r.config.multiAz ? " (Multi-AZ ×2)" : ""} 사용 시간`,
              hours * multiplier,
              "시간",
              a.rdsHourly[r.config.instanceClass] ?? 0,
            ),
          );
        } else {
          note = "stopped 상태: 인스턴스 사용 시간 비용 없음으로 가정";
        }
        items.push(item(`스토리지${r.config.multiAz ? " (Multi-AZ ×2)" : ""}`, r.config.allocatedStorageGb * (r.config.multiAz ? 2 : 1), "GB-월", a.rdsStorageGbMonth));
        break;
      }
      case "lambda": {
        const runs = monthlyScheduledInvocations(project, r, now, hours);
        if (!runs) {
          note = "이 함수를 호출하는 활성 일정이 없어 요청이 없다고 가정합니다. (콘솔 테스트 호출과 규칙 호출은 계산하지 않음)";
          break;
        }
        items.push(item("EventBridge Scheduler 호출", runs, "회", a.schedulerPerMillion / 1_000_000));
        const run = analyzeInvocation(project, topo, r);
        if (run.outcome === "invalid" || run.outcome === "throttled") {
          note = `일정 호출이 ${run.outcome === "throttled" ? "제한(throttle)되어" : "실행 전에 실패해"} 함수가 실행되지 않으므로 요청·실행 시간 요금이 없다고 가정합니다.`;
          break;
        }
        const arm = r.config.architecture === "arm64";
        const billedSeconds = Math.max(1, Math.ceil(run.durationMs)) / 1000;
        const gbSeconds = Math.round(runs * billedSeconds * (r.config.memoryMb / 1024) * 1000) / 1000;
        items.push(item("Lambda 요청", runs, "건", a.lambdaPerMillionRequests / 1_000_000));
        items.push(item(`Lambda 실행 시간 (${r.config.memoryMb}MB × ${billedSeconds}초${arm ? ", arm64" : ""})`, gbSeconds, "GB-초", a.lambdaPerGbSecond * (arm ? ARM64_DURATION_FACTOR : 1)));
        note = `앞으로 ${hours}시간 동안 일정이 호출하는 횟수로 계산합니다.${run.outcome === "timeout" ? " 시간 초과로 끝나는 실행은 제한 시간만큼 과금됩니다." : run.outcome === "error" ? " 오류로 끝난 실행도 실행한 시간만큼 과금됩니다." : ""}`;
        break;
      }
      case "internet-gateway": {
        const vpcId = topo.vpcOfIgw(r.id);
        if (vpcId) items.push(item("인터넷 방향 데이터 전송", a.dataTransferOutGb, "GB", a.dataTransferOutPerGb));
        else note = "VPC에 연결되지 않아 데이터 전송 없음으로 가정";
        break;
      }
      default:
        note = "교육용 가정: 이 리소스 자체에는 비용이 없다고 가정합니다.";
    }
    const subtotal = round(items.reduce((sum, i) => sum + i.amount, 0));
    lines.push({ resourceId: r.id, resourceName: displayName(r), resourceType: r.type, items, subtotal, note });
  }

  // ---- VPC 밖 서비스: Secrets Manager · Parameter Store · CloudFront
  const serviceLine = (resourceId: string, resourceName: string, resourceType: ServiceCostType, items: CostItem[], note?: string) =>
    lines.push({ resourceId, resourceName, resourceType, items, subtotal: round(items.reduce((sum, i) => sum + i.amount, 0)), note });
  const secrets = project.services.secretsmanager.secrets.filter((s) => !isPurged(s, now));
  for (const s of secrets) {
    serviceLine(s.id, s.name, "secret", [item("보안 암호 보관", 1, "개-월", a.secretPerMonth)], isPendingDeletion(s) ? "삭제 예약 중: 실제 AWS에서는 삭제가 예약된 보안 암호에는 요금이 붙지 않지만, 여기서는 단순하게 한 달 요금으로 계산합니다." : undefined);
  }
  const advanced = project.services.ssm.parameters.filter((p) => p.tier === "Advanced");
  for (const p of advanced) serviceLine(p.id, p.name, "ssm-parameter", [item("고급(Advanced) 파라미터", 1, "개-월", a.ssmAdvancedParameterPerMonth)]);
  const distributions = project.services.cloudfront.distributions.filter((d) => d.enabled);
  for (const d of distributions) {
    serviceLine(
      d.id,
      d.comment || d.domainName,
      "cloudfront",
      [item("인터넷으로 나가는 데이터 전송", a.cloudfrontDataGb, "GB", a.cloudfrontPerGb), item("HTTPS 요청", a.cloudfrontRequestsMillion, "백만 건", a.cloudfrontPerMillionRequests)],
      "사용량 가정(GB·요청 수)으로 계산합니다. 원본(S3·ALB)에서 CloudFront로 가는 전송 요금은 없다고 가정합니다.",
    );
  }

  const total = round(lines.reduce((sum, l) => sum + l.subtotal, 0));
  return {
    lines,
    total,
    assumptions: a,
    notes: [
      "가상 비용은 교육용 추정치이며 실제 청구 금액이 아닙니다.",
      "단가는 실제 AWS 요금표가 아닌 교육용 가정값입니다. 비용 패널에서 직접 수정할 수 있습니다.",
      "EBS 볼륨, 스냅샷, 요청 수, 리전 간 전송 등은 모델링하지 않습니다.",
      ...(hasLambda ? ["Lambda·EventBridge Scheduler의 프리 티어(무료 사용량)는 반영하지 않습니다. 호출이 적으면 실제 요금은 대부분 0에 가깝습니다."] : []),
      ...(secrets.length ? ["Secrets Manager: 보안 암호 개수만 계산합니다 (API 호출 요금과 30일 무료 체험은 반영하지 않음)."] : []),
      ...(project.services.ssm.parameters.length ? ["Parameter Store: 표준(Standard) 파라미터와 Session Manager는 추가 요금이 없다고 가정하고, 고급(Advanced) 파라미터만 계산합니다."] : []),
      ...(distributions.length ? ["CloudFront: 상시 무료 사용량(프리 티어)과 리전별 요금 차이, 무효화 요금은 반영하지 않습니다."] : []),
    ],
  };
}

export interface NatCostOption {
  items: CostItem[];
  monthly: number;
}

export interface NatCostComparison {
  instanceType: ConfigOf<"ec2">["instanceType"];
  gateway: NatCostOption;
  instance: NatCostOption;
  /** NAT 게이트웨이 − NAT 인스턴스 (양수면 NAT 인스턴스가 그만큼 저렴) */
  savings: number;
}

/**
 * 같은 가정 단가로 NAT 게이트웨이 1개와 NAT 인스턴스 1대의 월 비용을 비교한다.
 * 인터넷으로 나가는 데이터 전송 요금은 두 방식이 같다고 보고 뺀다.
 */
export function compareNatCost(a: CostAssumptions, instanceType: ConfigOf<"ec2">["instanceType"] = "t3.micro"): NatCostComparison {
  const hours = a.hoursPerMonth;
  const gatewayItems = [
    item("NAT 게이트웨이 사용 시간", hours, "시간", a.natHourly),
    item("NAT 처리 데이터", a.dataProcessedGb, "GB", a.natPerGb),
    item("탄력적 IP (퍼블릭 IPv4)", hours, "시간", a.publicIpv4Hourly),
  ];
  const instanceItems = [
    item(`${instanceType} 인스턴스 사용 시간`, hours, "시간", a.ec2Hourly[instanceType] ?? 0),
    item("퍼블릭 IPv4 주소", hours, "시간", a.publicIpv4Hourly),
  ];
  const sum = (items: CostItem[]) => round(items.reduce((s, i) => s + i.amount, 0));
  const gateway = { items: gatewayItems, monthly: sum(gatewayItems) };
  const instance = { items: instanceItems, monthly: sum(instanceItems) };
  return { instanceType, gateway, instance, savings: round(gateway.monthly - instance.monthly) };
}

export const COST_INSTANCE_TYPES = EC2_INSTANCE_TYPES;
export const COST_RDS_CLASSES = RDS_INSTANCE_CLASSES;
