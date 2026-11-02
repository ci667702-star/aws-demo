"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayName } from "@/lib/engine/topology-engine";
import { Copy, Info, Keyboard, Trash2 } from "lucide-react";
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
  type ResourceType,
  isRouteConnection,
} from "@/lib/engine/resource-models";
import { FieldHelpScope, revealField } from "@/components/docs/field-help";
import {
  AnalysisSection,
  DocHeader,
  DocSection,
  DocSectionNav,
  GeneralSection,
  LimitationSection,
  PinnedFieldHelp,
  RelationsSection,
  WhySection,
} from "@/components/docs/resource-doc-panel";
import { analyzeResource } from "@/lib/docs/resource-analysis";
import { deleteResources, disconnect, renameProject, updateRouteDestination } from "@/lib/project/mutations";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "@/components/console/analysis-context";
import { edgeLabel } from "@/components/console/map/canvas-model";
import { AlbForm, Ec2Form, TargetGroupForm } from "./compute-forms";
import { DbSubnetGroupForm, RdsForm } from "./database-forms";
import { ServiceDocPanel, TypeDocPanel, useBuilderDocActions } from "./doc-panels";
import { Callout, InfoRow, Section, TextField } from "./fields";
import { ResourceLink, type FormContext } from "./form-shared";
import { EipForm, IgwForm, NatForm, RouteTableForm, SubnetForm, VpcForm } from "./network-forms";
import { validateCidrInput } from "./rule-editors";
import { NetworkAclForm, SecurityGroupForm } from "./security-forms";
import { useProjectActions } from "./use-project-actions";

export function Inspector({ projectId, onAdd }: { projectId: string; onAdd?: (type: ResourceType) => void }) {
  const project = useProjectStore((s) => s.projects[projectId]);
  const analysis = useAnalysis();
  const actions = useProjectActions(projectId);
  const selectedResourceIds = useEditorStore((s) => s.selectedResourceIds);
  const selectedConnectionIds = useEditorStore((s) => s.selectedConnectionIds);
  const inspectorDoc = useEditorStore((s) => s.inspectorDoc);
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
  if (resources.length === 1 && connections.length === 0)
    // 리소스마다 새로 그려서 다른 리소스의 설명·입력값이 남지 않게 한다
    body = <ResourceInspector key={resources[0].id} resource={resources[0]} ctx={ctx} onShowValidation={() => setBottomTab("validation")} />;
  else if (resources.length === 0 && connections.length === 1) body = <ConnectionInspector connection={connections[0]} ctx={ctx} />;
  else if (resources.length + connections.length > 1)
    body = <MultiInspector resources={resources} connections={connections} ctx={ctx} />;
  else if (inspectorDoc?.kind === "preview") body = <TypeDocPanel key={`type-${inspectorDoc.type}`} type={inspectorDoc.type} from={inspectorDoc.from} ctx={ctx} onAdd={onAdd} />;
  else if (inspectorDoc?.kind === "service")
    body = <ServiceDocPanel key={`svc-${inspectorDoc.key}-${inspectorDoc.itemId ?? ""}`} docKey={inspectorDoc.key} itemId={inspectorDoc.itemId} from={inspectorDoc.from} ctx={ctx} />;
  else body = <ProjectOverview ctx={ctx} onShowValidation={() => setBottomTab("validation")} />;

  // 다른 리소스·설명으로 바뀌면 맨 위부터 보여 준다 (이전 화면의 스크롤 위치를 이어받지 않게)
  const bodyKey =
    resources.length === 1 && connections.length === 0
      ? `r-${resources[0].id}`
      : resources.length === 0 && connections.length === 1
        ? `c-${connections[0].id}`
        : resources.length + connections.length > 1
          ? "multi"
          : inspectorDoc?.kind === "preview"
            ? `t-${inspectorDoc.type}`
            : inspectorDoc?.kind === "service"
              ? `s-${inspectorDoc.key}-${inspectorDoc.itemId ?? ""}`
              : "overview";

  return (
    <ScrollArea key={bodyKey} className="h-full" data-testid="inspector">
      <div className="pb-8">{body}</div>
    </ScrollArea>
  );
}

