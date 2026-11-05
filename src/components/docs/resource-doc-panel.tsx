"use client";

/**
 * 리소스 상세 설명 패널 (쉬운 모드 설정 패널과 심화 모드 도움말 패널이 함께 쓴다).
 *   A. 기본 정보 · B. 왜 사용하는가 · C. 주요 설정 · D. 관련 리소스 · E. 현재 구성 분석 · F. 시뮬레이터 제한
 * 일반 개념(설명 데이터)과 현재 프로젝트 분석(실제 연결·검증·시뮬레이션)은 배지와 색으로 구분한다.
 */
import { Activity, ArrowRight, ChevronDown, CircleCheck, CircleX, ExternalLink, HardDrive, Info, KeyRound, Lightbulb, Play, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ResourceIcon } from "@/components/resource-visuals";
import { getFieldHelp, getResourceDoc, hasResourceDoc, type DocKey, type ServiceDocKey } from "@/lib/docs";
import { AWS_DOC_LINKS } from "@/lib/docs/aws-links";
import type { AnalysisCheck, AnalysisTone, Fact, LinkedItem, RelationGroup } from "@/lib/docs/resource-analysis";
import { fieldForFinding } from "@/lib/docs/rule-fields";
import type { SimulationRequest } from "@/lib/engine/connectivity-engine";
import { RESOURCE_TYPES, type ResourceType } from "@/lib/engine/resource-models";
import type { ValidationFinding } from "@/lib/engine/validation-engine";
import { FieldHelpBody, FieldHelpButton, revealElement, useRevealable } from "./field-help";

export interface DocPanelActions {
  /** 캔버스/콘솔에서 리소스로 이동 */
  onSelectResource?: (id: string) => void;
  /** 서비스(S3·IAM·CloudWatch) 항목으로 이동 */
  onSelectService?: (key: ServiceDocKey, itemId: string | null) => void;
  /** 일반 개념의 관련 리소스 유형 설명 보기 */
  onPreviewDoc?: (key: DocKey) => void;
  /** 관련 설정 항목으로 이동 */
  onOpenField?: (field: string) => void;
  /** 시뮬레이션 콘솔에서 요청 실행 */
  onRunSimulation?: (request: SimulationRequest) => void;
  /** 심화 모드 경로 → 링크 (없으면 링크를 만들지 않음) */
  consoleHref?: (path: string) => string | null;
}

export interface PanelAnalysis {
  headline: { tone: AnalysisTone; text: string };
  facts: Fact[];
  relations: RelationGroup[];
  checks: AnalysisCheck[];
  findings?: ValidationFinding[];
  recommendations: string[];
}

