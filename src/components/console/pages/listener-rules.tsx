"use client";

/** ALB 리스너 규칙 (경로 기반 라우팅, 고정 응답) */
import { useState } from "react";
import { normalizeHttpPath, pathPatternMatches } from "@/lib/engine/connectivity-engine";
import type { Listener, ListenerRule, ListenerRuleAction, ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { addListenerRule, deleteListenerRule, MAX_RULES_PER_LISTENER, updateListenerRule } from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { withHint } from "../error-codes";
import { ErrorAlert } from "../ui/alert";
import { Button } from "../ui/button";
import { FormField, SelectInput, TextArea, TextInput, Tiles } from "../ui/form";
import { SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink } from "../ui/links";
import { DeleteModal, Modal } from "../ui/overlay";
import { Badge } from "../ui/status";
import { useTopology } from "./common";

type Alb = ResourceOfType<"alb">;

function ActionText({ action }: { action: ListenerRuleAction }) {
  if (action.type === "fixed-response") {
    return (
      <span>
        고정 응답 <span className="font-bold">{action.statusCode}</span> ({action.contentType})
      </span>
    );
  }
  return (
    <span>
      전달 → <ResourceLink id={action.targetGroupId} showName />
    </span>
  );
}

/** 요청 경로를 넣으면 어떤 규칙이 일치하는지 보여 준다 */
function PathTester({ listener, defaultTgId }: { listener: Listener; defaultTgId: string | null }) {
  const topo = useTopology();
  const [path, setPath] = useState("/api/users");
  const normalized = normalizeHttpPath(path);
  const rules = [...(listener.rules ?? [])].sort((a, b) => a.priority - b.priority);
  const matched = rules.find((r) => r.pathPatterns.some((p) => pathPatternMatches(p, normalized)));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-aws-surface-2 p-2.5 text-sm">
      <label className="font-bold" htmlFor={`tester-${listener.id}`}>
        경로 테스트
      </label>
      <TextInput id={`tester-${listener.id}`} value={path} onChange={(e) => setPath(e.target.value)} className="w-48" />
      <span aria-live="polite">
        →{" "}
        {matched ? (
          <>
            규칙 {matched.priority} 일치 · <ActionText action={matched.action} />
          </>
        ) : (
          <>
            일치하는 규칙 없음 · 기본 작업 {defaultTgId ? <ResourceLink id={defaultTgId} showName /> : "(대상 그룹 없음)"}
            {defaultTgId && !topo.get(defaultTgId) && " (삭제됨)"}
          </>
        )}
      </span>
    </div>
  );
}

export function ListenerRulesSection({ alb, listener, defaultTgId }: { alb: Alb; listener: Listener; defaultTgId: string | null }) {
  const run = useRunAction();
  const [editing, setEditing] = useState<ListenerRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<ListenerRule | null>(null);
  const rules = [...(listener.rules ?? [])].sort((a, b) => a.priority - b.priority);
  return (
    <div className="space-y-2" data-testid="listener-rules">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">
          규칙 ({rules.length}) <InfoLink topic="listener-rules" />
        </p>
        <Button onClick={() => setEditing("new")} disabled={rules.length >= MAX_RULES_PER_LISTENER}>
          규칙 추가
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" aria-label={`리스너 ${listener.protocol}:${listener.port} 규칙`}>
          <thead>
            <tr className="border-b border-aws-border text-left text-aws-text-2">
              <th className="px-2 py-1.5">우선순위</th>
              <th className="px-2 py-1.5">조건 (경로)</th>
              <th className="px-2 py-1.5">작업</th>
              <th className="px-2 py-1.5">
                <span className="sr-only">관리</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-aws-divider align-top">
                <td className="px-2 py-1.5 font-bold">{r.priority}</td>
                <td className="px-2 py-1.5 font-mono text-[13px]">{r.pathPatterns.join(", ")}</td>
                <td className="px-2 py-1.5">
                  <ActionText action={r.action} />
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button type="button" className="text-aws-link hover:underline" onClick={() => setEditing(r)}>
                    편집
                  </button>{" "}
                  ·{" "}
                  <button type="button" className="text-aws-link hover:underline" onClick={() => setDeleting(r)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            <tr className="align-top">
              <td className="px-2 py-1.5">
                <Badge>기본값</Badge>
              </td>
              <td className="px-2 py-1.5 text-aws-text-2">다른 규칙이 적용되지 않을 때</td>
              <td className="px-2 py-1.5">{defaultTgId ? <span>전달 → <ResourceLink id={defaultTgId} showName /></span> : <span className="text-aws-error">대상 그룹 없음</span>}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {rules.length > 0 && <PathTester listener={listener} defaultTgId={defaultTgId} />}
      {editing && <RuleModal alb={alb} listener={listener} rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(null)}
          title={`규칙 ${deleting.priority} 삭제`}
          onConfirm={() => {
            const r = run("DeleteRule", (p) => deleteListenerRule(p, alb.id, listener.id, deleting.id), { success: () => `규칙 ${deleting.priority}을(를) 삭제했습니다.` });
            return r.ok ? null : withHint(r);
          }}
        >
          <p>
            경로 {deleting.pathPatterns.join(", ")}에 대한 요청은 이제 다음 규칙이나 기본 작업으로 처리됩니다.
          </p>
        </DeleteModal>
      )}
    </div>
  );
}

