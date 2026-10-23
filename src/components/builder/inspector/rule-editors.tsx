"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { parseCidr } from "@/lib/engine/cidr-utils";
import { createId } from "@/lib/engine/ids";
import type { Listener, NaclRule, RuleProtocol, SgRule } from "@/lib/engine/resource-models";
import { NativeSelect, type SelectOption } from "./fields";

const PROTOCOL_OPTIONS: SelectOption[] = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "icmp", label: "ICMP" },
  { value: "all", label: "모든 트래픽" },
];

export function parsePortRange(text: string): { ok: true; from: number; to: number } | { ok: false; error: string } {
  const t = text.trim();
  const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(t);
  if (!m) return { ok: false, error: '포트는 "80" 또는 "1024-65535" 형식이어야 합니다.' };
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from > 65535 || to > 65535) return { ok: false, error: "포트는 0~65535 범위여야 합니다." };
  if (from > to) return { ok: false, error: "시작 포트가 끝 포트보다 클 수 없습니다." };
  return { ok: true, from, to };
}

export function validateCidrInput(text: string): string | null {
  const r = parseCidr(text);
  return r.ok ? null : r.error;
}

/** 포커스를 잃거나 Enter를 누를 때 검증 후 확정하는 작은 인라인 입력 */
function InlineInput({
  value,
  validate,
  onCommit,
  ariaLabel,
  className,
  disabled,
  placeholder,
}: {
  value: string;
  validate: (v: string) => string | null;
  onCommit: (v: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (value !== prev) {
    setPrev(value);
    if (!focused) {
      setDraft(value);
      setError(null);
    }
  }
  const commit = () => {
    if (draft === value) return setError(null);
    const problem = validate(draft);
    if (problem) return setError(problem);
    setError(null);
    onCommit(draft);
  };
  return (
    <div className={cn("min-w-0", className)}>
      <Input
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        title={error ?? undefined}
        className="h-7 px-2 font-mono text-xs"
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(value);
            setError(null);
          }
        }}
      />
      {error && (
        <p role="alert" className="mt-0.5 text-[11px] leading-tight text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function portsText(rule: { protocol: RuleProtocol; fromPort: number; toPort: number }) {
  if (rule.protocol === "all" || rule.protocol === "icmp") return "";
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort}-${rule.toPort}`;
}

function withProtocol<T extends { protocol: RuleProtocol; fromPort: number; toPort: number }>(rule: T, protocol: RuleProtocol): T {
  if (protocol === "all" || protocol === "icmp") return { ...rule, protocol, fromPort: 0, toPort: 65535 };
  if (rule.protocol === "all" || rule.protocol === "icmp") return { ...rule, protocol, fromPort: 80, toPort: 80 };
  return { ...rule, protocol };
}

// ---------------------------------------------------------------- Security Group

export interface SgPreset {
  label: string;
  rule: () => SgRule;
}

export function SgRulesEditor({
  title,
  direction,
  rules,
  onChange,
  securityGroups,
  presets,
}: {
  title: string;
  direction: "inbound" | "outbound";
  rules: SgRule[];
  onChange: (rules: SgRule[]) => void;
  securityGroups: { id: string; name: string; sameVpc: boolean }[];
  presets: SgPreset[];
}) {
  const peerWord = direction === "inbound" ? "출발지" : "대상";
  const update = (id: string, patch: (r: SgRule) => SgRule) => onChange(rules.map((r) => (r.id === id ? patch(r) : r)));
  const sgOptions: SelectOption[] = securityGroups.map((g) => ({
    value: g.id,
    label: `${g.name}${g.sameVpc ? "" : " (다른 VPC)"}`,
  }));
  return (
    <div className="space-y-2" data-testid={`sg-rules-${direction}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {title} ({rules.length})
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" aria-label={`${title} 규칙 추가`}>
              <Plus /> 규칙 추가
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>자주 쓰는 규칙</DropdownMenuLabel>
            {presets.map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => onChange([...rules, p.rule()])}>
                {p.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                onChange([
                  ...rules,
                  { id: createId("sgr"), protocol: "tcp", fromPort: 80, toPort: 80, peer: { kind: "cidr", cidr: "0.0.0.0/0" }, description: "" },
                ])
              }
            >
              빈 TCP 규칙
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {rules.length === 0 && (
        <p className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">
          규칙이 없습니다. {direction === "inbound" ? "모든 인바운드 연결이 거부됩니다." : "이 그룹을 가진 리소스는 연결을 시작할 수 없습니다."}
        </p>
      )}
      {rules.map((rule, i) => (
        <div key={rule.id} className="space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="sg-rule">
          <div className="flex items-start gap-1.5">
            <NativeSelect
              value={rule.protocol}
              options={PROTOCOL_OPTIONS}
              onChange={(v) => update(rule.id, (r) => withProtocol(r, v as RuleProtocol))}
              className="w-28 shrink-0"
              ariaLabel={`규칙 ${i + 1} 프로토콜`}
            />
            <InlineInput
              className="flex-1"
              value={portsText(rule)}
              disabled={rule.protocol === "all" || rule.protocol === "icmp"}
              placeholder={rule.protocol === "all" || rule.protocol === "icmp" ? "전체" : "80"}
              ariaLabel={`규칙 ${i + 1} 포트 범위`}
              validate={(v) => {
                const r = parsePortRange(v);
                return r.ok ? null : r.error;
              }}
              onCommit={(v) => {
                const r = parsePortRange(v);
                if (r.ok) update(rule.id, (x) => ({ ...x, fromPort: r.from, toPort: r.to }));
              }}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`규칙 ${i + 1} 삭제`}
              onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="flex items-start gap-1.5">
            <NativeSelect
              value={rule.peer.kind}
              options={[
                { value: "cidr", label: `${peerWord}: CIDR` },
                { value: "security-group", label: `${peerWord}: 보안 그룹`, disabled: securityGroups.length === 0 },
              ]}
              onChange={(v) =>
                update(rule.id, (r) => ({
                  ...r,
                  peer:
                    v === "cidr"
                      ? { kind: "cidr", cidr: "0.0.0.0/0" }
                      : { kind: "security-group", securityGroupId: securityGroups[0]?.id ?? "" },
                }))
              }
              className="w-28 shrink-0"
              ariaLabel={`규칙 ${i + 1} ${peerWord} 유형`}
            />
            {rule.peer.kind === "cidr" ? (
              <InlineInput
                className="flex-1"
                value={rule.peer.cidr}
                ariaLabel={`규칙 ${i + 1} ${peerWord} CIDR`}
                validate={validateCidrInput}
                onCommit={(v) => update(rule.id, (r) => ({ ...r, peer: { kind: "cidr", cidr: v.trim() } }))}
              />
            ) : (
              <NativeSelect
                className="flex-1"
                value={rule.peer.securityGroupId}
                options={sgOptions}
                onChange={(v) => update(rule.id, (r) => ({ ...r, peer: { kind: "security-group", securityGroupId: v } }))}
                ariaLabel={`규칙 ${i + 1} ${peerWord} 보안 그룹`}
              />
            )}
          </div>
          <InlineInput
            value={rule.description}
            placeholder="설명 (선택)"
            ariaLabel={`규칙 ${i + 1} 설명`}
            validate={(v) => (v.length > 255 ? "설명은 255자 이하여야 합니다." : null)}
            onCommit={(v) => update(rule.id, (r) => ({ ...r, description: v }))}
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Network ACL

export function NaclRulesEditor({
  title,
  direction,
  rules,
  onChange,
  vpcCidr,
}: {
  title: string;
  direction: "inbound" | "outbound";
  rules: NaclRule[];
  onChange: (rules: NaclRule[]) => void;
  vpcCidr: string | null;
}) {
  const sorted = [...rules].sort((a, b) => a.ruleNumber - b.ruleNumber);
  const nextNumber = () => {
    const max = rules.reduce((m, r) => Math.max(m, r.ruleNumber), 0);
    return Math.min(32766, Math.ceil((max + 1) / 10) * 10 || 100);
  };
  const add = (rule: Omit<NaclRule, "id" | "ruleNumber">) =>
    onChange([...rules, { ...rule, id: createId("aclr"), ruleNumber: rules.length ? nextNumber() : 100 }]);
  const update = (id: string, patch: (r: NaclRule) => NaclRule) => onChange(rules.map((r) => (r.id === id ? patch(r) : r)));
  return (
    <div className="space-y-2" data-testid={`nacl-rules-${direction}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {title} ({rules.length})
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" aria-label={`${title} 규칙 추가`}>
              <Plus /> 규칙 추가
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>자주 쓰는 규칙</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => add({ protocol: "all", fromPort: 0, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" })}>
              모든 트래픽 허용 (기본 NACL과 동일)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ protocol: "tcp", fromPort: 1024, toPort: 65535, cidr: "0.0.0.0/0", action: "allow" })}>
              응답용 임시 포트 TCP 1024-65535 허용
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", action: "allow" })}>
              HTTP 80 허용 (0.0.0.0/0)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add({ protocol: "tcp", fromPort: 443, toPort: 443, cidr: "0.0.0.0/0", action: "allow" })}>
              HTTPS 443 허용 (0.0.0.0/0)
            </DropdownMenuItem>
            {vpcCidr && (
              <DropdownMenuItem onSelect={() => add({ protocol: "all", fromPort: 0, toPort: 65535, cidr: vpcCidr, action: "allow" })}>
                VPC 내부({vpcCidr}) 모든 트래픽 허용
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => add({ protocol: "tcp", fromPort: 22, toPort: 22, cidr: "0.0.0.0/0", action: "deny" })}>
              SSH 22 거부 (0.0.0.0/0)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {sorted.map((rule) => (
        <div key={rule.id} className="space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="nacl-rule">
          <div className="flex items-start gap-1.5">
            <InlineInput
              className="w-20 shrink-0"
              value={String(rule.ruleNumber)}
              ariaLabel={`규칙 #${rule.ruleNumber} 번호`}
              validate={(v) => {
                if (!/^\d+$/.test(v.trim())) return "규칙 번호는 정수입니다.";
                const n = Number(v);
                if (n < 1 || n > 32766) return "1~32766 사이여야 합니다.";
                if (rules.some((r) => r.id !== rule.id && r.ruleNumber === n)) return `규칙 번호 ${n}은(는) 이미 사용 중입니다.`;
                return null;
              }}
              onCommit={(v) => update(rule.id, (r) => ({ ...r, ruleNumber: Number(v) }))}
            />
            <NativeSelect
              value={rule.action}
              options={[
                { value: "allow", label: "ALLOW" },
                { value: "deny", label: "DENY" },
              ]}
              onChange={(v) => update(rule.id, (r) => ({ ...r, action: v as NaclRule["action"] }))}
              className="flex-1"
              ariaLabel={`규칙 #${rule.ruleNumber} 동작`}
            />
            <Button variant="ghost" size="icon-xs" aria-label={`규칙 #${rule.ruleNumber} 삭제`} onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}>
              <Trash2 />
            </Button>
          </div>
          <div className="flex items-start gap-1.5">
            <NativeSelect
              value={rule.protocol}
              options={PROTOCOL_OPTIONS}
              onChange={(v) => update(rule.id, (r) => withProtocol(r, v as RuleProtocol))}
              className="w-28 shrink-0"
              ariaLabel={`규칙 #${rule.ruleNumber} 프로토콜`}
            />
            <InlineInput
              className="flex-1"
              value={portsText(rule)}
              disabled={rule.protocol === "all" || rule.protocol === "icmp"}
              placeholder={rule.protocol === "all" || rule.protocol === "icmp" ? "전체" : "80"}
              ariaLabel={`규칙 #${rule.ruleNumber} 포트 범위`}
              validate={(v) => {
                const r = parsePortRange(v);
                return r.ok ? null : r.error;
              }}
              onCommit={(v) => {
                const r = parsePortRange(v);
                if (r.ok) update(rule.id, (x) => ({ ...x, fromPort: r.from, toPort: r.to }));
              }}
            />
          </div>
          <InlineInput
            value={rule.cidr}
            ariaLabel={`규칙 #${rule.ruleNumber} CIDR`}
            validate={validateCidrInput}
            onCommit={(v) => update(rule.id, (r) => ({ ...r, cidr: v.trim() }))}
          />
        </div>
      ))}
      <p className="rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">* DENY 모든 트래픽 0.0.0.0/0 (기본, 삭제 불가)</p>
    </div>
  );
}

// ---------------------------------------------------------------- Routes

export interface RouteRow {
  connectionId: string;
  destination: string;
  targetId: string;
}

export function RoutesEditor({
  localCidr,
  routes,
  targets,
  onAdd,
  onDestinationChange,
  onTargetChange,
  onRemove,
}: {
  localCidr: string | null;
  routes: RouteRow[];
  targets: SelectOption[];
  onAdd: (destination: string, targetId: string) => string | null;
  onDestinationChange: (connectionId: string, destination: string) => string | null;
  onTargetChange: (connectionId: string, targetId: string) => void;
  onRemove: (connectionId: string) => void;
}) {
  const [newDest, setNewDest] = useState("0.0.0.0/0");
  const [newTarget, setNewTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const target = newTarget || targets.find((t) => !t.disabled)?.value || "";
  return (
    <div className="space-y-2" data-testid="routes-editor">
      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground">
          <span>Destination</span>
          <span>Target</span>
          <span className="w-6" />
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5 border-t px-2 py-1.5 text-xs">
          <span className="font-mono">{localCidr ?? "(VPC 없음)"}</span>
          <span className="text-muted-foreground">local</span>
          <span className="w-6" />
        </div>
        {routes.map((r) => (
          <div key={r.connectionId} className="grid grid-cols-[1fr_1fr_auto] items-start gap-1.5 border-t px-2 py-1.5" data-testid="route-row">
            <InlineInput
              value={r.destination}
              ariaLabel={`경로 ${r.destination} Destination`}
              validate={validateCidrInput}
              onCommit={(v) => {
                onDestinationChange(r.connectionId, v.trim());
              }}
            />
            <NativeSelect
              value={r.targetId}
              options={targets.some((t) => t.value === r.targetId) ? targets : [...targets, { value: r.targetId, label: "(삭제된 대상)" }]}
              onChange={(v) => onTargetChange(r.connectionId, v)}
              ariaLabel={`경로 ${r.destination} Target`}
            />
            <Button variant="ghost" size="icon-xs" aria-label={`경로 ${r.destination} 삭제`} onClick={() => onRemove(r.connectionId)}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="space-y-1 rounded-md border border-dashed p-2">
        <p className="text-[11px] font-medium text-muted-foreground">경로 추가</p>
        <div className="flex items-start gap-1.5">
          <Input
            value={newDest}
            onChange={(e) => {
              setNewDest(e.target.value);
              setError(null);
            }}
            aria-label="새 경로 Destination"
            className="h-7 flex-1 px-2 font-mono text-xs"
          />
          <NativeSelect
            value={target}
            options={targets.length ? targets : [{ value: "", label: "대상(IGW/NAT) 없음", disabled: true }]}
            onChange={setNewTarget}
            className="flex-1"
            ariaLabel="새 경로 Target"
          />
          <Button
            size="xs"
            disabled={!target}
            onClick={() => {
              const problem = validateCidrInput(newDest);
              if (problem) return setError(problem);
              const result = onAdd(newDest.trim(), target);
              if (result) setError(result);
              else setError(null);
            }}
          >
            추가
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Listeners

export function ListenersEditor({
  listeners,
  bindings,
  targetGroups,
  onListenersChange,
  onTargetGroupChange,
}: {
  listeners: Listener[];
  bindings: Record<string, string | null>;
  targetGroups: SelectOption[];
  onListenersChange: (listeners: Listener[]) => void;
  onTargetGroupChange: (listenerId: string, targetGroupId: string | null) => void;
}) {
  const nextPort = [80, 443, 8080, 8443].find((p) => !listeners.some((l) => l.port === p)) ?? 8000 + listeners.length;
  return (
    <div className="space-y-2" data-testid="listeners-editor">
      {listeners.length === 0 && (
        <p className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">리스너가 없습니다. ALB가 어떤 연결도 받지 않습니다.</p>
      )}
      {listeners.map((l) => (
        <div key={l.id} className="space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="listener-row">
          <div className="flex items-start gap-1.5">
            <NativeSelect
              value={l.protocol}
              options={[
                { value: "HTTP", label: "HTTP" },
                { value: "HTTPS", label: "HTTPS" },
              ]}
              onChange={(v) => onListenersChange(listeners.map((x) => (x.id === l.id ? { ...x, protocol: v as Listener["protocol"] } : x)))}
              className="w-24 shrink-0"
              ariaLabel={`리스너 ${l.port} 프로토콜`}
            />
            <InlineInput
              className="flex-1"
              value={String(l.port)}
              ariaLabel={`리스너 ${l.protocol} 포트`}
              validate={(v) => {
                if (!/^\d+$/.test(v.trim())) return "포트는 정수입니다.";
                const n = Number(v);
                if (n < 1 || n > 65535) return "1~65535 사이여야 합니다.";
                if (listeners.some((x) => x.id !== l.id && x.port === n)) return `포트 ${n} 리스너가 이미 있습니다.`;
                return null;
              }}
              onCommit={(v) => onListenersChange(listeners.map((x) => (x.id === l.id ? { ...x, port: Number(v) } : x)))}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`리스너 ${l.protocol}:${l.port} 삭제`}
              onClick={() => onListenersChange(listeners.filter((x) => x.id !== l.id))}
            >
              <Trash2 />
            </Button>
          </div>
          <NativeSelect
            value={bindings[l.id] ?? ""}
            options={[{ value: "", label: "기본 작업: 대상 그룹 없음" }, ...targetGroups.map((t) => ({ ...t, label: `전달 → ${t.label}` }))]}
            onChange={(v) => onTargetGroupChange(l.id, v || null)}
            ariaLabel={`리스너 ${l.protocol}:${l.port} 대상 그룹`}
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        onClick={() => onListenersChange([...listeners, { id: createId("lsn"), protocol: nextPort === 443 || nextPort === 8443 ? "HTTPS" : "HTTP", port: nextPort, rules: [] }])}
      >
        <Plus /> 리스너 추가
      </Button>
    </div>
  );
}
