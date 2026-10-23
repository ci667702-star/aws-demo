"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { METRIC_CATALOG, MINUTE, NAMESPACE_RESOURCE } from "@/lib/engine/cloudwatch-engine";
import type { Dashboard, DashboardWidget, MetricRef } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { addWidget, createDashboard, deleteDashboard, removeWidget } from "@/lib/project/cloudwatch-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useAnalysis } from "../../analysis-context";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormField, MultiSelect, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { ResourceTable } from "../../ui/table";
import { periodForRange, RangePicker, refKey, seriesFor, useMetricModel, useNow } from "./cw-shared";
import { MetricCharts } from "./cw-metrics";
import { MetricNumber } from "./metric-chart";

export function DashboardListPage() {
  const project = useProject();
  const run = useRunAction();
  const dashboards = project.services.cloudwatch.dashboards;
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<"create" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = dashboards.find((d) => d.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Dashboard>
        ariaLabel="대시보드 목록"
        items={dashboards}
        trackBy={(d) => d.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(d) => d.name}
        header={
          <PageHeader
            title="대시보드"
            counter={`(${dashboards.length})`}
            info={<InfoLink topic="cloudwatch" />}
            description="자주 보는 그래프를 한 화면에 모아 둡니다. 예: 웹 서비스 대시보드 = ALB 요청 수 + 응답 시간 + EC2 CPU"
            actions={
              <>
                <Button disabled={!current} onClick={() => setModal("delete")}>
                  삭제
                </Button>
                <Button variant="primary" onClick={() => setModal("create")}>
                  대시보드 생성
                </Button>
              </>
            }
          />
        }
        empty={<EmptyState title="대시보드 없음" description="대시보드를 만들고 지표 위젯을 추가해 보세요." action={<Button onClick={() => setModal("create")}>대시보드 생성</Button>} />}
        columns={[
          { id: "name", header: "이름", cell: (d) => <a className="font-bold text-aws-link hover:underline" href={href(`/cloudwatch/dashboards/${d.id}`)}>{d.name}</a>, sortValue: (d) => d.name },
          { id: "widgets", header: "위젯", cell: (d) => `${d.widgets.length}개` },
          { id: "created", header: "생성일", cell: (d) => formatDateTime(d.createdAt), sortValue: (d) => d.createdAt },
        ]}
      />
      {modal === "create" && (
        <Modal
          open
          size="small"
          onClose={() => setModal(null)}
          title="대시보드 생성"
          footer={
            <>
              <Button variant="link" onClick={() => setModal(null)}>
                취소
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const r = run("PutDashboard", (p) => createDashboard(p, name), { success: () => `대시보드 ${name.trim()}을(를) 만들었습니다.` });
                  if (!r.ok) return setError(withHint(r));
                  setModal(null);
                  navigate(`/cloudwatch/dashboards/${r.createdId}`);
                }}
              >
                대시보드 생성
              </Button>
            </>
          }
        >
          <SpaceBetween size="m">
            <FormField label="대시보드 이름" constraint="영문자, 숫자, 하이픈(-), 밑줄(_)만 사용">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="web-service" />
            </FormField>
            {error && <ErrorAlert message={error} />}
          </SpaceBetween>
        </Modal>
      )}
      {modal === "delete" && current && (
        <DeleteModal
          open
          onClose={() => setModal(null)}
          title={`대시보드 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteDashboards", (p) => deleteDashboard(p, current.id), { success: () => `대시보드 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>대시보드만 삭제되며 지표와 경보는 그대로 남습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

function WidgetCard({ widget, range, now, onRemove }: { widget: DashboardWidget; range: number; now: number; onRemove: () => void }) {
  const project = useProject();
  const model = useMetricModel();
  const period = periodForRange(range);
  return (
    <Container
      header={
        <ContainerHeader
          title={widget.title}
          actions={
            <Button variant="icon" aria-label={`${widget.title} 위젯 삭제`} onClick={onRemove}>
              <Trash2 aria-hidden />
            </Button>
          }
        />
      }
    >
      {widget.type === "number" ? (
        <MetricNumber series={seriesFor(model, project, widget.metrics, period, now - range * MINUTE, now)} />
      ) : (
        <MetricCharts refs={widget.metrics} range={range} period={period} now={now} />
      )}
    </Container>
  );
}

export function DashboardDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const now = useNow();
  const [range, setRange] = useState(180);
  const [adding, setAdding] = useState(false);
  const dashboard = project.services.cloudwatch.dashboards.find((d) => d.id === id);
  if (!dashboard) {
    return (
      <Container>
        <EmptyState title="대시보드를 찾을 수 없습니다" action={<ButtonLink href={href("/cloudwatch/dashboards")}>대시보드 목록</ButtonLink>} />
      </Container>
    );
  }
  return (
    <SpaceBetween>
      <PageHeader
        title={dashboard.name}
        info={<InfoLink topic="cloudwatch" />}
        description="모든 위젯이 위에서 고른 같은 기간을 보여 줍니다. 15초마다 자동으로 새로 고칩니다."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            위젯 추가
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <RangePicker value={range} onChange={setRange} />
        <span className="text-sm text-aws-text-2">{periodForRange(range) / 60}분 간격</span>
      </div>
      {dashboard.widgets.length === 0 ? (
        <Container>
          <EmptyState title="위젯이 없습니다" description="위젯 추가를 눌러 그래프나 숫자를 넣으세요." action={<Button onClick={() => setAdding(true)}>위젯 추가</Button>} />
        </Container>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {dashboard.widgets.map((w) => (
            <WidgetCard key={w.id} widget={w} range={range} now={now} onRemove={() => run("PutDashboard", (p) => removeWidget(p, dashboard.id, w.id), { success: () => `위젯 ${w.title}을(를) 삭제했습니다.`, flashError: true })} />
          ))}
        </div>
      )}
      {adding && <AddWidgetModal dashboard={dashboard} onClose={() => setAdding(false)} />}
    </SpaceBetween>
  );
}

function AddWidgetModal({ dashboard, onClose }: { dashboard: Dashboard; onClose: () => void }) {
  const run = useRunAction();
  const { topology } = useAnalysis();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"line" | "number">("line");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const options = METRIC_CATALOG.flatMap((def) =>
    topology.ofType(NAMESPACE_RESOURCE[def.namespace]).map((r) => ({
      value: refKey({ namespace: def.namespace, metricName: def.metricName, resourceId: r.id }),
      label: `${displayName(r)} · ${def.label}`,
      description: `${def.namespace} ${def.metricName}`,
    })),
  );
  const save = () => {
    const metrics: MetricRef[] = selected.map((k) => {
      const [namespace, metricName, resourceId] = k.split("|");
      const def = METRIC_CATALOG.find((m) => m.namespace === namespace && m.metricName === metricName)!;
      return { namespace: def.namespace, metricName, resourceId, stat: def.defaultStat };
    });
    const r = run("PutDashboard", (p) => addWidget(p, dashboard.id, { title: title || "위젯", type, metrics }), { success: () => "위젯을 추가했습니다." });
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      size="large"
      onClose={onClose}
      title="위젯 추가"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            위젯 만들기
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <FormField label="위젯 유형">
          <Tiles
            aria-label="위젯 유형"
            columns={2}
            value={type}
            onChange={(v) => setType(v as "line" | "number")}
            items={[
              { value: "line", label: "선 그래프", description: "시간에 따른 변화를 봅니다." },
              { value: "number", label: "숫자", description: "가장 최근 값과 작은 추세선" },
            ]}
          />
        </FormField>
        <FormField label="위젯 제목">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 웹 서버 CPU" maxLength={100} />
        </FormField>
        <FormField label="지표 (최대 5개)" description="단위가 다른 지표를 섞으면 선 그래프는 단위별로 나눠서 그립니다.">
          {options.length ? (
            <MultiSelect aria-label="지표" selected={selected} onChange={setSelected} max={5} options={options} placeholder="리소스나 지표 이름으로 찾기" />
          ) : (
            <p className="text-sm text-aws-text-2">지표를 남기는 리소스(EC2, 로드 밸런서, RDS, NAT 게이트웨이)가 없습니다.</p>
          )}
        </FormField>
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}
