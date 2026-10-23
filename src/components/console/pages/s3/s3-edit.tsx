"use client";

import { Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { bucketArn, roleArn, userArn } from "@/lib/engine/iam-engine";
import type { S3Bucket } from "@/lib/engine/resource-models";
import { formatBytes, guessContentType, isTextType, S3_TEXT_LIMIT, websiteEndpoint } from "@/lib/engine/s3-engine";
import type { ActionResult } from "@/lib/project/console-actions";
import { putBucketPolicy, putObject, setBlockPublicAccess, setBucketEncryption, setBucketVersioning, setBucketWebsite } from "@/lib/project/s3-actions";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate, useHashLocation } from "../../router";
import { Alert, ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { FormActions, FormField, RadioGroup, SelectInput, TextArea, TextInput, Toggle } from "../../ui/form";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { CopyText } from "../../ui/status";
import { PolicyEditor } from "../iam/iam-shared";
import { BpaFields, BucketNotFound, useBucket, type Bpa } from "./s3-shared";

function back(bucket: S3Bucket, tab: string) {
  navigate(`/s3/buckets/${bucket.id}`, { query: { tab } });
}

function Actions({ bucket, tab, onSave, label = "변경 사항 저장", disabled }: { bucket: S3Bucket; tab: string; onSave: () => void; label?: string; disabled?: boolean }) {
  return (
    <>
      <ButtonLink variant="link" href={href(`/s3/buckets/${bucket.id}`, { tab })}>
        취소
      </ButtonLink>
      <Button variant="primary" onClick={onSave} disabled={disabled}>
        {label}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------- 퍼블릭 액세스 차단

export function EditBpaPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const run = useRunAction();
  const [value, setValue] = useState<Bpa>(() => bucket?.blockPublicAccess ?? { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;
  const loosening = (Object.keys(value) as (keyof Bpa)[]).some((k) => bucket.blockPublicAccess[k] && !value[k]);
  const save = () => {
    const r = run("PutPublicAccessBlock", (p) => setBlockPublicAccess(p, bucket.id, value), { success: () => "퍼블릭 액세스 차단 설정을 저장했습니다." });
    if (r.ok) back(bucket, "permissions");
    else setError(withHint(r));
  };
  return (
    <SpaceBetween tour="s3-bpa-form">
      <PageHeader title="퍼블릭 액세스 차단 편집 (버킷 설정)" info={<InfoLink topic="s3-bpa" />} description={`버킷 ${bucket.name}`} />
      <Container header={<ContainerHeader title="퍼블릭 액세스 차단" description="인터넷의 누구나 이 버킷에 접근하지 못하게 막습니다. 정적 웹 사이트를 공개할 때만 끄세요." />}>
        <BpaFields value={value} onChange={setValue} />
      </Container>
      {loosening && (
        <Container header={<ContainerHeader title="설정 변경 확인" />}>
          <SpaceBetween size="m">
            <Alert type="warning">차단을 끄면 버킷 정책으로 버킷과 객체를 인터넷에 공개할 수 있게 됩니다. 실제 AWS에서는 데이터 유출 사고의 흔한 원인입니다.</Alert>
            <FormField label='확인하려면 필드에 "확인"을 입력합니다.'>
              <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="확인" className="max-w-xs" />
            </FormField>
          </SpaceBetween>
        </Container>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <Actions bucket={bucket} tab="permissions" onSave={save} disabled={loosening && typed !== "확인"} />
      </FormActions>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 버킷 정책

export function EditBucketPolicyPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const project = useProject();
  const run = useRunAction();
  const [policy, setPolicy] = useState(() => (bucket?.policy ? bucket.policy : ""));
  const [principal, setPrincipal] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;
  const arn = bucketArn(bucket.name);
  const principals = [
    ...project.services.iam.roles.map((r) => ({ value: roleArn(r.name), label: `역할 ${r.name}` })),
    ...project.services.iam.users.map((u) => ({ value: userArn(u.name), label: `사용자 ${u.name}` })),
  ];
  const templates: { id: string; label: string; build: () => object | null }[] = [
    {
      id: "public-read",
      label: "퍼블릭 읽기 (정적 웹 사이트용)",
      build: () => ({ Version: "2012-10-17", Statement: [{ Sid: "PublicReadGetObject", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `${arn}/*` }] }),
    },
    {
      id: "principal-rw",
      label: "선택한 IAM 사용자·역할에 읽기/쓰기 허용",
      build: () =>
        principal
          ? {
              Version: "2012-10-17",
              Statement: [
                { Sid: "AllowList", Effect: "Allow", Principal: { AWS: principal }, Action: "s3:ListBucket", Resource: arn },
                { Sid: "AllowReadWrite", Effect: "Allow", Principal: { AWS: principal }, Action: ["s3:GetObject", "s3:PutObject"], Resource: `${arn}/*` },
              ],
            }
          : null,
    },
    {
      id: "deny-delete",
      label: "모든 사람의 객체 삭제 금지 (Deny)",
      build: () => ({ Version: "2012-10-17", Statement: [{ Sid: "DenyDelete", Effect: "Deny", Principal: "*", Action: "s3:DeleteObject", Resource: `${arn}/*` }] }),
    },
  ];
  const apply = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId);
    const doc = t?.build();
    if (!doc) return setError("[InvalidRequest] 먼저 아래에서 권한을 줄 IAM 사용자나 역할을 고르세요.");
    setError(null);
    setPolicy(JSON.stringify(doc, null, 2));
  };
  const save = () => {
    const r = run("PutBucketPolicy", (p) => putBucketPolicy(p, bucket.id, policy), { success: () => (policy.trim() ? "버킷 정책을 저장했습니다." : "버킷 정책을 삭제했습니다.") });
    if (r.ok) back(bucket, "permissions");
    else setError(withHint(r));
  };
  return (
    <SpaceBetween tour="s3-policy-form">
      <PageHeader title="버킷 정책 편집" info={<InfoLink topic="s3-policy" />} description="버킷 정책은 리소스 기반 정책이라 Principal(누구에게)을 반드시 적습니다." />
      <Container header={<ContainerHeader title="버킷 ARN" description="정책의 Resource에는 이 ARN(버킷 자체) 또는 ARN/*(버킷 안의 객체)를 씁니다." />}>
        <CopyText text={arn} />
      </Container>
      {bucket.blockPublicAccess.blockPublicPolicy && (
        <Alert type="info" header="퍼블릭 정책 차단이 켜져 있습니다">
          Principal &quot;*&quot;(누구나)에게 허용하는 정책은 저장할 수 없습니다. 공개하려면 권한 탭에서 퍼블릭 액세스 차단을 먼저 끄세요.
        </Alert>
      )}
      <Container header={<ContainerHeader title="정책 예시로 시작" description="예시를 고르면 아래 편집기에 채워집니다. 필요하면 고쳐서 저장하세요." />}>
        <SpaceBetween size="m">
          <FormField label="권한을 줄 IAM 사용자·역할 (두 번째 예시용)">
            <SelectInput value={principal} onChange={setPrincipal} placeholder={principals.length ? "선택" : "IAM 사용자·역할이 없습니다"} options={principals} className="max-w-md" />
          </FormField>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <Button key={t.id} onClick={() => apply(t.id)}>
                {t.label}
              </Button>
            ))}
          </div>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="정책" description="비워 두고 저장하면 정책이 삭제됩니다." />}>
        <PolicyEditor value={policy || ""} onChange={setPolicy} kind="resource" />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <Actions bucket={bucket} tab="permissions" onSave={save} />
      </FormActions>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 버전 관리·암호화·웹 사이트

export function EditVersioningPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const run = useRunAction();
  const [status, setStatus] = useState<string>(bucket?.versioning ?? "Disabled");
  const [error, setError] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;
  const options =
    bucket.versioning === "Disabled"
      ? [
          { value: "Disabled", label: "비활성화 (현재)", description: "버전 관리를 한 번 켜면 다시 '비활성화'로 돌아갈 수 없고 '일시 중지'만 할 수 있습니다." },
          { value: "Enabled", label: "활성화" },
        ]
      : [
          { value: "Suspended", label: "일시 중지", description: "기존 버전은 남고, 새로 올리는 객체만 버전을 남기지 않습니다." },
          { value: "Enabled", label: "활성화" },
        ];
  const save = () => {
    if (status === bucket.versioning) return back(bucket, "properties");
    const r = run("PutBucketVersioning", (p) => setBucketVersioning(p, bucket.id, status as "Enabled" | "Suspended"), { success: () => "버전 관리 설정을 저장했습니다." });
    if (r.ok) back(bucket, "properties");
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="버킷 버전 관리 편집" info={<InfoLink topic="s3-versioning" />} description={`버킷 ${bucket.name}`} />
      <Container header={<ContainerHeader title="버킷 버전 관리" />}>
        <RadioGroup aria-label="버킷 버전 관리" value={status} onChange={setStatus} items={options} />
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <Actions bucket={bucket} tab="properties" onSave={save} />
      </FormActions>
    </SpaceBetween>
  );
}

export function EditEncryptionPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const run = useRunAction();
  const [encryption, setEncryption] = useState<S3Bucket["encryption"]>(bucket?.encryption ?? "SSE-S3");
  if (!bucket) return <BucketNotFound />;
  const save = () => {
    const r = run("PutBucketEncryption", (p) => setBucketEncryption(p, bucket.id, encryption), { success: () => "기본 암호화 설정을 저장했습니다.", flashError: true });
    if (r.ok) back(bucket, "properties");
  };
  return (
    <SpaceBetween>
      <PageHeader title="기본 암호화 편집" description={`버킷 ${bucket.name} — 바꾼 설정은 앞으로 올리는 객체에 적용됩니다.`} />
      <Container header={<ContainerHeader title="암호화 유형" />}>
        <RadioGroup
          aria-label="암호화 유형"
          value={encryption}
          onChange={(v) => setEncryption(v as S3Bucket["encryption"])}
          items={[
            { value: "SSE-S3", label: "SSE-S3 (Amazon S3 관리형 키)", description: "기본값. 추가 비용이 없습니다." },
            { value: "SSE-KMS", label: "SSE-KMS (AWS KMS 키)", description: "누가 언제 키를 썼는지 기록되고, 키 사용 권한을 따로 관리합니다." },
          ]}
        />
      </Container>
      <FormActions>
        <Actions bucket={bucket} tab="properties" onSave={save} />
      </FormActions>
    </SpaceBetween>
  );
}

export function EditWebsitePage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const run = useRunAction();
  const [enabled, setEnabled] = useState(bucket?.website.enabled ?? false);
  const [indexDocument, setIndexDocument] = useState(bucket?.website.indexDocument ?? "index.html");
  const [errorDocument, setErrorDocument] = useState(bucket?.website.errorDocument ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;
  const save = () => {
    const r = run("PutBucketWebsite", (p) => setBucketWebsite(p, bucket.id, { enabled, indexDocument, errorDocument }), {
      success: () => (enabled ? "정적 웹 사이트 호스팅을 켰습니다." : "정적 웹 사이트 호스팅을 껐습니다."),
    });
    if (r.ok) back(bucket, "properties");
    else setError(withHint(r));
  };
  return (
    <SpaceBetween tour="s3-website-form">
      <PageHeader title="정적 웹 사이트 호스팅 편집" info={<InfoLink topic="s3" />} description={`버킷 ${bucket.name}`} />
      <Container header={<ContainerHeader title="정적 웹 사이트 호스팅" description="HTML·CSS·이미지 같은 정적 파일만 제공합니다. 서버 코드(PHP 등)는 실행되지 않습니다." />}>
        <SpaceBetween size="m">
          <Toggle checked={enabled} onChange={setEnabled}>
            정적 웹 사이트 호스팅 활성화
          </Toggle>
          {enabled && (
            <>
              <FormField label="인덱스 문서" description="주소가 / 또는 폴더로 끝날 때 보여 줄 파일입니다." constraint="예: index.html">
                <TextInput value={indexDocument} onChange={(e) => setIndexDocument(e.target.value)} className="max-w-md" />
              </FormField>
              <FormField label="오류 문서" optional description="없는 주소를 요청했을 때 보여 줄 파일입니다." constraint="예: error.html">
                <TextInput value={errorDocument} onChange={(e) => setErrorDocument(e.target.value)} className="max-w-md" />
              </FormField>
              <Alert type="info" header="방문자가 볼 수 있게 하려면">
                웹 사이트 방문자는 익명 사용자입니다. ① 권한 탭에서 퍼블릭 액세스 차단을 끄고 ② 버킷 정책에 s3:GetObject를 Principal &quot;*&quot;에게 허용해야 합니다.
                <br />
                엔드포인트(가상): <span className="font-mono text-[13px]">{websiteEndpoint(bucket.name)}</span>
              </Alert>
            </>
          )}
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <Actions bucket={bucket} tab="properties" onSave={save} />
      </FormActions>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- 업로드

interface PendingFile {
  key: string;
  size: number;
  contentType: string;
  text: string | null;
  note?: string;
}

const SAMPLE_HTML = `<!doctype html>
<html lang="ko">
  <head><meta charset="utf-8"><title>내 첫 S3 웹 사이트</title></head>
  <body>
    <h1>안녕하세요!</h1>
    <p>이 페이지는 S3 정적 웹 사이트 호스팅(가상)으로 제공됩니다.</p>
  </body>
</html>`;

export function UploadPage({ id }: { id: string }) {
  const bucket = useBucket(id);
  const run = useRunAction();
  const { query } = useHashLocation();
  const prefix = query.get("prefix") ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [newKey, setNewKey] = useState("index.html");
  const [newText, setNewText] = useState(SAMPLE_HTML);
  const [error, setError] = useState<string | null>(null);
  if (!bucket) return <BucketNotFound />;

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const added: PendingFile[] = [];
    for (const f of Array.from(list)) {
      const contentType = f.type || guessContentType(f.name);
      const readable = isTextType(contentType) && f.size <= S3_TEXT_LIMIT;
      const text = readable ? await f.text() : null;
      added.push({
        key: `${prefix}${f.name}`,
        size: f.size,
        contentType,
        text,
        note: readable ? undefined : isTextType(contentType) ? `${S3_TEXT_LIMIT / 1024}KB 초과 — 내용은 저장하지 않고 크기·형식만 기록` : "텍스트가 아닌 파일 — 내용은 저장하지 않고 크기·형식만 기록",
      });
    }
    setFiles((prev) => [...prev.filter((p) => !added.some((a) => a.key === p.key)), ...added]);
  };

  const addText = () => {
    const key = `${prefix}${newKey.trim()}`;
    if (!newKey.trim()) return setError("[InvalidArgument] 파일 이름(키)을 입력하세요.");
    setError(null);
    const size = new TextEncoder().encode(newText).length;
    setFiles((prev) => [...prev.filter((p) => p.key !== key), { key, size, contentType: guessContentType(key), text: newText, note: size > S3_TEXT_LIMIT ? `${S3_TEXT_LIMIT / 1024}KB 초과 — 내용은 저장되지 않습니다` : undefined }]);
  };

  const upload = () => {
    if (!files.length) return setError("[InvalidRequest] 업로드할 파일을 추가하세요.");
    const r = run(
      "PutObject",
      (p): ActionResult => {
        let next = p;
        const notes: string[] = [];
        for (const f of files) {
          const res = putObject(next, bucket.id, { key: f.key, size: f.size, contentType: f.contentType, text: f.text });
          if (!res.ok) return res;
          next = res.project;
          notes.push(...res.notes);
        }
        return { ok: true, project: next, notes };
      },
      { success: () => `객체 ${files.length}개를 업로드했습니다.` },
    );
    if (r.ok) navigate(`/s3/buckets/${bucket.id}`, { query: { tab: "objects", prefix: prefix || null } });
    else setError(withHint(r));
  };

  return (
    <div className="space-y-6" data-tour="s3-upload-form">
      <PageHeader
        title="업로드"
        info={<InfoLink topic="s3" />}
        description={`대상: s3://${bucket.name}/${prefix} — 파일은 이 브라우저에만 저장됩니다. ${S3_TEXT_LIMIT / 1024}KB 이하 텍스트 파일만 내용을 보관하고, 나머지는 크기·형식 정보만 기록합니다.`}
      />
      <Container header={<ContainerHeader title="파일 추가" description="컴퓨터의 파일을 고르거나, 아래에서 텍스트 파일을 직접 만들 수 있습니다." />}>
        <SpaceBetween size="m">
          <input ref={inputRef} type="file" multiple className="sr-only" aria-label="업로드할 파일 선택" onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ""))} />
          <div className="flex flex-wrap gap-2">
            <Button iconLeft={<Upload aria-hidden />} onClick={() => inputRef.current?.click()}>
              파일 선택
            </Button>
          </div>
          <div className="space-y-3 rounded-xl border border-aws-border p-4">
            <p className="font-bold">텍스트 파일 직접 만들기</p>
            <FormField label="파일 이름(키)" constraint={prefix ? `실제 키: ${prefix}${newKey}` : "예: index.html, error.html, notes/todo.txt"}>
              <TextInput value={newKey} onChange={(e) => setNewKey(e.target.value)} className="max-w-md" />
            </FormField>
            <FormField label="내용">
              <TextArea value={newText} onChange={(e) => setNewText(e.target.value)} rows={8} className="font-mono text-[13px]" />
            </FormField>
            <Button onClick={addText}>목록에 추가</Button>
          </div>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title={`파일 및 폴더 (${files.length})`} />}>
        {files.length === 0 ? (
          <p className="text-[15px] text-aws-text-2">아직 추가한 파일이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-aws-divider">
            {files.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-mono text-[14px] break-all">{f.key}</p>
                  <p className="text-sm text-aws-text-2">
                    {formatBytes(f.size)} · {f.contentType}
                    {f.note ? ` · ${f.note}` : ""}
                  </p>
                </div>
                <Button variant="icon" aria-label={`${f.key} 제거`} onClick={() => setFiles(files.filter((x) => x.key !== f.key))}>
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Container>
      <Container header={<ContainerHeader title="대상 설정" />}>
        <p className="text-[15px]">
          스토리지 클래스: Standard · 암호화: {bucket.encryption} · 버전 관리: {bucket.versioning === "Enabled" ? "활성화 (같은 이름이면 이전 버전 보관)" : bucket.versioning === "Suspended" ? "일시 중지" : "비활성화 (같은 이름이면 덮어씀)"}
        </p>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href(`/s3/buckets/${bucket.id}`, { tab: "objects", prefix: prefix || null })}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={upload}>
          업로드
        </Button>
      </FormActions>
    </div>
  );
}

