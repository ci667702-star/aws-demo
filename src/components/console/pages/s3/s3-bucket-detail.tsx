"use client";

import { File, Folder } from "lucide-react";
import { useState } from "react";
import { bucketArn } from "@/lib/engine/iam-engine";
import type { S3Bucket, S3Object } from "@/lib/engine/resource-models";
import { bucketAccess, bucketSize, formatBytes, listLevel, S3_REGION_LABEL, websiteEndpoint, websiteRequest, type WebsiteResponse } from "@/lib/engine/s3-engine";
import { createFolder, deleteObject, deleteObjects, putBucketPolicy } from "@/lib/project/s3-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, useHashLocation } from "../../router";
import { ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormField, TextInput, Toggle } from "../../ui/form";
import { Container, ContainerHeader, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { useQueryTab } from "../common";
import { PolicyDocumentView } from "../iam/iam-shared";
import { AccessBadge, BPA_ITEMS, BucketNotFound, useBucket } from "./s3-shared";

export const objectHref = (bucketId: string, key: string) => href(`/s3/buckets/${bucketId}/object`, { key });

export function BucketDetailPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const [tab, setTab] = useQueryTab("objects");
  if (!bucket) return <BucketNotFound />;
  const size = bucketSize(bucket);
  return (
    <SpaceBetween>
      <PageHeader title={bucket.name} info={<InfoLink topic="s3" />} description={`${S3_REGION_LABEL} · 객체 ${size.objects}개 · ${formatBytes(size.bytes)}`} actions={<AccessBadge bucket={bucket} />} />
      <Tabs
        ariaLabel="버킷 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          { id: "objects", label: "객체", content: <ObjectsTab bucket={bucket} /> },
          { id: "properties", label: "속성", content: <PropertiesTab bucket={bucket} /> },
          { id: "permissions", label: "권한", content: <PermissionsTab bucket={bucket} /> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 객체 탭

interface Row {
  id: string;
  kind: "folder" | "object" | "version";
  key: string;
  object?: S3Object;
  versionId?: string;
  deleteMarker?: boolean;
  size: number;
  lastModified?: string;
  current?: boolean;
}

function rowsFor(bucket: S3Bucket, prefix: string, showVersions: boolean): Row[] {
  const level = listLevel(bucket, prefix, showVersions);
  const rows: Row[] = level.folders.map((f) => ({ id: `f:${f}`, kind: "folder", key: f, size: 0 }));
  for (const o of level.objects) {
    if (!showVersions) {
      rows.push({ id: `o:${o.key}`, kind: "object", key: o.key, object: o, size: o.size, lastModified: o.lastModified });
      continue;
    }
    rows.push({ id: `v:${o.key}:${o.versionId}`, kind: "version", key: o.key, object: o, versionId: o.versionId, deleteMarker: o.deleteMarker, size: o.size, lastModified: o.lastModified, current: true });
    for (const v of o.previousVersions) {
      rows.push({ id: `v:${o.key}:${v.versionId}`, kind: "version", key: o.key, object: o, versionId: v.versionId, deleteMarker: v.deleteMarker, size: v.size, lastModified: v.lastModified });
    }
  }
  return rows;
}

function ObjectsTab({ bucket }: { bucket: S3Bucket }) {
  const run = useRunAction();
  const { query } = useHashLocation();
  const prefix = query.get("prefix") ?? "";
  const [showVersions, setShowVersions] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<"delete" | "folder" | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const rows = rowsFor(bucket, prefix, showVersions);
  const chosen = rows.filter((r) => selected.includes(r.id));
  const versioned = bucket.versioning !== "Disabled" || bucket.objects.some((o) => o.previousVersions.length || o.deleteMarker);
  const permanent = showVersions || bucket.versioning === "Disabled";
  const goPrefix = (p: string) => {
    setSelected([]);
    navigate(`/s3/buckets/${bucket.id}`, { query: { tab: "objects", prefix: p || null } });
  };
  const segments = prefix.split("/").filter(Boolean);

  const remove = (): string | null => {
    if (showVersions) {
      const versions = chosen.filter((r) => r.kind === "version");
      const r = run(
        "DeleteObjectVersions",
        (p) => {
          let next = p;
          for (const v of versions) {
            const res = deleteObject(next, bucket.id, v.key, v.versionId);
            if (!res.ok) return res;
            next = res.project;
          }
          return { ok: true, project: next, notes: [`버전 ${versions.length}개를 영구 삭제했습니다.`] };
        },
        { success: () => "선택한 버전을 삭제했습니다." },
      );
      if (!r.ok) return withHint(r);
    } else {
      const keys = chosen.map((r) => r.key);
      const r = run("DeleteObjects", (p) => deleteObjects(p, bucket.id, keys), { success: () => `객체 ${keys.length}개를 삭제했습니다.` });
      if (!r.ok) return withHint(r);
    }
    setSelected([]);
    return null;
  };

  return (
    <SpaceBetween>
      <ResourceTable<Row>
        ariaLabel="객체 목록"
        items={rows}
        trackBy={(r) => r.id}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => r.key}
        filterPlaceholder="접두사(이름)로 객체 찾기"
        header={
          <SpaceBetween size="m">
            <ContainerHeader
              title="객체"
              counter={`(${rows.length})`}
              info={<InfoLink topic="s3" />}
              description="객체는 버킷에 저장한 파일입니다. 이름에 /가 있으면 콘솔은 폴더처럼 묶어서 보여 줍니다 (실제로는 이름의 일부)."
              actions={
                <>
                  <Button disabled={!chosen.length} onClick={() => setModal("delete")}>
                    삭제
                  </Button>
                  <Button disabled={showVersions} onClick={() => setModal("folder")}>
                    폴더 만들기
                  </Button>
                  <ButtonLink variant="primary" href={href(`/s3/buckets/${bucket.id}/upload`, { prefix: prefix || null })} data-tour="s3-upload-button">
                    업로드
                  </ButtonLink>
                </>
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <nav aria-label="폴더 위치" className="flex flex-wrap items-center gap-1 text-[15px]">
                <button type="button" className="font-bold text-aws-link hover:underline" onClick={() => goPrefix("")}>
                  {bucket.name}
                </button>
                {segments.map((s, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className="text-aws-text-3">/</span>
                    <button type="button" className="text-aws-link hover:underline" onClick={() => goPrefix(`${segments.slice(0, i + 1).join("/")}/`)}>
                      {s}
                    </button>
                  </span>
                ))}
              </nav>
              {versioned && (
                <Toggle
                  checked={showVersions}
                  onChange={(v) => {
                    setShowVersions(v);
                    setSelected([]);
                  }}
                >
                  버전 표시
                </Toggle>
              )}
            </div>
          </SpaceBetween>
        }
        empty={
          <div className="py-6 text-center text-[15px] text-aws-text-2">
            {prefix ? "이 폴더에 객체가 없습니다." : "버킷에 객체가 없습니다. 업로드를 눌러 파일을 올려 보세요."}
          </div>
        }
        columns={[
          {
            id: "name",
            header: "이름",
            sortValue: (r) => r.key,
            filterValue: (r) => r.key,
            cell: (r) => {
              const label = r.key.slice(prefix.length) || r.key;
              if (r.kind === "folder") {
                return (
                  <button type="button" className="inline-flex items-center gap-1.5 font-bold text-aws-link hover:underline" onClick={() => goPrefix(r.key)}>
                    <Folder className="size-4" aria-hidden />
                    {label}
                  </button>
                );
              }
              return (
                <a className="inline-flex items-center gap-1.5 text-aws-link hover:underline" href={objectHref(bucket.id, r.key)}>
                  <File className="size-4" aria-hidden />
                  {label}
                </a>
              );
            },
          },
          ...(showVersions
            ? [
                {
                  id: "version",
                  header: "버전 ID",
                  cell: (r: Row) =>
                    r.kind === "folder" ? (
                      "–"
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px]">{r.versionId}</span>
                        {r.current && <Badge color="blue">현재 버전</Badge>}
                        {r.deleteMarker && <Badge color="orange">삭제 마커</Badge>}
                      </span>
                    ),
                },
              ]
            : []),
          { id: "type", header: "유형", cell: (r) => (r.kind === "folder" ? "폴더" : r.deleteMarker ? "삭제 마커" : (r.key.split(".").pop() ?? "").slice(0, 8) || "–") },
          { id: "modified", header: "마지막 수정", cell: (r) => (r.lastModified ? formatDateTime(r.lastModified) : "–"), sortValue: (r) => r.lastModified ?? "" },
          { id: "size", header: "크기", cell: (r) => (r.kind === "folder" || r.deleteMarker ? "–" : formatBytes(r.size)), sortValue: (r) => r.size },
          { id: "class", header: "스토리지 클래스", cell: (r) => (r.kind === "folder" || r.deleteMarker ? "–" : "Standard"), optional: true },
        ]}
      />
      {modal === "delete" && (
        <DeleteModal
          open
          onClose={() => setModal(null)}
          title={permanent ? "객체 영구 삭제" : "객체 삭제"}
          confirmText={permanent ? "영구 삭제" : "삭제"}
          onConfirm={remove}
        >
          <SpaceBetween size="s">
            <ul className="list-disc pl-5">
              {chosen.slice(0, 10).map((r) => (
                <li key={r.id} className="break-all">
                  {r.key}
                  {r.versionId ? ` (버전 ${r.versionId})` : ""}
                </li>
              ))}
              {chosen.length > 10 && <li>외 {chosen.length - 10}개</li>}
            </ul>
            <p className="text-aws-text-2">
              {showVersions
                ? "선택한 버전을 영구 삭제합니다. 삭제 마커를 지우면 바로 아래 버전이 현재 버전으로 되살아납니다."
                : bucket.versioning === "Disabled"
                  ? "버전 관리가 꺼져 있어 영구 삭제됩니다. 폴더를 고르면 그 안의 객체가 모두 삭제됩니다."
                  : "버전 관리가 켜져 있어 객체를 지우는 대신 '삭제 마커'를 붙입니다. '버전 표시'를 켜고 삭제 마커를 지우면 복구할 수 있습니다."}
            </p>
          </SpaceBetween>
        </DeleteModal>
      )}
      {modal === "folder" && (
        <Modal
          open
          size="small"
          onClose={() => setModal(null)}
          title="폴더 만들기"
          footer={
            <>
              <Button variant="link" onClick={() => setModal(null)}>
                취소
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const r = run("PutObject", (p) => createFolder(p, bucket.id, prefix, folderName), { success: () => `폴더 ${folderName.trim()}을(를) 만들었습니다.` });
                  if (!r.ok) return setFolderError(withHint(r));
                  setFolderName("");
                  setFolderError(null);
                  setModal(null);
                }}
              >
                폴더 만들기
              </Button>
            </>
          }
        >
          <SpaceBetween size="m">
            <FormField label="폴더 이름" description={`위치: ${bucket.name}/${prefix}`} constraint="S3에는 진짜 폴더가 없고, 이름이 '폴더이름/'인 빈 객체를 만들어 폴더처럼 보여 줍니다.">
              <TextInput value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="images" />
            </FormField>
            {folderError && <ErrorAlert message={folderError} />}
          </SpaceBetween>
        </Modal>
      )}
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 속성 탭

const VERSIONING_LABEL = { Disabled: "비활성화", Enabled: "활성화", Suspended: "일시 중지" } as const;

function PropertiesTab({ bucket }: { bucket: S3Bucket }) {
  const [preview, setPreview] = useState(false);
  const editLink = (segment: string) => (
    <ButtonLink href={href(`/s3/buckets/${bucket.id}/${segment}`)}>편집</ButtonLink>
  );
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="버킷 개요" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "AWS 리전", value: S3_REGION_LABEL },
            { label: "Amazon 리소스 이름(ARN)", value: <CopyText text={bucketArn(bucket.name)} /> },
            { label: "생성 날짜", value: formatDateTime(bucket.createdAt) },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="버킷 버전 관리" info={<InfoLink topic="s3-versioning" />} description="같은 키로 다시 올리거나 삭제해도 이전 버전을 보관합니다." actions={editLink("edit-versioning")} />}>
        <KeyValueGrid columns={2} items={[{ label: "버킷 버전 관리", value: VERSIONING_LABEL[bucket.versioning] }]} />
      </Container>
      <Container header={<ContainerHeader title="기본 암호화" description="새 객체는 항상 이 방식으로 암호화되어 저장됩니다 (가상)." actions={editLink("edit-encryption")} />}>
        <KeyValueGrid columns={2} items={[{ label: "암호화 유형", value: bucket.encryption === "SSE-S3" ? "Amazon S3 관리형 키를 사용한 서버 측 암호화(SSE-S3)" : "AWS KMS 키를 사용한 서버 측 암호화(SSE-KMS)" }]} />
      </Container>
      <Container
        header={
          <ContainerHeader
            title="정적 웹 사이트 호스팅"
            info={<InfoLink topic="s3" />}
            description="버킷의 HTML 파일을 웹 사이트처럼 제공합니다. 방문자는 익명이므로 버킷을 공개해야 합니다."
            actions={
              <>
                {bucket.website.enabled && (
                  <Button onClick={() => setPreview(true)} data-tour="s3-website-preview">
                    웹 사이트 열어 보기 (가상)
                  </Button>
                )}
                {editLink("edit-website")}
              </>
            }
          />
        }
      >
        <KeyValueGrid
          columns={3}
          items={
            bucket.website.enabled
              ? [
                  { label: "상태", value: <StatusIndicator type="success">활성화됨</StatusIndicator> },
                  { label: "인덱스 문서", value: bucket.website.indexDocument },
                  { label: "오류 문서", value: bucket.website.errorDocument || "–" },
                  { label: "버킷 웹 사이트 엔드포인트 (가상)", value: <CopyText text={websiteEndpoint(bucket.name)} /> },
                ]
              : [{ label: "상태", value: "비활성화됨" }]
          }
        />
      </Container>
      {preview && <WebsitePreview bucket={bucket} onClose={() => setPreview(false)} />}
    </SpaceBetween>
  );
}

