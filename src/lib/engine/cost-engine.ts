/**
 * 교육용 가상 비용 계산.
 * 실제 AWS 요금표를 사용하지 않는다. 모든 단가는 "교육용 가정값"이며 사용자가 프로젝트별로 수정할 수 있다.
 * 결과는 실제 청구 금액이 아니다.
 */
import {
  EC2_INSTANCE_TYPES,
  RDS_INSTANCE_CLASSES,
  type CostAssumptions,
  type Project,
  type ResourceType,
} from "./resource-models";
import { buildTopology } from "./topology-engine";

/** 교육용 가정 단가 (가상 USD). 실제 요금과 다를 수 있습니다. */
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
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
};

export interface CostItem {
  label: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface CostLine {
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  items: CostItem[];
  subtotal: number;
  note?: string;
}

export interface CostReport {
  lines: CostLine[];
  total: number;
  assumptions: CostAssumptions;
  notes: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;

function item(label: string, quantity: number, unit: string, rate: number): CostItem {
  return { label, quantity, unit, rate, amount: round(quantity * rate) };
}

export function resolveCostAssumptions(project: Project): CostAssumptions {
  const custom = project.costAssumptions;
  if (!custom) return DEFAULT_COST_ASSUMPTIONS;
  return {
    ...DEFAULT_COST_ASSUMPTIONS,
    ...custom,
    ec2Hourly: { ...DEFAULT_COST_ASSUMPTIONS.ec2Hourly, ...custom.ec2Hourly },
    rdsHourly: { ...DEFAULT_COST_ASSUMPTIONS.rdsHourly, ...custom.rdsHourly },
  };
}

export function estimateCost(project: Project, assumptions: CostAssumptions = resolveCostAssumptions(project)): CostReport {
  const topo = buildTopology(project);
  const a = assumptions;
  const hours = a.hoursPerMonth;
  const lines: CostLine[] = [];

  for (const r of project.resources) {
    const items: CostItem[] = [];
    let note: string | undefined;
    switch (r.type) {
      case "ec2": {
        if (r.config.state === "running" || r.config.state === "pending") {
          items.push(item(`${r.config.instanceType} 인스턴스 사용 시간`, hours, "시간", a.ec2Hourly[r.config.instanceType] ?? 0));
          if (topo.enisOf(r.id)[0]?.publicIp !== null) {
            items.push(item("퍼블릭 IPv4 주소", hours, "시간", a.publicIpv4Hourly));
          }
        } else {
          note = `${r.config.state} 상태: 인스턴스 사용 시간 비용 없음으로 가정 (스토리지는 모델링하지 않음)`;
        }
        break;
      }
      case "nat-gateway":
        if (r.config.state === "available") {
          items.push(item("NAT Gateway 사용 시간", hours, "시간", a.natHourly));
          items.push(item("NAT 처리 데이터", a.dataProcessedGb, "GB", a.natPerGb));
          items.push(item("Elastic IP (퍼블릭 IPv4)", hours, "시간", a.publicIpv4Hourly));
        } else {
          note = `${r.config.state} 상태: 비용 없음으로 가정`;
        }
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
    lines.push({ resourceId: r.id, resourceName: r.name, resourceType: r.type, items, subtotal, note });
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
    ],
  };
}

export const COST_INSTANCE_TYPES = EC2_INSTANCE_TYPES;
export const COST_RDS_CLASSES = RDS_INSTANCE_CLASSES;
