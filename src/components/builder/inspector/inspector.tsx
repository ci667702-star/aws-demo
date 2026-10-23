"use client";

import { useMemo } from "react";
import { displayName } from "@/lib/engine/topology-engine";
import { CircleX, Copy, Info, Keyboard, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResourceIcon, ToneBadge } from "@/components/resource-visuals";
import {
  RELATION_SPECS,
  RESOURCE_TYPE_INFO,
  RESOURCE_TYPES,
  type Connection,
  type Resource,
} from "@/lib/engine/resource-models";
import { deleteResources, disconnect, renameProject, updateRouteDestination } from "@/lib/project/mutations";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "@/components/console/analysis-context";
import { edgeLabel } from "@/components/console/map/canvas-model";
import { AlbForm, Ec2Form, TargetGroupForm } from "./compute-forms";
import { DbSubnetGroupForm, RdsForm } from "./database-forms";
import { Callout, InfoRow, Section, TextField } from "./fields";
import { ResourceLink, type FormContext } from "./form-shared";
import { EipForm, IgwForm, NatForm, RouteTableForm, SubnetForm, VpcForm } from "./network-forms";
import { validateCidrInput } from "./rule-editors";
import { NetworkAclForm, SecurityGroupForm } from "./security-forms";
import { useProjectActions } from "./use-project-actions";

export function Inspector({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId]);
  const analysis = useAnalysis();
  const actions = useProjectActions(projectId);
  const selectedResourceIds = useEditorStore((s) => s.selectedResourceIds);
  const selectedConnectionIds = useEditorStore((s) => s.selectedConnectionIds);
  const focusResources = useEditorStore((s) => s.focusResources);
  const setBottomTab = useEditorStore((s) => s.setBottomTab);

  const ctx: FormContext = useMemo(
    () => ({ projectId, project: project!, analysis, actions, focus: (id: string) => focusResources([id]) }),
    [projectId, project, analysis, actions, focusResources],
  );
  if (!project) return null;

  const resources = selectedResourceIds.map((id) => project.resources.find((r) => r.id === id)).filter((r): r is Resource => !!r);
  const connections = selectedConnectionIds
    .map((id) => project.connections.find((c) => c.id === id))
    .filter((c): c is Connection => !!c);

  let body: React.ReactNode;
  if (resources.length === 1 && connections.length === 0) body = <ResourceInspector resource={resources[0]} ctx={ctx} onShowValidation={() => setBottomTab("validation")} />;
  else if (resources.length === 0 && connections.length === 1) body = <ConnectionInspector connection={connections[0]} ctx={ctx} />;
  else if (resources.length + connections.length > 1)
    body = <MultiInspector resources={resources} connections={connections} ctx={ctx} />;
  else body = <ProjectOverview ctx={ctx} onShowValidation={() => setBottomTab("validation")} />;

  return (
    <ScrollArea className="h-full" data-testid="inspector">
      <div className="pb-8">{body}</div>
    </ScrollArea>
  );
}