/** 가상 브라우저: 웹 사이트 엔드포인트로 요청했을 때의 응답을 보여 준다 */
export function WebsitePreview({ bucket, onClose }: { bucket: S3Bucket; onClose: () => void }) {
  const project = useProject();
  const [path, setPath] = useState("/");
  const [response, setResponse] = useState<WebsiteResponse>(() => websiteRequest(project, bucket.id, "/"));
  const [showSource, setShowSource] = useState(false);
  const go = (p: string) => {
    setPath(p);
    setResponse(websiteRequest(project, bucket.id, p));
  };
  const html = response.body !== null && response.contentType === "text/html";
  return (
    <Modal open size="large" onClose={onClose} title="웹 사이트 열어 보기 (가상 브라우저)">
      <SpaceBetween size="m">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go(path);
          }}
        >
          <span className="max-w-full truncate font-mono text-[13px] text-aws-text-2">{websiteEndpoint(bucket.name)}</span>
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} aria-label="요청 경로" className="w-56" />
          <Button type="submit">요청</Button>
        </form>
        <p className="font-mono text-[14px]">
          HTTP/1.1{" "}
          <span className={response.status < 300 ? "font-bold text-aws-success" : response.status < 400 ? "font-bold text-aws-info" : "font-bold text-aws-error"}>
            {response.status} {response.code}
          </span>
          {response.location && (
            <>
              {" "}
              → Location: {response.location}{" "}
              <button type="button" className="text-aws-link hover:underline" onClick={() => go(response.location!)}>
                따라가기
              </button>
            </>
          )}
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-aws-text-2">
          {response.explanation.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        {response.body !== null ? (
          <div className="space-y-2">
            {html && (
              <Toggle checked={showSource} onChange={setShowSource}>
                HTML 소스 보기
              </Toggle>
            )}
            {html && !showSource ? (
              // 사용자가 올린 HTML은 스크립트·폼·이동이 모두 막힌 샌드박스 iframe에서만 그린다
              <iframe title="웹 사이트 미리 보기" sandbox="" srcDoc={response.body} className="h-80 w-full rounded-xl border border-aws-border bg-white" />
            ) : (
              <pre className="max-h-80 overflow-auto rounded-xl border border-aws-border bg-aws-surface-2 p-3 font-mono text-[13px] whitespace-pre-wrap">{response.body}</pre>
            )}
          </div>
        ) : response.key ? (
          <p className="text-sm text-aws-text-2">이 객체는 내용을 저장하지 않은 파일이라 미리 볼 수 없습니다 (크기·형식 정보만 있음).</p>
        ) : null}
      </SpaceBetween>
    </Modal>
  );
}

