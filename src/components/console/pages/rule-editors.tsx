"use client";

/**
 * 보안 그룹 / 네트워크 ACL 규칙 편집기 (AWS 콘솔의 "유형" 목록 방식).
 * 편집 중에는 문자열 초안을 유지하고, 저장할 때 검증해 규칙으로 바꾼다.
 */
import { parseCidr } from "@/lib/engine/cidr-utils";
import { createId } from "@/lib/engine/ids";
import type { NaclRule, RuleProtocol, SgRule } from "@/lib/engine/resource-models";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import { Button } from "../ui/button";
import { SelectInput, TextInput } from "../ui/form";

export interface RuleType {
  id: string;
  label: string;
  protocol: RuleProtocol;
  /** null이면 포트를 직접 입력 */
  ports: [number, number] | null;
}

export const RULE_TYPES: RuleType[] = [
  { id: "custom-tcp", label: "사용자 지정 TCP", protocol: "tcp", ports: null },
  { id: "custom-udp", label: "사용자 지정 UDP", protocol: "udp", ports: null },
  { id: "all-tcp", label: "모든 TCP", protocol: "tcp", ports: [0, 65535] },
  { id: "all-udp", label: "모든 UDP", protocol: "udp", ports: [0, 65535] },
  { id: "all-icmp", label: "모든 ICMP - IPv4", protocol: "icmp", ports: [0, 65535] },
  { id: "all-traffic", label: "모든 트래픽", protocol: "all", ports: [0, 65535] },
  { id: "ssh", label: "SSH", protocol: "tcp", ports: [22, 22] },
  { id: "smtp", label: "SMTP", protocol: "tcp", ports: [25, 25] },
  { id: "dns-udp", label: "DNS (UDP)", protocol: "udp", ports: [53, 53] },
  { id: "dns-tcp", label: "DNS (TCP)", protocol: "tcp", ports: [53, 53] },
  { id: "http", label: "HTTP", protocol: "tcp", ports: [80, 80] },
  { id: "https", label: "HTTPS", protocol: "tcp", ports: [443, 443] },
  { id: "mysql", label: "MYSQL/Aurora", protocol: "tcp", ports: [3306, 3306] },
  { id: "rdp", label: "RDP", protocol: "tcp", ports: [3389, 3389] },
  { id: "postgresql", label: "PostgreSQL", protocol: "tcp", ports: [5432, 5432] },
];

const TYPE_OPTIONS = RULE_TYPES.map((t) => ({ value: t.id, label: t.label }));
const typeById = (id: string) => RULE_TYPES.find((t) => t.id === id) ?? RULE_TYPES[0];

export function ruleTypeOf(rule: { protocol: RuleProtocol; fromPort: number; toPort: number }): RuleType {
  if (rule.protocol === "all") return typeById("all-traffic");
  if (rule.protocol === "icmp") return typeById("all-icmp");
  const fixed = RULE_TYPES.find((t) => t.protocol === rule.protocol && t.ports && t.ports[0] === rule.fromPort && t.ports[1] === rule.toPort && !t.id.startsWith("all-"));
  if (fixed) return fixed;
  if (rule.fromPort === 0 && rule.toPort === 65535) return typeById(rule.protocol === "tcp" ? "all-tcp" : "all-udp");
  return typeById(rule.protocol === "tcp" ? "custom-tcp" : "custom-udp");
}

export function protocolLabel(protocol: RuleProtocol): string {
  return { tcp: "TCP", udp: "UDP", icmp: "ICMP", all: "전체" }[protocol];
}

export function portRangeLabel(rule: { protocol: RuleProtocol; fromPort: number; toPort: number }): string {
  if (rule.protocol === "all" || rule.protocol === "icmp") return "전체";
  if (rule.fromPort === 0 && rule.toPort === 65535) return "0 - 65535";
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort} - ${rule.toPort}`;
}

function parsePorts(text: string): { ok: true; from: number; to: number } | { ok: false; error: string } {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(text);
  if (!m) return { ok: false, error: '포트 범위는 "80" 또는 "1024-65535" 형식이어야 합니다.' };
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from > 65535 || to > 65535) return { ok: false, error: "포트는 0~65535 범위여야 합니다." };
  if (from > to) return { ok: false, error: "시작 포트가 끝 포트보다 클 수 없습니다." };
  return { ok: true, from, to };
}

function portsDraft(rule: { protocol: RuleProtocol; fromPort: number; toPort: number }) {
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort}-${rule.toPort}`;
}

// ---------------------------------------------------------------- 보안 그룹

export interface SgRuleDraft {
  key: string;
  id?: string;
  typeId: string;
  ports: string;
  peerMode: "custom" | "anywhere" | "sg";
  cidr: string;
  sgId: string;
  description: string;
}

