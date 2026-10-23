"use client";

/** 읽기 전용 라우팅·규칙 표 */
import type { NaclRule, SgRule } from "@/lib/engine/resource-models";
import type { EffectiveRoute, Topology } from "@/lib/engine/topology-engine";
import { ResourceLink } from "../ui/links";
import { StatusIndicator } from "../ui/status";
import { portRangeLabel, protocolLabel, ruleTypeOf, SgPeer } from "./rule-editors";

const th = "border-b border-aws-border px-3 py-2 text-left font-bold whitespace-nowrap text-aws-text-2";
const td = "border-b border-aws-divider px-3 py-2 align-middle";

export function RoutesTable({ topo, routes }: { topo: Topology; routes: EffectiveRoute[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="경로">
        <thead>
          <tr>
            <th className={th}>대상 (Destination)</th>
            <th className={th}>대상 (Target)</th>
            <th className={th}>상태</th>
            <th className={th}>전파됨</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => {
            const target = r.targetId ? topo.get(r.targetId) : null;
            const rtId = r.connectionId ? topo.connections.find((c) => c.id === r.connectionId)?.sourceResourceId : undefined;
            const blackhole =
              r.targetKind === "internet-gateway"
                ? !topo.igwAttachedTo(r.targetId, rtId ? topo.vpcOf(rtId) : null)
                : r.targetKind === "nat-gateway"
                  ? !target || (target.type === "nat-gateway" && target.config.state === "failed")
                  : false;
            return (
              <tr key={r.key}>
                <td className={`${td} font-mono text-[13px]`}>{r.destinationCidr}</td>
                <td className={td}>{r.targetKind === "local" ? "local" : target ? <ResourceLink id={target.id} /> : <span className="text-aws-error">{r.targetId} (삭제됨)</span>}</td>
                <td className={td}>{blackhole ? <StatusIndicator type="error">Blackhole</StatusIndicator> : <StatusIndicator type="success">Active</StatusIndicator>}</td>
                <td className={td}>아니요</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function NaclRulesTable({ title, rules, direction }: { title?: string; rules: NaclRule[]; direction: "inbound" | "outbound" }) {
  const sorted = [...rules].sort((a, b) => a.ruleNumber - b.ruleNumber);
  return (
    <div className="space-y-2">
      {title && <h3 className="text-sm font-bold">{title}</h3>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" aria-label={title ?? (direction === "inbound" ? "인바운드 규칙" : "아웃바운드 규칙")}>
          <thead>
            <tr>
              <th className={th}>규칙 번호</th>
              <th className={th}>유형</th>
              <th className={th}>프로토콜</th>
              <th className={th}>포트 범위</th>
              <th className={th}>{direction === "inbound" ? "소스" : "대상"}</th>
              <th className={th}>허용/거부</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td className={td}>{r.ruleNumber}</td>
                <td className={td}>{ruleTypeOf(r).label}</td>
                <td className={td}>{protocolLabel(r.protocol)}</td>
                <td className={td}>{portRangeLabel(r)}</td>
                <td className={`${td} font-mono text-[13px]`}>{r.cidr}</td>
                <td className={td}>{r.action === "allow" ? <StatusIndicator type="success">Allow</StatusIndicator> : <StatusIndicator type="error">Deny</StatusIndicator>}</td>
              </tr>
            ))}
            <tr className="text-aws-text-2">
              <td className={td}>*</td>
              <td className={td}>모든 트래픽</td>
              <td className={td}>전체</td>
              <td className={td}>전체</td>
              <td className={`${td} font-mono text-[13px]`}>0.0.0.0/0</td>
              <td className={td}>
                <StatusIndicator type="error">Deny</StatusIndicator>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SgRulesTable({ rules, direction, topo }: { rules: SgRule[]; direction: "inbound" | "outbound"; topo: Topology }) {
  if (!rules.length) {
    return (
      <p className="rounded-lg border border-dashed border-aws-border px-4 py-5 text-center text-sm text-aws-text-2">
        {direction === "inbound" ? "인바운드 규칙 없음 — 들어오는 트래픽이 모두 거부됩니다." : "아웃바운드 규칙 없음 — 나가는 연결이 모두 거부됩니다."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label={direction === "inbound" ? "인바운드 규칙" : "아웃바운드 규칙"}>
        <thead>
          <tr>
            <th className={th}>보안 그룹 규칙 ID</th>
            <th className={th}>유형</th>
            <th className={th}>프로토콜</th>
            <th className={th}>포트 범위</th>
            <th className={th}>{direction === "inbound" ? "소스" : "대상"}</th>
            <th className={th}>설명</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-mono text-[13px] text-aws-text-2`}>{r.id}</td>
              <td className={td}>{ruleTypeOf(r).label}</td>
              <td className={td}>{protocolLabel(r.protocol)}</td>
              <td className={td}>{portRangeLabel(r)}</td>
              <td className={td}>
                <SgPeer rule={r} topo={topo} />
              </td>
              <td className={`${td} text-aws-text-2`}>{r.description || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