// ---------------------------------------------------------------- 권한 탭

function PermissionsTab({ bucket }: { bucket: S3Bucket }) {
  const run = useRunAction();
  const [deleting, setDeleting] = useState(false);
  const access = bucketAccess(bucket);
  return (
    <SpaceBetween>
      <Container header={<ContainerHeader title="권한 개요" />}>
        <SpaceBetween size="s">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-aws-text-2">액세스</span>
            <AccessBadge bucket={bucket} />
          </div>
          <p className="text-[15px]">{access.detail}</p>
          <p className="text-sm">
            누가 접근할 수 있는지 직접 시험해 보려면{" "}
            <a className="text-aws-link hover:underline" href={href("/s3/access-test", { bucket: bucket.id })}>
              S3 접근 테스트
            </a>
            를 쓰세요.
          </p>
        </SpaceBetween>
      </Container>
      <Container
        header={
          <ContainerHeader
            title="퍼블릭 액세스 차단 (버킷 설정)"
            info={<InfoLink topic="s3-bpa" />}
            description="버킷 정책보다 먼저 적용되는 안전장치입니다."
            actions={<ButtonLink href={href(`/s3/buckets/${bucket.id}/edit-bpa`)}>편집</ButtonLink>}
          />
        }
      >
        <ul className="space-y-1.5">
          {BPA_ITEMS.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start gap-2">
              {bucket.blockPublicAccess[item.key] ? <StatusIndicator type="success">켜짐</StatusIndicator> : <StatusIndicator type="warning">꺼짐</StatusIndicator>}
              <span className="text-[15px]">{item.label}</span>
            </li>
          ))}
        </ul>
      </Container>
      <Container
        header={
          <ContainerHeader
            title="버킷 정책"
            info={<InfoLink topic="s3-policy" />}
            description="JSON으로 작성한 리소스 기반 정책입니다. 다른 사용자·역할·익명 사용자에게 이 버킷에 대한 권한을 줍니다."
            actions={
              <>
                {bucket.policy && <Button onClick={() => setDeleting(true)}>삭제</Button>}
                <ButtonLink href={href(`/s3/buckets/${bucket.id}/edit-policy`)}>편집</ButtonLink>
              </>
            }
          />
        }
      >
        {bucket.policy ? <PolicyDocumentView document={bucket.policy} kind="resource" /> : <p className="text-[15px] text-aws-text-2">표시할 정책이 없습니다. 같은 계정의 사용자·역할은 IAM 정책만으로도 접근할 수 있습니다.</p>}
      </Container>
      <Container header={<ContainerHeader title="객체 소유권" />}>
        <p className="text-[15px]">ACL 비활성화됨 (권장) — 이 버킷의 모든 객체는 이 계정이 소유하며, 접근은 정책으로만 관리합니다.</p>
      </Container>
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title="버킷 정책 삭제"
          confirmText="삭제"
          onConfirm={() => {
            const r = run("DeleteBucketPolicy", (p) => putBucketPolicy(p, bucket.id, ""), { success: () => "버킷 정책을 삭제했습니다." });
            return r.ok ? null : withHint(r);
          }}
        >
          <p>버킷 정책으로 받은 권한(공개 읽기 등)이 모두 사라집니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

