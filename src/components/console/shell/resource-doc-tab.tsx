"use client";

/**
 * 심화 모드(콘솔) 도움말 패널의 '리소스 설명' 탭.
 * 지금 보고 있는 화면(경로)의 리소스·서비스를 찾아 쉬운 모드와 같은 설명 섹션(A~F)을 보여 준다.
 * 일반 개념은 src/lib/docs, 현재 구성 분석은 이 샌드박스의 실제 토폴로지·검증·시뮬레이션 결과에서 온다.
 */
import { ArrowLeft } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  AnalysisSection,
  DocHeader,
  DocIcon,
  DocSectionNav,
  FieldHelpList,
  GeneralSection,
  LimitationSection,
  RelationsSection,
  RESOURCE_SECTION_LINKS,
  WhySection,
  type DocPanelActions,
} from "@/components/docs/resource-doc-panel";
import { revealField } from "@/components/docs/field-help";
import { ALL_DOC_KEYS, docShortLabel, isServiceDocKey, type DocKey, type ServiceDocKey } from "@/lib/docs";
import { analyzeResource } from "@/lib/docs/resource-analysis";
import { analyzeService, serviceConsolePath } from "@/lib/docs/service-analysis";
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { useMetricModel, useNow } from "../pages/cloudwatch/cw-shared";
import { navigate, RESOURCE_LIST_PATH, resourcePath, useHashLocation } from "../router";

export type ConsoleDocTarget =
  | { kind: "resource"; id: string }
  | { kind: "service"; key: ServiceDocKey; itemId: string | null }
  | { kind: "type"; type: ResourceType }
  | null;

const EXTRA_LIST_PATHS: Record<string, ResourceType> = {
  "/ec2/security-groups": "security-group",
  "/ec2/eips": "elastic-ip",
};

/** 콘솔 경로 → 설명할 대상. 상세 화면이면 그 리소스, 목록 화면이면 리소스 유형, S3·IAM·CloudWatch는 서비스 */
export function docTargetForPath(project: Project, segments: string[]): ConsoleDocTarget {
  const parts = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const [service, section, id] = parts;
  if (service === "s3") return { kind: "service", key: "s3", itemId: section === "buckets" && id ? id : null };
  if (service === "iam") return { kind: "service", key: "iam", itemId: id ?? null };
  if (service === "cloudwatch") return { kind: "service", key: "cloudwatch", itemId: section === "alarms" && id ? id : null };
  for (const part of parts) {
    const r = project.resources.find((x) => x.id === part);
    if (r) return { kind: "resource", id: r.id };
  }
  const base = `/${service ?? ""}/${section ?? ""}`;
  const type = (Object.entries(RESOURCE_LIST_PATH) as [ResourceType, string][]).find(([, p]) => p === base)?.[0] ?? EXTRA_LIST_PATHS[base];
  return type ? { kind: "type", type } : null;
}

function useConsoleDocActions(panelRef: React.RefObject<HTMLElement | null>, onPreview: (key: DocKey) => void): DocPanelActions {
  const project = useProject();
  return useMemo(
    () => ({
      onSelectResource: (id: string) => {
        const r = project.resources.find((x) => x.id === id);
        if (r) navigate(resourcePath(r.type, r.id));
      },
      onSelectService: (key: ServiceDocKey, itemId: string | null) => navigate(serviceConsolePath(project, key, itemId)),
      onPreviewDoc: onPreview,
      // 패널 안의 '주요 설정' 목록에서 그 설정을 찾아 펼친다
      onOpenField: (field: string) => {
        if (panelRef.current) revealField(panelRef.current, field);
      },
    }),
    [project, onPreview, panelRef],
  );
}

export function ResourceDocTab() {
  const location = useHashLocation();
  const project = useProject();
  const routeTarget = docTargetForPath(project, location.segments);
  // 다른 유형의 일반 설명을 잠깐 볼 때 (경로가 바뀌면 화면의 대상으로 돌아간다)
  const [preview, setPreview] = useState<{ path: string; key: DocKey } | null>(null);
  const previewKey = preview && preview.path === location.path ? preview.key : null;
  const onPreview = useMemo(() => (key: DocKey) => setPreview({ path: location.path, key }), [location.path]);

  if (previewKey) {
    return (
      <div className="space-y-2">
        <button type="button" className="inline-flex items-center gap-1 text-sm font-bold text-aws-link hover:underline" onClick={() => setPreview(null)}>
          <ArrowLeft className="size-4" aria-hidden /> 이 화면의 설명으로 돌아가기
        </button>
        {isServiceDocKey(previewKey) ? (
          <ServiceDoc key={`svc-${previewKey}`} docKey={previewKey} itemId={null} onPreview={onPreview} />
        ) : (
          <TypeDoc key={`type-${previewKey}`} type={previewKey} onPreview={onPreview} />
        )}
      </div>
    );
  }
  if (!routeTarget) return <DocPicker onPick={onPreview} />;
  if (routeTarget.kind === "resource") return <ResourceDoc key={routeTarget.id} id={routeTarget.id} onPreview={onPreview} />;
  if (routeTarget.kind === "service")
    return <ServiceDoc key={`${routeTarget.key}-${routeTarget.itemId ?? ""}`} docKey={routeTarget.key} itemId={routeTarget.itemId} onPreview={onPreview} />;
  return <TypeDoc key={routeTarget.type} type={routeTarget.type} onPreview={onPreview} />;
}

