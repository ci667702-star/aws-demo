"use client";

import { useEffect, useRef } from "react";
import { alarmHistory, loadStatus, type AlarmState } from "@/lib/engine/cloudwatch-engine";
import type { MetricRef } from "@/lib/engine/resource-models";
import { useAnalysis } from "../../analysis-context";
import { useProject } from "../../console-context";
import { notify } from "../../notify";
import { href } from "../../router";
import { ButtonLink } from "../../ui/button";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { PageGuide } from "../../ui/page-guide";
import { StatusIndicator, type StatusType } from "../../ui/status";
import { StartTutorialButton } from "../../tutorial/tutorial-menu";
import { conditionText } from "./cw-alarms";
import { MetricCharts } from "./cw-metrics";
import { AlarmStateBadge, useMetricModel, useNow } from "./cw-shared";

function StatTile({ label, value, status, path }: { label: string; value: number; status: StatusType; path: string }) {
  return (
    <a href={href(path)} className="block rounded-2xl border border-aws-border bg-aws-surface p-5 shadow-[0_1px_3px_rgba(0,7,22,0.08)] transition-colors hover:border-aws-link">
      <StatusIndicator type={status}>
        <span className="text-sm font-bold text-aws-text-2">{label}</span>
      </StatusIndicator>
      <p className="mt-2 text-[32px] leading-none font-bold text-aws-text">{value}</p>
    </a>
  );
}

const STEPS = [
  { title: "가상 부하 만들기", body: "웹 서버나 로드 밸런서에 분당 요청 수를 정해 부하를 줍니다.", path: "/cloudwatch/load" },
  { title: "지표 그래프 보기", body: "CPU 사용률이나 요청 수가 어떻게 바뀌는지 확인합니다.", path: "/cloudwatch/metrics" },
  { title: "경보 만들기", body: "예: CPU가 70%를 넘으면 경보 상태가 되도록 조건을 정합니다.", path: "/cloudwatch/alarms/create" },
  { title: "대시보드 만들기", body: "자주 보는 그래프를 한 화면에 모읍니다.", path: "/cloudwatch/dashboards" },
];

