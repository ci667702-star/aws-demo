"use client";

import { BookOpenCheck, CircleCheck, Circle, GraduationCap, Shapes } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { useMemo } from "react";
import { estimateCost } from "@/lib/engine/cost-engine";
import { firstWebServerSteps } from "@/lib/project/first-steps";
import { useGuidePrefs } from "@/lib/store/guide-prefs";
import { formatMoney } from "@/lib/ui/format";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { href } from "../router";
import { NAV_GROUPS } from "../shell/navigation";
import { StartTutorialButton } from "../tutorial/tutorial-menu";
import { Button } from "../ui/button";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink } from "../ui/links";
import { StatusIndicator } from "../ui/status";

export function ConsoleHomePage() {
  const projectId = useConsoleProjectId();
  const project = useProject();
  const { topology: topo, counts } = useAnalysis();
  const openLabs = useConsoleUi((s) => s.openLabs);
  const cost = useMemo(() => estimateCost(project), [project]);

  const steps = firstWebServerSteps(project, topo);
  const doneCount = steps.filter((s) => s.done).length;
  const nextHidden = useGuidePrefs((s) => !!s.nextStepHidden[projectId]);

  return (
    <SpaceBetween>
      <PageHeader
        title="콘솔 홈"
        info={<InfoLink topic="console" />}
        description={`샌드박스 "${project.name}" — 여기서 만드는 모든 리소스는 이 브라우저 안에서만 존재하는 가상 리소스입니다.`}
      />

      <section aria-label="무엇을 해 볼까요?" className="grid gap-4 @2xl/main:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-2xl border-2 border-aws-link/40 bg-aws-info-bg p-5" data-tour="home-tutorial">
          <GraduationCap className="size-7 text-aws-link" aria-hidden />
          <div>
            <h2 className="text-lg font-bold">따라하기</h2>
            <p className="mt-1 text-[15px] text-aws-text-2">화면 오른쪽 안내가 한 단계씩 알려 줍니다. 처음이라면 &apos;첫 웹 서버 만들기&apos;부터 시작하세요.</p>
          </div>
          <div className="mt-auto flex flex-wrap items-center gap-2">
            <StartTutorialButton tutorialId="first-web-server" variant="primary" />
            <StartTutorialButton tutorialId="console-tour" variant="link" label="화면 둘러보기 (1분)" />
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-2xl border border-aws-border bg-aws-surface p-5">
          <BookOpenCheck className="size-7 text-aws-success" aria-hidden />
          <div>
            <h2 className="text-lg font-bold">실습 문제</h2>
            <p className="mt-1 text-[15px] text-aws-text-2">목표만 주어지고 방법은 스스로 찾는 5가지 연습입니다. 설정이 맞으면 단계가 자동으로 완료됩니다.</p>
          </div>
          <div className="mt-auto">
            <Button onClick={openLabs}>실습 문제 목록 열기</Button>
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-2xl border border-aws-border bg-aws-surface p-5">
          <Shapes className="size-7 text-aws-warning" aria-hidden />
          <div>
            <h2 className="text-lg font-bold">쉬운 모드</h2>
            <p className="mt-1 text-[15px] text-aws-text-2">같은 샌드박스를 그림으로 봅니다. 리소스를 끌어다 놓고 선으로 연결해 설계할 수 있습니다.</p>
          </div>
          <div className="mt-auto">
            <Link href={`/projects/${projectId}`} className="inline-flex h-9 items-center rounded-full border-2 border-aws-link px-4 text-sm font-bold text-aws-link hover:bg-aws-info-bg">
              쉬운 모드로 열기
            </Link>
          </div>
        </div>
      </section>

      <div className="grid gap-5 @3xl/main:grid-cols-3">
        <Container
          className="@3xl/main:col-span-2"
          header={
            <ContainerHeader
              title={`직접 만들어 보기 (${doneCount}/${steps.length})`}
              description="앱이 미리 만들어 두는 리소스는 없습니다. 아래 순서대로 하나씩 만들면 인터넷에서 접속되는 웹 서버가 완성됩니다. 다른 화면에서도 위쪽 '다음 할 일' 줄이 이 순서를 알려 줍니다."
              actions={
                nextHidden ? (
                  <Button variant="link" onClick={() => useGuidePrefs.getState().setNextStepHidden(projectId, false)}>
                    다음 할 일 줄 다시 보이기
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={i}>
                <a href={href(s.consolePath)} className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-aws-surface-2">
                  {s.done ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-aws-success" aria-label="완료" /> : <Circle className="mt-0.5 size-5 shrink-0 text-aws-text-3" aria-label="미완료" />}
                  <span>
                    <span className={cn("block text-[15px] font-bold", s.done ? "text-aws-text-2" : "text-aws-link")}>
                      {i + 1}. {s.title}
                    </span>
                    <span className="block text-sm text-aws-text-2">{s.detail}</span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-aws-text-2">
            AWS 계정처럼 기본 VPC로 빠르게 시작하려면 VPC 목록의{" "}
            <a href={href("/vpc/vpcs")} className="text-aws-link hover:underline">
              작업 → 기본 VPC 생성
            </a>
            을 고르세요.
          </p>
        </Container>
        <Container header={<ContainerHeader title="내 샌드박스 상태" />}>
          <SpaceBetween size="m">
            <a href={href("/checks")} className="block rounded-xl p-2 hover:bg-aws-surface-2">
              <p className="text-sm font-bold text-aws-text-2">구성 검사</p>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <StatusIndicator type={counts.error ? "error" : "success"}>오류 {counts.error}</StatusIndicator>
                <StatusIndicator type={counts.warning ? "warning" : "success"}>경고 {counts.warning}</StatusIndicator>
                <StatusIndicator type="info">정보 {counts.info}</StatusIndicator>
              </div>
            </a>
            <a href={href("/billing")} className="block rounded-xl p-2 hover:bg-aws-surface-2">
              <p className="text-sm font-bold text-aws-text-2">가상 월 비용 (실제 요금 아님)</p>
              <p className="mt-1 text-2xl font-bold text-aws-text">{formatMoney(cost.total)}</p>
            </a>
            <p className="px-2 text-sm text-aws-text-2">
              네트워크 리소스 {project.resources.length}개 · S3 버킷 {project.services.s3.buckets.length}개 · IAM 사용자 {project.services.iam.users.length}명 · 경보{" "}
              {project.services.cloudwatch.alarms.length}개
            </p>
          </SpaceBetween>
        </Container>
      </div>

      <Container header={<ContainerHeader title="서비스" description="왼쪽 메뉴에서도 모든 서비스를 볼 수 있습니다." />}>
        <div className="grid gap-4 @xl/main:grid-cols-2 @3xl/main:grid-cols-4">
          {NAV_GROUPS.map((g) => {
            const total = g.items.reduce((sum, i) => sum + (i.count?.(topo, project) ?? 0), 0);
            return (
              <a key={g.id} href={href(g.root)} className="group flex flex-col gap-2 rounded-xl border border-aws-border p-4 hover:border-aws-link hover:bg-aws-surface-2">
                <span className="flex items-center gap-2">
                  <g.icon className="size-5 text-aws-link" aria-hidden />
                  <span className="text-[15px] font-bold text-aws-text group-hover:text-aws-link">{g.label}</span>
                </span>
                <span className="text-sm leading-relaxed text-aws-text-2">{g.description}</span>
                {total > 0 && <span className="text-[13px] font-bold text-aws-text-2">리소스 {total}개</span>}
              </a>
            );
          })}
        </div>
      </Container>
    </SpaceBetween>
  );
}