const STATUS_CODES = ["200", "403", "404", "500", "503"];

function RuleModal({ alb, listener, rule, onClose }: { alb: Alb; listener: Listener; rule: ListenerRule | null; onClose: () => void }) {
  const topo = useTopology();
  const run = useRunAction();
  const vpcId = topo.vpcOf(alb.id);
  const tgs = topo.ofType("target-group").filter((tg) => topo.vpcOf(tg.id) === vpcId && topo.targetGroupAlbs(tg.id).every((a) => a.id === alb.id));
  const nextPriority = Math.max(0, ...(listener.rules ?? []).map((r) => r.priority)) + 10;
  const [priority, setPriority] = useState(String(rule?.priority ?? nextPriority));
  const [patterns, setPatterns] = useState((rule?.pathPatterns ?? ["/api/*"]).join("\n"));
  const [type, setType] = useState<ListenerRuleAction["type"]>(rule?.action.type ?? "forward");
  const [tgId, setTgId] = useState(rule?.action.type === "forward" ? rule.action.targetGroupId : (tgs[0]?.id ?? ""));
  const [statusCode, setStatusCode] = useState(rule?.action.type === "fixed-response" ? String(rule.action.statusCode) : "404");
  const [contentType, setContentType] = useState<"text/plain" | "text/html" | "application/json">(rule?.action.type === "fixed-response" ? rule.action.contentType : "text/plain");
  const [body, setBody] = useState(rule?.action.type === "fixed-response" ? rule.action.body : "Not Found");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const action: ListenerRuleAction = type === "forward" ? { type: "forward", targetGroupId: tgId } : { type: "fixed-response", statusCode: Number(statusCode), contentType, body };
    const input = { priority: Number(priority), pathPatterns: patterns.split(/[\n,]/), action };
    const r = rule
      ? run("ModifyRule", (p) => updateListenerRule(p, alb.id, listener.id, rule.id, input), { success: () => `규칙 ${priority}을(를) 저장했습니다.` })
      : run("CreateRule", (p) => addListenerRule(p, alb.id, listener.id, input), { success: () => `규칙 ${priority}을(를) 추가했습니다.` });
    if (r.ok) onClose();
    else setError(withHint(r));
  };
  return (
    <Modal
      open
      size="large"
      onClose={onClose}
      title={rule ? `규칙 편집 (${listener.protocol}:${listener.port})` : `규칙 추가 (${listener.protocol}:${listener.port})`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            {rule ? "변경 사항 저장" : "규칙 추가"}
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        <p className="text-[15px] text-aws-text-2">요청 경로가 조건과 맞으면 기본 작업 대신 이 규칙의 작업을 합니다. 예: /api/* 요청은 API 서버 대상 그룹으로, 나머지는 웹 서버로.</p>
        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <FormField label="우선순위" constraint="1~50000 · 작을수록 먼저">
            <TextInput value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" />
          </FormField>
          <FormField label="조건: 경로 패턴" description="한 줄에 하나씩, 최대 5개. *는 아무 글자(0자 이상), ?는 한 글자" constraint="예: /api/*  ·  /images/*.png  ·  /health">
            <TextArea value={patterns} onChange={(e) => setPatterns(e.target.value)} rows={3} className="font-mono text-[13px]" />
          </FormField>
        </div>
        <FormField label="작업">
          <Tiles
            aria-label="규칙 작업"
            columns={2}
            value={type}
            onChange={(v) => setType(v as ListenerRuleAction["type"])}
            items={[
              { value: "forward", label: "대상 그룹으로 전달", description: "경로에 따라 다른 서버 묶음으로 보냅니다." },
              { value: "fixed-response", label: "고정 응답 반환", description: "서버로 보내지 않고 ALB가 직접 응답합니다 (예: 점검 안내, 404)." },
            ]}
          />
        </FormField>
        {type === "forward" ? (
          <FormField label="대상 그룹" description="로드 밸런서와 같은 VPC에 있고 다른 로드 밸런서가 쓰지 않는 대상 그룹">
            <SelectInput value={tgId} onChange={setTgId} placeholder={tgs.length ? "대상 그룹 선택" : "사용할 수 있는 대상 그룹이 없습니다"} options={tgs.map((t) => ({ value: t.id, label: `${displayName(t)} (${t.config.protocol}:${t.config.port})` }))} />
          </FormField>
        ) : (
          <div className="grid gap-4 md:grid-cols-[160px_220px_1fr]">
            <FormField label="응답 코드">
              <SelectInput value={statusCode} onChange={setStatusCode} options={STATUS_CODES.map((c) => ({ value: c, label: c }))} />
            </FormField>
            <FormField label="콘텐츠 유형">
              <SelectInput
                value={contentType}
                onChange={(v) => setContentType(v as typeof contentType)}
                options={[
                  { value: "text/plain", label: "text/plain" },
                  { value: "text/html", label: "text/html" },
                  { value: "application/json", label: "application/json" },
                ]}
              />
            </FormField>
            <FormField label="응답 본문" optional constraint="최대 1024자">
              <TextInput value={body} onChange={(e) => setBody(e.target.value)} maxLength={1024} />
            </FormField>
          </div>
        )}
        {error && <ErrorAlert message={error} />}
      </SpaceBetween>
    </Modal>
  );
}