export function sgDraftsFromRules(rules: SgRule[]): SgRuleDraft[] {
  return rules.map((r) => ({
    key: r.id,
    id: r.id,
    typeId: ruleTypeOf(r).id,
    ports: portsDraft(r),
    peerMode: r.peer.kind === "security-group" ? "sg" : r.peer.cidr === "0.0.0.0/0" ? "anywhere" : "custom",
    cidr: r.peer.kind === "cidr" ? r.peer.cidr : "",
    sgId: r.peer.kind === "security-group" ? r.peer.securityGroupId : "",
    description: r.description,
  }));
}

export function newSgDraft(partial: Partial<SgRuleDraft> = {}): SgRuleDraft {
  return { key: createId("draft"), typeId: "custom-tcp", ports: "", peerMode: "custom", cidr: "", sgId: "", description: "", ...partial };
}

/** 초안을 규칙으로 변환. 문제가 있는 행은 errors[key]에 메시지를 담는다. */
export function sgRulesFromDrafts(drafts: SgRuleDraft[]): { rules: SgRule[]; errors: Record<string, string> } {
  const rules: SgRule[] = [];
  const errors: Record<string, string> = {};
  for (const d of drafts) {
    const type = typeById(d.typeId);
    let from = type.ports?.[0] ?? 0;
    let to = type.ports?.[1] ?? 0;
    if (!type.ports) {
      const p = parsePorts(d.ports);
      if (!p.ok) {
        errors[d.key] = p.error;
        continue;
      }
      from = p.from;
      to = p.to;
    }
    let peer: SgRule["peer"];
    if (d.peerMode === "sg") {
      if (!d.sgId) {
        errors[d.key] = "소스/대상 보안 그룹을 선택하세요.";
        continue;
      }
      peer = { kind: "security-group", securityGroupId: d.sgId };
    } else {
      const text = d.peerMode === "anywhere" ? "0.0.0.0/0" : d.cidr.trim();
      const c = parseCidr(text);
      if (!c.ok) {
        errors[d.key] = text ? `CIDR 블록이 올바르지 않습니다: ${c.error}` : "CIDR 블록을 입력하세요 (예: 203.0.113.0/24).";
        continue;
      }
      peer = { kind: "cidr", cidr: c.value.text };
    }
    rules.push({ id: d.id ?? createId("sgr"), protocol: type.protocol, fromPort: from, toPort: to, peer, description: d.description.trim() });
  }
  return { rules, errors };
}

