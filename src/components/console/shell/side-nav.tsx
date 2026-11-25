"use client";

import { ChevronDown, ChevronRight, Home, Minus, Plus, Shapes, X } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { useState } from "react";
import { glossaryMeaning } from "@/lib/docs/glossary";
import { useGuidePrefs } from "@/lib/store/guide-prefs";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId } from "../console-context";
import { href } from "../router";
import { useActiveTutorial } from "../tutorial/use-tutorial";
import { activeNavItem, NAV_GROUPS, type NavGroup } from "./navigation";

/** "서버리스 (Lambda)" → "Lambda" */
const serviceName = (g: NavGroup) => /\(([^)]+)\)/.exec(g.label)?.[1] ?? g.label;

/**
 * 서비스 사이드바. 처음에는 기본 서비스(네트워크·서버·스토리지·권한·분석 도구)만 보이고 나머지는 '서비스 더 보기'로 연다.
 * 지금 보고 있는 화면의 서비스와 따라하기 중에는 모든 서비스가 보인다 (안내가 가리키는 메뉴가 숨지 않게). 현재 위치의 그룹은 자동으로 펼친다.
 */
export function SideNav({ path, onNavigate, onClose }: { path: string; onNavigate?: () => void; onClose: () => void }) {
  const { topology, project } = useAnalysis();
  const projectId = useConsoleProjectId();
  const active = activeNavItem(path);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => open[id] ?? id === active?.group.id;
  const showAll = useGuidePrefs((s) => s.navShowAll);
  const tutorialActive = !!useActiveTutorial();
  const groups = NAV_GROUPS.filter((g) => g.core || showAll || tutorialActive || g.id === active?.group.id);
  const more = NAV_GROUPS.filter((g) => !groups.includes(g));

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
        {groups.map((group) => {
          const expanded = isOpen(group.id);
          const Icon = group.icon;
          const groupActive = active?.group.id === group.id;
          return (
            <section key={group.id}>
              <button
                type="button"
                aria-expanded={expanded}
                data-nav-group={group.id}
                title={group.description}
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
                          title={glossaryMeaning(item.label) ?? undefined}
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
        {more.length > 0 ? (
          <button
            type="button"
            onClick={() => useGuidePrefs.getState().setNavShowAll(true)}
            className="mt-2 flex w-full items-start gap-2.5 rounded-lg border border-dashed border-aws-border px-3 py-2 text-left hover:border-aws-link hover:bg-aws-surface-2"
            data-testid="nav-show-more"
          >
            <Plus className="mt-0.5 size-[18px] shrink-0 text-aws-link" aria-hidden />
            <span className="min-w-0">
              <span className="block text-[15px] font-bold text-aws-link">서비스 더 보기 ({more.length})</span>
              <span className="block text-[13px] leading-snug text-aws-text-2">{more.map(serviceName).join(" · ")}</span>
            </span>
          </button>
        ) : (
          showAll &&
          !tutorialActive && (
            <button
              type="button"
              onClick={() => useGuidePrefs.getState().setNavShowAll(false)}
              className="mt-2 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-bold text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-link"
              data-testid="nav-show-less"
            >
              <Minus className="size-4 shrink-0" aria-hidden />
              기본 서비스만 보기
            </button>
          )
        )}
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
