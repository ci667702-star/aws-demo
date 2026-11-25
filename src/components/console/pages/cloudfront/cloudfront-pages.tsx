"use client";

/**
 * CloudFront 콘솔 (가상): 배포 목록·생성·편집, 상세(일반·원본·동작·요청 테스트·무효화), 활성화·비활성화·삭제.
 * 요청 테스트는 실제 HTTP 요청 없이 설정으로 응답을 계산하고, 그 결과로 가상 엣지 캐시를 채운다.
 * 가상 도메인(dxxxx.cloudfront.net)은 실제로 접속되는 주소가 아니다.
 */
import { ArrowDown, ArrowUp, Copy, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  ALLOWED_METHODS_LABEL,
  CACHE_POLICY_INFO,
  distributionArn,
  distributionHealth,
  evaluateOacAccess,
  HTTP_METHODS,
  isDefaultBehavior,
  oacPolicyStatement,
  ORIGIN_KIND_LABEL,
  originTargetName,
  simulateCloudFrontRequest,
  VIEWER_POLICY_LABEL,
  type CfRequest,
  type CfResponse,
} from "@/lib/engine/cloudfront-engine";
import { createId } from "@/lib/engine/ids";
import { objectArn } from "@/lib/engine/iam-engine";
import { CF_ALLOWED_METHODS, CF_CACHE_POLICIES, CF_ORIGIN_KINDS, CF_VIEWER_PROTOCOL_POLICIES, VIRTUAL_REGION, type CfBehavior, type CfDistribution, type CfOrigin, type Project } from "@/lib/engine/resource-models";
import { evaluateS3Access, websiteEndpoint } from "@/lib/engine/s3-engine";
import { displayName } from "@/lib/engine/topology-engine";
import { addOacBucketPolicy, createDistribution, createInvalidation, deleteDistribution, recordCacheEntry, setDistributionEnabled, updateDistribution, type DistributionInput } from "@/lib/project/cloudfront-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { formatDateTime, formatTime } from "@/lib/ui/format";
import { useConsoleProjectId, useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../../ui/button";
import { FormActions, FormField, RadioGroup, SelectInput, TextArea, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { AccessSteps } from "../access-test";
import { useNow } from "../cloudwatch/cw-shared";
import { useQueryTab, useSelection, useTopology } from "../common";

const PRICE_CLASS_LABEL: Record<CfDistribution["priceClass"], string> = {
  PriceClass_All: "모든 엣지 로케이션 사용 (최고의 성능)",
  PriceClass_200: "북미, 유럽, 아시아, 중동 및 아프리카 사용",
  PriceClass_100: "북미 및 유럽만 사용",
};

const ORIGIN_PROTOCOL_LABEL: Record<CfOrigin["protocolPolicy"], string> = { "http-only": "HTTP만 (80)", "https-only": "HTTPS만 (443)", "match-viewer": "뷰어와 일치" };

function EnabledBadge({ dist }: { dist: CfDistribution }) {
  return dist.enabled ? <StatusIndicator type="success">활성화됨</StatusIndicator> : <StatusIndicator type="stopped">비활성화됨</StatusIndicator>;
}

function DeployState({ dist }: { dist: CfDistribution }) {
  return dist.state === "InProgress" ? <StatusIndicator type="in-progress">배포 중</StatusIndicator> : <span>{formatDateTime(dist.updatedAt)}</span>;
}

function DistributionNotFound() {
  return (
    <Container>
      <EmptyState title="배포를 찾을 수 없습니다" description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/cloudfront/distributions")}>배포 목록</ButtonLink>} />
    </Container>
  );
}

function OriginTargetLink({ project, origin }: { project: Project; origin: CfOrigin }) {
  const name = originTargetName(project, origin);
  if (origin.kind === "alb") {
    return project.resources.some((r) => r.id === origin.targetId) ? (
      <a className="text-aws-link hover:underline" href={href(`/ec2/load-balancers/${origin.targetId}`)}>
        {name}
      </a>
    ) : (
      <span className="text-aws-error">{name}</span>
    );
  }
  return project.services.s3.buckets.some((b) => b.id === origin.targetId) ? (
    <a className="text-aws-link hover:underline" href={href(`/s3/buckets/${origin.targetId}`)}>
      {name}
    </a>
  ) : (
    <span className="text-aws-error">{name}</span>
  );
}

/** 이 배포의 OAC 원본 중 버킷 정책이 허용하지 않는 것 */
function missingOacPolicies(project: Project, dist: CfDistribution): CfOrigin[] {
  return dist.origins.filter((o) => {
    if (o.kind !== "s3" || o.originAccess !== "oac") return false;
    const bucket = project.services.s3.buckets.find((b) => b.id === o.targetId);
    return !!bucket && !evaluateOacAccess(bucket, dist.id, "s3:GetObject", objectArn(bucket.name, dist.defaultRootObject || "index.html")).allowed;
  });
}

// ================================================================ 목록

export function DistributionListPage() {
  const project = useProject();
  const run = useRunAction();
  const dists = project.services.cloudfront.distributions;
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = dists.find((d) => d.id === selected[0]);
  return (
    <SpaceBetween>
      <PageGuide topic="cloudfront" />
      <ResourceTable<CfDistribution>
        ariaLabel="배포 목록"
        items={dists}
        trackBy={(d) => d.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(d) => d.id}
        filterPlaceholder="배포 찾기"
        header={
          <PageHeader
            title="배포"
            counter={`(${dists.length})`}
            info={<InfoLink topic="cloudfront" />}
            description="전 세계 엣지 로케이션에서 콘텐츠를 캐시해 빠르게 전달합니다 (가상). 가상 도메인은 실제로 접속되지 않습니다."
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "enable", text: "활성화", disabled: !current || current.enabled },
                    { id: "disable", text: "비활성화", disabled: !current || !current.enabled },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "enable" || a === "disable") run("UpdateDistribution", (p) => setDistributionEnabled(p, current.id, a === "enable"), { success: () => `배포 ${current.id}을(를) ${a === "enable" ? "활성화" : "비활성화"}하는 중입니다.`, flashError: true });
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/cloudfront/distributions/create")}>
                  배포 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="배포 없음" description="S3 버킷이나 로드 밸런서를 원본으로 배포를 만들면, 가까운 엣지에서 캐시해 응답합니다 (가상)." action={<ButtonLink href={href("/cloudfront/distributions/create")}>배포 생성</ButtonLink>} />}
        columns={[
          { id: "id", header: "ID", cell: (d) => <a className="font-mono font-bold text-aws-link hover:underline" href={href(`/cloudfront/distributions/${d.id}`)}>{d.id}</a>, sortValue: (d) => d.id },
          { id: "desc", header: "설명", cell: (d) => <span className="text-aws-text-2">{d.comment || "–"}</span> },
          { id: "domain", header: "도메인 이름 (가상)", cell: (d) => <span className="font-mono text-[13px] break-all">{d.domainName}</span> },
          { id: "origins", header: "원본", cell: (d) => d.origins.map((o) => <div key={o.id} className="break-all">{originTargetName(project, o)}</div>) },
          { id: "status", header: "상태", cell: (d) => <EnabledBadge dist={d} /> },
          { id: "modified", header: "마지막 수정", cell: (d) => <DeployState dist={d} />, sortValue: (d) => d.updatedAt },
        ]}
      />
      {deleting && current && <DeleteDistributionModal dist={current} onClose={() => setDeleting(false)} onDeleted={() => setSelected([])} />}
    </SpaceBetween>
  );
}

