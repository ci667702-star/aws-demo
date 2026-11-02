"use client";

import { useState } from "react";
import { formatMetricValue, METRIC_CATALOG, NAMESPACE_RESOURCE, rawValue, MINUTE, type MetricDefinition } from "@/lib/engine/cloudwatch-engine";
import type { MetricRef, Resource } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { addWidget, createDashboard } from "@/lib/project/cloudwatch-actions";
import { useAnalysis } from "../../analysis-context";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, resourceHref, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormField, SelectInput, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { Modal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { ResourceTable } from "../../ui/table";
import { periodForRange, RangePicker, refKey, seriesFor, STAT_OPTIONS, useMetricModel, useNow } from "./cw-shared";
import { MetricChart } from "./metric-chart";

const NAMESPACES: { value: MetricRef["namespace"]; label: string; description: string }[] = [
  { value: "AWS/EC2", label: "EC2", description: "인스턴스 CPU·네트워크" },
  { value: "AWS/ApplicationELB", label: "ApplicationELB", description: "요청 수·응답 시간·오류" },
  { value: "AWS/RDS", label: "RDS", description: "DB CPU·연결 수·저장 공간" },
  { value: "AWS/NATGateway", label: "NATGateway", description: "나간 데이터·연결 수" },
];

const CREATE_PATH: Record<string, { label: string; path: string }> = {
  ec2: { label: "인스턴스 시작", path: "/ec2/instances/launch" },
  alb: { label: "로드 밸런서 생성", path: "/ec2/load-balancers/select-type" },
  rds: { label: "데이터베이스 생성", path: "/rds/databases/create" },
  "nat-gateway": { label: "NAT 게이트웨이 생성", path: "/vpc/nat-gateways/create" },
};

interface Row {
  key: string;
  resource: Resource;
  def: MetricDefinition;
}

const MAX_SELECTED = 5;

/** 선택한 지표를 단위별로 나눠 그린다 (축은 언제나 하나) */
export function MetricCharts({ refs, range, period, now, threshold }: { refs: MetricRef[]; range: number; period: number; now: number; threshold?: { value: number; label: string } | null }) {
  const project = useProject();
  const model = useMetricModel();
  const start = now - range * MINUTE;
  const series = seriesFor(model, project, refs, period, start, now);
  const groups = new Map<string, typeof series>();
  for (const s of series) {
    const unit = s.unit ?? "Count";
    groups.set(unit, [...(groups.get(unit) ?? []), s]);
  }
  const UNIT_LABEL: Record<string, string> = { Percent: "퍼센트(%)", Count: "개수", Bytes: "바이트", Seconds: "초" };
  return (
    <SpaceBetween size="m">
      {groups.size > 1 && <p className="text-sm text-aws-text-2">단위가 다른 지표는 같은 축에 그리면 오해하기 쉬워 단위별로 나눠서 보여 줍니다.</p>}
      {[...groups.entries()].map(([unit, s]) => (
        <div key={unit} className="space-y-1">
          {groups.size > 1 && <p className="text-sm font-bold text-aws-text-2">{UNIT_LABEL[unit] ?? unit}</p>}
          <MetricChart series={s} start={start} end={now} threshold={threshold} ariaLabel={`${s.map((x) => x.label).join(", ")} 그래프`} />
        </div>
      ))}
    </SpaceBetween>
  );
}

export function MetricsPage() {
  const run = useRunAction();
  const { topology } = useAnalysis();
  const model = useMetricModel();
  const now = useNow();
  const { query } = useHashLocation();
  const initialNs = NAMESPACES.some((n) => n.value === query.get("ns")) ? (query.get("ns") as MetricRef["namespace"]) : "AWS/EC2";
  const [namespace, setNamespace] = useState<MetricRef["namespace"]>(initialNs);
  const [selected, setSelected] = useState<string[]>(() => {
    const r = query.get("resource");
    const m = query.get("metric");
    return r && m ? [refKey({ namespace: initialNs, metricName: m, resourceId: r })] : [];
  });
  const [range, setRange] = useState(60);
  const [stat, setStat] = useState("auto");
  const [limitNote, setLimitNote] = useState(false);
  const [adding, setAdding] = useState(false);

  const type = NAMESPACE_RESOURCE[namespace];
  const resources = topology.ofType(type) as Resource[];
  const defs = METRIC_CATALOG.filter((m) => m.namespace === namespace);
  const rows: Row[] = resources.flatMap((resource) => defs.map((def) => ({ key: refKey({ namespace, metricName: def.metricName, resourceId: resource.id }), resource, def })));
  const period = periodForRange(range);
  const refs: MetricRef[] = selected
    .map((k) => {
      const [ns, metricName, resourceId] = k.split("|");
      const def = METRIC_CATALOG.find((m) => m.namespace === ns && m.metricName === metricName);
      if (!def) return null;
      return { namespace: def.namespace, metricName, resourceId, stat: (stat === "auto" ? def.defaultStat : stat) as MetricRef["stat"] };
    })
    .filter((r): r is MetricRef => !!r && !!topology.get(r.resourceId));
  const minute = Math.floor(now / MINUTE) - 1;

  return (
    <SpaceBetween>
      <PageHeader
        title="지표"
        info={<InfoLink topic="cloudwatch" />}
        description="리소스가 1분마다 남기는 숫자(지표)를 그래프로 봅니다. 이 시뮬레이터의 지표는 리소스 상태와 가상 부하로 계산한 값입니다."
        actions={
          <>
            <Button disabled={!refs.length} onClick={() => setAdding(true)}>
              대시보드에 추가
            </Button>
            <Button
              variant="primary"
              disabled={refs.length !== 1}
              onClick={() => {
                const r = refs[0];
                navigate("/cloudwatch/alarms/create", { query: { ns: r.namespace, metric: r.metricName, resource: r.resourceId, stat: r.stat } });
              }}
            >
              경보 생성
            </Button>
          </>
        }
      />
      <PageGuide topic="cloudwatch" />
      <Container header={<ContainerHeader title="1. 네임스페이스" description="지표는 서비스별 묶음(네임스페이스)으로 나뉩니다." />}>
        <Tiles
          aria-label="네임스페이스"
          columns={4}
          value={namespace}
          onChange={(v) => {
            setNamespace(v as MetricRef["namespace"]);
            setSelected([]);
          }}
          items={NAMESPACES.map((n) => ({ value: n.value, label: `${n.label} (${topology.ofType(NAMESPACE_RESOURCE[n.value]).length})`, description: n.description }))}
        />
      </Container>
      <Container
        header={
          <ContainerHeader
            title="2. 그래프"
            description={refs.length ? `선택한 지표 ${refs.length}개 · ${period / 60}분 간격` : "아래 표에서 지표를 고르면 그래프가 그려집니다 (최대 5개)."}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <RangePicker value={range} onChange={setRange} />
                <SelectInput aria-label="통계" value={stat} onChange={setStat} options={[{ value: "auto", label: "통계: 지표 기본값" }, ...STAT_OPTIONS]} className="w-48" />
              </div>
            }
          />
        }
      >
        {refs.length ? <MetricCharts refs={refs} range={range} period={period} now={now} /> : <p className="py-6 text-center text-[15px] text-aws-text-2">아직 선택한 지표가 없습니다.</p>}
      </Container>
      {limitNote && <Alert type="info">한 그래프에는 지표를 {MAX_SELECTED}개까지 표시합니다.</Alert>}
      <ResourceTable<Row>
        ariaLabel="지표 목록"
        items={rows}
        trackBy={(r) => r.key}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={(ids) => {
          setLimitNote(ids.length > MAX_SELECTED);
          setSelected(ids.slice(0, MAX_SELECTED));
        }}
        rowLabel={(r) => `${displayName(r.resource)} ${r.def.label}`}
        filterPlaceholder="리소스 이름이나 지표 이름으로 찾기"
        header={<ContainerHeader title={`3. 지표 선택 — ${namespace}`} counter={`(${rows.length})`} />}
        empty={
          <EmptyState
            title="지표가 없습니다"
            description="이 네임스페이스의 리소스가 아직 없습니다."
            action={<ButtonLink href={href(CREATE_PATH[type].path)}>{CREATE_PATH[type].label}</ButtonLink>}
          />
        }
        columns={[
          {
            id: "resource",
            header: "리소스",
            cell: (r) => (
              <a className="text-aws-link hover:underline" href={resourceHref(r.resource.type, r.resource.id)}>
                {displayName(r.resource)}
              </a>
            ),
            sortValue: (r) => displayName(r.resource),
            filterValue: (r) => `${displayName(r.resource)} ${r.resource.id}`,
          },
          { id: "metric", header: "지표 이름", cell: (r) => <span className="font-mono text-[13px]">{r.def.metricName}</span>, sortValue: (r) => r.def.metricName, filterValue: (r) => `${r.def.metricName} ${r.def.label}` },
          { id: "label", header: "설명", cell: (r) => `${r.def.label} — ${r.def.description}` },
          { id: "latest", header: "최근 1분 값", cell: (r) => formatMetricValue(rawValue(model, { namespace, metricName: r.def.metricName, resourceId: r.resource.id }, minute), r.def.unit) },
        ]}
      />
      {adding && <AddToDashboardModal refs={refs} onClose={() => setAdding(false)} run={run} />}
    </SpaceBetween>
  );
}

