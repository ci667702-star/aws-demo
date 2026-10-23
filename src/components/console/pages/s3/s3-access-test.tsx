"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { displayName } from "@/lib/engine/topology-engine";
import { evaluateS3Access, visibleObjects, type S3AccessRequest, type S3Caller } from "@/lib/engine/s3-engine";
import { useProject } from "../../console-context";
import { href, useHashLocation } from "../../router";
import { Button, ButtonLink } from "../../ui/button";
import { FormField, SelectInput, TextInput, Tiles } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { PageGuide } from "../../ui/page-guide";
import { StatusIndicator, type StatusType } from "../../ui/status";
import { useTopology } from "../common";

const ACTIONS = [
  { value: "s3:GetObject", label: "s3:GetObject — 객체 읽기(내려받기)" },
  { value: "s3:PutObject", label: "s3:PutObject — 객체 올리기" },
  { value: "s3:DeleteObject", label: "s3:DeleteObject — 객체 삭제" },
  { value: "s3:ListBucket", label: "s3:ListBucket — 버킷의 객체 목록 보기" },
];

type CallerKind = S3Caller["kind"];

const STEP_TYPE: Record<string, StatusType> = { pass: "success", fail: "error", info: "info", warn: "warning" };

export function S3AccessTestPage() {
  const project = useProject();
  const topo = useTopology();
  const { query } = useHashLocation();
  const { buckets } = project.services.s3;
  const { users, roles } = project.services.iam;
  const instances = topo.ofType("ec2").filter((i) => i.config.state !== "terminated");
  const [bucketId, setBucketId] = useState(query.get("bucket") ?? buckets[0]?.id ?? "");
  const [key, setKey] = useState(query.get("key") ?? "");
  const [action, setAction] = useState("s3:GetObject");
  const [callerKind, setCallerKind] = useState<CallerKind>("anonymous");
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? "");
  const [request, setRequest] = useState<S3AccessRequest | null>(null);
  // 설정을 바꾸면 결과도 바로 다시 계산된다
  const result = request ? evaluateS3Access(project, request) : null;
  const bucket = buckets.find((b) => b.id === bucketId);
  const objectAction = action !== "s3:ListBucket";

  if (!buckets.length) {
    return (
      <SpaceBetween>
        <PageHeader title="S3 접근 테스트" info={<InfoLink topic="s3-policy" />} />
        <Container>
          <EmptyState title="버킷이 없습니다" description="먼저 버킷을 만들고 파일을 올린 뒤 누가 접근할 수 있는지 시험해 보세요." action={<ButtonLink href={href("/s3/create")}>버킷 만들기</ButtonLink>} />
        </Container>
      </SpaceBetween>
    );
  }

  const caller = (): S3Caller | null => {
    if (callerKind === "anonymous") return { kind: "anonymous" };
    if (callerKind === "user") return userId ? { kind: "user", userId } : null;
    if (callerKind === "role") return roleId ? { kind: "role", roleId } : null;
    return instanceId ? { kind: "instance", instanceId } : null;
  };
  const c = caller();

  return (
    <SpaceBetween>
      <PageHeader
        title="S3 접근 테스트"
        info={<InfoLink topic="s3-policy" />}
        description="누가(익명·IAM 사용자·EC2 서버) 어떤 작업을 할 때 성공하는지, 실패하면 어느 단계에서 막히는지 보여 줍니다. 네트워크 → 자격 증명 → IAM 정책·버킷 정책·퍼블릭 액세스 차단 → 객체 순서로 검사합니다."
      />
      <PageGuide topic="s3-policy" />
      <Container header={<ContainerHeader title="1. 누가 요청하나요?" />}>
        <SpaceBetween size="m">
          <Tiles
            aria-label="요청하는 주체"
            columns={4}
            value={callerKind}
            onChange={(v) => setCallerKind(v as CallerKind)}
            items={[
              { value: "anonymous", label: "인터넷의 브라우저", description: "로그인하지 않은 익명 사용자" },
              { value: "user", label: "IAM 사용자", description: "노트북의 CLI·SDK가 액세스 키로 서명" },
              { value: "instance", label: "EC2 인스턴스", description: "서버 안의 프로그램 (역할 사용)" },
              { value: "role", label: "IAM 역할", description: "역할의 임시 자격 증명" },
            ]}
          />
          {callerKind === "user" && (
            <FormField label="IAM 사용자">
              <SelectInput value={userId} onChange={setUserId} placeholder={users.length ? "선택" : "사용자가 없습니다"} options={users.map((u) => ({ value: u.id, label: u.name, description: `활성 키 ${u.accessKeys.filter((k) => k.status === "Active").length}개` }))} className="max-w-md" />
            </FormField>
          )}
          {callerKind === "role" && (
            <FormField label="IAM 역할">
              <SelectInput value={roleId} onChange={setRoleId} placeholder={roles.length ? "선택" : "역할이 없습니다"} options={roles.map((r) => ({ value: r.id, label: r.name }))} className="max-w-md" />
            </FormField>
          )}
          {callerKind === "instance" && (
            <FormField label="EC2 인스턴스" description="인스턴스에서 S3 엔드포인트까지 네트워크로 갈 수 있는지도 함께 검사합니다.">
              <SelectInput
                value={instanceId}
                onChange={setInstanceId}
                placeholder={instances.length ? "선택" : "인스턴스가 없습니다"}
                options={instances.map((i) => ({ value: i.id, label: `${i.id} (${displayName(i)})`, description: i.config.state }))}
                className="max-w-md"
              />
            </FormField>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="2. 무엇을 하려고 하나요?" />}>
        <div className="grid gap-4 md:grid-cols-3">
          <FormField label="버킷">
            <SelectInput value={bucketId} onChange={setBucketId} options={buckets.map((b) => ({ value: b.id, label: b.name }))} />
          </FormField>
          <FormField label="작업">
            <SelectInput value={action} onChange={setAction} options={ACTIONS} />
          </FormField>
          {objectAction && (
            <FormField label="객체 키" constraint="예: index.html">
              <TextInput value={key} onChange={(e) => setKey(e.target.value)} list="pg-object-keys" placeholder="index.html" />
              <datalist id="pg-object-keys">
                {bucket && visibleObjects(bucket).map((o) => <option key={o.key} value={o.key} />)}
              </datalist>
            </FormField>
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" disabled={!c || !bucketId} onClick={() => c && setRequest({ bucketId, key: objectAction ? key.trim() : null, action, caller: c })}>
            테스트 실행
          </Button>
        </div>
      </Container>
      {result && (
        <Container
          header={
            <ContainerHeader
              title="3. 결과"
              description="설정을 바꾸면 결과가 바로 다시 계산됩니다."
              actions={
                <span className={result.ok ? "text-xl font-bold text-aws-success" : "text-xl font-bold text-aws-error"} aria-live="polite">
                  {result.httpStatus === 0 ? "연결 실패" : `HTTP ${result.httpStatus} ${result.code}`}
                </span>
              }
            />
          }
        >
          <SpaceBetween size="m">
            <StatusIndicator type={result.ok ? "success" : "error"}>
              <span className="font-bold">{result.summary}</span>
            </StatusIndicator>
            {result.network && result.network.path.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-aws-text-2">
                네트워크 경로:
                {result.network.path.map((h, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    {i > 0 && <ArrowRight className="size-3.5" aria-hidden />}
                    {h.label}
                  </span>
                ))}
              </p>
            )}
            <ol className="space-y-3">
              {result.steps.map((s, i) => (
                <li key={i} className="rounded-xl border border-aws-border p-3">
                  <StatusIndicator type={STEP_TYPE[s.status]}>
                    <span className="font-bold">
                      {i + 1}. {s.title}
                    </span>
                  </StatusIndicator>
                  <p className="mt-1 pl-6 text-[15px] leading-relaxed">{s.detail}</p>
                  {s.link && (
                    <a className="mt-1 inline-block pl-6 text-sm text-aws-link hover:underline" href={href(s.link.path)}>
                      {s.link.label} →
                    </a>
                  )}
                </li>
              ))}
            </ol>
            {result.decision && result.decision.matched.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-bold">일치한 정책 문장</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">
                  {result.decision.matched.map((m, i) => (
                    <li key={i}>
                      <span className={m.statement.effect === "Deny" ? "font-bold text-aws-error" : "font-bold text-aws-success"}>{m.statement.effect}</span> · {m.source}
                      {m.statement.sid ? ` (Sid: ${m.statement.sid})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
}
