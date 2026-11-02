"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { objectArn } from "@/lib/engine/iam-engine";
import { evaluateS3Access, findObject, formatBytes, objectS3Uri, objectUrl, S3_REGION_LABEL } from "@/lib/engine/s3-engine";
import { deleteObject } from "@/lib/project/s3-actions";
import { downloadTextFile } from "@/lib/ui/download";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, useHashLocation } from "../../router";
import { Button, ButtonLink } from "../../ui/button";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal, Modal } from "../../ui/overlay";
import { Badge, CopyText, StatusIndicator } from "../../ui/status";
import { Tabs } from "../../ui/tabs";
import { useQueryTab } from "../common";
import { BucketNotFound, useBucket } from "./s3-shared";

export function ObjectDetailPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const project = useProject();
  const run = useRunAction();
  const { query } = useHashLocation();
  const key = query.get("key") ?? "";
  const [tab, setTab] = useQueryTab("properties");
  const [modal, setModal] = useState<"delete" | "open" | null>(null);
  const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;
  const object = bucket.objects.find((o) => o.key === key);
  const current = findObject(bucket, key);
  if (!object) {
    return (
      <Container>
        <EmptyState title="객체를 찾을 수 없습니다" description={`키: ${key}`} action={<ButtonLink href={href(`/s3/buckets/${bucket.id}`)}>버킷으로 돌아가기</ButtonLink>} />
      </Container>
    );
  }
  const name = key.split("/").filter(Boolean).pop() ?? key;
  const publicRead = evaluateS3Access(project, { bucketId: bucket.id, key, action: "s3:GetObject", caller: { kind: "anonymous" } });
  const versions = [object, ...object.previousVersions];
  return (
    <SpaceBetween>
      <PageHeader
        title={name}
        info={<InfoLink topic="s3" />}
        description={`s3://${bucket.name}/${key}`}
        actions={
          <>
            <Button disabled={!current} onClick={() => setModal("delete")}>
              삭제
            </Button>
            <Button disabled={current?.text == null} onClick={() => setModal("open")}>
              열기
            </Button>
            <Button
              variant="primary"
              iconLeft={<Download aria-hidden />}
              disabled={current?.text == null}
              onClick={() => current?.text != null && downloadTextFile(name, current.text, current.contentType || "text/plain")}
            >
              다운로드
            </Button>
          </>
        }
      />
      {object.deleteMarker && (
        <Container>
          <StatusIndicator type="warning">현재 버전이 삭제 마커입니다. 버전 탭에서 삭제 마커를 지우면 이전 버전이 복구됩니다.</StatusIndicator>
        </Container>
      )}
      <Tabs
        ariaLabel="객체 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "properties",
            label: "속성",
            content: (
              <Container header={<ContainerHeader title="객체 개요" />}>
                <KeyValueGrid
                  columns={3}
                  items={[
                    { label: "소유자", value: "이 계정 (가상)" },
                    { label: "AWS 리전", value: S3_REGION_LABEL },
                    { label: "마지막 수정", value: formatDateTime(object.lastModified) },
                    { label: "크기", value: object.deleteMarker ? "–" : formatBytes(object.size) },
                    { label: "유형", value: object.contentType || "–" },
                    { label: "키", value: <CopyText text={key} /> },
                    { label: "S3 URI", value: <CopyText text={objectS3Uri(bucket.name, key)} /> },
                    { label: "Amazon 리소스 이름(ARN)", value: <CopyText text={objectArn(bucket.name, key)} /> },
                    { label: "엔터티 태그(Etag, 가상)", value: object.etag || "–" },
                    { label: "객체 URL (가상 — 실제로 열리지 않음)", value: <CopyText text={objectUrl(bucket.name, key)} /> },
                    { label: "버전 ID", value: object.versionId },
                    { label: "스토리지 클래스", value: "Standard" },
                    { label: "서버 측 암호화", value: bucket.encryption },
                    { label: "내용 저장 여부", value: current?.text != null ? "저장됨 (미리 보기·다운로드 가능)" : "크기·형식 정보만 있음" },
                  ]}
                />
              </Container>
            ),
          },
          {
            id: "permissions",
            label: "권한",
            content: (
              <Container header={<ContainerHeader title="퍼블릭 접근" info={<InfoLink topic="s3-bpa" />} description="인터넷의 누구나(익명)가 객체 URL로 이 객체를 읽을 수 있는지 확인합니다." />}>
                <SpaceBetween size="m">
                  {publicRead.ok ? (
                    <StatusIndicator type="warning">공개됨 — 익명 사용자가 읽을 수 있습니다 ({publicRead.httpStatus} {publicRead.code})</StatusIndicator>
                  ) : (
                    <StatusIndicator type="success">비공개 — 익명 사용자는 읽을 수 없습니다 ({publicRead.httpStatus} {publicRead.code})</StatusIndicator>
                  )}
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-aws-text-2">
                    {publicRead.steps
                      .filter((s) => s.title.startsWith("권한"))
                      .map((s, i) => (
                        <li key={i}>{s.detail}</li>
                      ))}
                  </ul>
                  <p className="text-sm">
                    <a className="text-aws-link hover:underline" href={href("/s3/access-test", { bucket: bucket.id, key })}>
                      다른 사용자·서버로 접근 테스트하기
                    </a>
                  </p>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "versions",
            label: `버전 (${versions.length})`,
            content: (
              <Container header={<ContainerHeader title="버전" info={<InfoLink topic="s3-versioning" />} description={bucket.versioning === "Disabled" ? "버전 관리가 꺼져 있어 버전 ID가 null인 버전 하나만 있습니다." : "가장 위가 현재 버전입니다."} />}>
                <ul className="divide-y divide-aws-divider">
                  {versions.map((v, i) => (
                    <li key={`${v.versionId}-${i}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                      <div className="space-y-0.5">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[13px]">{v.versionId}</span>
                          {i === 0 && <Badge color="blue">현재 버전</Badge>}
                          {v.deleteMarker && <Badge color="orange">삭제 마커</Badge>}
                        </p>
                        <p className="text-sm text-aws-text-2">
                          {formatDateTime(v.lastModified)}
                          {!v.deleteMarker && ` · ${formatBytes(v.size)}`}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {!v.deleteMarker && v.text != null && (
                          <Button onClick={() => downloadTextFile(name, v.text ?? "", v.contentType || "text/plain")} iconLeft={<Download aria-hidden />}>
                            이 버전 다운로드
                          </Button>
                        )}
                        <Button onClick={() => setDeletingVersion(v.versionId)}>{v.deleteMarker ? "삭제 마커 지우기(복구)" : "영구 삭제"}</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Container>
            ),
          },
        ]}
      />
      {modal === "open" && current?.text != null && (
        <Modal open size="large" onClose={() => setModal(null)} title={`${name} 내용`}>
          <pre className="max-h-[60vh] overflow-auto rounded-xl border border-aws-border bg-aws-surface-2 p-3 font-mono text-[13px] whitespace-pre-wrap">{current.text}</pre>
        </Modal>
      )}
      {modal === "delete" && (
        <DeleteModal
          open
          onClose={() => setModal(null)}
          title={`${name} 삭제`}
          confirmText={bucket.versioning === "Disabled" ? "영구 삭제" : "삭제"}
          onConfirm={() => {
            const r = run("DeleteObject", (p) => deleteObject(p, bucket.id, key), { success: () => `${name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            if (bucket.versioning === "Disabled") navigate(`/s3/buckets/${bucket.id}`);
            return null;
          }}
        >
          <p>{bucket.versioning === "Disabled" ? "버전 관리가 꺼져 있어 영구 삭제됩니다." : "삭제 마커가 추가되어 목록에서 사라지지만 이전 버전은 남아 있어 복구할 수 있습니다."}</p>
        </DeleteModal>
      )}
      {deletingVersion && (
        <DeleteModal
          open
          onClose={() => setDeletingVersion(null)}
          title="버전 삭제"
          confirmText="영구 삭제"
          onConfirm={() => {
            const remaining = versions.length - 1;
            const r = run("DeleteObjectVersion", (p) => deleteObject(p, bucket.id, key, deletingVersion), { success: () => "버전을 삭제했습니다." });
            if (!r.ok) return withHint(r);
            if (remaining === 0) navigate(`/s3/buckets/${bucket.id}`);
            return null;
          }}
        >
          <p>
            버전 <span className="font-mono">{deletingVersion}</span>을(를) 영구 삭제합니다. 현재 버전을 지우면 바로 아래 버전이 현재 버전이 됩니다.
          </p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}