function DocPicker({ onPick }: { onPick: (key: DocKey) => void }) {
  return (
    <div className="space-y-4" data-testid="console-doc-picker">
      <p className="rounded-xl bg-aws-info-bg px-4 py-3 text-[15px] font-bold text-aws-text">리소스를 선택하면 상세 설명과 설정 가이드를 확인할 수 있습니다.</p>
      <p className="text-sm text-aws-text-2">리소스 상세 화면이나 목록 화면으로 이동하면 그 리소스의 설명이 여기에 표시됩니다. 아래에서 유형을 골라 일반 설명을 볼 수도 있습니다.</p>
      <ul className="grid grid-cols-2 gap-2">
        {ALL_DOC_KEYS.map((key) => (
          <li key={key}>
            <button type="button" onClick={() => onPick(key)} className="flex w-full items-center gap-2 rounded-lg border border-aws-border px-2 py-1.5 text-left text-sm hover:border-aws-link hover:bg-aws-info-bg">
              <DocIcon docKey={key} size="sm" />
              <span className="truncate">{docShortLabel(key)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResourceDoc({ id, onPreview }: { id: string; onPreview: (key: DocKey) => void }) {
  const analysis = useAnalysis();
  const ref = useRef<HTMLDivElement>(null);
  const actions = useConsoleDocActions(ref, onPreview);
  const resource = analysis.topology.get(id);
  const result = useMemo(() => analyzeResource(analysis, id), [analysis, id]);
  if (!resource || !result) return <DocPicker onPick={onPreview} />;
  return (
    <div ref={ref} className="-mx-5 -my-4" data-testid="console-resource-doc" data-doc-key={resource.type}>
      <DocHeader docKey={resource.type} name={displayName(resource)} />
      <DocSectionNav rootRef={ref} />
      <GeneralSection docKey={resource.type} />
      <WhySection docKey={resource.type} />
      <FieldHelpList
        docKey={resource.type}
        facts={result.facts}
        footer={<p className="text-[11px] text-muted-foreground">값은 이 화면의 편집 기능이나 쉬운 모드에서 바꿉니다. 각 설정 옆 ? 아이콘에서도 같은 설명을 볼 수 있습니다.</p>}
      />
      <RelationsSection docKey={resource.type} relations={result.relations} actions={actions} />
      <AnalysisSection docKey={resource.type} analysis={result} resourceType={resource.type} actions={actions} />
      <LimitationSection docKey={resource.type} />
    </div>
  );
}

function TypeDoc({ type, onPreview }: { type: ResourceType; onPreview: (key: DocKey) => void }) {
  const project = useProject();
  const ref = useRef<HTMLDivElement>(null);
  const actions = useConsoleDocActions(ref, onPreview);
  const existing = project.resources.filter((r) => r.type === type);
  return (
    <div ref={ref} className="-mx-5 -my-4" data-testid="console-type-doc" data-doc-key={type}>
      <DocHeader docKey={type}>
        <div className="space-y-1 rounded-lg border border-violet-500/30 bg-violet-500/[0.03] p-2.5">
          <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            현재 프로젝트: {existing.length}개 {existing.length > 0 && "— 이름을 누르면 상세 화면과 실제 설정 분석을 봅니다."}
          </p>
          <ul className="space-y-0.5">
            {existing.slice(0, 12).map((r) => (
              <li key={r.id}>
                <button type="button" className="text-left text-[13px] text-aws-link hover:underline" onClick={() => navigate(resourcePath(r.type, r.id))}>
                  {displayName(r)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DocHeader>
      <DocSectionNav rootRef={ref} links={RESOURCE_SECTION_LINKS.filter((l) => l.letter !== "E")} />
      <GeneralSection docKey={type} />
      <WhySection docKey={type} />
      <FieldHelpList docKey={type} facts={[]} />
      <RelationsSection docKey={type} relations={null} actions={actions} />
      <LimitationSection docKey={type} />
    </div>
  );
}

function ServiceDoc({ docKey, itemId, onPreview }: { docKey: ServiceDocKey; itemId: string | null; onPreview: (key: DocKey) => void }) {
  const analysis = useAnalysis();
  const project = useProject();
  const ref = useRef<HTMLDivElement>(null);
  const actions = useConsoleDocActions(ref, onPreview);
  const metricModel = useMetricModel();
  const now = useNow();
  const result = useMemo(() => analyzeService(analysis, docKey, { itemId, now: now || undefined, metricModel }), [analysis, docKey, itemId, now, metricModel]);
  return (
    <div ref={ref} className="-mx-5 -my-4" data-testid="console-service-doc" data-doc-key={docKey}>
      <DocHeader docKey={docKey} name={result.selectedLabel ?? undefined}>
        {result.items.length > 0 && (
          <label className="block space-y-1 text-[11px] font-medium text-muted-foreground">
            살펴볼 항목
            <select
              className="block h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
              value={result.selectedLabel ? (itemId ?? "") : ""}
              onChange={(e) => navigate(serviceConsolePath(project, docKey, e.target.value || null))}
            >
              <option value="">{docShortLabel(docKey)} 전체 개요</option>
              {result.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.detail ? `${i.label} — ${i.detail}` : i.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </DocHeader>
      <DocSectionNav rootRef={ref} />
      <GeneralSection docKey={docKey} />
      <WhySection docKey={docKey} />
      <FieldHelpList docKey={docKey} facts={result.facts} />
      <RelationsSection docKey={docKey} relations={result.relations} actions={actions} />
      <AnalysisSection docKey={docKey} analysis={result} actions={actions} />
      <LimitationSection docKey={docKey} />
    </div>
  );
}