/**
 * 리소스 상세 패널: 머리글(이름·서비스·요약) + A 기본 정보 · B 왜 사용하는가 · C 주요 설정(실제 편집 폼) ·
 * D 관련 리소스 · E 현재 구성 분석 · F 시뮬레이터 제한.
 * 설명 데이터는 src/lib/docs, 분석은 실제 토폴로지·검증·시뮬레이션 결과(analyzeResource)에서 가져온다.
 */
function ResourceInspector({ resource, ctx, onShowValidation }: { resource: Resource; ctx: FormContext; onShowValidation: () => void }) {
  const info = RESOURCE_TYPE_INFO[resource.type];
  const findings = ctx.analysis.findingsByResource.get(resource.id) ?? [];
  const setSelection = useEditorStore((s) => s.setSelection);
  const focusField = useEditorStore((s) => s.focusField);
  const fieldFocus = useEditorStore((s) => s.fieldFocus);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const openField = useCallback((field: string) => focusField(resource.id, field), [focusField, resource.id]);
  const docActions = useBuilderDocActions(ctx.projectId, resource.id, openField);
  const analysis = useMemo(() => analyzeResource(ctx.analysis, resource.id), [ctx.analysis, resource.id]);

  // '설정으로 이동' 요청 처리: 폼에 항목이 있으면 펼치고 강조, 없으면 그 설정의 도움말 카드를 보여 준다
  useEffect(() => {
    if (!fieldFocus || fieldFocus.resourceId !== resource.id) return;
    const { field } = fieldFocus;
    const timer = window.setTimeout(() => {
      useEditorStore.setState({ fieldFocus: null });
      const root = rootRef.current;
      if (!root) return;
      if (revealField(root, field)) setPinned(null);
      else setPinned(field);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fieldFocus, resource.id]);

  return (
    <div ref={rootRef} data-testid="resource-inspector" data-resource-type={resource.type}>
      <DocHeader
        docKey={resource.type}
        name={displayName(resource)}
        actions={
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
        }
      >
        <button
          type="button"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
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
      </DocHeader>
      <DocSectionNav rootRef={rootRef} />
      <GeneralSection docKey={resource.type} />
      <WhySection docKey={resource.type} />
      <DocSection letter="C" title="주요 설정" kind="mixed" flush testId="doc-section-settings">
        {pinned && <PinnedFieldHelp docKey={resource.type} field={pinned} onClose={() => setPinned(null)} />}
        <FieldHelpScope docKey={resource.type}>
          <div className="space-y-2 px-4 pt-1 pb-3">
            <TextField
              label="이름"
              help="name"
              value={resource.name}
              testId="resource-name"
              validate={(v) => (!v.trim() ? "이름을 입력하세요." : v.trim().length > 128 ? "128자 이하여야 합니다." : null)}
              onCommit={(v) => ctx.actions.rename(resource, v.trim())}
            />
            <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              설정 이름 옆 ? 아이콘에 마우스를 올리면 짧은 설명, 누르면 자세한 설명이 나옵니다. 값을 바꾸면 아래 분석·검증·시뮬레이션에 바로 반영됩니다.
            </p>
          </div>
          <ResourceForm resource={resource} ctx={ctx} />
        </FieldHelpScope>
      </DocSection>
      <RelationsSection docKey={resource.type} relations={analysis?.relations ?? []} actions={docActions} />
      {analysis && (
        <AnalysisSection
          docKey={resource.type}
          analysis={analysis}
          resourceType={resource.type}
          actions={docActions}
          footer={
            findings.length > 0 && (
              <Button variant="link" size="xs" className="h-auto px-0" onClick={onShowValidation}>
                검증 센터에서 {info.shortLabel} 관련 결과 보기 ({findings.length})
              </Button>
            )
          }
        />
      )}
      <LimitationSection docKey={resource.type} />
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
        {isRouteConnection(connection) && (
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
      <div className="border-b p-4" data-testid="inspector-empty-hint">
        <Callout>
          <p className="flex items-center gap-1 font-medium">
            <Info className="size-3.5" aria-hidden /> 리소스를 선택하면 상세 설명과 설정 가이드를 확인할 수 있습니다.
          </p>
          <p className="mt-0.5 text-muted-foreground">
            캔버스의 리소스를 누르세요. 왼쪽 팔레트의 ? 버튼은 리소스 유형 설명을, &lsquo;서비스 (VPC 밖)&rsquo;는 S3·IAM·CloudWatch 설명과 현재 구성을 보여 줍니다.
          </p>
        </Callout>
      </div>
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