export function CloudWatchOverviewPage() {
  const project = useProject();
  const { topology } = useAnalysis();
  const model = useMetricModel();
  const now = useNow();
  const alarms = project.services.cloudwatch.alarms;
  const states = alarms.map((a) => ({ alarm: a, state: alarmHistory(model, a, now, 60).current.state }));
  const count = (s: AlarmState) => states.filter((x) => x.state === s).length;
  const inAlarm = states.filter((s) => s.state === "ALARM");
  const running = topology.ofType("ec2").filter((i) => i.config.state === "running").slice(0, 5);
  const albs = topology.ofType("alb").slice(0, 5);
  const activeLoads = project.services.cloudwatch.loads.filter((l) => loadStatus(l, now) === "running").length;
  const cpuRefs: MetricRef[] = running.map((i) => ({ namespace: "AWS/EC2", metricName: "CPUUtilization", resourceId: i.id, stat: "Average" }));
  const albRefs: MetricRef[] = albs.map((a) => ({ namespace: "AWS/ApplicationELB", metricName: "RequestCount", resourceId: a.id, stat: "Sum" }));
  return (
    <SpaceBetween>
      <PageHeader
        title="CloudWatch 개요"
        info={<InfoLink topic="cloudwatch" />}
        description="CloudWatch는 리소스의 상태를 숫자(지표)로 모으고, 이상하면 경보로 알려 주는 모니터링 서비스입니다. 이 샌드박스의 지표는 실제 수집값이 아니라 설정과 가상 부하로 계산한 값입니다."
        actions={
          <>
            <StartTutorialButton tutorialId="cloudwatch-alarm" label="따라하기 튜토리얼" />
            <ButtonLink variant="primary" href={href("/cloudwatch/alarms/create")}>
              경보 생성
            </ButtonLink>
          </>
        }
      />
      <PageGuide topic="cloudwatch" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="경보 상태" value={count("ALARM")} status="error" path="/cloudwatch/alarms" />
        <StatTile label="정상" value={count("OK")} status="success" path="/cloudwatch/alarms" />
        <StatTile label="데이터 부족" value={count("INSUFFICIENT_DATA")} status="pending" path="/cloudwatch/alarms" />
        <StatTile label="진행 중인 부하" value={activeLoads} status="info" path="/cloudwatch/load" />
      </div>
      <Container header={<ContainerHeader title="경보 상태인 경보" info={<InfoLink topic="cloudwatch-alarm" />} />}>
        {alarms.length === 0 ? (
          <p className="text-[15px] text-aws-text-2">아직 경보가 없습니다. 아래 &apos;시작하기&apos;를 따라 만들어 보세요.</p>
        ) : inAlarm.length === 0 ? (
          <StatusIndicator type="success">경보 상태인 경보가 없습니다.</StatusIndicator>
        ) : (
          <ul className="divide-y divide-aws-divider">
            {inAlarm.map(({ alarm }) => (
              <li key={alarm.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div>
                  <a className="font-bold text-aws-link hover:underline" href={href(`/cloudwatch/alarms/${alarm.id}`)}>
                    {alarm.name}
                  </a>
                  <p className="text-sm text-aws-text-2">{conditionText(alarm)}</p>
                </div>
                <AlarmStateBadge state="ALARM" />
              </li>
            ))}
          </ul>
        )}
      </Container>
      {cpuRefs.length > 0 && (
        <Container header={<ContainerHeader title="EC2 CPU 사용률 (최근 1시간)" description="실행 중인 인스턴스 최대 5대" />}>
          <MetricCharts refs={cpuRefs} range={60} period={60} now={now} />
        </Container>
      )}
      {albRefs.length > 0 && (
        <Container header={<ContainerHeader title="로드 밸런서 요청 수 (최근 1시간, 1분 합계)" />}>
          <MetricCharts refs={albRefs} range={60} period={60} now={now} />
        </Container>
      )}
      <Container header={<ContainerHeader title="시작하기" description="순서대로 해 보면 모니터링의 기본 흐름을 익힐 수 있습니다." />}>
        <ol className="grid gap-3 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <a href={href(s.path)} className="block h-full rounded-xl border border-aws-border bg-aws-surface-2 p-4 transition-colors hover:border-aws-link">
                <p className="text-sm font-bold text-aws-link">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-1 text-[15px] leading-relaxed">{s.body}</p>
              </a>
            </li>
          ))}
        </ol>
      </Container>
    </SpaceBetween>
  );
}

/**
 * 콘솔이 열려 있는 동안 경보 상태 변화를 지켜보다가 가상 알림(토스트)을 띄운다.
 * 실제 AWS의 SNS 알림(이메일·문자)을 흉내 낸 것으로, 아무것도 외부로 보내지 않는다.
 */
export function AlarmWatcher() {
  const project = useProject();
  const model = useMetricModel();
  const now = useNow();
  const previous = useRef<Map<string, AlarmState> | null>(null);
  useEffect(() => {
    const alarms = project.services.cloudwatch.alarms;
    const next = new Map(alarms.map((a) => [a.id, alarmHistory(model, a, now, 30).current.state]));
    const before = previous.current;
    previous.current = next;
    if (!before) return;
    for (const a of alarms) {
      if (!a.notify) continue;
      const was = before.get(a.id);
      const is = next.get(a.id);
      if (!is || was === is) continue;
      if (is === "ALARM") {
        notify({ type: "warning", title: `경보 ${a.name}이(가) 경보 상태(ALARM)가 되었습니다`, description: conditionText(a), action: { label: "경보 보기", href: `#/cloudwatch/alarms/${a.id}` } });
      } else if (is === "OK" && was === "ALARM") {
        notify({ type: "success", title: `경보 ${a.name}이(가) 정상(OK)으로 돌아왔습니다`, action: { label: "경보 보기", href: `#/cloudwatch/alarms/${a.id}` } });
      }
    }
  }, [project, model, now]);
  return null;
}
