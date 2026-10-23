"use client";

import { cn } from "cn";
import { useId, useRef } from "react";

export interface TabItem {
  id: string;
  label: React.ReactNode;
  content: React.ReactNode;
}

/** 제어형 탭 (선택한 탭은 상위에서 관리 — 보통 해시의 ?tab= 값) */
export function Tabs({ tabs, activeId, onChange, ariaLabel }: { tabs: TabItem[]; activeId: string; onChange: (id: string) => void; ariaLabel: string }) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={ariaLabel} className="flex overflow-x-auto border-b border-aws-border">
        {tabs.map((t, i) => {
          const selected = t.id === active?.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`${base}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(e) => onKeyDown(e, i)}
              onClick={() => onChange(t.id)}
              className={cn(
                "relative shrink-0 px-4 py-2 text-sm font-bold whitespace-nowrap transition-colors",
                selected ? "text-aws-link after:absolute after:inset-x-2 after:bottom-0 after:h-1 after:rounded-t after:bg-aws-link" : "text-aws-text-2 hover:text-aws-link",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {active && (
        <div role="tabpanel" id={`${base}-panel-${active.id}`} aria-labelledby={`${base}-tab-${active.id}`}>
          {active.content}
        </div>
      )}
    </div>
  );
}
