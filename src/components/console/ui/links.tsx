"use client";

import { cn } from "cn";
import type { ResourceType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { useAnalysis } from "@/components/console/analysis-context";
import { useConsoleUi } from "../console-store";
import { href, resourceHref } from "../router";

/** 콘솔 내부 링크 (해시 경로) */
export function ConsoleLink({
  to,
  query,
  className,
  children,
  ...props
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string; query?: Record<string, string | null | undefined> }) {
  return (
    <a href={href(to, query)} className={cn("text-aws-link hover:text-aws-link-hover hover:underline", className)} {...props}>
      {children}
    </a>
  );
}

/** 필드 옆 "정보" 링크 — 오른쪽 도움말 패널을 연다 */
export function InfoLink({ topic, label = "정보" }: { topic: string; label?: string }) {
  const openHelp = useConsoleUi((s) => s.openHelp);
  return (
    <button
      type="button"
      onClick={() => openHelp(topic)}
      className="text-xs font-bold text-aws-link hover:text-aws-link-hover hover:underline"
      aria-label={`${label}: 도움말 열기`}
    >
      {label}
    </button>
  );
}

/** 리소스 ID 링크 (상세 페이지로 이동). 이름이 있으면 함께 표시할 수 있다. */
export function ResourceLink({ id, showName = false, fallback }: { id: string | null | undefined; showName?: boolean; fallback?: string }) {
  const { topology } = useAnalysis();
  if (!id) return <span className="text-aws-text-2">{fallback ?? "-"}</span>;
  const r = topology.get(id);
  if (!r) return <span className="text-aws-text-2">{id} (삭제됨)</span>;
  const name = r.name?.trim();
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      <a href={resourceHref(r.type, r.id)} className="font-mono text-[13px] text-aws-link hover:text-aws-link-hover hover:underline">
        {r.id}
      </a>
      {showName && name && <span className="text-aws-text-2">/ {displayName(r)}</span>}
    </span>
  );
}

export function TypedResourceLink({ type, id, children }: { type: ResourceType; id: string; children?: React.ReactNode }) {
  return (
    <a href={resourceHref(type, id)} className="font-mono text-[13px] text-aws-link hover:text-aws-link-hover hover:underline">
      {children ?? id}
    </a>
  );
}
