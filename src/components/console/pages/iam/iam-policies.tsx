"use client";

import { useState } from "react";
import { bucketArn, checkPolicyDocument, KNOWN_SERVICES, policyArn, policyAttachments, SERVICE_ACTIONS } from "@/lib/engine/iam-engine";
import { createPolicy, deletePolicy, updatePolicyDocument } from "@/lib/project/iam-actions";
import { formatDateTime } from "@/lib/ui/format";
import { useProject, useRunAction } from "../../console-context";
import { withHint } from "../../error-codes";
import { href, navigate } from "../../router";
import { ErrorAlert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { Checkbox, FormActions, FormField, RadioGroup, SelectInput, TextArea, TextInput } from "../../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { DeleteModal } from "../../ui/overlay";
import { PageGuide } from "../../ui/page-guide";
import { CopyText } from "../../ui/status";
import { ResourceTable } from "../../ui/table";
import { Tabs } from "../../ui/tabs";
import { useQueryTab } from "../common";
import { POLICY_TEMPLATES, PolicyDocumentView, PolicyEditor, PolicyTypeBadge, useIamPolicyList } from "./iam-shared";

type PolicyRow = ReturnType<typeof useIamPolicyList>[number];

export function PolicyListPage() {
  const project = useProject();
  const run = useRunAction();
  const policies = useIamPolicyList();
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const shown = policies.filter((p) => type === "all" || (type === "aws" ? p.managed : !p.managed));
  const current = policies.find((p) => p.id === selected[0]);
  const attachedCount = (id: string) => {
    const a = policyAttachments(project, id);
    return a.users.length + a.groups.length + a.roles.length;
  };
  return (
    <SpaceBetween>
      <PageGuide topic="iam-policy" />
      <ResourceTable<PolicyRow>
        ariaLabel="IAM 정책 목록"
        items={shown}
        trackBy={(p) => p.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(p) => p.name}
        header={
          <SpaceBetween size="m">
            <PageHeader
              title="정책"
              counter={`(${shown.length})`}
              info={<InfoLink topic="iam-policy" />}
              description="정책은 '어떤 작업(Action)을 어떤 리소스(Resource)에 허용/거부(Effect)할지' 적은 JSON 문서입니다."
              actions={
                <>
                  <Button disabled={!current || current.managed} onClick={() => setDeleting(true)}>
                    삭제
                  </Button>
                  <ButtonLink variant="primary" href={href("/iam/policies/create")}>
                    정책 생성
                  </ButtonLink>
                </>
              }
            />
            <FormField label="유형으로 필터링" className="max-w-xs">
              <SelectInput
                value={type}
                onChange={setType}
                options={[
                  { value: "all", label: "모든 유형" },
                  { value: "aws", label: "AWS 관리형" },
                  { value: "customer", label: "고객 관리형" },
                ]}
              />
            </FormField>
          </SpaceBetween>
        }
        empty={<EmptyState title="정책 없음" description="직접 만든 정책이 없습니다." action={<ButtonLink href={href("/iam/policies/create")}>정책 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "정책 이름", cell: (p) => <a className="font-bold text-aws-link hover:underline" href={href(`/iam/policies/${encodeURIComponent(p.id)}`)}>{p.name}</a>, sortValue: (p) => p.name },
          { id: "type", header: "유형", cell: (p) => <PolicyTypeBadge managed={p.managed} />, sortValue: (p) => (p.managed ? 0 : 1) },
          { id: "used", header: "연결된 엔터티", cell: (p) => attachedCount(p.id), sortValue: (p) => attachedCount(p.id) },
          { id: "description", header: "설명", cell: (p) => p.description || "–", filterValue: (p) => p.description },
        ]}
      />
      {deleting && current && !current.managed && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`정책 ${current.name} 삭제`}
          confirmText={current.name}
          onConfirm={() => {
            const r = run("DeletePolicy", (p) => deletePolicy(p, current.id), { success: () => `정책 ${current.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            setSelected([]);
            return null;
          }}
        >
          <p>사용자·그룹·역할에 연결된 정책은 먼저 분리해야 삭제할 수 있습니다.</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

const BUILDER_SERVICES = [...new Set(SERVICE_ACTIONS.map((a) => a.service))];
const EMPTY_DOCUMENT = JSON.stringify({ Version: "2012-10-17", Statement: [] }, null, 2);

/** 시각적 편집기: 문장 하나를 골라서 JSON에 추가한다 */
function StatementBuilder({ document, onChange }: { document: string; onChange: (doc: string) => void }) {
  const buckets = useProject().services.s3.buckets;
  const [effect, setEffect] = useState<"Allow" | "Deny">("Allow");
  const [service, setService] = useState("s3");
  const [actions, setActions] = useState<string[]>([]);
  const [allActions, setAllActions] = useState(false);
  const [scope, setScope] = useState<"all" | "bucket">("all");
  const [bucket, setBucket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const serviceActions = SERVICE_ACTIONS.filter((a) => a.service === service);
  const toggle = (a: string, on: boolean) => setActions(on ? [...actions, a] : actions.filter((x) => x !== a));
  const add = () => {
    setError(null);
    const chosen = allActions ? [`${service}:*`] : actions.map((a) => `${service}:${a}`);
    if (!chosen.length) return setError("작업을 하나 이상 고르세요.");
    let resources: string[] = ["*"];
    if (service === "s3" && scope === "bucket") {
      const name = bucket.trim();
      if (!name) return setError("버킷 이름을 입력하세요.");
      resources = [bucketArn(name), `${bucketArn(name)}/*`];
    }
    let parsed: { Version?: string; Statement?: unknown };
    try {
      parsed = JSON.parse(document.trim() || EMPTY_DOCUMENT);
    } catch {
      return setError("아래 JSON에 문법 오류가 있어 문장을 추가할 수 없습니다. 오류를 먼저 고치세요.");
    }
    const list = Array.isArray(parsed.Statement) ? parsed.Statement : parsed.Statement ? [parsed.Statement] : [];
    const statement = { Effect: effect, Action: chosen.length === 1 ? chosen[0] : chosen, Resource: resources.length === 1 ? resources[0] : resources };
    onChange(JSON.stringify({ Version: parsed.Version ?? "2012-10-17", Statement: [...list, statement] }, null, 2));
    setActions([]);
    setAllActions(false);
  };
  return (
    <SpaceBetween size="m">
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="효과 (Effect)">
          <RadioGroup
            aria-label="효과"
            value={effect}
            onChange={(v) => setEffect(v as "Allow" | "Deny")}
            items={[
              { value: "Allow", label: "허용 (Allow)" },
              { value: "Deny", label: "거부 (Deny)", description: "Deny는 다른 어떤 Allow보다 우선합니다." },
            ]}
          />
        </FormField>
        <FormField label="서비스">
          <SelectInput
            value={service}
            onChange={(v) => {
              setService(v);
              setActions([]);
              setAllActions(false);
            }}
            options={BUILDER_SERVICES.map((s) => ({ value: s, label: `${KNOWN_SERVICES[s] ?? s} (${s})` }))}
          />
        </FormField>
      </div>
      <FormField label="작업 (Action)">
        <div className="space-y-2 rounded-xl border border-aws-border p-3">
          <Checkbox checked={allActions} onChange={setAllActions} description="편하지만 필요 이상으로 넓은 권한이 됩니다.">
            모든 {service} 작업 ({service}:*)
          </Checkbox>
          <div className="grid gap-x-6 gap-y-1.5 border-t border-aws-divider pt-2 sm:grid-cols-2">
            {serviceActions.map((a) => (
              <Checkbox key={a.action} checked={allActions || actions.includes(a.action)} disabled={allActions} onChange={(v) => toggle(a.action, v)}>
                <span className="font-mono text-[13px]">{a.action}</span> <span className="text-aws-text-2">— {a.description}</span>
              </Checkbox>
            ))}
          </div>
        </div>
      </FormField>
      <FormField label="리소스 (Resource)">
        {service === "s3" ? (
          <SpaceBetween size="s">
            <RadioGroup
              aria-label="리소스 범위"
              value={scope}
              onChange={(v) => setScope(v as "all" | "bucket")}
              items={[
                { value: "all", label: "모든 리소스 (*)" },
                { value: "bucket", label: "특정 버킷과 그 안의 객체" },
              ]}
            />
            {scope === "bucket" && (
              <SelectOrType
                value={bucket}
                onChange={setBucket}
                options={buckets.map((b) => b.name)}
                placeholder="버킷 이름 (예: my-site-bucket)"
              />
            )}
          </SpaceBetween>
        ) : (
          <p className="text-sm text-aws-text-2">이 서비스는 시뮬레이터에서 리소스를 &quot;*&quot;(전체)로만 다룹니다.</p>
        )}
      </FormField>
      {error && <ErrorAlert message={error} header="문장을 추가할 수 없습니다" />}
      <div>
        <Button onClick={add}>JSON에 문장 추가</Button>
      </div>
    </SpaceBetween>
  );
}

function SelectOrType({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: string[]; placeholder: string }) {
  return (
    <div className="flex max-w-xl flex-wrap gap-2">
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} list="pg-bucket-names" className="min-w-60 flex-1" />
      <datalist id="pg-bucket-names">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

export function CreatePolicyPage() {
  const run = useRunAction();
  const [step, setStep] = useState<1 | 2>(1);
  const [document, setDocument] = useState(EMPTY_DOCUMENT);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const check = checkPolicyDocument(document, "identity");
  const create = () => {
    const r = run("CreatePolicy", (p) => createPolicy(p, { name, description, document }), { success: () => `정책 ${name.trim()}을(를) 만들었습니다.` });
    if (r.ok && r.createdId) navigate(`/iam/policies/${encodeURIComponent(r.createdId)}`);
    else if (!r.ok) setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader
        title="정책 생성"
        info={<InfoLink topic="iam-policy" />}
        description={step === 1 ? "1단계 / 2단계 — 권한 지정: 위의 시각적 편집기로 문장을 추가하거나 JSON을 직접 고칩니다." : "2단계 / 2단계 — 검토 및 생성"}
      />
      {step === 1 && (
        <>
          <Container header={<ContainerHeader title="시각적 편집기" description="효과 → 서비스 → 작업 → 리소스 순서로 고르고 'JSON에 문장 추가'를 누르세요." />}>
            <StatementBuilder document={document} onChange={setDocument} />
          </Container>
          <Container
            header={
              <ContainerHeader
                title="정책 편집기 (JSON)"
                description="입력할 때마다 문법을 검사합니다."
                actions={
                  <>
                    <SelectInput
                      aria-label="템플릿으로 시작"
                      value=""
                      placeholder="템플릿으로 시작…"
                      onChange={(v) => {
                        const t = POLICY_TEMPLATES.find((x) => x.id === v);
                        if (t) setDocument(JSON.stringify(t.document, null, 2));
                      }}
                      options={POLICY_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
                      className="w-60"
                    />
                    <Button onClick={() => setDocument(EMPTY_DOCUMENT)}>비우기</Button>
                  </>
                }
              />
            }
          >
            <PolicyEditor value={document} onChange={setDocument} />
          </Container>
        </>
      )}
      {step === 2 && (
        <>
          <Container header={<ContainerHeader title="정책 세부 정보" />}>
            <SpaceBetween size="m">
              <FormField label="정책 이름" constraint="최대 128자. 영문자, 숫자, + = , . @ _ - 사용 가능">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: SiteBucketReadOnly" maxLength={128} />
              </FormField>
              <FormField label="설명" optional>
                <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
              </FormField>
            </SpaceBetween>
          </Container>
          <Container header={<ContainerHeader title="이 정책에 정의된 권한" />}>
            <PolicyDocumentView document={document} />
          </Container>
        </>
      )}
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        {step === 1 ? (
          <>
            <ButtonLink variant="link" href={href("/iam/policies")}>
              취소
            </ButtonLink>
            <Button
              variant="primary"
              onClick={() => {
                setError(check.ok ? null : `[MalformedPolicyDocument] ${check.errors[0]}`);
                if (check.ok) setStep(2);
              }}
            >
              다음
            </Button>
          </>
        ) : (
          <>
            <Button variant="link" onClick={() => setStep(1)}>
              이전
            </Button>
            <Button variant="primary" onClick={create}>
              정책 생성
            </Button>
          </>
        )}
      </FormActions>
    </SpaceBetween>
  );
}

export function PolicyDetailPage({ id }: { id: string }) {
  const project = useProject();
  const run = useRunAction();
  const policy = useIamPolicyList().find((p) => p.id === id);
  const [tab, setTab] = useQueryTab("permissions");
  const [deleting, setDeleting] = useState(false);
  if (!policy) {
    return (
      <Container>
        <EmptyState title="정책을 찾을 수 없습니다" action={<ButtonLink href={href("/iam/policies")}>정책 목록</ButtonLink>} />
      </Container>
    );
  }
  const a = policyAttachments(project, policy.id);
  const attached = a.users.length + a.groups.length + a.roles.length;
  return (
    <SpaceBetween>
      <PageHeader
        title={policy.name}
        description={policy.description || undefined}
        actions={
          !policy.managed && (
            <>
              <Button onClick={() => setDeleting(true)}>삭제</Button>
              <ButtonLink variant="primary" href={href(`/iam/policies/${encodeURIComponent(policy.id)}/edit`)}>
                편집
              </ButtonLink>
            </>
          )
        }
      />
      <Container header={<ContainerHeader title="정책 세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "유형", value: <PolicyTypeBadge managed={policy.managed} /> },
            { label: "ARN", value: <CopyText text={policyArn(policy)} /> },
            { label: "연결된 엔터티", value: `${attached}곳` },
            ...(policy.source
              ? [
                  { label: "생성일", value: formatDateTime(policy.source.createdAt) },
                  { label: "마지막 편집", value: formatDateTime(policy.source.updatedAt) },
                ]
              : [{ label: "참고", value: "AWS 관리형 정책은 AWS가 관리하므로 편집할 수 없습니다. (학습용 단순화 버전)" }]),
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="정책 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "permissions",
            label: "권한",
            content: (
              <Container header={<ContainerHeader title="이 정책에 정의된 권한" />}>
                <PolicyDocumentView document={policy.document} />
              </Container>
            ),
          },
          {
            id: "entities",
            label: `연결된 엔터티 (${attached})`,
            content: (
              <Container header={<ContainerHeader title="연결된 엔터티" description="정책을 연결하거나 빼려면 각 사용자·그룹·역할의 권한 탭에서 바꿉니다." />}>
                {attached === 0 ? (
                  <p className="text-[15px] text-aws-text-2">아무 곳에도 연결되지 않았습니다.</p>
                ) : (
                  <ul className="space-y-1">
                    {a.users.map((u) => (
                      <li key={u.id}>
                        사용자{" "}
                        <a className="text-aws-link hover:underline" href={href(`/iam/users/${u.id}`)}>
                          {u.name}
                        </a>
                      </li>
                    ))}
                    {a.groups.map((g) => (
                      <li key={g.id}>
                        그룹{" "}
                        <a className="text-aws-link hover:underline" href={href(`/iam/groups/${g.id}`)}>
                          {g.name}
                        </a>
                      </li>
                    ))}
                    {a.roles.map((r) => (
                      <li key={r.id}>
                        역할{" "}
                        <a className="text-aws-link hover:underline" href={href(`/iam/roles/${r.id}`)}>
                          {r.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Container>
            ),
          },
        ]}
      />
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title={`정책 ${policy.name} 삭제`}
          confirmText={policy.name}
          onConfirm={() => {
            const r = run("DeletePolicy", (p) => deletePolicy(p, policy.id), { success: () => `정책 ${policy.name}을(를) 삭제했습니다.` });
            if (!r.ok) return withHint(r);
            navigate("/iam/policies");
            return null;
          }}
        >
          <p>삭제한 정책은 되돌릴 수 없습니다(실행 취소 제외).</p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

export function EditPolicyPage({ id }: { id: string }) {
  const run = useRunAction();
  const policy = useProject().services.iam.policies.find((p) => p.id === id);
  const [document, setDocument] = useState(policy?.document ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!policy) {
    return (
      <Container>
        <EmptyState title="편집할 수 있는 정책이 아닙니다" description="AWS 관리형 정책은 편집할 수 없습니다." action={<ButtonLink href={href("/iam/policies")}>정책 목록</ButtonLink>} />
      </Container>
    );
  }
  return (
    <SpaceBetween>
      <PageHeader title={`정책 편집: ${policy.name}`} info={<InfoLink topic="iam-policy" />} description="변경 내용은 이 정책이 연결된 모든 사용자·그룹·역할에 바로 적용됩니다." />
      <Container header={<ContainerHeader title="정책 편집기 (JSON)" />}>
        <PolicyEditor value={document} onChange={setDocument} />
      </Container>
      <ExpandableSection variant="container" header="시각적 편집기로 문장 추가">
        <StatementBuilder document={document} onChange={setDocument} />
      </ExpandableSection>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href(`/iam/policies/${encodeURIComponent(policy.id)}`)}>
          취소
        </ButtonLink>
        <Button
          variant="primary"
          onClick={() => {
            const r = run("CreatePolicyVersion", (p) => updatePolicyDocument(p, policy.id, document), { success: () => `정책 ${policy.name}을(를) 저장했습니다.` });
            if (r.ok) navigate(`/iam/policies/${encodeURIComponent(policy.id)}`);
            else setError(withHint(r));
          }}
        >
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
