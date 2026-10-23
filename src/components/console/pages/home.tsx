"use client";

import { CircleCheck, Circle } from "lucide-react";
import { cn } from "cn";
import { useMemo } from "react";
import { estimateCost } from "@/lib/engine/cost-engine";
import { formatMoney } from "@/lib/ui/format";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { href } from "../router";
import { SERVICES, TOOLS } from "../shell/navigation";
import { Button, ButtonLink } from "../ui/button";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink } from "../ui/links";
import { StatusIndicator } from "../ui/status";

export function ConsoleHomePage() {
  const project = useProject();
  const { topology: topo, counts } = useAnalysis();
  const openLabs = useConsoleUi((s) => s.openLabs);
  const cost = useMemo(() => estimateCost(project), [project]);

  const count = (type: Parameters<typeof topo.ofType>[0]) => topo.ofType(type).length;
  const serviceCounts: Record<string, { label: string; value: number }[]> = {
    vpc: [
      { label: "VPC", value: count("vpc") },
      { label: "서브넷", value: count("subnet") },
      { label: "보안 그룹", value: count("security-group") },
    ],
    ec2: [
      { label: "실행 중인 인스턴스", value: topo.ofType("ec2").filter((e) => e.config.state === "running").length },
      { label: "로드 밸런서", value: count("alb") },
      { label: "대상 그룹", value: count("target-group") },
    ],
    rds: [
      { label: "DB 인스턴스", value: count("rds") },
      { label: "DB 서브넷 그룹", value: count("db-subnet-group") },
    ],
  };

  const vpcs = topo.ofType("vpc");
  const hasPublicSubnet = topo.ofType("subnet").some((s) => topo.classifySubnet(s.id).kind === "public");
  const steps = [
    { done: vpcs.length > 0, text: "VPC 생성 — IPv4 CIDR(예: 10.0.0.0/16)을 직접 지정", path: "/vpc/vpcs/create" },
    { done: count("subnet") > 0, text: "서브넷 생성 — 가용 영역과 VPC 범위 안의 CIDR 지정", path: "/vpc/subnets/create" },
    { done: vpcs.some((v) => !!topo.igwOfVpc(v.id)), text: "인터넷 게이트웨이 생성 후 VPC에 연결", path: "/vpc/igws" },
    { done: hasPublicSubnet, text: "라우팅 테이블에 0.0.0.0/0 → 인터넷 게이트웨이 경로를 추가하고 서브넷과 연결", path: "/vpc/route-tables" },
    { done: topo.ofType("security-group").some((g) => !g.config.isDefault), text: "보안 그룹 생성 — 필요한 인바운드 규칙만 허용", path: "/vpc/security-groups/create" },
    { done: count("ec2") > 0, text: "EC2 인스턴스 시작 — 서브넷, 퍼블릭 IP, 보안 그룹, 사용자 데이터 선택", path: "/ec2/instances/launch" },
    { done: project.networkPaths.some((p) => p.lastAnalysis), text: "Reachability Analyzer로 통신 경로 분석", path: "/vpc/reachability/create" },
  ];

  return (
    <SpaceBetween>
      <PageHeader
        title="콘솔 홈"
        info={<InfoLink topic="console" />}
        description={`샌드박스 "${project.name}" — 모든 리소스는 이 브라우저 안에서만 존재하는 가상 리소스입니다.`}
        actions={<Button onClick={openLabs}>실습 가이드 열기</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Container className="lg:col-span-2" header={<ContainerHeader title="시작하기" description="앱이 미리 만들어 두는 리소스는 없습니다. 아래 순서대로 직접 구성해 보세요." />}>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {s.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-aws-success" aria-label="완료" /> : <Circle className="mt-0.5 size-4 shrink-0 text-aws-text-3" aria-label="미완료" />}
                <a href={href(s.path)} className={cn("hover:underline", s.done ? "text-aws-text-2" : "text-aws-link")}>
                  {i + 1}. {s.text}
                </a>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[13px] text-aws-text-2">
            AWS 계정처럼 기본 VPC로 빠르게 시작하려면 VPC 목록에서 <a href={href("/vpc/vpcs")} className="text-aws-link hover:underline">작업 → 기본 VPC 생성</a>을 선택할 수 있습니다.
          </p>
        </Container>
        <Container header={<ContainerHeader title="구성 상태" />}>
          <SpaceBetween size="s">
            <a href={href("/checks")} className="block rounded-lg p-1 hover:bg-aws-surface-2">
              <p className="text-xs font-bold text-aws-text-2">구성 검사</p>
              <div className="mt-1 flex flex-wrap gap-3">
                <StatusIndicator type={counts.error ? "error" : "success"}>오류 {counts.error}</StatusIndicator>
                <StatusIndicator type={counts.warning ? "warning" : "success"}>경고 {counts.warning}</StatusIndicator>
                <StatusIndicator type="info">정보 {counts.info}</StatusIndicator>
              </div>
            </a>
            <a href={href("/billing")} className="block rounded-lg p-1 hover:bg-aws-surface-2">
              <p className="text-xs font-bold text-aws-text-2">가상 월 비용 추정 (실제 요금 아님)</p>
              <p className="mt-1 text-2xl font-bold text-aws-text">{formatMoney(cost.total)}</p>
            </a>
            <p className="text-xs text-aws-text-2">리소스 {project.resources.length}개 · 저장된 분석 경로 {project.networkPaths.length}개</p>
          </SpaceBetween>
        </Container>
      </div>
      <Container header={<ContainerHeader title="서비스" />}>
        <div className="grid gap-4 md:grid-cols-3">
          {SERVICES.map((s) => (
            <a key={s.id} href={href(s.root)} className="group rounded-xl border border-aws-border p-4 hover:border-aws-link hover:bg-aws-surface-2">
              <div className="flex items-center gap-2">
                <s.icon className="size-5 text-aws-text-2 group-hover:text-aws-link" aria-hidden />
                <span className="text-base font-bold text-aws-link">{s.name}</span>
              </div>
              <p className="mt-1 text-[13px] text-aws-text-2">{s.description}</p>
              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {serviceCounts[s.id].map((c) => (
                  <div key={c.label} className="text-[13px]">
                    <dt className="inline text-aws-text-2">{c.label} </dt>
                    <dd className="inline font-bold text-aws-text">{c.value}</dd>
                  </div>
                ))}
              </dl>
            </a>
          ))}
        </div>
      </Container>
      <Container header={<ContainerHeader title="도구" />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {TOOLS.map((t) => (
            <a key={t.id} href={href(t.path)} className="rounded-xl border border-aws-border p-3 hover:border-aws-link hover:bg-aws-surface-2">
              <t.icon className="size-5 text-aws-text-2" aria-hidden />
              <p className="mt-2 text-sm font-bold text-aws-link">{t.name}</p>
              <p className="text-xs text-aws-text-2">{t.description}</p>
            </a>
          ))}
        </div>
      </Container>
      <div className="flex justify-end">
        <ButtonLink variant="link" href="/">
          샌드박스 목록으로
        </ButtonLink>
      </div>
    </SpaceBetween>
  );
}
