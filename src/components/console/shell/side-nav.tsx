"use client";

import { ChevronDown, ChevronRight, Home, Shapes, X } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { useState } from "react";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId } from "../console-context";
import { href } from "../router";
import { activeNavItem, NAV_GROUPS } from "./navigation";

/** 모든 서비스를 한 번에 보여 주는 사이드바 (현재 위치의 그룹은 자동으로 펼친다) */
export function SideNav({ path, onNavigate, onClose }: { path: string; onNavigate?: () => void; onClose: () => void }) {
  const { topology, project } = useAnalysis();
  const projectId = useConsoleProjectId();
  const active = activeNavItem(path);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => open[id] ?? id === active?.group.id;

  return (
    <nav aria-label="서비스 탐색" className="flex h-full flex-col overflow-y-auto" data-tour="side-nav">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <a
          href={href("/")}
          onClick={onNavigate}
          className={cn(
            "flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] font-bold",
            path === "/" ? "bg-aws-selected text-aws-link" : "text-aws-text hover:bg-aws-surface-2",
          )}
          aria-current={path === "/" ? "page" : undefined}
        >
          <Home className="size-[18px]" aria-hidden />
          콘솔 홈
        </a>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text" aria-label="탐색 창 닫기">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex-1 space-y-1 px-4 pb-4">
        {NAV_GROUPS.map((group) => {
          const expanded = isOpen(group.id);
          const Icon = group.icon;
          const groupActive = active?.group.id === group.id;
          return (
            <section key={group.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen({ ...open, [group.id]: !expanded })}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[15px] font-bold hover:bg-aws-surface-2",
                  groupActive ? "text-aws-text" : "text-aws-text-2",
                )}
              >
                <Icon className={cn("size-[18px] shrink-0", groupActive && "text-aws-link")} aria-hidden />
                <span className="flex-1">{group.label}</span>
                {expanded ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
              </button>
              {expanded && (
                <ul className="mt-0.5 mb-2 space-y-0.5 border-l border-aws-divider pl-3 ml-[21px]">
                  {group.items.map((item) => {
                    const current = active?.item.path === item.path;
                    const count = item.count?.(topology, project) ?? 0;
                    return (
                      <li key={item.path}>
                        <a
                          href={href(item.path)}
                          onClick={onNavigate}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-[15px]",
                            current ? "bg-aws-selected font-bold text-aws-link" : "text-aws-text hover:bg-aws-surface-2 hover:text-aws-link",
                          )}
                        >
                          <span>{item.label}</span>
                          {count > 0 && (
                            <span className="min-w-6 rounded-full bg-aws-surface-2 px-2 py-px text-center text-xs font-bold text-aws-text-2 tabular-nums" aria-label={`${count}개`}>
                              {count}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <div className="border-t border-aws-divider p-4">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-start gap-3 rounded-xl border border-aws-border p-3 hover:border-aws-link hover:bg-aws-surface-2"
          data-tour="easy-mode-link"
        >
          <Shapes className="mt-0.5 size-5 shrink-0 text-aws-link" aria-hidden />
          <span>
            <span className="block text-sm font-bold text-aws-text">쉬운 모드로 보기</span>
            <span className="block text-[13px] leading-snug text-aws-text-2">같은 샌드박스를 그림(캔버스)으로 끌어다 놓으며 설계합니다.</span>
          </span>
        </Link>
      </div>
    </nav>
  );
}