function ResourceInspector({ resource, ctx, onShowValidation }: { resource: Resource; ctx: FormContext; onShowValidation: () => void }) {
  const info = RESOURCE_TYPE_INFO[resource.type];
  const findings = ctx.analysis.findingsByResource.get(resource.id) ?? [];
  const important = findings.filter((f) => f.severity !== "info");
  const setSelection = useEditorStore((s) => s.setSelection);
  return (
    <div>
      <div className="space-y-3 border-b p-4">
        <div className="flex items-start gap-3">
          <ResourceIcon type={resource.type} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">{info.label}</p>
            <p className="truncate font-semibold" title={displayName(resource)}>
              {displayName(resource)}
            </p>
            <button
              type="button"
              className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                void navigator.clipboard?.writeText(resource.id).then(
                  () => toast.success("가상 리소스 ID를 복사했습니다."),
                  () => toast.error("클립보드에 복사할 수 없습니다."),
                );
              }}
              title="가상 ID 복사 (실제 AWS ID 아님)"
            >
              {resource.id} <Copy className="size-3" aria-hidden />
            </button>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${displayName(resource)} 삭제`}
            onClick={() => {
              const err = ctx.actions.run(`${displayName(resource)} 삭제`, (p) => deleteResources(p, [resource.id]));
              if (!err) {
                toast.success(`${displayName(resource)}을(를) 삭제했습니다.`, { description: "실행 취소(Ctrl+Z)로 되돌릴 수 있습니다." });
                setSelection([], []);
              }
            }}
          >
            <Trash2 />
          </Button>
        </div>
        <TextField
          label="이름"
          value={resource.name}
          testId="resource-name"
          validate={(v) => (!v.trim() ? "이름을 입력하세요." : v.trim().length > 128 ? "128자 이하여야 합니다." : null)}
          onCommit={(v) => ctx.actions.rename(resource, v.trim())}
        />
        <p className="text-[11px] text-muted-foreground">{info.description}</p>
        {important.length > 0 && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2">
            {important.slice(0, 4).map((f) => (
              <p key={f.id} className="flex items-start gap-1.5 text-xs">
                {f.severity === "error" ? (
                  <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-600" aria-label="오류" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-label="경고" />
                )}
                <span>
                  <span className="font-medium">{f.title}</span>
                  <span className="block text-muted-foreground">{f.cause}</span>
                </span>
              </p>
            ))}
            <Button variant="link" size="xs" className="h-auto px-0" onClick={onShowValidation}>
              검증 센터에서 전체 보기 ({findings.length})
            </Button>
          </div>
        )}
      </div>
      <ResourceForm resource={resource} ctx={ctx} />
    </div>
  );
}

function ResourceForm({ resource, ctx }: { resource: Resource; ctx: FormContext }) {
  switch (resource.type) {
    case "vpc":
      return <VpcForm vpc={resource} ctx={ctx} />;
    case "subnet":
      return <SubnetForm subnet={resource} ctx={ctx} />;
    case "internet-gateway":
      return <IgwForm igw={resource} ctx={ctx} />;
    case "route-table":
      return <RouteTableForm rt={resource} ctx={ctx} />;
    case "nat-gateway":
      return <NatForm nat={resource} ctx={ctx} />;
    case "elastic-ip":
      return <EipForm eip={resource} ctx={ctx} />;
    case "security-group":
      return <SecurityGroupForm sg={resource} ctx={ctx} />;
    case "network-acl":
      return <NetworkAclForm nacl={resource} ctx={ctx} />;
    case "ec2":
      return <Ec2Form ec2={resource} ctx={ctx} />;
    case "alb":
      return <AlbForm alb={resource} ctx={ctx} />;
    case "target-group":
      return <TargetGroupForm tg={resource} ctx={ctx} />;
    case "db-subnet-group":
      return <DbSubnetGroupForm group={resource} ctx={ctx} />;
    case "rds":
      return <RdsForm rds={resource} ctx={ctx} />;
  }
}

function ConnectionInspector({ connection, ctx }: { connection: Connection; ctx: FormContext }) {
  const spec = RELATION_SPECS[connection.relationType];
  const setSelection = useEditorStore((s) => s.setSelection);
  return (
    <div>
      <div className="space-y-2 border-b p-4">
        <p className="text-xs font-medium text-muted-foreground">연결 (관계)</p>
        <p className="font-semibold">
          {RESOURCE_TYPE_INFO[spec.source].shortLabel} → {RESOURCE_TYPE_INFO[spec.target].shortLabel}: {spec.label}
        </p>
        <p className="text-xs text-muted-foreground">{spec.description}</p>
      </div>
      <Section title="관계">
        <InfoRow label="출발 (source)">
          <ResourceLink ctx={ctx} id={connection.sourceResourceId} />
        </InfoRow>
        <InfoRow label="대상 (target)">
          <ResourceLink ctx={ctx} id={connection.targetResourceId} />
        </InfoRow>
        <InfoRow label="관계 유형" mono>
          {connection.relationType}
        </InfoRow>
        {(connection.relationType === "route-table-internet-gateway" || connection.relationType === "route-table-nat-gateway") && (
          <TextField
            label="경로 Destination CIDR"
            value={connection.metadata.destinationCidr}
            mono
            validate={validateCidrInput}
            onCommit={(v) => ctx.actions.run("경로 Destination 변경", (p) => updateRouteDestination(p, connection.id, v.trim()))}
          />
        )}
        {connection.relationType === "alb-target-group" && (
          <InfoRow label="리스너">{edgeLabel(connection, ctx.analysis.topology)}</InfoRow>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            const err = ctx.actions.run("연결 삭제", (p) => disconnect(p, [connection.id]));
            if (!err) {
              toast.success("연결을 삭제했습니다.", { description: "검증과 시뮬레이션 결과에 즉시 반영됩니다." });
              setSelection([], []);
            }
          }}
        >
          <Trash2 /> 연결 삭제
        </Button>
      </Section>
    </div>
  );
}

function MultiInspector({ resources, connections, ctx }: { resources: Resource[]; connections: Connection[]; ctx: FormContext }) {
  const setSelection = useEditorStore((s) => s.setSelection);
  return (
    <div className="space-y-3 p-4">
      <p className="font-semibold">
        {resources.length}개 리소스 · {connections.length}개 연결 선택됨
      </p>
      <ul className="space-y-1 text-sm">
        {resources.map((r) => (
          <li key={r.id}>
            <ResourceLink ctx={ctx} id={r.id} />
          </li>
        ))}
      </ul>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          const err = ctx.actions.run(`선택 항목 삭제`, (p) => {
            let next = p;
            const ids = connections.map((c) => c.id).filter((id) => next.connections.some((c) => c.id === id));
            if (ids.length) {
              const d = disconnect(next, ids);
              if (!d.ok) return d;
              next = d.project;
            }
            if (resources.length) return deleteResources(next, resources.map((r) => r.id));
            return { ok: true, project: next, notes: [] };
          });
          if (!err) {
            toast.success("선택 항목을 삭제했습니다.");
            setSelection([], []);
          }
        }}
      >
        <Trash2 /> 선택 항목 삭제
      </Button>
      <p className="text-xs text-muted-foreground">Delete 또는 Backspace 키로도 삭제할 수 있습니다.</p>
    </div>
  );
}

function ProjectOverview({ ctx, onShowValidation }: { ctx: FormContext; onShowValidation: () => void }) {
  const { project, analysis } = ctx;
  const counts = RESOURCE_TYPES.map((t) => [t, project.resources.filter((r) => r.type === t).length] as const);
  return (
    <div>
      <div className="space-y-3 border-b p-4">
        <p className="text-xs font-medium text-muted-foreground">프로젝트</p>
        <TextField
          label="프로젝트 이름"
          value={project.name}
          maxLength={100}
          validate={(v) => (!v.trim() ? "이름을 입력하세요." : null)}
          onCommit={(v) => ctx.actions.run("프로젝트 이름 변경", (p) => renameProject(p, v))}
        />
        <TextField
          label="설명"
          value={project.description}
          maxLength={500}
          onCommit={(v) =>
            ctx.actions.run("프로젝트 설명 변경", (p) => ({
              ok: true,
              project: { ...p, description: v, updatedAt: new Date().toISOString() },
              notes: [],
            }))
          }
        />
      </div>
      <Section title="검증 요약">
        <div className="flex flex-wrap gap-1.5">
          <ToneBadge tone={analysis.counts.error ? "error" : "ok"}>오류 {analysis.counts.error}</ToneBadge>
          <ToneBadge tone={analysis.counts.warning ? "warn" : "ok"}>경고 {analysis.counts.warning}</ToneBadge>
          <ToneBadge tone="info">정보 {analysis.counts.info}</ToneBadge>
        </div>
        <Button variant="outline" size="xs" onClick={onShowValidation}>
          검증 센터 열기
        </Button>
      </Section>
      <Section title={`리소스 (${project.resources.length})`}>
        <ul className="grid grid-cols-2 gap-1.5 text-xs">
          {counts.map(([type, n]) => (
            <li key={type} className="flex items-center gap-1.5">
              <ResourceIcon type={type} size="sm" />
              <span className="truncate">{RESOURCE_TYPE_INFO[type].shortLabel}</span>
              <span className="ml-auto font-medium">{n}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="사용 방법">
        <Callout>
          <p className="flex items-center gap-1 font-medium">
            <Info className="size-3.5" aria-hidden /> 리소스를 선택하면 여기에서 설정을 편집할 수 있습니다.
          </p>
        </Callout>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li>• 팔레트 항목을 캔버스로 끌어다 놓거나 클릭해 추가 (VPC/서브넷 영역 위에 놓으면 자동 연결)</li>
          <li>• 노드 위·아래의 연결점(●)을 다른 노드로 드래그해 관계 생성</li>
          <li>• 연결선을 클릭해 선택한 뒤 × 버튼이나 Delete 키로 삭제</li>
          <li>• Shift + 드래그: 영역 선택 · Ctrl/⌘ + 클릭: 다중 선택</li>
        </ul>
        <p className="flex items-center gap-1 text-xs font-medium">
          <Keyboard className="size-3.5" aria-hidden /> 단축키
        </p>
        <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
          <li>Ctrl/⌘+Z 실행 취소 · Ctrl/⌘+Shift+Z / Ctrl+Y 다시 실행</li>
          <li>Delete / Backspace 선택 항목 삭제</li>
        </ul>
      </Section>
    </div>
  );
}