export function SgRuleEditor({
  direction,
  drafts,
  onChange,
  errors,
  topo,
  vpcId,
  selfId,
}: {
  direction: "inbound" | "outbound";
  drafts: SgRuleDraft[];
  onChange: (drafts: SgRuleDraft[]) => void;
  errors: Record<string, string>;
  topo: Topology;
  vpcId: string | null;
  selfId?: string;
}) {
  const peerLabel = direction === "inbound" ? "소스" : "대상";
  const groups = topo.ofType("security-group").filter((g) => !vpcId || topo.vpcOf(g.id) === vpcId);
  const groupOptions = [
    ...(selfId && !groups.some((g) => g.id === selfId) ? [{ value: selfId, label: `${selfId} (이 보안 그룹)` }] : []),
    ...groups.map((g) => ({ value: g.id, label: `${g.id} (${displayName(g)})` })),
  ];
  const update = (key: string, patch: Partial<SgRuleDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-3">
      {drafts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-aws-border px-4 py-5 text-center text-sm text-aws-text-2">
          {direction === "inbound" ? "인바운드 규칙이 없습니다. 이 보안 그룹은 들어오는 트래픽을 모두 거부합니다." : "아웃바운드 규칙이 없습니다. 이 보안 그룹에서 시작하는 연결이 모두 거부됩니다."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm" aria-label={`${direction === "inbound" ? "인바운드" : "아웃바운드"} 규칙 편집`}>
            <thead>
              <tr className="text-left text-aws-text-2">
                <th className="w-44 px-1 pb-1 font-bold">유형</th>
                <th className="w-20 px-1 pb-1 font-bold">프로토콜</th>
                <th className="w-32 px-1 pb-1 font-bold">포트 범위</th>
                <th className="w-36 px-1 pb-1 font-bold">{peerLabel} 유형</th>
                <th className="px-1 pb-1 font-bold">{peerLabel}</th>
                <th className="w-44 px-1 pb-1 font-bold">설명 - 선택 사항</th>
                <th className="w-20 px-1 pb-1" />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => {
                const type = typeById(d.typeId);
                const n = i + 1;
                return (
                  <tr key={d.key} className="align-top" data-testid="sg-rule-row">
                    <td className="px-1 py-1">
                      <SelectInput aria-label={`규칙 ${n} 유형`} value={d.typeId} options={TYPE_OPTIONS} onChange={(v) => update(d.key, { typeId: v, ports: typeById(v).ports ? "" : d.ports })} />
                    </td>
                    <td className="px-1 py-1">
                      <TextInput aria-label={`규칙 ${n} 프로토콜`} value={protocolLabel(type.protocol)} disabled readOnly />
                    </td>
                    <td className="px-1 py-1">
                      <TextInput
                        aria-label={`규칙 ${n} 포트 범위`}
                        value={type.ports ? portRangeLabel({ protocol: type.protocol, fromPort: type.ports[0], toPort: type.ports[1] }) : d.ports}
                        disabled={!!type.ports}
                        placeholder="예: 8080"
                        onChange={(e) => update(d.key, { ports: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <SelectInput
                        aria-label={`규칙 ${n} ${peerLabel} 유형`}
                        value={d.peerMode}
                        options={[
                          { value: "custom", label: "사용자 지정 (CIDR)" },
                          { value: "anywhere", label: "Anywhere-IPv4" },
                          { value: "sg", label: "보안 그룹" },
                        ]}
                        onChange={(v) => update(d.key, { peerMode: v as SgRuleDraft["peerMode"] })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      {d.peerMode === "sg" ? (
                        <SelectInput aria-label={`규칙 ${n} ${peerLabel} 보안 그룹`} value={d.sgId} placeholder="보안 그룹 선택" options={groupOptions} onChange={(v) => update(d.key, { sgId: v })} />
                      ) : (
                        <TextInput
                          aria-label={`규칙 ${n} ${peerLabel} CIDR`}
                          value={d.peerMode === "anywhere" ? "0.0.0.0/0" : d.cidr}
                          disabled={d.peerMode === "anywhere"}
                          placeholder="CIDR 블록 (예: 203.0.113.0/24)"
                          onChange={(e) => update(d.key, { cidr: e.target.value })}
                        />
                      )}
                      {errors[d.key] && (
                        <p className="mt-1 text-xs font-bold text-aws-error" role="alert">
                          {errors[d.key]}
                        </p>
                      )}
                    </td>
                    <td className="px-1 py-1">
                      <TextInput aria-label={`규칙 ${n} 설명`} value={d.description} maxLength={255} onChange={(e) => update(d.key, { description: e.target.value })} />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <Button variant="normal" onClick={() => onChange(drafts.filter((x) => x.key !== d.key))} aria-label={`규칙 ${n} 삭제`}>
                        삭제
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Button onClick={() => onChange([...drafts, newSgDraft()])}>규칙 추가</Button>
    </div>
  );
}

// ---------------------------------------------------------------- 네트워크 ACL

export interface NaclRuleDraft {
  key: string;
  id?: string;
  ruleNumber: string;
  typeId: string;
  ports: string;
  cidr: string;
  action: "allow" | "deny";
}

export function naclDraftsFromRules(rules: NaclRule[]): NaclRuleDraft[] {
  return [...rules]
    .sort((a, b) => a.ruleNumber - b.ruleNumber)
    .map((r) => ({ key: r.id, id: r.id, ruleNumber: String(r.ruleNumber), typeId: ruleTypeOf(r).id, ports: portsDraft(r), cidr: r.cidr, action: r.action }));
}

export function naclRulesFromDrafts(drafts: NaclRuleDraft[]): { rules: NaclRule[]; errors: Record<string, string> } {
  const rules: NaclRule[] = [];
  const errors: Record<string, string> = {};
  for (const d of drafts) {
    const num = Number(d.ruleNumber);
    if (!/^\d+$/.test(d.ruleNumber.trim()) || num < 1 || num > 32766) {
      errors[d.key] = "규칙 번호는 1~32766 사이의 정수여야 합니다.";
      continue;
    }
    const type = typeById(d.typeId);
    let from = type.ports?.[0] ?? 0;
    let to = type.ports?.[1] ?? 65535;
    if (!type.ports) {
      const p = parsePorts(d.ports);
      if (!p.ok) {
        errors[d.key] = p.error;
        continue;
      }
      from = p.from;
      to = p.to;
    }
    const c = parseCidr(d.cidr.trim());
    if (!c.ok) {
      errors[d.key] = d.cidr.trim() ? `CIDR 블록이 올바르지 않습니다: ${c.error}` : "CIDR 블록을 입력하세요.";
      continue;
    }
    rules.push({ id: d.id ?? createId("aclr"), ruleNumber: num, protocol: type.protocol, fromPort: from, toPort: to, cidr: c.value.text, action: d.action });
  }
  return { rules, errors };
}

export function NaclRuleEditor({
  direction,
  drafts,
  onChange,
  errors,
}: {
  direction: "inbound" | "outbound";
  drafts: NaclRuleDraft[];
  onChange: (drafts: NaclRuleDraft[]) => void;
  errors: Record<string, string>;
}) {
  const peerLabel = direction === "inbound" ? "소스" : "대상";
  const update = (key: string, patch: Partial<NaclRuleDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const nextNumber = () => {
    const max = drafts.reduce((m, d) => Math.max(m, Number(d.ruleNumber) || 0), 0);
    return String(Math.min(32766, Math.floor(max / 100) * 100 + 100));
  };
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] border-collapse text-sm" aria-label={`${direction === "inbound" ? "인바운드" : "아웃바운드"} 규칙 편집`}>
          <thead>
            <tr className="text-left text-aws-text-2">
              <th className="w-28 px-1 pb-1 font-bold">규칙 번호</th>
              <th className="w-44 px-1 pb-1 font-bold">유형</th>
              <th className="w-20 px-1 pb-1 font-bold">프로토콜</th>
              <th className="w-32 px-1 pb-1 font-bold">포트 범위</th>
              <th className="px-1 pb-1 font-bold">{peerLabel}</th>
              <th className="w-28 px-1 pb-1 font-bold">허용/거부</th>
              <th className="w-20 px-1 pb-1" />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => {
              const type = typeById(d.typeId);
              const n = i + 1;
              return (
                <tr key={d.key} className="align-top" data-testid="nacl-rule-row">
                  <td className="px-1 py-1">
                    <TextInput aria-label={`규칙 ${n} 번호`} value={d.ruleNumber} inputMode="numeric" onChange={(e) => update(d.key, { ruleNumber: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <SelectInput aria-label={`규칙 ${n} 유형`} value={d.typeId} options={TYPE_OPTIONS} onChange={(v) => update(d.key, { typeId: v })} />
                  </td>
                  <td className="px-1 py-1">
                    <TextInput aria-label={`규칙 ${n} 프로토콜`} value={protocolLabel(type.protocol)} disabled readOnly />
                  </td>
                  <td className="px-1 py-1">
                    <TextInput
                      aria-label={`규칙 ${n} 포트 범위`}
                      value={type.ports ? portRangeLabel({ protocol: type.protocol, fromPort: type.ports[0], toPort: type.ports[1] }) : d.ports}
                      disabled={!!type.ports}
                      placeholder="예: 1024-65535"
                      onChange={(e) => update(d.key, { ports: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <TextInput aria-label={`규칙 ${n} ${peerLabel}`} value={d.cidr} placeholder="0.0.0.0/0" onChange={(e) => update(d.key, { cidr: e.target.value })} />
                    {errors[d.key] && (
                      <p className="mt-1 text-xs font-bold text-aws-error" role="alert">
                        {errors[d.key]}
                      </p>
                    )}
                  </td>
                  <td className="px-1 py-1">
                    <SelectInput
                      aria-label={`규칙 ${n} 허용/거부`}
                      value={d.action}
                      options={[
                        { value: "allow", label: "허용" },
                        { value: "deny", label: "거부" },
                      ]}
                      onChange={(v) => update(d.key, { action: v as "allow" | "deny" })}
                    />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <Button onClick={() => onChange(drafts.filter((x) => x.key !== d.key))} aria-label={`규칙 ${n} 제거`}>
                      제거
                    </Button>
                  </td>
                </tr>
              );
            })}
            <tr className="text-aws-text-2">
              <td className="px-2 py-2">*</td>
              <td className="px-2 py-2">모든 트래픽</td>
              <td className="px-2 py-2">전체</td>
              <td className="px-2 py-2">전체</td>
              <td className="px-2 py-2">0.0.0.0/0</td>
              <td className="px-2 py-2">거부</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <Button onClick={() => onChange([...drafts, { key: createId("draft"), ruleNumber: nextNumber(), typeId: "custom-tcp", ports: "", cidr: "", action: "allow" }])}>새 규칙 추가</Button>
    </div>
  );
}

/** 읽기 전용 규칙 표에서 쓰는 피어 표시 */
export function SgPeer({ rule, topo }: { rule: SgRule; topo: Topology }) {
  if (rule.peer.kind === "cidr") return <span className="font-mono text-[13px]">{rule.peer.cidr}</span>;
  const g = topo.getOfType(rule.peer.securityGroupId, "security-group");
  return (
    <a href={`#/vpc/security-groups/${rule.peer.securityGroupId}`} className="font-mono text-[13px] text-aws-link hover:underline">
      {rule.peer.securityGroupId}
      {g ? ` / ${displayName(g)}` : " (삭제됨)"}
    </a>
  );
}
