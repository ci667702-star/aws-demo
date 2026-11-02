"use client";

/**
 * NAT 게이트웨이 vs NAT 인스턴스 월 비용 비교 (교육용 가정 단가).
 * 쉬운 모드 비용 패널과 심화 모드 비용 화면에서 함께 쓴다.
 */
import { compareNatCost, type NatCostOption } from "@/lib/engine/cost-engine";
import type { CostAssumptions, Project } from "@/lib/engine/resource-models";
import { formatMoney, formatRate } from "@/lib/ui/format";
import { cn } from "@/lib/utils";

const NAT_COMPARISON_DOC = "https://docs.aws.amazon.com/ko_kr/vpc/latest/userguide/vpc-nat-comparison.html";

/** 프로젝트가 NAT(게이트웨이 또는 인스턴스)를 쓰는지와, NAT 인스턴스가 있으면 그 유형 */
function natUsage(project: Project) {
  const gateways = project.resources.filter((r) => r.type === "nat-gateway").length;
  const instanceIds = new Set(project.connections.filter((c) => c.relationType === "route-table-ec2").map((c) => c.targetResourceId));
  const instance = project.resources.find((r) => r.type === "ec2" && instanceIds.has(r.id));
  return { gateways, instances: instanceIds.size, instanceType: instance?.type === "ec2" ? instance.config.instanceType : undefined };
}

function Option({ title, option, current, points }: { title: string; option: NatCostOption; current: boolean; points: string[] }) {
  return (
    <div className={cn("space-y-1.5 rounded-lg border p-2.5", current && "border-primary/60 bg-primary/5")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">
          {title}
          {current && <span className="ml-1.5 rounded bg-primary/15 px-1 py-0.5 text-[10px] font-medium">지금 구성</span>}
        </span>
        <span className="font-mono text-sm font-semibold">{formatMoney(option.monthly)}/월</span>
      </div>
      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
        {option.items.map((i) => (
          <li key={i.label}>
            {i.label}: {i.quantity.toLocaleString()} {i.unit} × {formatRate(i.rate)} = {formatMoney(i.amount)}
          </li>
        ))}
      </ul>
      <ul className="list-disc space-y-0.5 pl-4 text-[12px]">
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function NatCostComparisonCard({ project, assumptions, className }: { project: Project; assumptions: CostAssumptions; className?: string }) {
  const usage = natUsage(project);
  if (!usage.gateways && !usage.instances) return null;
  const c = compareNatCost(assumptions, usage.instanceType ?? "t3.micro");
  return (
    <section className={cn("space-y-2 rounded-lg border p-3", className)} data-testid="nat-cost-comparison" aria-label="NAT 비용 비교">
      <div className="space-y-0.5">
        <p className="text-sm font-semibold">NAT 게이트웨이 vs NAT 인스턴스 (교육용 가정 단가)</p>
        <p className="text-[12px] text-muted-foreground">
          같은 가정으로 한 달 비용을 비교합니다.{" "}
          {c.savings > 0
            ? `NAT 인스턴스(${c.instanceType})가 월 ${formatMoney(c.savings)} 적게 듭니다.`
            : c.savings < 0
              ? `이 가정에서는 NAT 게이트웨이가 월 ${formatMoney(-c.savings)} 적게 듭니다.`
              : "이 가정에서는 두 방식의 비용이 같습니다."}{" "}
          인터넷으로 나가는 데이터 전송 요금은 두 방식이 같다고 보고 뺐습니다.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Option
          title="NAT 게이트웨이"
          option={c.gateway}
          current={usage.gateways > 0}
          points={["AWS가 관리 (패치·장애 복구 불필요)", "가용 영역 안에서 이중화, 최대 100 Gbps까지 자동 확장", "AWS 권장 방식 · 운영 환경에 적합"]}
        />
        <Option
          title={`NAT 인스턴스 (${c.instanceType})`}
          option={c.instance}
          current={usage.instances > 0}
          points={["인스턴스 요금만 (처리 데이터 요금 없음)", "패치·장애 복구를 직접 하고, 대역폭은 인스턴스 유형에 따라 다름", "인스턴스가 멈추면 외부 통신이 끊김 · 실습·소규모에 적합"]}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        실제 요금이 아닌 가정 단가입니다. 두 방식의 차이는 AWS 문서{" "}
        <a href={NAT_COMPARISON_DOC} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          NAT 게이트웨이 및 NAT 인스턴스 비교
        </a>
        를 참고하세요.
      </p>
    </section>
  );
}
