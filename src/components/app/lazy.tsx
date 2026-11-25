"use client";

/**
 * 필요할 때만 불러오는 화면 묶음.
 * - lazyGroup: 모듈 하나를 동적 import로 나누고, 그 안의 컴포넌트를 이름 그대로 쓸 수 있게 감싼다.
 *   처음 그릴 때만 Suspense로 잠깐 기다리고, 한 번 불러온 뒤에는 바로(동기) 그린다.
 * - preloadLazyGroups: 등록된 묶음을 미리 불러온다 (한가할 때 미리 받아 두면 화면 전환이 끊기지 않는다. 테스트에서도 쓴다).
 */
import { Component, createElement, use, type ComponentType, type ReactNode } from "react";

interface Group {
  load: () => Promise<unknown>;
  module: Record<string, unknown> | null;
  promise: Promise<Record<string, unknown>> | null;
}

const groups: Group[] = [];

function ensure(group: Group): Promise<Record<string, unknown>> {
  if (!group.promise) {
    group.promise = group.load().then(
      (m) => {
        group.module = m as Record<string, unknown>;
        return group.module;
      },
      (e) => {
        // 다시 시도할 수 있게 비운다 (네트워크가 잠깐 끊긴 경우)
        group.promise = null;
        throw e;
      },
    );
  }
  return group.promise;
}

export function lazyGroup<M extends object, K extends keyof M & string>(load: () => Promise<M>, names: readonly K[]): { [P in K]: M[P] } {
  const group: Group = { load, module: null, promise: null };
  groups.push(group);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const Lazy = (props: object) => {
      const mod = group.module ?? use(ensure(group));
      return createElement(mod[name] as ComponentType<object>, props);
    };
    Lazy.displayName = `Lazy(${name})`;
    out[name] = Lazy;
  }
  return out as { [P in K]: M[P] };
}

/** 등록된 모든 묶음을 불러온다 (불러오는 중에 새로 등록된 묶음까지). 하나가 실패해도 나머지는 계속 받는다 */
export async function preloadLazyGroups(): Promise<void> {
  for (;;) {
    const pending = groups.filter((g) => !g.module);
    if (!pending.length) return;
    const results = await Promise.allSettled(pending.map(ensure));
    if (results.every((r) => r.status === "rejected")) return;
  }
}

/** 브라우저가 한가할 때 하나씩 미리 불러온다 (첫 화면을 막지 않는다). 정리 함수를 돌려준다 */
export function preloadLazyGroupsWhenIdle(): () => void {
  if (typeof window === "undefined") return () => undefined;
  let cancelled = false;
  // 묶음은 다른 묶음을 불러오는 중에 새로 등록될 수 있으므로 매번 목록을 다시 본다 (실패한 묶음은 이번에는 다시 시도하지 않는다)
  const tried = new Set<Group>();
  const idle: (cb: () => void) => void =
    typeof window.requestIdleCallback === "function" ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 }) : (cb) => window.setTimeout(cb, 300);
  const next = () => {
    if (cancelled) return;
    const group = groups.find((g) => !g.module && !tried.has(g));
    if (!group) return;
    tried.add(group);
    ensure(group).then(
      () => idle(next),
      () => idle(next),
    );
  };
  idle(next);
  return () => {
    cancelled = true;
  };
}

/** 코드 조각(청크)을 받지 못한 오류인지 (오프라인, 배포 직후의 옛 탭, 개발 서버 재시작) */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || /Loading chunk|Failed to load chunk|dynamically imported module|Importing a module script failed/i.test(error.message);
}

interface BoundaryState {
  error: unknown;
  key: string | undefined;
}

/**
 * 화면 묶음을 불러오지 못했을 때 빈 화면 대신 안내를 보여 준다.
 * 코드 조각을 받지 못한 오류만 처리하고, 화면 코드 자체의 오류는 그대로 던진다 (숨기지 않는다).
 */
export class LazyBoundary extends Component<{ children: ReactNode; resetKey?: string; fallback: (retry: () => void) => ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: BoundaryState): Partial<BoundaryState> | null {
    // 다른 화면으로 옮기면 오류 상태를 지운다
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    return this.props.fallback(() => this.setState({ error: null }));
  }
}
