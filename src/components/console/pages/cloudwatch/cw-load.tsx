"use client";

import { useState } from "react";
import { INSTANCE_CAPACITY_RPM, loadStatus, loadWindow, MINUTE, type LoadStatus } from "@/lib/engine/cloudwatch-engine";
import type { LoadTest } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { createLoadTest, deleteLoadTest, stopLoadTest } from "@/lib/project/cloudwatch-actions";
import { formatTime } from "@/lib/ui/format";
import { useAnalysis } from "../../analysis-context";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, SelectInput, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { useMetricModel, useNow } from "./cw-shared";

const RATE_PRESETS = [
  { value: "100", label: "가벼움", description: "분당 100건" },
  { value: "1000", label: "보통", description: "분당 1,000건" },
  { value: "5000", label: "많음", description: "분당 5,000건" },
  { value: "20000", label: "폭주", description: "분당 20,000건" },
];

const STATUS_BADGE: Record<LoadStatus, React.ReactNode> = {
  scheduled: <Badge>예정</Badge>,
  running: <Badge color="blue">진행 중</Badge>,
  finished: <Badge>종료</Badge>,
};

export function LoadTestPage() {
  const project = useProject();
  const run = useRunAction();
  const { topology } = useAnalysis();
  const model = useMetricModel();
  const now = useNow();
  const targets = [...topology.ofType("alb"), ...topology.ofType("ec2").filter((i) => i.config.state !== "terminated")];
  const [name, setName] = useState("spike-test");
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const target = topology.get(targetId);
  const ports = target?.type === "alb" ? target.config.listeners.map((l) => l.port) : target?.type === "ec2" ? target.config.listenPorts : [];
  const [port, setPort] = useState(String(ports[0] ?? 80));
  const [rate, setRate] = useState("1000");
  const [customRate, setCustomRate] = useState("");
  const [duration, setDuration] = useState("30");
  const [offset, setOffset] = useState("-15");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LoadTest | null>(null);
  const loads = project.services.cloudwatch.loads;
  const rpm = rate === "custom" ? Number(customRate) : Number(rate);
  const startMs = (Math.floor(now / MINUTE) + Number(offset)) * MINUTE;
  const endMs = startMs + Number(duration) * MINUTE;
  const remaining = Math.round((endMs - now) / MINUTE);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

  const start = () => {
    setError(null);
    const r = run(
      "StartLoadTest",
      (p) => createLoadTest(p, { name, targetId, port: Number(port), requestsPerMinute: rpm, durationMinutes: Number(duration), startOffsetMinutes: Number(offset) }),
      { success: () => `가상 부하 ${name.trim()}을(를) 시작했습니다.`, successAction: () => ({ label: "지표 보기", href: `#/cloudwatch/metrics?ns=${target?.type === "alb" ? "AWS/ApplicationELB" : "AWS/EC2"}&resource=${targetId}&metric=${target?.type === "alb" ? "RequestCount" : "CPUUtilization"}` }) },
    );
    if (!r.ok) setError(withHint(r));
  };

  const capacityHint =
    target?.type === "ec2"
      ? `이 인스턴스(${target.config.instanceType})는 분당 약 ${INSTANCE_CAPACITY_RPM[target.config.instanceType].toLocaleString("ko-KR")}건을 처리하면 CPU가 85% 정도가 된다고 가정합니다.`
      : target?.type === "alb"
        ? "요청은 정상(healthy) 대상에 고르게 나뉩니다. 정상 대상이 없으면 로드 밸런서가 5XX 오류로 응답합니다."
        : "";

  return (
    <SpaceBetween>
      <PageHeader
        title="가상 부하"
        info={<InfoLink topic="cloudwatch-load" />}
        description="실제 요청을 보내지 않고, 정해진 시간 동안 인터넷에서 대상으로 요청이 들어온다고 가정합니다. 보안 그룹·라우팅을 통과하는 요청만 지표(CPU, 요청 수 등)에 반영됩니다."
      />
      <PageGuide topic="cloudwatch-load" />
      {targets.length === 0 ? (
        <Container>
          <EmptyState title="부하를 줄 대상이 없습니다" description="EC2 인스턴스나 Application Load Balancer를 먼저 만드세요." action={<ButtonLink href={href("/ec2/instances/launch")}>인스턴스 시작</ButtonLink>} />
        </Container>
      ) : (
        <Container id="tour-cw-load-form" header={<ContainerHeader title="새 가상 부하" />}>
          <SpaceBetween size="m">
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="이름">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </FormField>
              <FormField label="대상">
                <SelectInput
                  value={targetId}
                  onChange={(v) => {
                    setTargetId(v);
                    const t = topology.get(v);
                    const p = t?.type === "alb" ? t.config.listeners[0]?.port : t?.type === "ec2" ? t.config.listenPorts[0] : undefined;
                    if (p) setPort(String(p));
                  }}
                  options={targets.map((t) => ({ value: t.id, label: `${t.type === "alb" ? "로드 밸런서" : "EC2"} ${displayName(t)}`, description: t.id }))}
                />
              </FormField>
              <FormField label="포트" constraint={ports.length ? `열려 있는 포트: ${ports.join(", ")}` : "대상에 열린 포트가 없습니다"}>
                <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" list="pg-load-ports" className="max-w-32" />
                <datalist id="pg-load-ports">
                  {ports.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </FormField>
            </div>
            <FormField label="분당 요청 수" description={capacityHint}>
              <Tiles aria-label="분당 요청 수" columns={4} value={rate} onChange={setRate} items={[...RATE_PRESETS, { value: "custom", label: "직접 입력", description: "1~100,000" }]} />
            </FormField>
            {rate === "custom" && (
              <FormField label="분당 요청 수 (직접 입력)">
                <TextInput value={customRate} onChange={(e) => setCustomRate(e.target.value)} inputMode="numeric" className="max-w-40" />
              </FormField>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="지속 시간">
                <SelectInput
                  value={duration}
                  onChange={setDuration}
                  options={[
                    { value: "10", label: "10분" },
                    { value: "30", label: "30분" },
                    { value: "60", label: "1시간" },
                    { value: "120", label: "2시간" },
                  ]}
                />
              </FormField>
              <FormField label="시작 시점" description="과거부터 시작한 것으로 하면 지난 기록이 생겨 그래프를 바로 볼 수 있습니다.">
                <SelectInput
                  value={offset}
                  onChange={setOffset}
                  options={[
                    { value: "0", label: "지금 시작" },
                    { value: "-15", label: "15분 전부터 진행 중" },
                    { value: "-30", label: "30분 전부터 진행 중" },
                    { value: "-60", label: "1시간 전부터 진행 중" },
                  ]}
                />
              </FormField>
            </div>
            {now > 0 &&
              (remaining > 0 ? (
                <p className="text-[15px]">
                  {clock(startMs)}에 시작해 {clock(endMs)}에 끝납니다 · <span className="font-bold">지금부터 약 {remaining}분 동안 진행</span>
                </p>
              ) : (
                <Alert type="warning">이 설정이면 시작하자마자 끝난 부하가 되어 지난 기록만 생깁니다. 지속 시간을 늘리거나 시작 시점을 늦추세요.</Alert>
              ))}
            <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
              <Button variant="primary" onClick={start}>
                부하 시작
              </Button>
            </FormActions>
          </SpaceBetween>
        </Container>
      )}
      <ResourceTable<LoadTest>
        ariaLabel="가상 부하 목록"
        items={loads}
        trackBy={(l) => l.id}
        header={<ContainerHeader title="가상 부하 기록" counter={`(${loads.length})`} description="부하를 삭제하면 그 부하로 생긴 지난 지표도 그래프에서 사라집니다." />}
        empty={<p className="py-6 text-center text-[15px] text-aws-text-2">아직 만든 부하가 없습니다.</p>}
        defaultSort={{ columnId: "start", descending: true }}
        columns={[
          { id: "name", header: "이름", cell: (l) => <span className="font-bold">{l.name}</span>, sortValue: (l) => l.name },
          {
            id: "target",
            header: "대상",
            cell: (l) => {
              const t = topology.get(l.targetId);
              return t ? `${displayName(t)} :${l.port}` : `${l.targetId} (삭제됨)`;
            },
          },
          { id: "rate", header: "분당 요청", cell: (l) => l.requestsPerMinute.toLocaleString("ko-KR"), sortValue: (l) => l.requestsPerMinute },
          {
            id: "start",
            header: "시간",
            cell: (l) => {
              const w = loadWindow(l);
              return `${formatTime(new Date(w.start * MINUTE).toISOString())} ~ ${formatTime(new Date(w.end * MINUTE).toISOString())}`;
            },
            sortValue: (l) => l.startAt,
          },
          { id: "status", header: "상태", cell: (l) => STATUS_BADGE[loadStatus(l, now)] },
          {
            id: "reach",
            header: "도달 여부",
            cell: (l) => {
              const reach = model.loads.find((x) => x.load.id === l.id);
              if (!reach) return "–";
              return (
                <span className="block max-w-80">
                  {reach.reaches && !reach.albOnly ? (
                    <StatusIndicator type="success">대상까지 도달</StatusIndicator>
                  ) : reach.albOnly ? (
                    <StatusIndicator type="warning">로드 밸런서까지만 도달 (5XX)</StatusIndicator>
                  ) : (
                    <StatusIndicator type="error">도달하지 못함</StatusIndicator>
                  )}
                  {!(reach.reaches && !reach.albOnly) && <span className="mt-0.5 block text-[13px] text-aws-text-2">{reach.reason}</span>}
                </span>
              );
            },
          },
          {
            id: "actions",
            header: "작업",
            cell: (l) => (
              <span className="flex flex-wrap gap-2">
                <Button disabled={loadStatus(l, now) !== "running"} onClick={() => run("StopLoadTest", (p) => stopLoadTest(p, l.id), { success: () => `가상 부하 ${l.name}을(를) 멈췄습니다.`, flashError: true })}>
                  중지
                </Button>
                <Button onClick={() => setDeleting(l)}>삭제</Button>
              </span>
            ),
          },
        ]}
      />
      {loads.some((l) => loadStatus(l, now) === "running") && (
        <Alert type="info">진행 중인 부하가 있습니다. 지표 화면이나 경보 화면은 15초마다 저절로 새로 고쳐집니다.</Alert>
      )}
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(null)}
          title={`가상 부하 ${deleting.name} 삭제`}
          confirmText="삭제"
          onConfirm={() => {
            const r = run("DeleteLoadTest", (p) => deleteLoadTest(p, deleting.id), { success: () => `가상 부하 ${deleting.name}을(를) 삭제했습니다.` });
            return r.ok ? null : withHint(r);
          }}
        >
          <p>이 부하로 생긴 지표 기록과 그에 따른 경보 기록도 다시 계산됩니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}
