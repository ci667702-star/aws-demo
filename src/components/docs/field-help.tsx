"use client";

/**
 * 설정 항목별 도움말 아이콘.
 * - 마우스를 올리거나 키보드로 초점을 주면: 짧은 툴팁 (설정 이름 + 의미)
 * - 클릭하면: 긴 설명 팝오버 (의미·목적·가능한 값·실제 AWS·시뮬레이터·잘못 설정하면·예시). 모바일에서도 탭으로 연다.
 * 어떤 리소스의 도움말인지는 FieldHelpScope로 감싸서 알려 준다.
 */
import { CircleHelp, X } from "lucide-react";
import { cn } from "cn";
import { Popover } from "radix-ui";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getFieldHelp, type DocKey, type FieldHelp } from "@/lib/docs";

const FieldHelpContext = createContext<DocKey | null>(null);

/** 접힌 섹션을 펼치라는 DOM 이벤트. data-revealable 요소(Section, DocSection)가 듣는다. */
const REVEAL_EVENT = "fieldhelp:reveal";

/** 접고 펼치는 섹션이 쓰는 훅: 반환한 ref를 섹션 요소(data-revealable)에 달면 revealField가 섹션을 펼칠 수 있다. */
export function useRevealable<T extends HTMLElement>(open: boolean, setOpen: (open: boolean) => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onReveal = () => {
      if (!open) flushSync(() => setOpen(true));
    };
    el.addEventListener(REVEAL_EVENT, onReveal);
    return () => el.removeEventListener(REVEAL_EVENT, onReveal);
  }, [open, setOpen]);
  return ref;
}

/**
 * container 안의 설정 항목([data-field])을 보이게 한다: 접힌 섹션을 펼치고, 스크롤하고, 잠깐 강조한다.
 * 항목을 찾지 못하면 false (호출한 쪽이 도움말 카드로 대신 보여 준다). React 렌더링 밖(타이머, 이벤트)에서 호출한다.
 */
export function revealField(container: HTMLElement, field: string): boolean {
  const el = container.querySelector<HTMLElement>(`[data-field="${field}"]`);
  if (!el) return false;
  revealElement(el, container);
  // 키보드·마우스 환경에서는 입력란으로 초점을 옮긴다 (터치 기기에서는 화면 키보드가 뜨지 않게 건너뛴다)
  if (window.matchMedia?.("(hover: hover)")?.matches) {
    el.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), [role=switch]:not(:disabled), [role=checkbox]:not(:disabled)")?.focus({ preventScroll: true });
  }
  return true;
}

/** 요소를 보이게 한다: 접힌 조상 섹션을 펼치고(stopAt 전까지), 화면 안으로 스크롤하고, 잠깐 강조한다. */
export function revealElement(el: HTMLElement, stopAt?: HTMLElement | null, options: { block?: ScrollLogicalPosition; flash?: boolean } = {}) {
  for (let node: HTMLElement | null = el; node && node !== stopAt; node = node.parentElement) {
    if (node.hasAttribute("data-revealable")) node.dispatchEvent(new Event(REVEAL_EVENT));
  }
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  el.scrollIntoView?.({ block: options.block ?? "center", behavior: reduceMotion ? "auto" : "smooth" });
  if (options.flash === false) return;
  el.removeAttribute("data-field-flash");
  void el.offsetWidth; // 같은 항목을 다시 강조해도 애니메이션이 처음부터 재생되게 한다
  el.setAttribute("data-field-flash", "");
  window.setTimeout(() => el.removeAttribute("data-field-flash"), 1800);
}

export function FieldHelpScope({ docKey, children }: { docKey: DocKey; children: React.ReactNode }) {
  return <FieldHelpContext.Provider value={docKey}>{children}</FieldHelpContext.Provider>;
}

export function useFieldHelpDoc(): DocKey | null {
  return useContext(FieldHelpContext);
}

export function FieldHelpBody({ help }: { help: FieldHelp }) {
  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed">
      <p>{help.meaning}</p>
      <dl className="space-y-2">
        <div>
          <dt className="text-[11px] font-semibold text-muted-foreground">설정하는 목적</dt>
          <dd>{help.purpose}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold text-muted-foreground">가능한 값 · 입력 조건</dt>
          <dd>{help.values}</dd>
        </div>
        <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2">
          <dt className="text-[11px] font-semibold text-sky-700 dark:text-sky-300">실제 AWS에서는</dt>
          <dd>{help.realAws}</dd>
        </div>
        <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2">
          <dt className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">이 시뮬레이터에서는</dt>
          <dd>{help.simulator}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold text-muted-foreground">잘못 설정하면</dt>
          <dd>
            <ul className="list-disc space-y-0.5 pl-4">
              {help.mistakes.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold text-muted-foreground">예시</dt>
          <dd className="rounded bg-muted px-2 py-1 font-mono text-[12px] break-all whitespace-pre-wrap">{help.example}</dd>
        </div>
      </dl>
    </div>
  );
}

// 넓은 화면에서는 오른쪽 패널을 가리지 않게 왼쪽(캔버스 쪽)에, 좁은 화면에서는 아이콘 아래에 연다
const WIDE_QUERY = "(min-width: 1024px)";

function subscribeWide(listener: () => void) {
  const mq = window.matchMedia?.(WIDE_QUERY);
  mq?.addEventListener?.("change", listener);
  return () => mq?.removeEventListener?.("change", listener);
}

function useWideScreen(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia?.(WIDE_QUERY)?.matches ?? true, () => true);
}

/** 설정 이름 옆의 도움말 아이콘. docKey를 주지 않으면 FieldHelpScope의 리소스를 쓴다. */
export function FieldHelpButton({
  field,
  docKey,
  className,
  side = "auto",
}: {
  field: string;
  docKey?: DocKey;
  className?: string;
  /** 자세한 설명을 여는 방향. auto: 넓은 화면은 왼쪽, 좁은 화면은 아래 */
  side?: "auto" | "left" | "right" | "bottom";
}) {
  const wide = useWideScreen();
  const scoped = useFieldHelpDoc();
  const key = docKey ?? scoped;
  const help = getFieldHelp(key, field);
  if (!help) return <span hidden data-help-missing={`${key ?? "?"}.${field}`} />;
  return (
    <Popover.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-sky-600 focus-visible:text-sky-600 focus-visible:outline-2 focus-visible:outline-ring",
                className,
              )}
              aria-label={`${help.title} 도움말`}
              data-testid={`field-help-${field}`}
            >
              <CircleHelp className="size-3.5" aria-hidden />
            </button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 flex-col items-start">
          <span className="font-semibold">{help.title}</span>
          <span className="opacity-80">{help.meaning}</span>
          <span className="opacity-60">클릭하면 자세한 설명</span>
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side={side === "auto" ? (wide ? "left" : "bottom") : side}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 max-h-[min(70vh,34rem,var(--radix-popover-content-available-height,100vh))] w-[min(92vw,22rem)] overflow-y-auto rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-xl outline-none"
          data-testid="field-help-popover"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{help.title}</p>
            <Popover.Close className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="도움말 닫기">
              <X className="size-3.5" aria-hidden />
            </Popover.Close>
          </div>
          <FieldHelpBody help={help} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
