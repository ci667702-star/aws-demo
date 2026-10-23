"use client";

/**
 * 콘솔 페이지 공통 도우미.
 */
import { useCallback, useState } from "react";
import { formatIpv4 } from "@/lib/engine/cidr-utils";
import { RESOURCE_TYPE_INFO, type Resource, type ResourceOfType, type ResourceType } from "@/lib/engine/resource-models";
import type { Topology } from "@/lib/engine/topology-engine";
import { useAnalysis } from "../analysis-context";
import { navigate, RESOURCE_LIST_PATH, useHashLocation } from "../router";
import { ButtonLink } from "../ui/button";
import { Container, EmptyState } from "../ui/layout";
import { StatusIndicator, type StatusType } from "../ui/status";

export function useTopology(): Topology {
  return useAnalysis().topology;
}

/** 해시 쿼리의 ?tab= 값과 연결된 탭 상태 */
export function useQueryTab(defaultTab: string): [string, (tab: string) => void] {
  const { path, query } = useHashLocation();
  const tab = query.get("tab") ?? defaultTab;
  const setTab = useCallback(
    (next: string) => {
      const q: Record<string, string> = {};
      query.forEach((v, k) => (q[k] = v));
      q.tab = next;
      navigate(path, { replace: true, query: q });
    },
    [path, query],
  );
  return [tab, setTab];
}

export function useSelection(): [string[], (ids: string[]) => void] {
  return useState<string[]>([]);
}

export function NameCell({ r }: { r: Pick<Resource, "name"> }) {
  return <span className="break-all">{r.name?.trim() ? r.name : "–"}</span>;
}

/** 존재하지 않는 리소스의 상세 페이지 */
export function ResourceNotFound({ type, id }: { type: ResourceType; id: string }) {
  const info = RESOURCE_TYPE_INFO[type];
  return (
    <Container>
      <EmptyState
        title={`${info.label}을(를) 찾을 수 없습니다`}
        description={`${id}은(는) 존재하지 않거나 삭제되었습니다.`}
        action={<ButtonLink href={`#${RESOURCE_LIST_PATH[type]}`}>{info.label} 목록으로</ButtonLink>}
      />
    </Container>
  );
}

export function useResource<T extends ResourceType>(id: string, type: T): ResourceOfType<T> | undefined {
  return useTopology().getOfType(id, type);
}

// ---------------------------------------------------------------- 상태 표시

const EC2_STATE: Record<string, { type: StatusType; label: string }> = {
  pending: { type: "pending", label: "대기 중 (Pending)" },
  running: { type: "success", label: "실행 중 (Running)" },
  stopped: { type: "stopped", label: "중지됨 (Stopped)" },
  terminated: { type: "stopped", label: "종료됨 (Terminated)" },
};

export function InstanceState({ state }: { state: string }) {
  const s = EC2_STATE[state] ?? { type: "info" as StatusType, label: state };
  return <StatusIndicator type={s.type === "pending" ? "in-progress" : s.type}>{s.label}</StatusIndicator>;
}

export function NatState({ state }: { state: string }) {
  if (state === "available") return <StatusIndicator type="success">Available</StatusIndicator>;
  if (state === "pending") return <StatusIndicator type="in-progress">Pending</StatusIndicator>;
  if (state === "failed") return <StatusIndicator type="error">Failed</StatusIndicator>;
  return <StatusIndicator type="stopped">{state}</StatusIndicator>;
}

export function LbState({ state }: { state: string }) {
  return state === "active" ? <StatusIndicator type="success">Active</StatusIndicator> : <StatusIndicator type="in-progress">Provisioning</StatusIndicator>;
}

export function DbState({ state }: { state: string }) {
  if (state === "available") return <StatusIndicator type="success">사용 가능</StatusIndicator>;
  if (state === "creating") return <StatusIndicator type="in-progress">생성 중</StatusIndicator>;
  if (state === "stopped") return <StatusIndicator type="stopped">중지됨</StatusIndicator>;
  return <StatusIndicator type="info">{state}</StatusIndicator>;
}

export function ipText(ip: number | null | undefined): string {
  return ip === null || ip === undefined ? "–" : formatIpv4(ip);
}

/** 서브넷 종류(라우팅으로 판정) */
export function SubnetKindLabel({ topo, subnetId }: { topo: Topology; subnetId: string }) {
  const cls = topo.classifySubnet(subnetId);
  const map = {
    public: { type: "success" as const, label: "퍼블릭 (IGW 경로)" },
    "private-nat": { type: "info" as const, label: "프라이빗 (NAT 경로)" },
    "private-isolated": { type: "stopped" as const, label: "프라이빗 (외부 경로 없음)" },
    unattached: { type: "warning" as const, label: "VPC 없음" },
  }[cls.kind];
  return (
    <span title={cls.reason}>
      <StatusIndicator type={map.type}>{map.label}</StatusIndicator>
    </span>
  );
}

export function routeTargetText(topo: Topology, targetId: string | null): string {
  if (!targetId) return "local";
  return targetId;
}

/** 리소스 이름(없으면 ID)으로 정렬할 때 쓰는 값 */
export const sortName = (r: Resource) => (r.name?.trim() ? r.name : `~${r.id}`);