const SERVICE_ICON: Record<ServiceDocKey, { icon: typeof HardDrive; className: string }> = {
  s3: { icon: HardDrive, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  iam: { icon: KeyRound, className: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  cloudwatch: { icon: Activity, className: "bg-pink-500/15 text-pink-700 dark:text-pink-300" },
};

export function DocIcon({ docKey, size = "md" }: { docKey: DocKey; size?: "sm" | "md" | "lg" }) {
  if ((RESOURCE_TYPES as readonly string[]).includes(docKey)) return <ResourceIcon type={docKey as ResourceType} size={size} />;
  const s = SERVICE_ICON[docKey as ServiceDocKey];
  const Icon = s.icon;
  const box = size === "sm" ? "size-6 rounded-md" : size === "lg" ? "size-10 rounded-lg" : "size-8 rounded-md";
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", box, s.className)} aria-hidden>
      <Icon className={size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

const TONE: Record<AnalysisTone, { icon: typeof Info; className: string; label: string }> = {
  ok: { icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400", label: "정상" },
  warn: { icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400", label: "주의" },
  error: { icon: CircleX, className: "text-red-600 dark:text-red-400", label: "문제" },
  info: { icon: Info, className: "text-sky-600 dark:text-sky-400", label: "정보" },
};

export function ToneIcon({ tone, className }: { tone: AnalysisTone; className?: string }) {
  const t = TONE[tone];
  const Icon = t.icon;
  return <Icon className={cn("size-3.5 shrink-0", t.className, className)} aria-label={t.label} />;
}

function KindBadge({ kind }: { kind: "concept" | "project" | "virtual" }) {
  const style = {
    concept: "border-border bg-muted text-muted-foreground",
    project: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    virtual: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  }[kind];
  const label = { concept: "일반 개념", project: "현재 프로젝트", virtual: "시뮬레이터" }[kind];
  return <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold whitespace-nowrap normal-case", style)}>{label}</span>;
}

// 섹션을 접고 펼친 상태는 리소스를 바꿔도 유지되도록 브라우저에 기억한다 (실패해도 기본값으로 동작).
const SECTION_STORAGE_KEY = "aws-playground:doc-sections";
const sectionListeners = new Set<() => void>();
let sectionCache: { raw: string | null; value: Record<string, boolean> } = { raw: null, value: {} };

function readSections(): Record<string, boolean> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SECTION_STORAGE_KEY);
  } catch {
    return sectionCache.value;
  }
  if (raw !== sectionCache.raw) {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      sectionCache = { raw, value: parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {} };
    } catch {
      sectionCache = { raw, value: {} };
    }
  }
  return sectionCache.value;
}

function writeSection(id: string, open: boolean) {
  const next = { ...readSections(), [id]: open };
  const raw = JSON.stringify(next);
  sectionCache = { raw, value: next };
  try {
    window.localStorage.setItem(SECTION_STORAGE_KEY, raw);
  } catch {
    // 저장할 수 없으면 이번 화면에서만 유지한다
  }
  sectionListeners.forEach((l) => l());
}

function subscribeSections(listener: () => void) {
  sectionListeners.add(listener);
  return () => sectionListeners.delete(listener);
}

function useSectionOpen(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const stored = useSyncExternalStore(
    subscribeSections,
    () => readSections()[id] as boolean | undefined,
    () => undefined,
  );
  const setOpen = useCallback((open: boolean) => writeSection(id, open), [id]);
  return [typeof stored === "boolean" ? stored : defaultOpen, setOpen];
}

export function DocSection({
  letter,
  title,
  kind,
  defaultOpen = true,
  flush,
  children,
  testId,
}: {
  letter: string;
  title: string;
  kind: "concept" | "project" | "virtual" | "mixed";
  defaultOpen?: boolean;
  /** 내용에 여백을 두지 않는다 (안에 자체 여백이 있는 설정 폼을 넣을 때) */
  flush?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useSectionOpen(letter, defaultOpen);
  const ref = useRevealable<HTMLElement>(open, setOpen);
  const id = useId();
  return (
    <section ref={ref} className="border-b" data-testid={testId} data-open={open} data-revealable>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/40"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="text-[11px] font-bold text-muted-foreground">{letter}</span>
        <span className="flex-1 text-sm font-semibold">{title}</span>
        {kind === "mixed" ? (
          <span className="flex gap-1">
            <KindBadge kind="project" />
            <KindBadge kind="concept" />
          </span>
        ) : (
          <KindBadge kind={kind} />
        )}
      </button>
      <div id={id} hidden={!open} className={flush ? "pb-2" : "space-y-3 px-4 pb-4"}>
        {children}
      </div>
    </section>
  );
}

export interface DocSectionLink {
  letter: string;
  label: string;
  testId: string;
}

export const RESOURCE_SECTION_LINKS: DocSectionLink[] = [
  { letter: "A", label: "기본 정보", testId: "doc-section-basic" },
  { letter: "B", label: "왜 쓰나", testId: "doc-section-why" },
  { letter: "C", label: "설정", testId: "doc-section-settings" },
  { letter: "D", label: "관련 리소스", testId: "doc-section-relations" },
  { letter: "E", label: "분석", testId: "doc-section-analysis" },
  { letter: "F", label: "제한", testId: "doc-section-limits" },
];

/** 긴 패널에서 섹션으로 바로 가는 버튼 줄 (접혀 있으면 펼친다) */
export function DocSectionNav({ rootRef, links = RESOURCE_SECTION_LINKS }: { rootRef: React.RefObject<HTMLElement | null>; links?: DocSectionLink[] }) {
  return (
    <nav className="flex flex-wrap gap-1 border-b px-4 py-2" aria-label="설명 섹션 바로 가기" data-testid="doc-section-nav">
      {links.map((s) => (
        <button
          key={s.letter}
          type="button"
          className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => {
            const el = rootRef.current?.querySelector<HTMLElement>(`[data-testid="${s.testId}"]`);
            if (el) revealElement(el, null, { block: "start", flash: false });
          }}
        >
          <span className="font-bold">{s.letter}</span> {s.label}
        </button>
      ))}
    </nav>
  );
}

/** 패널 맨 위: 아이콘, 이름, AWS 서비스 이름, 한 줄 요약 */
export function DocHeader({ docKey, name, badge, actions, children }: { docKey: DocKey; name?: string; badge?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  const doc = getResourceDoc(docKey);
  return (
    <div className="space-y-2.5 border-b p-4" data-testid="doc-header" data-doc-key={docKey}>
      <div className="flex items-start gap-3">
        <DocIcon docKey={docKey} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {doc.title}
            {badge}
          </p>
          {name && (
            <p className="truncate font-semibold" title={name}>
              {name}
            </p>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">{doc.serviceName}</p>
        </div>
        {actions}
      </div>
      <p className="rounded-lg border-l-4 border-sky-500 bg-sky-500/5 px-3 py-2 text-[13px] font-medium leading-relaxed" data-testid="doc-summary">
        {doc.summary}
      </p>
      {children}
    </div>
  );
}

/** 폼에 입력란이 없는 설정(또는 접근할 수 없는 설정)으로 이동할 때 대신 보여 주는 도움말 카드 */
export function PinnedFieldHelp({ docKey, field, onClose }: { docKey: DocKey; field: string; onClose: () => void }) {
  const help = getFieldHelp(docKey, field);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => ref.current && revealElement(ref.current), 0);
    return () => window.clearTimeout(timer);
  }, [field]);
  if (!help) return null;
  return (
    <div ref={ref} className="mx-4 my-2 rounded-xl border border-sky-500/40 bg-sky-500/[0.04] p-3" data-testid="pinned-field-help" data-pinned-field={field}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">
          <span className="mr-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">설정 도움말</span>
          {help.title}
        </p>
        <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="설정 도움말 닫기" onClick={onClose}>
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <p className="mb-2 text-[12px] text-muted-foreground">이 설정은 쉬운 모드 폼에서 직접 바꾸지 않습니다. 아래 설명과 현재 구성 분석을 참고하세요.</p>
      <FieldHelpBody help={help} />
    </div>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold tracking-wide text-muted-foreground">{children}</p>;
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-[13px] leading-relaxed">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- A, B, F (일반 개념)

export function GeneralSection({ docKey, defaultOpen = true }: { docKey: string; defaultOpen?: boolean }) {
  const doc = getResourceDoc(docKey);
  // "네트워킹 · AWS::EC2::VPC" → 분류와 CloudFormation 유형 이름을 나눠 보여 준다
  const split = doc.resourceType.indexOf(" · ");
  const category = split >= 0 ? doc.resourceType.slice(0, split) : null;
  const typeName = split >= 0 ? doc.resourceType.slice(split + 3) : doc.resourceType;
  return (
    <DocSection letter="A" title="기본 정보" kind="concept" defaultOpen={defaultOpen} testId="doc-section-basic">
      <dl className="divide-y rounded-lg border text-[12px]">
        <div className="flex items-start justify-between gap-3 px-2.5 py-1.5">
          <dt className="shrink-0 text-muted-foreground">AWS 서비스</dt>
          <dd className="text-right">{doc.serviceName}</dd>
        </div>
        {category && (
          <div className="flex items-start justify-between gap-3 px-2.5 py-1.5">
            <dt className="shrink-0 text-muted-foreground">분류</dt>
            <dd className="text-right">{category}</dd>
          </div>
        )}
        <div className="flex items-start justify-between gap-3 px-2.5 py-1.5">
          <dt className="shrink-0 text-muted-foreground">리소스 유형</dt>
          <dd className="text-right font-mono text-[11.5px] break-all">{typeName}</dd>
        </div>
      </dl>
      {doc.description.map((p, i) => (
        <p key={i} className="text-[13px] leading-relaxed">
          {p}
        </p>
      ))}
      {doc.coreRoles.length > 0 && (
        <div className="space-y-1">
          <SubTitle>핵심 역할</SubTitle>
          <Bullets items={doc.coreRoles} />
        </div>
      )}
      {hasResourceDoc(docKey) && AWS_DOC_LINKS[docKey].length > 0 && (
        <div className="space-y-1" data-testid="aws-doc-links">
          <SubTitle>AWS 공식 문서 (새 창)</SubTitle>
          <ul className="space-y-1">
            {AWS_DOC_LINKS[docKey].map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-[12.5px] leading-snug text-primary underline-offset-2 hover:underline">
                  <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {link.title}
                </a>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-snug text-muted-foreground">실제 AWS 기준의 외부 문서입니다. 이 시뮬레이터에서 다르게 동작하는 부분은 아래 F(시뮬레이터 제한)를 보세요.</p>
        </div>
      )}
    </DocSection>
  );
}

export function WhySection({ docKey }: { docKey: string }) {
  const doc = getResourceDoc(docKey);
  if (!doc.why.problem) return null;
  return (
    <DocSection letter="B" title="왜 사용하는가?" kind="concept" defaultOpen={false} testId="doc-section-why">
      <div className="space-y-1">
        <SubTitle>어떤 문제를 해결하나요?</SubTitle>
        <p className="text-[13px] leading-relaxed">{doc.why.problem}</p>
      </div>
      <div className="space-y-1">
        <SubTitle>필요한 상황</SubTitle>
        <Bullets items={doc.why.whenNeeded} />
      </div>
      <div className="space-y-1">
        <SubTitle>쓰지 않는 상황</SubTitle>
        <Bullets items={doc.why.whenNotNeeded} />
      </div>
      {doc.why.comparisons.length > 0 && (
        <div className="space-y-1">
          <SubTitle>비슷한 리소스와의 차이</SubTitle>
          <ul className="space-y-1 text-[13px] leading-relaxed">
            {doc.why.comparisons.map((c) => (
              <li key={c.other}>
                <span className="font-semibold">{c.other}:</span> {c.difference}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <SubTitle>주요 사용 목적</SubTitle>
        <Bullets items={doc.purposes} />
      </div>
      {doc.useCases.length > 0 && (
        <div className="space-y-1.5">
          <SubTitle>실무 사례</SubTitle>
          {doc.useCases.map((u) => (
            <div key={u.title} className="rounded-lg border p-2.5 text-[13px] leading-relaxed">
              <p className="font-semibold">{u.title}</p>
              <p className="text-muted-foreground">{u.scenario}</p>
              <p className="mt-1 flex items-start gap-1">
                <ArrowRight className="mt-1 size-3 shrink-0 text-muted-foreground" aria-hidden />
                {u.expectedBehavior}
              </p>
            </div>
          ))}
        </div>
      )}
    </DocSection>
  );
}

export function LimitationSection({ docKey }: { docKey: string }) {
  const doc = getResourceDoc(docKey);
  const s = doc.simulator;
  return (
    <DocSection letter="F" title="시뮬레이터 제한" kind="virtual" defaultOpen={false} testId="doc-section-limits">
      <div className="space-y-1">
        <SubTitle>현재 구현된 동작</SubTitle>
        <Bullets items={s.implemented} />
      </div>
      {s.differences.length > 0 && (
        <div className="space-y-1">
          <SubTitle>실제 AWS와 다른 부분</SubTitle>
          <Bullets items={s.differences} />
        </div>
      )}
      <div className="space-y-1">
        <SubTitle>가상으로 처리하는 부분</SubTitle>
        <Bullets items={s.virtual} />
      </div>
      <div className="space-y-1">
        <SubTitle>아직 지원하지 않는 기능</SubTitle>
        <Bullets items={s.unsupported} />
      </div>
    </DocSection>
  );
}

// ---------------------------------------------------------------- D. 관련 리소스

function LinkedItemButton({ entry, actions }: { entry: LinkedItem; actions: DocPanelActions }) {
  const clickable = (entry.resourceId && actions.onSelectResource) || (entry.service && actions.onSelectService);
  const body = (
    <>
      {entry.type ? <ResourceIcon type={entry.type} size="sm" className="size-5 [&_svg]:size-3" /> : entry.service ? <DocIcon docKey={entry.service.key} size="sm" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{entry.name}</span>
        {entry.detail && <span className="block text-[11px] leading-snug text-muted-foreground">{entry.detail}</span>}
      </span>
      {entry.tone && <ToneIcon tone={entry.tone} className="mt-0.5" />}
    </>
  );
  if (!clickable) return <div className="flex items-start gap-2 rounded-md px-1.5 py-1">{body}</div>;
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
      onClick={() => {
        if (entry.resourceId && actions.onSelectResource) actions.onSelectResource(entry.resourceId);
        else if (entry.service && actions.onSelectService) actions.onSelectService(entry.service.key, entry.service.itemId);
      }}
      title={`${entry.name}(으)로 이동`}
      data-testid="related-item"
    >
      {body}
    </button>
  );
}

export function RelationsSection({
  docKey,
  relations,
  actions,
  defaultOpen = true,
}: {
  docKey: string;
  relations: RelationGroup[] | null;
  actions: DocPanelActions;
  defaultOpen?: boolean;
}) {
  const doc = getResourceDoc(docKey);
  return (
    <DocSection letter="D" title="관련 리소스" kind={relations ? "mixed" : "concept"} defaultOpen={defaultOpen} testId="doc-section-relations">
      {relations && (
        <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.03] p-2.5" data-testid="current-relations">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            <KindBadge kind="project" /> 지금 실제로 연결된 리소스
          </p>
          {relations.map((g) => (
            <div key={g.label} className="space-y-0.5">
              <p className="flex items-center gap-1 text-[12px] font-semibold">
                {g.label}
                {g.field && <FieldHelpButton field={g.field} docKey={docKey as DocKey} />}
              </p>
              <p className="text-[11px] text-muted-foreground">{g.explanation}</p>
              {g.items.length > 0 ? (
                <div className="space-y-0.5">
                  {g.items.map((entry, i) => (
                    <LinkedItemButton key={`${entry.resourceId ?? entry.service?.itemId ?? entry.name}-${i}`} entry={entry} actions={actions} />
                  ))}
                </div>
              ) : g.missing ? (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[12px] text-amber-800 dark:text-amber-300" data-testid="relation-missing">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>
                    {g.missing}
                    {g.field && actions.onOpenField && (
                      <button type="button" className="ml-1 font-semibold underline" onClick={() => actions.onOpenField!(g.field!)}>
                        설정으로 이동
                      </button>
                    )}
                  </span>
                </p>
              ) : (
                <p className="px-1.5 text-[12px] text-muted-foreground">{g.empty ?? "없습니다."}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {doc.relatedResources.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <KindBadge kind="concept" /> 이 리소스와 함께 쓰는 리소스
          </p>
          <ul className="space-y-1.5">
            {doc.relatedResources.map((rel) => (
              <li key={rel.type} className="flex items-start gap-2">
                <DocIcon docKey={rel.type} size="sm" />
                <div className="min-w-0 flex-1 text-[12px] leading-snug">
                  {actions.onPreviewDoc ? (
                    <button type="button" className="font-semibold hover:underline" onClick={() => actions.onPreviewDoc!(rel.type)}>
                      {getResourceDoc(rel.type).title}
                    </button>
                  ) : (
                    <span className="font-semibold">{getResourceDoc(rel.type).title}</span>
                  )}
                  <span className="text-muted-foreground"> — {rel.relationship}</span>
                  <span className="block text-muted-foreground">{rel.why}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DocSection>
  );
}

// ---------------------------------------------------------------- E. 현재 구성 분석

const SEVERITY_TONE = { error: "error", warning: "warn", info: "info" } as const;

export function AnalysisSection({
  docKey,
  analysis,
  resourceType,
  actions,
  footer,
}: {
  docKey: string;
  analysis: PanelAnalysis;
  resourceType?: ResourceType;
  actions: DocPanelActions;
  footer?: React.ReactNode;
}) {
  const findings = analysis.findings ?? [];
  return (
    <DocSection letter="E" title="현재 구성 분석" kind="project" testId="doc-section-analysis">
      <p className={cn("flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[13px] font-medium", analysis.headline.tone === "error" ? "border-red-500/40 bg-red-500/5" : analysis.headline.tone === "warn" ? "border-amber-500/40 bg-amber-500/5" : "border-violet-500/30 bg-violet-500/[0.03]")} data-testid="analysis-headline">
        <ToneIcon tone={analysis.headline.tone} className="mt-0.5" />
        {analysis.headline.text}
      </p>
      {analysis.facts.length > 0 && (
        <div className="space-y-1">
          <SubTitle>현재 설정 상태</SubTitle>
          <dl className="divide-y rounded-lg border text-[12px]">
            {analysis.facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="flex items-start justify-between gap-3 px-2.5 py-1.5">
                <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  {f.field && actions.onOpenField ? (
                    <button type="button" className="hover:underline" onClick={() => actions.onOpenField!(f.field!)}>
                      {f.label}
                    </button>
                  ) : (
                    f.label
                  )}
                  {f.field && <FieldHelpButton field={f.field} docKey={docKey as DocKey} />}
                </dt>
                <dd className="min-w-0 text-right font-mono text-[11.5px] break-all">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {analysis.checks.length > 0 && (
        <div className="space-y-1">
          <SubTitle>연결·통신 분석 (가상 시뮬레이션)</SubTitle>
          <ul className="space-y-1.5" data-testid="analysis-checks">
            {analysis.checks.map((c, i) => (
              <li key={`${c.title}-${i}`} className="rounded-lg border p-2" data-tone={c.tone}>
                <p className="flex items-start gap-1.5 text-[13px] font-medium">
                  <ToneIcon tone={c.tone} className="mt-0.5" />
                  {c.title}
                </p>
                <p className="mt-0.5 pl-5 text-[12px] leading-relaxed text-muted-foreground">{c.detail}</p>
                {(c.field || c.request) && (
                  <div className="mt-1 flex flex-wrap gap-1 pl-5">
                    {c.field && actions.onOpenField && (
                      <Button variant="outline" size="xs" onClick={() => actions.onOpenField!(c.field!)}>
                        관련 설정
                      </Button>
                    )}
                    {c.request && actions.onRunSimulation && (
                      <Button variant="outline" size="xs" onClick={() => actions.onRunSimulation!(c.request!)}>
                        <Play /> 시뮬레이션 다시 실행
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {findings.length > 0 && (
        <div className="space-y-1">
          <SubTitle>검증 결과 ({findings.length})</SubTitle>
          <ul className="space-y-1.5" data-testid="analysis-findings">
            {findings.map((f) => {
              const field = resourceType ? fieldForFinding(f, resourceType) : null;
              return (
                <li key={f.id} className="rounded-lg border p-2" data-rule={f.ruleId}>
                  <p className="flex items-start gap-1.5 text-[13px] font-medium">
                    <ToneIcon tone={SEVERITY_TONE[f.severity]} className="mt-0.5" />
                    <span>
                      {f.title} <span className="font-mono text-[10px] font-normal text-muted-foreground">{f.ruleId}</span>
                    </span>
                  </p>
                  <p className="mt-0.5 pl-5 text-[12px] text-muted-foreground">{f.cause}</p>
                  <p className="mt-0.5 pl-5 text-[12px]">
                    <span className="font-semibold">수정 방법:</span> {f.fix[0]}
                  </p>
                  {field && actions.onOpenField && (
                    <div className="mt-1 pl-5">
                      <Button variant="outline" size="xs" onClick={() => actions.onOpenField!(field)}>
                        설정으로 이동
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {analysis.recommendations.length > 0 && (
        <div className="space-y-1">
          <SubTitle>개선 권장 사항</SubTitle>
          <ul className="space-y-1 text-[12px]">
            {analysis.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {footer}
    </DocSection>
  );
}

// ---------------------------------------------------------------- C. 주요 설정 (폼이 없을 때)

/** 편집 폼이 없는 화면(서비스, 콘솔 도움말 패널)에서 쓰는 설정 항목 목록: 현재 값 + 도움말 */
export function FieldHelpList({ docKey, facts, footer }: { docKey: DocKey; facts: Fact[]; footer?: React.ReactNode }) {
  const doc = getResourceDoc(docKey);
  const fields = Object.entries(doc.fields as Record<string, { title: string; meaning: string }>);
  const valueOf = (field: string) => facts.find((f) => f.field === field)?.value;
  return (
    <DocSection letter="C" title="주요 설정" kind="mixed" testId="doc-section-settings">
      <ul className="divide-y rounded-lg border">
        {fields.map(([field, help]) => (
          <li key={field} className="space-y-0.5 px-2.5 py-1.5" data-field={field}>
            <p className="flex items-center gap-1 text-[12.5px] font-semibold">
              {help.title}
              <FieldHelpButton field={field} docKey={docKey} />
            </p>
            <p className="text-[11.5px] leading-snug text-muted-foreground">{help.meaning}</p>
            {valueOf(field) && <p className="font-mono text-[11.5px] text-violet-700 dark:text-violet-300">현재: {valueOf(field)}</p>}
          </li>
        ))}
      </ul>
      {footer}
    </DocSection>
  );
}

