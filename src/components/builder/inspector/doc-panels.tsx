"use client";

/**
 * 쉬운 모드 오른쪽 패널의 설명 화면: 팔레트에서 고른 리소스 유형 설명, VPC 밖 서비스(S3·IAM·CloudWatch) 설명.
 * 리소스를 선택했을 때의 패널은 inspector.tsx의 ResourceInspector가 같은 섹션 컴포넌트로 그린다.
 */
import Link from "next/link";
import { ArrowLeft, ExternalLink, Plus, X } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { href } from "@/components/console/router";
import { useMetricModel, useNow } from "@/components/console/pages/cloudwatch/cw-shared";
import {
  AnalysisSection,
  DocHeader,
  DocSectionNav,
  FieldHelpList,
  RESOURCE_SECTION_LINKS,
  GeneralSection,
  LimitationSection,
  RelationsSection,
  WhySection,
  type DocPanelActions,
} from "@/components/docs/resource-doc-panel";
import { revealField } from "@/components/docs/field-help";
import { docLabel, isServiceDocKey, type ServiceDocKey } from "@/lib/docs";
import { analyzeService, serviceConsolePath } from "@/lib/docs/service-analysis";
import { RESOURCE_TYPE_INFO, type ResourceType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { useEditorStore } from "@/lib/store/editor-store";
import { NativeSelect } from "./fields";
import { ResourceList, type FormContext } from "./form-shared";

/** 쉬운 모드에서 설명 패널의 링크·버튼이 하는 일 */
export function useBuilderDocActions(projectId: string, from: string | null, onOpenField?: (field: string) => void): DocPanelActions {
  const focusResources = useEditorStore((s) => s.focusResources);
  const showDoc = useEditorStore((s) => s.showDoc);
  const requestSimulation = useEditorStore((s) => s.requestSimulation);
  return useMemo(
    () => ({
      onSelectResource: (id: string) => focusResources([id]),
      onSelectService: (key: ServiceDocKey, itemId: string | null) => showDoc({ kind: "service", key, itemId, from }),
      onPreviewDoc: (key) => showDoc(isServiceDocKey(key) ? { kind: "service", key, itemId: null, from } : { kind: "preview", type: key, from }),
      onOpenField,
      onRunSimulation: (request) => requestSimulation(request, true),
      consoleHref: (path: string) => `/console/${projectId}${href(path)}`,
    }),
    [projectId, from, onOpenField, focusResources, showDoc, requestSimulation],
  );
}

/** 설명을 열기 전에 보던 리소스로 돌아가는 버튼 (그 리소스가 아직 있을 때만) */
function BackButton({ ctx, from }: { ctx: FormContext; from: string | null | undefined }) {
  const focusResources = useEditorStore((s) => s.focusResources);
  const r = from ? ctx.project.resources.find((x) => x.id === from) : undefined;
  if (!r) return null;
  return (
    <Button variant="ghost" size="xs" className="-ml-1.5 h-6 text-muted-foreground" onClick={() => focusResources([r.id])}>
      <ArrowLeft /> {displayName(r)}(으)로 돌아가기
    </Button>
  );
}

function CloseButton() {
  const showDoc = useEditorStore((s) => s.showDoc);
  return (
    <Button variant="ghost" size="icon-sm" aria-label="설명 닫기" onClick={() => showDoc(null)}>
      <X />
    </Button>
  );
}

// ---------------------------------------------------------------- 리소스 유형 설명 (팔레트)

export function TypeDocPanel({ type, from, ctx, onAdd }: { type: ResourceType; from?: string | null; ctx: FormContext; onAdd?: (type: ResourceType) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const openField = useMemo(() => (field: string) => rootRef.current && revealField(rootRef.current, field), []);
  const actions = useBuilderDocActions(ctx.projectId, from ?? null, openField);
  const info = RESOURCE_TYPE_INFO[type];
  const existing = ctx.project.resources.filter((r) => r.type === type);
  return (
    <div ref={rootRef} data-testid="type-doc-panel" data-doc-key={type}>
      <DocHeader
        docKey={type}
        badge={<span className="rounded-full border px-1.5 py-px text-[10px] font-semibold">리소스 유형 설명</span>}
        actions={<CloseButton />}
      >
        <BackButton ctx={ctx} from={from} />
        {onAdd && (
          <Button size="xs" onClick={() => onAdd(type)} data-testid="type-doc-add">
            <Plus /> 캔버스에 {info.shortLabel} 추가
          </Button>
        )}
        <div className="space-y-1 rounded-lg border border-violet-500/30 bg-violet-500/[0.03] p-2.5" data-testid="type-doc-existing">
          <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            현재 프로젝트의 {info.shortLabel}: {existing.length}개
          </p>
          <ResourceList ctx={ctx} resources={existing} empty="아직 없습니다. 추가한 뒤 선택하면 실제 설정과 연결 상태가 여기에 표시됩니다." />
        </div>
      </DocHeader>
      <DocSectionNav rootRef={rootRef} links={RESOURCE_SECTION_LINKS.filter((l) => l.letter !== "E")} />
      <GeneralSection docKey={type} />
      <WhySection docKey={type} />
      <FieldHelpList
        docKey={type}
        facts={[]}
        footer={<p className="text-[11px] text-muted-foreground">리소스를 추가하고 캔버스에서 선택하면 이 설정을 직접 바꾸고 현재 값을 확인할 수 있습니다.</p>}
      />
      <RelationsSection docKey={type} relations={null} actions={actions} />
      <LimitationSection docKey={type} />
    </div>
  );
}

// ---------------------------------------------------------------- VPC 밖 서비스 (S3 · IAM · CloudWatch)

export function ServiceDocPanel({ docKey, itemId, from, ctx }: { docKey: ServiceDocKey; itemId: string | null; from?: string | null; ctx: FormContext }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const showDoc = useEditorStore((s) => s.showDoc);
  const openField = useMemo(() => (field: string) => rootRef.current && revealField(rootRef.current, field), []);
  const actions = useBuilderDocActions(ctx.projectId, from ?? null, openField);
  const metricModel = useMetricModel();
  // CloudWatch 경보 상태는 시간에 따라 바뀌는 가상 지표로 계산하므로 주기적으로 다시 계산한다
  const now = useNow();
  const analysis = useMemo(
    () => analyzeService(ctx.analysis, docKey, { itemId, now: now || undefined, metricModel }),
    [ctx.analysis, docKey, itemId, now, metricModel],
  );
  const path = serviceConsolePath(ctx.project, docKey, itemId);
  const label = docLabel(docKey);
  return (
    <div ref={rootRef} data-testid="service-doc-panel" data-doc-key={docKey}>
      <DocHeader
        docKey={docKey}
        name={analysis.selectedLabel ?? undefined}
        badge={<span className="rounded-full border px-1.5 py-px text-[10px] font-semibold">VPC 밖 서비스</span>}
        actions={<CloseButton />}
      >
        <BackButton ctx={ctx} from={from} />
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground" htmlFor={`svc-item-${docKey}`}>
            살펴볼 항목
          </label>
          <NativeSelect
            id={`svc-item-${docKey}`}
            value={analysis.selectedLabel ? (itemId ?? "") : ""}
            options={[{ value: "", label: `${label} 전체 개요` }, ...analysis.items.map((i) => ({ value: i.id, label: i.detail ? `${i.label} — ${i.detail}` : i.label }))]}
            onChange={(v) => showDoc({ kind: "service", key: docKey, itemId: v || null, from })}
            testId="service-doc-item"
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {label}은(는) VPC 밖의 가상 서비스라 캔버스에는 그리지 않습니다. 만들고 바꾸는 작업은 심화 모드(콘솔)에서 하고, 여기서는 현재 구성과 분석 결과를 확인합니다.
        </p>
        <Button asChild variant="outline" size="xs">
          <Link href={actions.consoleHref?.(path) ?? "#"} data-testid="service-doc-console">
            <ExternalLink /> 심화 모드에서 설정하기
          </Link>
        </Button>
      </DocHeader>
      <DocSectionNav rootRef={rootRef} />
      <GeneralSection docKey={docKey} />
      <WhySection docKey={docKey} />
      <FieldHelpList docKey={docKey} facts={analysis.facts} />
      <RelationsSection docKey={docKey} relations={analysis.relations} actions={actions} />
      <AnalysisSection docKey={docKey} analysis={analysis} actions={actions} />
      <LimitationSection docKey={docKey} />
    </div>
  );
}