function AddToDashboardModal({ refs, onClose, run }: { refs: MetricRef[]; onClose: () => void; run: ReturnType<typeof useRunAction> }) {
  const project = useProject();
  const dashboards = project.services.cloudwatch.dashboards;
  const [dashboardId, setDashboardId] = useState(dashboards[0]?.id ?? "new");
  const [newName, setNewName] = useState("my-dashboard");
  const [title, setTitle] = useState(refs.length === 1 ? (METRIC_CATALOG.find((m) => m.metricName === refs[0].metricName && m.namespace === refs[0].namespace)?.label ?? "지표") : "선택한 지표");
  const [type, setType] = useState<"line" | "number">("line");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    let targetId = dashboardId;
    const r = run(
      "PutDashboard",
      (p) => {
        let next = p;
        if (dashboardId === "new") {
          const created = createDashboard(next, newName);
          if (!created.ok) return created;
          next = created.project;
          targetId = created.createdId!;
        }
        return addWidget(next, targetId, { title, type, metrics: refs });
      },
      { success: () => "대시보드에 위젯을 추가했습니다.", successAction: () => ({ label: "대시보드 열기", href: `#/cloudwatch/dashboards/${targetId}` }) },
    );
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="대시보드에 추가"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            추가
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <FormField label="대시보드">
          <SelectInput value={dashboardId} onChange={setDashboardId} options={[...dashboards.map((d) => ({ value: d.id, label: d.name })), { value: "new", label: "새 대시보드 만들기" }]} />
        </FormField>
        {dashboardId === "new" && (
          <FormField label="새 대시보드 이름" constraint="영문자, 숫자, 하이픈(-), 밑줄(_)">
            <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} />
          </FormField>
        )}
        <FormField label="위젯 제목">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        </FormField>
        <FormField label="위젯 유형">
          <Tiles
            aria-label="위젯 유형"
            columns={2}
            value={type}
            onChange={(v) => setType(v as "line" | "number")}
            items={[
              { value: "line", label: "선 그래프", description: "시간에 따른 변화" },
              { value: "number", label: "숫자", description: "가장 최근 값" },
            ]}
          />
        </FormField>
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}
