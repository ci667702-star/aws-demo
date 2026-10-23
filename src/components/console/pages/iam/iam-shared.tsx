"use client";

import { useMemo, useState } from "react";
import { allPolicies, checkPolicyDocument, type PolicyKind } from "@/lib/engine/iam-engine";
import { useProject } from "../../console-context";
import { href } from "../../router";
import { Checkbox, SearchInput } from "../../ui/form";
import { EmptyState } from "../../ui/layout";
import { Badge } from "../../ui/status";

export function useIamPolicyList() {
  const project = useProject();
  return useMemo(() => allPolicies(project), [project]);
}

export function PolicyName({ id }: { id: string }) {
  const policies = useIamPolicyList();
  const p = policies.find((x) => x.id === id);
  if (!p) return <span className="text-aws-text-2">{id} (삭제됨)</span>;
  return (
    <a href={href(`/iam/policies/${encodeURIComponent(p.id)}`)} className="text-aws-link hover:underline">
      {p.name}
    </a>
  );
}

export function PolicyTypeBadge({ managed }: { managed: boolean }) {
  return managed ? <Badge color="orange">AWS 관리형</Badge> : <Badge color="blue">고객 관리형</Badge>;
}

/** 연결할 정책 고르기 (검색 + 체크박스) */
export function PolicyPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const policies = useIamPolicyList();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q ? policies.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : policies;
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <div className="space-y-3">
      <SearchInput value={filter} onChange={setFilter} placeholder="정책 이름이나 설명으로 검색" className="max-w-md" />
      <div className="max-h-80 overflow-y-auto rounded-xl border border-aws-border">
        {shown.length === 0 ? (
          <EmptyState title="일치하는 정책이 없습니다" />
        ) : (
          <ul className="divide-y divide-aws-divider">
            {shown.map((p) => (
              <li key={p.id} className="px-4 py-2.5 hover:bg-aws-surface-2">
                <Checkbox checked={selected.includes(p.id)} onChange={(v) => toggle(p.id, v)} description={p.description || undefined}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{p.name}</span>
                    <PolicyTypeBadge managed={p.managed} />
                  </span>
                </Checkbox>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-sm text-aws-text-2">
        선택한 정책 {selected.length}개 · AWS 관리형 정책은 학습용으로 단순화한 버전입니다. 직접 만들려면{" "}
        <a className="text-aws-link hover:underline" href={href("/iam/policies/create")}>
          정책 생성
        </a>
        을 쓰세요.
      </p>
    </div>
  );
}

/** 정책 문서를 표(효과·작업·리소스)와 JSON으로 보여 준다 */
export function PolicyDocumentView({ document, kind = "identity" }: { document: string; kind?: PolicyKind }) {
  const check = checkPolicyDocument(document, kind);
  return (
    <div className="space-y-4">
      {check.statements.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[15px]" aria-label="정책 요약">
            <thead>
              <tr className="border-b border-aws-border text-left text-sm text-aws-text-2">
                <th className="px-3 py-2 font-bold">효과</th>
                {kind !== "identity" && <th className="px-3 py-2 font-bold">주체</th>}
                <th className="px-3 py-2 font-bold">작업</th>
                {kind !== "trust" && <th className="px-3 py-2 font-bold">리소스</th>}
              </tr>
            </thead>
            <tbody>
              {check.statements.map((s, i) => (
                <tr key={i} className="border-b border-aws-divider align-top">
                  <td className="px-3 py-2">{s.effect === "Allow" ? <Badge color="green">허용</Badge> : <Badge color="red">거부</Badge>}</td>
                  {kind !== "identity" && (
                    <td className="px-3 py-2 font-mono text-[13px] break-all">{s.principal?.any ? "* (모든 사람)" : [...(s.principal?.aws ?? []), ...(s.principal?.service ?? [])].join(", ")}</td>
                  )}
                  <td className="px-3 py-2 font-mono text-[13px] break-all">{s.actions.join(", ")}</td>
                  {kind !== "trust" && <td className="px-3 py-2 font-mono text-[13px] break-all">{s.resources.join(", ")}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <pre className="max-h-96 overflow-auto rounded-xl border border-aws-border bg-aws-surface-2 p-4 font-mono text-[13px] leading-relaxed text-aws-text">{document}</pre>
    </div>
  );
}

/** 정책 JSON 편집기 + 실시간 검사 결과 */
export function PolicyEditor({ value, onChange, kind = "identity" }: { value: string; onChange: (v: string) => void; kind?: PolicyKind }) {
  const check = checkPolicyDocument(value, kind);
  return (
    <div className="space-y-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label="정책 JSON"
        className="h-80 w-full rounded-xl border border-aws-border-strong bg-aws-surface p-4 font-mono text-[13px] leading-relaxed text-aws-text focus:border-aws-focus focus:outline-2 focus:outline-aws-focus"
      />
      <div className="rounded-xl border border-aws-border p-3 text-sm" role="status" aria-live="polite">
        {check.errors.length === 0 ? (
          <p className="font-bold text-aws-success">✓ 정책 문법에 문제가 없습니다{check.warnings.length ? ` (참고 ${check.warnings.length}건)` : ""}.</p>
        ) : (
          <p className="font-bold text-aws-error">오류 {check.errors.length}건</p>
        )}
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {check.errors.map((e, i) => (
            <li key={`e${i}`} className="text-aws-error">
              {e}
            </li>
          ))}
          {check.warnings.map((w, i) => (
            <li key={`w${i}`} className="text-aws-warning">
              {w}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const POLICY_TEMPLATES: { id: string; label: string; document: object }[] = [
  {
    id: "s3-read-bucket",
    label: "특정 버킷 읽기 전용",
    document: {
      Version: "2012-10-17",
      Statement: [
        { Sid: "ListBucket", Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::my-bucket" },
        { Sid: "ReadObjects", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::my-bucket/*" },
      ],
    },
  },
  {
    id: "ec2-describe",
    label: "EC2 조회만 허용",
    document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "ec2:Describe*", Resource: "*" }] },
  },
  {
    id: "deny-delete",
    label: "S3 객체 삭제 금지 (Deny)",
    document: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["s3:DeleteObject", "s3:DeleteBucket"], Resource: "*" }] },
  },
];
