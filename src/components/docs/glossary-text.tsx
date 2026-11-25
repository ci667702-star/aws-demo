"use client";

/**
 * 안내 글 속 AWS 용어에 점선 밑줄을 긋고, 마우스를 올리거나(데스크톱) 누르면(터치·키보드) 한 줄 풀이를 보여 준다.
 * 풀이는 lib/docs/glossary.ts의 학습용 데이터다. 버튼 안에 넣으면 안 되므로 링크·버튼 밖의 글에만 쓴다.
 */
import { Popover } from "radix-ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { splitGlossary, type GlossaryEntry } from "@/lib/docs/glossary";

export function Term({ entry, children }: { entry: GlossaryEntry; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const pointer = useRef<string>("");
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(next), ms);
  };
  const onEnter = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") later(true, 200);
  };
  const onLeave = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") later(false, 150);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
          onPointerDown={(e) => {
            pointer.current = e.pointerType;
          }}
          onClick={(e) => {
            // 마우스로 올려서 이미 열렸다면 누를 때 닫지 않는다 (터치·키보드는 누를 때마다 열고 닫는다)
            e.preventDefault();
            clear();
            setOpen((o) => (pointer.current === "mouse" ? true : !o));
            pointer.current = "";
          }}
          className="inline cursor-help appearance-none border-0 bg-transparent p-0 text-left [color:inherit] [font:inherit] underline decoration-current/50 decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-aws-focus"
          data-testid="glossary-term"
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={clear}
          onPointerLeave={onLeave}
          className="z-[80] w-max max-w-[min(88vw,20rem)] rounded-lg border bg-popover px-3 py-2 text-[13px] leading-relaxed text-popover-foreground shadow-lg outline-none"
          data-testid="glossary-popover"
        >
          <p className="font-bold">{entry.term}</p>
          <p>{entry.meaning}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 글 속 용어(처음 나오는 것만, 최대 limit개)에 풀이를 붙인다 */
export function GlossaryText({ text, limit = 3 }: { text: string; limit?: number }) {
  const pieces = useMemo(() => splitGlossary(text, limit), [text, limit]);
  return (
    <>
      {pieces.map((p, i) =>
        typeof p === "string" ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <Term key={i} entry={p.entry}>
            {p.text}
          </Term>
        ),
      )}
    </>
  );
}