// ================================================================ 생성·편집 양식

type DistDraft = Omit<DistributionInput, "behaviors"> & { behaviors: CfBehavior[] };

const sanitizeId = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** AWS 콘솔이 원본 이름으로 채워 주는 값 (원본의 도메인 이름) */
function defaultOriginId(project: Project, kind: CfOrigin["kind"], targetId: string): string {
  if (kind === "alb") {
    const alb = project.resources.find((r) => r.id === targetId);
    return `${sanitizeId(alb ? displayName(alb) : "") || "my-alb"}.${VIRTUAL_REGION}.elb.amazonaws.com`;
  }
  const bucket = project.services.s3.buckets.find((b) => b.id === targetId);
  const name = bucket?.name ?? "my-bucket";
  return kind === "s3" ? `${name}.s3.${VIRTUAL_REGION}.amazonaws.com` : `${name}.s3-website.${VIRTUAL_REGION}.amazonaws.com`;
}

function OriginEditor({ origin, index, canRemove, onChange, onRemove }: { origin: CfOrigin; index: number; canRemove: boolean; onChange: (o: CfOrigin) => void; onRemove: () => void }) {
  const project = useProject();
  const topo = useTopology();
  const buckets = project.services.s3.buckets;
  const albs = topo.ofType("alb");
  const bucket = buckets.find((b) => b.id === origin.targetId);
  const change = (kind: CfOrigin["kind"], targetId: string) => {
    const auto = !origin.id || origin.id === defaultOriginId(project, origin.kind, origin.targetId);
    onChange({ ...origin, kind, targetId, id: auto ? defaultOriginId(project, kind, targetId) : origin.id });
  };
  const targets =
    origin.kind === "alb"
      ? albs.map((a) => ({ value: a.id, label: `${displayName(a)} (${a.config.scheme === "internal" ? "내부" : "인터넷 경계"})` }))
      : buckets.map((b) => ({ value: b.id, label: origin.kind === "s3-website" && !b.website.enabled ? `${b.name} — 정적 웹 사이트 호스팅 꺼짐` : b.name }));
  return (
    <div className="space-y-4 rounded-xl border border-aws-border p-4" data-testid={`origin-editor-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold">원본 {index + 1}</h3>
        {canRemove && (
          <Button variant="icon" aria-label={`원본 ${index + 1} 제거`} onClick={onRemove}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      <div className="grid gap-4 @2xl/main:grid-cols-2">
        <FormField help={{ docKey: "cloudfront", field: "origin" }} label="원본 종류">
          <SelectInput
            value={origin.kind}
            onChange={(v) => {
              const kind = v as CfOrigin["kind"];
              const sameFamily = (kind === "alb") === (origin.kind === "alb");
              change(kind, sameFamily ? origin.targetId : kind === "alb" ? (albs[0]?.id ?? "") : (buckets[0]?.id ?? ""));
            }}
            options={CF_ORIGIN_KINDS.map((k) => ({ value: k, label: ORIGIN_KIND_LABEL[k] }))}
          />
        </FormField>
        <FormField label={origin.kind === "alb" ? "로드 밸런서" : "S3 버킷"}>
          <SelectInput value={origin.targetId} onChange={(v) => change(origin.kind, v)} placeholder={targets.length ? "선택" : origin.kind === "alb" ? "로드 밸런서가 없습니다" : "버킷이 없습니다"} options={targets} />
        </FormField>
      </div>
      {origin.kind === "s3-website" && bucket && <p className="text-sm text-aws-text-2">엔드포인트: {websiteEndpoint(bucket.name)} — HTTP만 지원하고 OAC를 쓸 수 없어 버킷이 공개되어 있어야 합니다.</p>}
      <FormField label="원본 이름" constraint="배포 안에서 고유한 이름. 동작이 이 이름으로 원본을 가리킵니다.">
        <TextInput value={origin.id} onChange={(e) => onChange({ ...origin, id: e.target.value })} maxLength={128} className="font-mono" />
      </FormField>
      {origin.kind === "s3" && (
        <FormField help={{ docKey: "cloudfront", field: "originAccess" }} label="원본 액세스">
          <Tiles
            aria-label={`원본 ${index + 1} 액세스`}
            columns={2}
            value={origin.originAccess}
            onChange={(v) => onChange({ ...origin, originAccess: v as CfOrigin["originAccess"] })}
            items={[
              { value: "oac", label: "원본 액세스 제어 설정 (권장)", description: "버킷은 비공개로 두고, 이 배포가 서명한 요청만 버킷 정책으로 허용합니다." },
              { value: "public", label: "퍼블릭", description: "버킷이 공개되어 있어야 합니다. 누구나 S3 주소로도 직접 읽을 수 있습니다." },
            ]}
          />
        </FormField>
      )}
      {origin.kind === "alb" && (
        <FormField help={{ docKey: "cloudfront", field: "originProtocolPolicy" }} label="프로토콜 (CloudFront → ALB)">
          <RadioGroup
            aria-label={`원본 ${index + 1} 프로토콜`}
            value={origin.protocolPolicy}
            onChange={(v) => onChange({ ...origin, protocolPolicy: v as CfOrigin["protocolPolicy"] })}
            items={(["http-only", "https-only", "match-viewer"] as const).map((p) => ({ value: p, label: ORIGIN_PROTOCOL_LABEL[p] }))}
          />
        </FormField>
      )}
    </div>
  );
}

function BehaviorEditor({
  behavior,
  index,
  total,
  origins,
  onChange,
  onMove,
  onRemove,
}: {
  behavior: CfBehavior;
  index: number;
  total: number;
  origins: CfOrigin[];
  onChange: (b: CfBehavior) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const isDefault = index === total - 1;
  return (
    <div className="space-y-4 rounded-xl border border-aws-border p-4" data-testid={`behavior-editor-${index}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold">{isDefault ? "기본 동작 (*)" : `동작 ${index + 1} — 우선순위 ${index}`}</h3>
        {!isDefault && (
          <div className="flex gap-1">
            <Button variant="icon" aria-label={`동작 ${index + 1} 위로`} disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUp aria-hidden />
            </Button>
            <Button variant="icon" aria-label={`동작 ${index + 1} 아래로`} disabled={index >= total - 2} onClick={() => onMove(1)}>
              <ArrowDown aria-hidden />
            </Button>
            <Button variant="icon" aria-label={`동작 ${index + 1} 제거`} onClick={onRemove}>
              <X aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <div className="grid gap-4 @2xl/main:grid-cols-2">
        <FormField help={{ docKey: "cloudfront", field: "pathPattern" }} label="경로 패턴" constraint={isDefault ? "기본 동작은 다른 동작과 일치하지 않는 모든 요청을 받습니다." : "예: /api/*, *.jpg (*는 여러 글자, ?는 한 글자)"}>
          <TextInput value={isDefault ? "기본값 (*)" : behavior.pathPattern} disabled={isDefault} onChange={(e) => onChange({ ...behavior, pathPattern: e.target.value })} maxLength={255} className="font-mono" />
        </FormField>
        <FormField label="원본">
          <SelectInput value={behavior.originId} onChange={(v) => onChange({ ...behavior, originId: v })} options={origins.map((o) => ({ value: o.id, label: o.id || "(이름 없음)" }))} />
        </FormField>
        <FormField help={{ docKey: "cloudfront", field: "viewerProtocolPolicy" }} label="뷰어 프로토콜 정책">
          <SelectInput value={behavior.viewerProtocolPolicy} onChange={(v) => onChange({ ...behavior, viewerProtocolPolicy: v as CfBehavior["viewerProtocolPolicy"] })} options={CF_VIEWER_PROTOCOL_POLICIES.map((p) => ({ value: p, label: VIEWER_POLICY_LABEL[p] }))} />
        </FormField>
        <FormField help={{ docKey: "cloudfront", field: "allowedMethods" }} label="허용된 HTTP 메서드">
          <SelectInput value={behavior.allowedMethods} onChange={(v) => onChange({ ...behavior, allowedMethods: v as CfBehavior["allowedMethods"] })} options={CF_ALLOWED_METHODS.map((m) => ({ value: m, label: ALLOWED_METHODS_LABEL[m] }))} />
        </FormField>
        <FormField help={{ docKey: "cloudfront", field: "cachePolicy" }} label="캐시 정책" constraint={CACHE_POLICY_INFO[behavior.cachePolicy].description} className="@2xl/main:col-span-2">
          <SelectInput value={behavior.cachePolicy} onChange={(v) => onChange({ ...behavior, cachePolicy: v as CfBehavior["cachePolicy"] })} options={CF_CACHE_POLICIES.map((c) => ({ value: c, label: CACHE_POLICY_INFO[c].label }))} />
        </FormField>
      </div>
    </div>
  );
}

function DistributionForm({ draft, set }: { draft: DistDraft; set: (p: Partial<DistDraft>) => void }) {
  const project = useProject();
  const setOrigin = (i: number, next: CfOrigin) => {
    const prev = draft.origins[i];
    // 원본 이름이 바뀌면 그 원본을 가리키던 동작도 따라간다
    set({ origins: draft.origins.map((o, j) => (j === i ? next : o)), behaviors: prev.id !== next.id ? draft.behaviors.map((b) => (b.originId === prev.id ? { ...b, originId: next.id } : b)) : draft.behaviors });
  };
  const addOrigin = () => {
    const bucket = project.services.s3.buckets[0];
    const origin: CfOrigin = { id: "", kind: "s3", targetId: bucket?.id ?? "", originAccess: "oac", protocolPolicy: "https-only" };
    set({ origins: [...draft.origins, { ...origin, id: `${defaultOriginId(project, "s3", origin.targetId)}-${draft.origins.length + 1}` }] });
  };
  const removeOrigin = (i: number) => {
    const removed = draft.origins[i];
    const origins = draft.origins.filter((_, j) => j !== i);
    set({ origins, behaviors: draft.behaviors.map((b) => (b.originId === removed.id ? { ...b, originId: origins[0]?.id ?? "" } : b)) });
  };
  const setBehavior = (i: number, b: CfBehavior) => set({ behaviors: draft.behaviors.map((x, j) => (j === i ? b : x)) });
  const moveBehavior = (i: number, delta: -1 | 1) => {
    const list = [...draft.behaviors];
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    set({ behaviors: list });
  };
  const addBehavior = () => {
    const def = draft.behaviors[draft.behaviors.length - 1];
    const added: CfBehavior = { id: createId("cb"), pathPattern: "/api/*", originId: def?.originId ?? draft.origins[0]?.id ?? "", viewerProtocolPolicy: "redirect-to-https", allowedMethods: "ALL", cachePolicy: "CachingDisabled" };
    set({ behaviors: [...draft.behaviors.slice(0, -1), added, ...draft.behaviors.slice(-1)] });
  };
  return (
    <>
      <Container header={<ContainerHeader title="원본" info={<InfoLink topic="cloudfront" />} description="CloudFront가 콘텐츠를 가져올 곳입니다 (최대 5개)." />}>
        <SpaceBetween size="m">
          {draft.origins.map((o, i) => (
            <OriginEditor key={i} origin={o} index={i} canRemove={draft.origins.length > 1} onChange={(next) => setOrigin(i, next)} onRemove={() => removeOrigin(i)} />
          ))}
          <div>
            <Button iconLeft={<Plus aria-hidden />} onClick={addOrigin} disabled={draft.origins.length >= 5}>
              원본 추가
            </Button>
          </div>
        </SpaceBetween>
      </Container>
      <Container
        header={
          <ContainerHeader
            title="동작"
            info={<InfoLink topic="cloudfront-cache" />}
            description="요청 경로마다 어느 원본으로 보내고 어떻게 캐시할지 정합니다. 위에서부터 처음 일치하는 동작을 쓰고, 맨 아래 기본 동작(*)이 나머지 모든 요청을 받습니다."
          />
        }
      >
        <SpaceBetween size="m">
          {draft.behaviors.map((b, i) => (
            <BehaviorEditor key={b.id} behavior={b} index={i} total={draft.behaviors.length} origins={draft.origins} onChange={(next) => setBehavior(i, next)} onMove={(d) => moveBehavior(i, d)} onRemove={() => set({ behaviors: draft.behaviors.filter((_, j) => j !== i) })} />
          ))}
          <div>
            <Button iconLeft={<Plus aria-hidden />} onClick={addBehavior} disabled={draft.behaviors.length >= 10}>
              동작 추가
            </Button>
          </div>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="설정" />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "cloudfront", field: "priceClass" }} label="가격 분류" constraint="이 시뮬레이터는 엣지 위치에 따른 지연 시간을 계산하지 않습니다.">
            <SelectInput value={draft.priceClass} onChange={(v) => set({ priceClass: v as CfDistribution["priceClass"] })} options={(Object.keys(PRICE_CLASS_LABEL) as CfDistribution["priceClass"][]).map((p) => ({ value: p, label: PRICE_CLASS_LABEL[p] }))} />
          </FormField>
          <FormField help={{ docKey: "cloudfront", field: "defaultRootObject" }} label="기본 루트 객체" optional constraint="루트(/) 요청에 돌려줄 객체. 예: index.html (/로 시작하지 않음)">
            <TextInput value={draft.defaultRootObject} onChange={(e) => set({ defaultRootObject: e.target.value })} maxLength={255} className="font-mono" placeholder="index.html" />
          </FormField>
          <FormField label="설명" optional>
            <TextInput value={draft.comment} onChange={(e) => set({ comment: e.target.value })} maxLength={128} />
          </FormField>
        </SpaceBetween>
      </Container>
    </>
  );
}

function initialDraft(project: Project, albIds: string[]): DistDraft {
  const bucket = project.services.s3.buckets[0];
  const origin: CfOrigin = bucket
    ? { id: defaultOriginId(project, "s3", bucket.id), kind: "s3", targetId: bucket.id, originAccess: "oac", protocolPolicy: "https-only" }
    : { id: defaultOriginId(project, "alb", albIds[0] ?? ""), kind: "alb", targetId: albIds[0] ?? "", originAccess: "public", protocolPolicy: "http-only" };
  return {
    comment: "",
    enabled: true,
    defaultRootObject: bucket ? "index.html" : "",
    priceClass: "PriceClass_All",
    origins: [origin],
    behaviors: [{ id: createId("cb"), pathPattern: "*", originId: origin.id, viewerProtocolPolicy: "redirect-to-https", allowedMethods: "GET_HEAD", cachePolicy: bucket ? "CachingOptimized" : "CachingDisabled" }],
  };
}

export function CreateDistributionPage() {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  const [draft, setDraft] = useState<DistDraft>(() => initialDraft(project, topo.ofType("alb").map((a) => a.id)));
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<DistDraft>) => setDraft((d) => ({ ...d, ...p }));
  const submit = () => {
    setError(null);
    const r = run("CreateDistribution", (p) => createDistribution(p, draft), { success: (res) => `배포 ${res.createdId}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/cloudfront/distributions/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  const empty = !project.services.s3.buckets.length && !topo.ofType("alb").length;
  return (
    <SpaceBetween>
      <PageHeader title="배포 생성" info={<InfoLink topic="cloudfront" />} description="CloudFront 배포를 만듭니다 (가상). 가상 도메인이 만들어지지만 실제로 접속되는 주소는 아닙니다." />
      {empty && (
        <Alert type="warning" header="원본이 없습니다">
          먼저 <a href={href("/s3/create")}>S3 버킷</a>이나 <a href={href("/ec2/load-balancers/select-type")}>로드 밸런서</a>를 만드세요.
        </Alert>
      )}
      <DistributionForm draft={draft} set={set} />
      <FormActions error={error ? <ErrorAlert message={error} header="배포를 만들 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/cloudfront/distributions")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          배포 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditDistributionPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const dist = project.services.cloudfront.distributions.find((d) => d.id === id);
  const [draft, setDraft] = useState<DistDraft | null>(() =>
    dist ? { comment: dist.comment, enabled: dist.enabled, defaultRootObject: dist.defaultRootObject, priceClass: dist.priceClass, origins: dist.origins, behaviors: dist.behaviors } : null,
  );
  const [error, setError] = useState<string | null>(null);
  if (!dist || !draft) return <DistributionNotFound />;
  const set = (p: Partial<DistDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const save = () => {
    setError(null);
    const r = run("UpdateDistribution", (p) => updateDistribution(p, dist.id, { ...draft, enabled: dist.enabled }), { success: () => `배포 ${dist.id}의 변경 사항을 배포하는 중입니다.` });
    if (r.ok) navigate(`/cloudfront/distributions/${dist.id}`);
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`배포 편집: ${dist.id}`} info={<InfoLink topic="cloudfront" />} description="저장하면 변경 사항을 다시 배포합니다(InProgress). 이미 캐시된 응답은 그대로 남습니다." />
      <DistributionForm draft={draft} set={set} />
      <FormActions error={error ? <ErrorAlert message={error} header="배포를 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(`/cloudfront/distributions/${dist.id}`)}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

// ================================================================ 상세

export function DistributionDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const [tab, setTab] = useQueryTab("general");
  const [deleting, setDeleting] = useState(false);
  const dist = project.services.cloudfront.distributions.find((d) => d.id === id);
  if (!dist) return <DistributionNotFound />;
  const toggle = () =>
    run("UpdateDistribution", (p) => setDistributionEnabled(p, dist.id, !dist.enabled), { success: () => (dist.enabled ? "배포를 비활성화하는 중입니다." : "배포를 활성화하는 중입니다."), flashError: true });
  return (
    <SpaceBetween>
      <PageHeader
        title={<span className="font-mono">{dist.id}</span>}
        info={<InfoLink topic="cloudfront" />}
        description={dist.comment || undefined}
        actions={
          <>
            <ButtonLink href={href(`/cloudfront/distributions/${dist.id}/edit`)}>편집</ButtonLink>
            <Button onClick={toggle}>{dist.enabled ? "비활성화" : "활성화"}</Button>
            <Button onClick={() => setDeleting(true)}>삭제</Button>
          </>
        }
      />
      <Tabs
        ariaLabel="배포 세부 정보"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "general", label: "일반", content: <GeneralTab dist={dist} onGo={setTab} /> },
          { id: "origins", label: "원본", content: <OriginsTab dist={dist} /> },
          { id: "behaviors", label: "동작", content: <BehaviorsTab dist={dist} /> },
          { id: "test", label: "요청 테스트", content: <RequestTestTab dist={dist} /> },
          { id: "invalidations", label: "무효화", content: <InvalidationsTab dist={dist} /> },
        ]}
      />
      {deleting && <DeleteDistributionModal dist={dist} onClose={() => setDeleting(false)} onDeleted={() => navigate("/cloudfront/distributions")} />}
    </SpaceBetween>
  );
}

function GeneralTab({ dist, onGo }: { dist: CfDistribution; onGo: (tab: string) => void }) {
  const project = useProject();
  const topo = useTopology();
  const health = distributionHealth(project, topo, dist);
  const missing = missingOacPolicies(project, dist);
  return (
    <SpaceBetween>
      {missing.length > 0 && (
        <Alert type="warning" header="S3 버킷 정책을 업데이트해야 합니다" action={<Button onClick={() => onGo("origins")}>원본 탭으로</Button>}>
          원본 {missing.map((o) => originTargetName(project, o)).join(", ")}의 버킷 정책에 이 배포(OAC)의 s3:GetObject 허용이 없어 요청이 403으로 거부됩니다.
        </Alert>
      )}
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "배포 도메인 이름 (가상)", value: <CopyText text={dist.domainName} /> },
            { label: "ARN (가상)", value: <CopyText text={distributionArn(dist.id)} /> },
            { label: "상태", value: <EnabledBadge dist={dist} /> },
            { label: "마지막 수정", value: <DeployState dist={dist} /> },
            { label: "가격 분류", value: PRICE_CLASS_LABEL[dist.priceClass] },
            { label: "기본 루트 객체", value: dist.defaultRootObject ? <span className="font-mono">{dist.defaultRootObject}</span> : "–" },
            { label: "설명", value: dist.comment || "–" },
            { label: "만든 날짜", value: formatDateTime(dist.createdAt) },
          ]}
        />
        {dist.state === "InProgress" && <p className="mt-4 text-sm text-aws-text-2">변경 사항을 엣지 로케이션에 배포하는 중입니다. 이 시뮬레이터에서는 몇 초 뒤 Deployed가 됩니다 (실제로는 보통 몇 분).</p>}
      </Container>
      <Container
        header={
          <ContainerHeader
            title="원본 연결 확인"
            description="기본 동작으로 루트(/)를 HTTPS GET으로 요청했다고 가정한 결과입니다. 설정을 바꾸면 바로 다시 계산합니다."
            actions={<Button onClick={() => onGo("test")}>요청 테스트</Button>}
          />
        }
      >
        <div data-testid="distribution-health" data-ok={health.ok}>
          <StatusIndicator type={health.ok ? "success" : "error"}>
            <span className="font-bold">{health.status ? `${health.status} 응답` : "응답 없음"}</span>
          </StatusIndicator>
          <p className="mt-1 text-[15px]">{health.detail}</p>
        </div>
      </Container>
    </SpaceBetween>
  );
}

function CopyPolicyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  return (
    <Button iconLeft={<Copy aria-hidden />} onClick={copy}>
      {copied ? "복사됨" : "정책 복사"}
    </Button>
  );
}

function OriginsTab({ dist }: { dist: CfDistribution }) {
  const project = useProject();
  const topo = useTopology();
  const run = useRunAction();
  return (
    <SpaceBetween>
      {dist.origins.map((o) => {
        const bucket = project.services.s3.buckets.find((b) => b.id === o.targetId);
        const alb = o.kind === "alb" ? topo.getOfType(o.targetId, "alb") : null;
        const users = dist.behaviors.filter((b) => b.originId === o.id).map((b) => (isDefaultBehavior(b) ? "기본 (*)" : b.pathPattern));
        let check: { type: "success" | "warning" | "error" | "info"; text: string };
        if (o.kind === "s3") {
          if (!bucket) check = { type: "error", text: "원본 버킷이 삭제되었습니다." };
          else if (o.originAccess === "oac") {
            const d = evaluateOacAccess(bucket, dist.id, "s3:GetObject", objectArn(bucket.name, dist.defaultRootObject || "index.html"));
            check = { type: d.allowed ? (d.scoped ? "success" : "warning") : "error", text: d.detail };
          } else {
            const a = evaluateS3Access(project, { bucketId: bucket.id, key: dist.defaultRootObject || "index.html", action: "s3:GetObject", caller: { kind: "anonymous" } });
            check = a.ok
              ? { type: "warning", text: "버킷이 공개되어 있어 익명 요청으로 읽습니다. CloudFront를 거치지 않고 S3 주소로도 누구나 읽을 수 있습니다. OAC를 쓰는 것이 권장됩니다." }
              : { type: "error", text: `익명 요청이 ${a.httpStatus} ${a.code}(으)로 거부됩니다. ${a.summary}` };
          }
        } else if (o.kind === "s3-website") {
          check = !bucket ? { type: "error", text: "원본 버킷이 삭제되었습니다." } : bucket.website.enabled ? { type: "info", text: `${websiteEndpoint(bucket.name)} (HTTP만). 버킷이 공개되어 있어야 합니다.` } : { type: "error", text: "버킷의 정적 웹 사이트 호스팅이 꺼져 있어 404가 됩니다." };
        } else {
          check = !alb
            ? { type: "error", text: "원본 로드 밸런서가 삭제되었습니다." }
            : alb.config.scheme === "internal"
              ? { type: "error", text: "내부(internal) 로드 밸런서라 인터넷에서 접속하는 CloudFront가 닿을 수 없습니다." }
              : { type: "success", text: `인터넷 경계 ALB입니다. CloudFront는 ${ORIGIN_PROTOCOL_LABEL[o.protocolPolicy]}(으)로 접속합니다. ALB 보안 그룹이 그 포트를 허용해야 합니다.` };
        }
        const statement = bucket && o.kind === "s3" && o.originAccess === "oac" ? JSON.stringify(oacPolicyStatement(bucket.name, dist.id), null, 2) : null;
        return (
          <Container key={o.id} header={<ContainerHeader title={<span className="font-mono break-all">{o.id}</span>} description={ORIGIN_KIND_LABEL[o.kind]} />}>
            <SpaceBetween size="m">
              <KeyValueGrid
                columns={3}
                items={[
                  { label: "대상", value: <OriginTargetLink project={project} origin={o} /> },
                  { label: o.kind === "alb" ? "프로토콜" : "원본 액세스", value: o.kind === "alb" ? ORIGIN_PROTOCOL_LABEL[o.protocolPolicy] : o.kind === "s3" ? (o.originAccess === "oac" ? "원본 액세스 제어 (OAC)" : "퍼블릭") : "퍼블릭 (웹 사이트 엔드포인트)" },
                  { label: "이 원본을 쓰는 동작", value: users.length ? users.join(", ") : "없음" },
                ]}
              />
              <div data-testid={`origin-check-${o.id}`} data-type={check.type}>
                <StatusIndicator type={check.type}>{check.text}</StatusIndicator>
              </div>
              {statement && bucket && (
                <SpaceBetween size="s">
                  <p className="text-sm">
                    버킷 정책에 아래 문을 넣으면 이 배포만 객체를 읽을 수 있습니다 (AWS:SourceArn 조건). 실제 콘솔의 &apos;정책 복사&apos; 후 버킷 정책에 붙여 넣는 것과 같습니다.
                  </p>
                  <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">{statement}</pre>
                  <div className="flex flex-wrap gap-2">
                    <CopyPolicyButton text={statement} />
                    <Button
                      variant="primary"
                      data-testid={`add-oac-policy-${o.id}`}
                      onClick={() => run("PutBucketPolicy", (p) => addOacBucketPolicy(p, dist.id, o.id), { success: () => `버킷 ${bucket.name}의 정책을 업데이트했습니다.`, flashError: true })}
                    >
                      버킷 정책에 추가
                    </Button>
                    <ButtonLink href={href(`/s3/buckets/${bucket.id}/edit-policy`)}>버킷 정책 편집</ButtonLink>
                  </div>
                </SpaceBetween>
              )}
            </SpaceBetween>
          </Container>
        );
      })}
    </SpaceBetween>
  );
}

function BehaviorsTab({ dist }: { dist: CfDistribution }) {
  return (
    <ResourceTable<CfBehavior>
      ariaLabel="동작 목록"
      items={dist.behaviors}
      trackBy={(b) => b.id}
      filtering={false}
      header={
        <ContainerHeader
          title="동작"
          counter={`(${dist.behaviors.length})`}
          info={<InfoLink topic="cloudfront-cache" />}
          description="우선순위 순서(위에서부터)로 경로 패턴을 비교해 처음 일치하는 동작을 씁니다. 기본 동작(*)은 항상 마지막입니다."
          actions={<ButtonLink href={href(`/cloudfront/distributions/${dist.id}/edit`)}>동작 편집</ButtonLink>}
        />
      }
      columns={[
        { id: "priority", header: "우선순위", cell: (b) => dist.behaviors.indexOf(b) },
        { id: "path", header: "경로 패턴", cell: (b) => <span className="font-mono">{isDefaultBehavior(b) ? "기본값 (*)" : b.pathPattern}</span> },
        { id: "origin", header: "원본", cell: (b) => <span className="break-all">{b.originId}</span> },
        { id: "viewer", header: "뷰어 프로토콜 정책", cell: (b) => VIEWER_POLICY_LABEL[b.viewerProtocolPolicy] },
        { id: "methods", header: "허용된 HTTP 메서드", cell: (b) => ALLOWED_METHODS_LABEL[b.allowedMethods] },
        { id: "cache", header: "캐시 정책", cell: (b) => `${b.cachePolicy} (TTL ${CACHE_POLICY_INFO[b.cachePolicy].ttlSeconds.toLocaleString("ko-KR")}초)` },
      ]}
    />
  );
}

// ---------------------------------------------------------------- 요청 테스트

interface TestRecord {
  key: string;
  /** 요청할 때의 배포 도메인 (가상) */
  domain: string;
  request: CfRequest;
  response: CfResponse;
  at: number;
}

function samplePaths(project: Project, dist: CfDistribution): string[] {
  const out = new Set<string>(["/"]);
  const def = dist.behaviors.find(isDefaultBehavior);
  const origin = dist.origins.find((o) => o.id === def?.originId);
  const bucket = origin && origin.kind !== "alb" ? project.services.s3.buckets.find((b) => b.id === origin.targetId) : undefined;
  for (const o of bucket?.objects.slice(0, 4) ?? []) out.add(`/${o.key}`);
  for (const b of dist.behaviors) if (!isDefaultBehavior(b)) out.add(`/${b.pathPattern.replace(/^\//, "").replace(/\*/g, "sample").replace(/\?/g, "x")}`);
  return [...out].slice(0, 8);
}

function ResponseView({ record }: { record: TestRecord }) {
  const { request, response } = record;
  const headers: [string, string][] = [
    ...(response.xCache ? [["x-cache", response.xCache] as [string, string]] : []),
    ...(response.ageSeconds !== null ? [["age", String(response.ageSeconds)] as [string, string]] : []),
    ...(response.location ? [["location", response.location] as [string, string]] : []),
    ...(response.contentType ? [["content-type", response.contentType] as [string, string]] : []),
    ...(response.etag ? [["etag", response.etag] as [string, string]] : []),
  ];
  const ok = response.status > 0 && response.status < 400;
  return (
    <div className="space-y-3 rounded-xl border border-aws-border p-4" data-testid="cf-response" data-status={response.status} data-xcache={response.xCache ?? ""}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm break-all">
          {request.method} {request.protocol}://{record.domain}
          {request.path.startsWith("/") ? request.path : `/${request.path}`}
        </p>
        <span className="text-[13px] text-aws-text-2">{formatTime(new Date(record.at).toISOString())}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusIndicator type={response.status === 0 ? "error" : ok ? "success" : response.status < 500 ? "warning" : "error"}>
          <span className="font-mono font-bold">{response.status ? `HTTP/2 ${response.status} ${response.statusText}` : "응답 없음"}</span>
        </StatusIndicator>
        {response.xCache && <Badge color={response.xCache.startsWith("Hit") || response.xCache.startsWith("RefreshHit") ? "green" : response.xCache.startsWith("Error") ? "red" : "blue"}>{response.xCache}</Badge>}
        {response.status > 0 && <Badge>{response.originRequested ? "원본에 요청함" : "원본에 가지 않음"}</Badge>}
      </div>
      {headers.length > 0 && (
        <pre className="overflow-x-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px]">{headers.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
      )}
      {response.preview && (
        <div>
          <p className="text-sm font-bold">본문 앞부분 (가상)</p>
          <pre className="max-h-40 overflow-auto rounded-lg bg-aws-bg p-3 font-mono text-[13px] whitespace-pre-wrap break-all">{response.preview}</pre>
        </div>
      )}
      <AccessSteps steps={response.steps} />
    </div>
  );
}

function RequestTestTab({ dist }: { dist: CfDistribution }) {
  const project = useProject();
  const topo = useTopology();
  const projectId = useConsoleProjectId();
  const [protocol, setProtocol] = useState<CfRequest["protocol"]>("https");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [records, setRecords] = useState<TestRecord[]>([]);
  const send = () => {
    const at = Date.now();
    const request: CfRequest = { protocol, method, path };
    const response = simulateCloudFrontRequest(project, topo, dist, request, at);
    const store = response.store;
    // 엣지 캐시는 AWS API로 바꾸는 설정이 아니라 시뮬레이터의 상태라 실행 취소 기록 없이 저장한다
    if (store) useProjectStore.getState().updateWithoutHistory(projectId, (p) => recordCacheEntry(p, dist.id, store));
    setRecords((r) => [{ key: `${at}-${r.length}`, domain: dist.domainName, request, response, at }, ...r].slice(0, 6));
  };
  return (
    <SpaceBetween>
      <Container
        header={
          <ContainerHeader
            title="요청 테스트 (가상)"
            info={<InfoLink topic="cloudfront-cache" />}
            description="뷰어가 이 배포에 요청했다고 가정하고 동작 선택 → 캐시 → 원본 순서로 응답을 계산합니다. 실제 HTTP 요청은 보내지 않습니다. 같은 경로를 두 번 보내 캐시 적중(Hit)을 확인해 보세요."
          />
        }
      >
        <SpaceBetween size="m">
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="프로토콜" className="w-32">
              <SelectInput value={protocol} onChange={(v) => setProtocol(v as CfRequest["protocol"])} options={[{ value: "https", label: "HTTPS" }, { value: "http", label: "HTTP" }]} />
            </FormField>
            <FormField label="메서드" className="w-32">
              <SelectInput value={method} onChange={setMethod} options={HTTP_METHODS.map((m) => ({ value: m, label: m }))} />
            </FormField>
            <FormField label="경로" className="min-w-56 flex-1">
              <TextInput value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" aria-label="요청 경로" onKeyDown={(e) => e.key === "Enter" && send()} />
            </FormField>
            <Button variant="primary" onClick={send} data-testid="cf-send">
              요청 보내기
            </Button>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="예시 경로">
            {samplePaths(project, dist).map((p) => (
              <Button key={p} variant="link" onClick={() => setPath(p)} className="font-mono">
                {p}
              </Button>
            ))}
          </div>
        </SpaceBetween>
      </Container>
      {records.length > 0 && (
        <SpaceBetween size="m">
          {records.map((r) => (
            <ResponseView key={r.key} record={r} />
          ))}
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 무효화·엣지 캐시

function InvalidationsTab({ dist }: { dist: CfDistribution }) {
  const run = useRunAction();
  const now = useNow();
  const [paths, setPaths] = useState("/*");
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    setError(null);
    const r = run("CreateInvalidation", (p) => createInvalidation(p, dist.id, paths.split(/\r?\n/)), { success: () => "무효화를 만들었습니다." });
    if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="무효화 생성" info={<InfoLink topic="cloudfront-cache" />} description="엣지 캐시에서 경로와 일치하는 응답을 지워, 다음 요청이 원본의 새 내용을 가져오게 합니다." />}>
        <SpaceBetween size="m">
          <FormField help={{ docKey: "cloudfront", field: "invalidation" }} label="객체 경로" constraint="한 줄에 하나씩. 예: /index.html, /images/* (와일드카드 *는 맨 끝에만)">
            <TextArea value={paths} onChange={(e) => setPaths(e.target.value)} rows={3} aria-label="무효화할 경로" />
          </FormField>
          {error && <ErrorAlert message={error} header="무효화를 만들 수 없습니다" />}
          <div>
            <Button variant="primary" onClick={create} data-testid="cf-invalidate">
              무효화 생성
            </Button>
          </div>
        </SpaceBetween>
      </Container>
      <ResourceTable
        ariaLabel="무효화 목록"
        items={dist.invalidations}
        trackBy={(i) => i.id}
        filtering={false}
        header={<ContainerHeader title="무효화" counter={`(${dist.invalidations.length})`} />}
        empty={<p className="px-6 py-4 text-sm text-aws-text-2">아직 무효화가 없습니다.</p>}
        columns={[
          { id: "id", header: "무효화 ID", cell: (i) => <span className="font-mono">{i.id}</span> },
          { id: "paths", header: "경로", cell: (i) => <span className="font-mono text-[13px] break-all">{i.paths.join(", ")}</span> },
          { id: "status", header: "상태", cell: () => <StatusIndicator type="success">완료됨 (즉시 반영)</StatusIndicator> },
          { id: "created", header: "만든 날짜", cell: (i) => formatDateTime(i.createdAt) },
        ]}
      />
      <ResourceTable
        ariaLabel="엣지 캐시"
        items={dist.cache}
        trackBy={(c) => c.path}
        filtering={false}
        header={
          <ContainerHeader
            title="엣지 캐시 (시뮬레이터 보기)"
            counter={`(${dist.cache.length})`}
            description="실제 콘솔에는 없는 화면입니다. 요청 테스트가 채운 가상 엣지 캐시를 보여 줍니다. 만료 시각이 지나면 다음 요청은 원본에 다시 확인합니다."
          />
        }
        empty={<p className="px-6 py-4 text-sm text-aws-text-2">캐시된 응답이 없습니다. 요청 테스트 탭에서 GET 요청을 보내 보세요.</p>}
        columns={[
          { id: "path", header: "경로", cell: (c) => <span className="font-mono text-[13px] break-all">{c.path}</span> },
          { id: "status", header: "응답", cell: (c) => c.status },
          { id: "etag", optional: true, header: "ETag", cell: (c) => <span className="font-mono text-[13px]">{c.etag || "–"}</span> },
          { id: "cached", header: "저장 시각", cell: (c) => formatTime(c.cachedAt) },
          {
            id: "expires",
            header: "만료 시각",
            cell: (c) => {
              const expires = Date.parse(c.cachedAt) + c.ttlSeconds * 1000;
              return (
                <span className="flex flex-wrap items-center gap-1">
                  {formatTime(new Date(expires).toISOString())} {now >= expires && <Badge>만료</Badge>}
                </span>
              );
            },
          },
          { id: "preview", optional: true, header: "캐시된 내용", cell: (c) => <span className="text-[13px] break-all text-aws-text-2">{c.preview?.slice(0, 80) ?? "–"}</span> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 삭제

function DeleteDistributionModal({ dist, onClose, onDeleted }: { dist: CfDistribution; onClose: () => void; onDeleted?: () => void }) {
  const run = useRunAction();
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={`배포 ${dist.id} 삭제`}
      onConfirm={() => {
        const r = run("DeleteDistribution", (p) => deleteDistribution(p, dist.id), { success: () => `배포 ${dist.id}을(를) 삭제했습니다.` });
        if (!r.ok) return withHint(r);
        onDeleted?.();
        return null;
      }}
    >
      <p>
        배포를 삭제하면 가상 도메인 <span className="font-mono">{dist.domainName}</span>이(가) 더 이상 응답하지 않습니다. 원본(S3 버킷·로드 밸런서)은 남습니다.
      </p>
      {dist.enabled && <Alert type="warning">활성화된 배포는 삭제할 수 없습니다. 먼저 비활성화하고, 배포가 끝난(Deployed) 뒤 삭제하세요.</Alert>}
    </DeleteModal>
  );
}
