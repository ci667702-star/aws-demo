"use client";

/**
 * 콘솔 내부 화면 이동에 쓰는 해시 라우터.
 * 예: /console/proj-1#/vpc/subnets/subnet-0001?tab=routes
 * 해시를 쓰므로 서버 요청 없이 이동하며 브라우저 뒤로/앞으로 가기가 동작한다.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { ResourceType } from "@/lib/engine/resource-models";

export interface HashLocation {
  /** 정규화된 경로 (예: "/vpc/subnets") */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

const getSnapshot = () => window.location.hash;
const getServerSnapshot = () => "";

export function parseHash(hash: string): HashLocation {
  const raw = hash.replace(/^#/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const segments = pathPart
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path: `/${segments.join("/")}`, segments, query: new URLSearchParams(queryPart) };
}

export function useHashLocation(): HashLocation {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => parseHash(hash), [hash]);
}

/** 콘솔 경로를 href로 바꾼다. */
export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const clean = `/${path.replace(/^[#/]+/, "")}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) params.set(k, v);
  const qs = params.toString();
  return `#${clean}${qs ? `?${qs}` : ""}`;
}

export function navigate(path: string, options: { replace?: boolean; query?: Record<string, string | null | undefined> } = {}) {
  const target = href(path, options.query);
  if (options.replace) {
    window.history.replaceState(window.history.state, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

/** 패턴("/vpc/subnets/:id")과 경로를 비교해 매개변수를 돌려준다. */
export function matchPath(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = segments[i];
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

/** 리소스 유형별 목록 경로 */
export const RESOURCE_LIST_PATH: Record<ResourceType, string> = {
  vpc: "/vpc/vpcs",
  subnet: "/vpc/subnets",
  "internet-gateway": "/vpc/igws",
  "elastic-ip": "/vpc/eips",
  "route-table": "/vpc/route-tables",
  "nat-gateway": "/vpc/nat-gateways",
  "security-group": "/vpc/security-groups",
  "network-acl": "/vpc/network-acls",
  ec2: "/ec2/instances",
  alb: "/ec2/load-balancers",
  "target-group": "/ec2/target-groups",
  "db-subnet-group": "/rds/subnet-groups",
  rds: "/rds/databases",
};

export function resourcePath(type: ResourceType, id: string): string {
  return `${RESOURCE_LIST_PATH[type]}/${encodeURIComponent(id)}`;
}

export function resourceHref(type: ResourceType, id: string, query?: Record<string, string | null | undefined>): string {
  return href(resourcePath(type, id), query);
}
