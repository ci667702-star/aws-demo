"use client";

import { useState } from "react";
import type { S3Bucket } from "@/lib/engine/resource-models";
import { bucketAccess, bucketNameWarnings, bucketSize, formatBytes, S3_REGION_LABEL, validateBucketName } from "@/lib/engine/s3-engine";
import { createBucket, deleteBucket, emptyBucket } from "@/lib/project/s3-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, RadioGroup, TextInput } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { ResourceTable } from "../../ui/table";
import { StartTutorialButton } from "../../tutorial/tutorial-menu";
import { AccessBadge, allOn, BpaFields, PublicWarning, type Bpa } from "./s3-shared";

export function BucketListPage() {
  const project = useProject();
  const run = useRunAction();
  const buckets = project.services.s3.buckets;
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<"empty" | "delete" | null>(null);
  const current = buckets.find((b) => b.id === selected[0]);
  const totals = buckets.reduce((t, b) => {
    const s = bucketSize(b);
    return { objects: t.objects + s.objects, bytes: t.bytes + s.bytes };
  }, { objects: 0, bytes: 0 });
  const publicCount = buckets.filter((b) => bucketAccess(b).kind === "public").length;
  return (
    <SpaceBetween>
      <PageGuide topic="s3" />
      <Container header={<ContainerHeader title="계정 스냅샷 (가상)" info={<InfoLink topic="s3" />} description="이 샌드박스에 저장된 객체 요약입니다. 실제 파일은 업로드되지 않습니다." />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "버킷", value: `${buckets.length}개` },
            { label: "객체", value: `${totals.objects}개` },
            { label: "총 크기", value: formatBytes(totals.bytes) },
            { label: "퍼블릭 버킷", value: publicCount ? <span className="font-bold text-aws-error">{publicCount}개</span> : "없음" },
          ]}
        />
      </Container>
      <ResourceTable<S3Bucket>
        ariaLabel="범용 버킷 목록"
        items={buckets}
        trackBy={(b) => b.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(b) => b.name}
        filterPlaceholder="이름으로 버킷 찾기"
        header={
          <PageHeader
            title="범용 버킷"
            counter={`(${buckets.length})`}
            info={<InfoLink topic="s3" />}
            description="버킷은 파일(객체)을 담는 상자입니다. 버킷 이름은 전 세계 모든 AWS 계정에서 하나뿐이어야 합니다."
            actions={
              <>
                <StartTutorialButton tutorialId="s3-static-site" label="따라하기 튜토리얼" />
                <Button disabled={!current} onClick={() => setModal("empty")}>
                  비우기
                </Button>
                <Button disabled={!current} onClick={() => setModal("delete")}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/s3/create")} data-tour="s3-create-button">
                  버킷 만들기
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="버킷 없음" description="버킷을 만들고 파일을 올려 보세요. 정적 웹 사이트도 호스팅할 수 있습니다." action={<ButtonLink href={href("/s3/create")}>버킷 만들기</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (b) => <a className="font-bold text-aws-link hover:underline" href={href(`/s3/buckets/${b.id}`)}>{b.name}</a>, sortValue: (b) => b.name },
          { id: "region", header: "AWS 리전", cell: () => S3_REGION_LABEL, optional: true },
          { id: "access", header: "액세스", cell: (b) => <AccessBadge bucket={b} />, sortValue: (b) => bucketAccess(b).kind },
          { id: "objects", header: "객체", cell: (b) => `${bucketSize(b).objects}개 · ${formatBytes(bucketSize(b).bytes)}`, sortValue: (b) => bucketSize(b).objects },
          { id: "versioning", header: "버전 관리", cell: (b) => ({ Disabled: "비활성화", Enabled: "활성화", Suspended: "일시 중지" })[b.versioning], optional: true },
          { id: "created", header: "생성 날짜", cell: (b) => formatDateTime(b.createdAt), sortValue: (b) => b.createdAt },
        ]}
      />
      {modal === "empty" && current && (
        <DeleteModal
          open
          onClose={() => setModal(null)}
          title={`버킷 ${current.name} 비우기`}
          actionLabel="비우기"
          confirmText="영구 삭제"
          onConfirm={() => {
            const r = run("DeleteObjects", (p) => emptyBucket(p, current.id), { success: () => `버킷 ${current.name}을(를) 비웠습니다.` });
            return r.ok ? null : withHint(r);
          }}
        >
          <p>버킷 안의 모든 객체와 이전 버전, 삭제 마커를 영구 삭제합니다. 버전 관리가 켜져 있어도 되돌릴 수 없습니다(이 샌드박스의 실행 취소 제외).</p>
        </DeleteModal>
      )}
      {modal === "delete" && current && (
        <DeleteModal
          open
          onClose={() => setModal(null)}
          title={`버킷 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeleteBucket", (p) => deleteBucket(p, current.id), { success: () => `버킷 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>버킷은 비어 있어야 삭제할 수 있습니다. 실제 AWS에서는 삭제한 이름을 다른 계정이 바로 가져갈 수도 있습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

const ALL_BLOCKED: Bpa = { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true };

export function CreateBucketPage() {
  const run = useRunAction();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [bpa, setBpa] = useState<Bpa>(ALL_BLOCKED);
  const [acknowledged, setAcknowledged] = useState(false);
  const [versioning, setVersioning] = useState<"Disabled" | "Enabled">("Disabled");
  const [encryption, setEncryption] = useState<S3Bucket["encryption"]>("SSE-S3");
  const [error, setError] = useState<string | null>(null);
  const nameError = touched ? validateBucketName(name.trim()) : null;
  const create = () => {
    setTouched(true);
    setError(null);
    if (!allOn(bpa) && !acknowledged) return setError("[InvalidRequest] 퍼블릭 액세스 차단을 끄려면 경고 내용을 확인하고 체크하세요.");
    const r = run("CreateBucket", (p) => createBucket(p, { name, blockPublicAccess: bpa, versioning, encryption }), {
      success: () => `버킷 ${name.trim()}을(를) 만들었습니다.`,
    });
    if (r.ok && r.createdId) navigate(`/s3/buckets/${r.createdId}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <div className="space-y-6" data-tour="s3-create-form">
      <PageHeader title="버킷 만들기" info={<InfoLink topic="s3" />} description="버킷은 만든 뒤 이름과 리전을 바꿀 수 없습니다. 설정 대부분은 나중에 바꿀 수 있습니다." />
      <PageGuide topic="s3" />
      <Container header={<ContainerHeader title="일반 구성" />}>
        <SpaceBetween size="m">
          <KeyValueGrid
            columns={2}
            items={[
              { label: "AWS 리전", value: `${S3_REGION_LABEL} (가상)` },
              { label: "버킷 유형", value: "범용 — 대부분의 용도에 쓰는 기본 유형" },
            ]}
          />
          <FormField
            label="버킷 이름"
            info={<InfoLink topic="s3" />}
            description="전 세계에서 하나뿐인 이름이어야 합니다. 예: my-site-2026-kim"
            constraint="3~63자. 영문 소문자, 숫자, 마침표(.), 하이픈(-)만 사용. 소문자나 숫자로 시작하고 끝나야 합니다."
            error={nameError ?? undefined}
          >
            <TextInput value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="my-site-2026-kim" maxLength={63} autoComplete="off" />
          </FormField>
          {bucketNameWarnings(name.trim()).map((w) => (
            <Alert key={w} type="info">
              {w}
            </Alert>
          ))}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="객체 소유권" />}>
        <p className="text-[15px]">
          <span className="font-bold">ACL 비활성화됨 (권장)</span> — 버킷의 모든 객체를 이 계정이 소유하고, 접근 권한은 정책(IAM 정책·버킷 정책)으로만 관리합니다.
        </p>
      </Container>
      <Container header={<ContainerHeader title="이 버킷의 퍼블릭 액세스 차단 설정" info={<InfoLink topic="s3-bpa" />} description="인터넷의 누구나(익명) 버킷에 접근하지 못하도록 막는 안전장치입니다. 버킷 정책보다 먼저 적용됩니다." />}>
        <SpaceBetween size="m">
          <BpaFields value={bpa} onChange={setBpa} />
          {!allOn(bpa) && <PublicWarning acknowledged={acknowledged} onAcknowledge={setAcknowledged} />}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="버킷 버전 관리" info={<InfoLink topic="s3-versioning" />} description="같은 이름으로 다시 올리거나 삭제해도 이전 버전을 보관해 실수를 되돌릴 수 있습니다." />}>
        <RadioGroup
          aria-label="버킷 버전 관리"
          value={versioning}
          onChange={(v) => setVersioning(v as typeof versioning)}
          items={[
            { value: "Disabled", label: "비활성화", description: "덮어쓰거나 삭제하면 이전 내용이 사라집니다." },
            { value: "Enabled", label: "활성화", description: "모든 버전을 보관합니다 (실제 AWS에서는 보관한 버전만큼 저장 요금이 듭니다)." },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="기본 암호화" description="S3는 새 객체를 항상 암호화해 저장합니다. 어떤 키로 암호화할지 고릅니다." />}>
        <RadioGroup
          aria-label="암호화 유형"
          value={encryption}
          onChange={(v) => setEncryption(v as S3Bucket["encryption"])}
          items={[
            { value: "SSE-S3", label: "Amazon S3 관리형 키를 사용한 서버 측 암호화(SSE-S3)", description: "추가 설정과 비용이 없는 기본값입니다." },
            { value: "SSE-KMS", label: "AWS Key Management Service 키를 사용한 서버 측 암호화(SSE-KMS)", description: "키 사용 기록과 권한을 따로 관리할 수 있습니다 (KMS 요청 요금 발생 가능)." },
          ]}
        />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="버킷을 만들 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/s3")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={create}>
          버킷 만들기
        </Button>
      </FormActions>
    </div>
  );
}
