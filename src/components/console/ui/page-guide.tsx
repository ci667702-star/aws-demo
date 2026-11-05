"use client";

import { BookOpen, ChevronDown, ChevronRight, Lightbulb } from "lucide-react";
import { useState } from "react";
import { HELP_TOPICS } from "../help-topics";
import { InfoLink } from "./links";

const STORAGE_PREFIX = "aws-playground:guide-open:";

function readOpen(topic: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + topic) === "1";
  } catch {
    return false;
  }
}

function writeOpen(topic: string, open: boolean) {
  try {
    if (open) window.localStorage.setItem(STORAGE_PREFIX + topic, "1");
    else window.localStorage.removeItem(STORAGE_PREFIX + topic);
  } catch {
    // 저장소를 쓸 수 없으면 이번 화면에서만 펼친다
  }
}

/**
 * 화면 위쪽의 "쉽게 이해하기" 안내.
 * 양식을 가리지 않도록 기본은 한 줄 요약만 보이고, 누르면 비유와 해 볼 순서가 펼쳐진다 (펼친 상태는 이 브라우저에 기억).
 */
export function PageGuide({ topic }: { topic: string }) {
  const t = HELP_TOPICS[topic];
  const [open, setOpen] = useState(() => (typeof window === "undefined" ? false : readOpen(topic)));
  if (!t) return null;
  const toggle = () => {
    writeOpen(topic, !open);
    setOpen(!open);
  };
  return (
    <section className="rounded-2xl border border-aws-info/30 bg-aws-info-bg" aria-label={`${t.title} 안내`} data-testid="page-guide">
      <button type="button" onClick={toggle} aria-expanded={open} className={`flex w-full items-center gap-2.5 px-5 text-left ${open ? "py-3.5" : "py-2.5"}`}>
        <BookOpen className="size-5 shrink-0 text-aws-info" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[15px] text-aws-text">
          <span className="font-bold">쉽게 이해하기: {t.title}</span>
          {!open && <span className="text-aws-text-2"> — {t.summary}</span>}
        </span>
        {open ? <ChevronDown className="size-4 text-aws-text-2" aria-hidden /> : <ChevronRight className="size-4 text-aws-text-2" aria-hidden />}
      </button>
      {open && (
        <div className="space-y-3 px-5 pb-5 text-[15px] leading-relaxed text-aws-text">
          <p className="font-bold">{t.summary}</p>
          {t.analogy && (
            <p className="flex gap-2 rounded-xl bg-aws-surface px-4 py-3">
              <Lightbulb className="mt-1 size-4 shrink-0 text-aws-warning" aria-hidden />
              <span>
                <span className="font-bold">비유로 보면 </span>
                {t.analogy}
              </span>
            </p>
          )}
          {t.steps && (
            <div>
              <p className="mb-1 text-sm font-bold text-aws-text-2">이렇게 해 보세요</p>
              <ol className="list-decimal space-y-0.5 pl-6">
                {t.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          <InfoLink topic={topic} label="자세한 설명 보기" />
        </div>
      )}
    </section>
  );
}
