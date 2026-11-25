"use client";

/**
 * 튜토리얼 안내 패널.
 * 화면을 덮는 팝업 대신 오른쪽 열(넓은 화면)이나 아래 시트(좁은 화면)에 자리 잡아, 양식과 메뉴를 가리지 않는다.
 * - 지금 단계의 할 일을 순서대로 보여 주고(값은 복사, 이름을 누르면 화면의 그 항목을 찾아 준다)
 * - 실제 설정이 맞으면 '완료'로 바뀐다 (다음 단계로는 사용자가 '다음'을 눌러 넘어간다)
 * - 화면은 자동으로 옮기지 않는다: '이 화면으로 이동'을 누르거나, 밝게 표시된 메뉴를 눌러 직접 찾아간다
 */
import { ArrowRight, Check, ChevronDown, ChevronRight, ChevronUp, Circle, CircleCheck, Copy, GraduationCap, Minimize2, X } from "lucide-react";
import { cn } from "cn";
import { useEffect, useState } from "react";
import { navigate } from "../router";
import { Button } from "../ui/button";
import { useTutorialStore } from "./tutorial-store";
import type { TutorialTodo } from "./tutorials";
import { flashElement, isShown, locateTodo, useTutorialView, type TutorialView } from "./use-tutorial";

const store = () => useTutorialStore.getState();

function goNext(view: TutorialView) {
  if (view.isLast) store().stop();
  else store().next();
}

// ---------------------------------------------------------------- 할 일 목록

const VERB: Record<NonNullable<TutorialTodo["kind"]>, string> = { type: "입력", choose: "선택", check: "체크", click: "누르기" };

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-aws-border bg-aws-surface-2 py-0.5 pr-1.5 pl-2 font-mono text-[13px] text-aws-text hover:border-aws-link hover:bg-aws-info-bg"
      title="눌러서 복사"
      aria-label={`${value} 복사`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      <span className="truncate">{value}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-aws-success" aria-hidden /> : <Copy className="size-3.5 shrink-0 text-aws-text-2" aria-hidden />}
      {copied && <span className="sr-only">복사됨</span>}
    </button>
  );
}

function TodoList({ view }: { view: TutorialView }) {
  const todo = view.step.todo ?? [];
  // 화면에서 찾지 못한 항목 (단계가 바뀌면 지운다)
  const [missing, setMissing] = useState<{ step: string; index: number } | null>(null);
  const stepKey = `${view.tutorial.id}:${view.step.id}`;
  const locate = (t: TutorialTodo, index: number) => {
    const roots = view.onRightPage && view.step.target ? [...document.querySelectorAll(view.step.target)].filter(isShown) : [];
    const el = locateTodo(t, roots) ?? (roots.length ? locateTodo(t, []) : null);
    if (el) {
      setMissing(null);
      flashElement(el);
    } else {
      setMissing({ step: stepKey, index });
    }
  };
  return (
    <ol className="space-y-1.5" data-testid="tutorial-todo">
      {todo.map((t, i) => {
        const kind = t.kind ?? "type";
        return (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-aws-info-bg text-xs font-bold text-aws-info" aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 text-[15px] leading-snug">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {/* 양식의 버튼과 이름이 겹치지 않게 접근성 이름을 따로 둔다 */}
                <button type="button" className="rounded text-left font-bold text-aws-link hover:underline" title="화면에서 이 항목 찾기" aria-label={`화면에서 ${t.label} 찾기`} onClick={() => locate(t, i)}>
                  {t.label}
                </button>
                {t.value && kind === "type" && <CopyChip value={t.value} />}
                {t.value && kind !== "type" && (
                  <span className="rounded-md border border-aws-border bg-aws-surface-2 px-2 py-0.5 text-[13px] font-bold text-aws-text">{t.value}</span>
                )}
                <span className="text-[13px] text-aws-text-2">{VERB[kind]}</span>
              </div>
              {t.note && <p className="text-[13px] text-aws-text-2">{t.note}</p>}
              {missing?.step === stepKey && missing.index === i && (
                <p className="text-[13px] text-aws-warning" role="status">
                  지금 화면에서는 이 항목을 찾지 못했습니다. 앞의 항목을 먼저 하거나 이 단계의 화면인지 확인하세요.
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- 단계 내용

function StepContent({ view }: { view: TutorialView }) {
  const { step } = view;
  const stepKey = `${view.tutorial.id}:${view.step.id}`;
  // 실습 단계의 설명은 접어 두고(할 일이 먼저 보이게), 읽기 단계는 바로 보여 준다
  const [openFor, setOpenFor] = useState<string | null>(null);
  const hasWork = !!(step.todo?.length || step.task);
  const bodyOpen = !hasWork || openFor === stepKey;
  const offPage = !!view.expected && !view.onRightPage && !view.done;
  return (
    <div className="space-y-3" data-step-id={step.id}>
      <h3 className="text-[17px] leading-snug font-bold text-aws-text">{step.title}</h3>

      {hasWork ? (
        <div>
          <button type="button" aria-expanded={bodyOpen} className="flex items-center gap-1 text-[13px] font-bold text-aws-text-2 hover:text-aws-link" onClick={() => setOpenFor(bodyOpen ? null : stepKey)}>
            {bodyOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}왜 하는 건가요?
          </button>
          {bodyOpen && (
            <div className="mt-1.5 space-y-1.5 text-[14px] leading-relaxed text-aws-text">
              {step.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-[15px] leading-relaxed text-aws-text">
          {step.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}

      {offPage && (
        <div className="space-y-2 rounded-xl border border-aws-info/40 bg-aws-info-bg p-3" data-testid="tutorial-where">
          <p className="text-[13px] font-bold text-aws-info">이 단계의 화면</p>
          <p className="text-[15px] font-bold break-words text-aws-text">{view.pageLabel ?? "다른 화면"}</p>
          <Button variant="primary" iconRight={<ArrowRight aria-hidden />} onClick={() => navigate(view.expected!)} data-testid="tutorial-go">
            이 화면으로 이동
          </Button>
          <p className="text-[13px] text-aws-text-2">밝게 표시된 메뉴를 눌러 직접 찾아가도 됩니다.</p>
        </div>
      )}
      {view.needsEarlierStep && (
        <p className="rounded-xl border border-aws-warning/40 bg-aws-warning-bg px-3 py-2 text-[14px] text-aws-text" role="status">
          이 단계의 화면은 앞 단계에서 만든 리소스로 열립니다. 앞 단계를 먼저 마치세요.
        </p>
      )}

      {hasWork && (
        <section className="space-y-2 rounded-xl border border-aws-border p-3">
          <h4 className="text-[13px] font-bold text-aws-info">지금 할 일</h4>
          {step.todo?.length ? <TodoList view={view} /> : <p className="text-[15px] leading-relaxed text-aws-text">{step.task}</p>}
        </section>
      )}

      {step.isDone && (
        <p
          className={cn(
            "rounded-xl px-3 py-2 text-[14px]",
            view.done ? "pg-tour-done border border-aws-success/45 bg-aws-success-bg font-bold text-aws-success" : "border border-dashed border-aws-border bg-aws-surface-2 text-aws-text-2",
          )}
          role="status"
          data-testid="tutorial-status"
          data-done={view.done || undefined}
        >
          {view.done ? "✓ 완료 · 다음을 눌러 계속하세요." : "저장하면 완료 여부를 확인합니다."}
        </p>
      )}
    </div>
  );
}

function StepList({ view }: { view: TutorialView }) {
  return (
    <ol className="space-y-0.5" data-testid="tutorial-steps">
      {view.tutorial.steps.map((s, i) => {
        const state = view.stepStates[i];
        const current = i === view.index;
        return (
          <li key={s.id}>
            <button
              type="button"
              aria-current={current ? "step" : undefined}
              onClick={() => store().goTo(i)}
              className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[14px]", current ? "bg-aws-selected font-bold text-aws-link" : "text-aws-text hover:bg-aws-surface-2")}
            >
              {state === true ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-aws-success" aria-label="완료" />
              ) : state === false ? (
                <Circle className="mt-0.5 size-4 shrink-0 text-aws-text-3" aria-label="아직" />
              ) : (
                <span className="mt-0.5 inline-block size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1">{s.title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function NavButtons({ view, compact }: { view: TutorialView; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {view.index > 0 && !compact && (
        <Button variant="link" onClick={() => store().prev()} data-testid="tutorial-prev">
          이전
        </Button>
      )}
      {view.locked && !view.isLast && (
        <Button variant="link" onClick={() => store().next()} data-testid="tutorial-skip" title="이 단계를 하지 않고 넘어갑니다">
          건너뛰기
        </Button>
      )}
      <Button
        variant="primary"
        disabled={view.locked}
        title={view.locked ? "할 일을 마치면 누를 수 있습니다" : undefined}
        onClick={() => goNext(view)}
        className={cn(view.done && "pg-tour-ready")}
        data-testid="tutorial-next"
      >
        {view.isLast ? "마치기" : "다음"}
      </Button>
    </div>
  );
}

function Progress({ view }: { view: TutorialView }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-aws-divider" role="progressbar" aria-label="튜토리얼 진행" aria-valuemin={1} aria-valuemax={view.total} aria-valuenow={view.index + 1}>
      <div className="h-full rounded-full bg-aws-link transition-all" style={{ width: `${((view.index + 1) / view.total) * 100}%` }} />
    </div>
  );
}

function DimToggle() {
  const dim = useTutorialStore((s) => s.dim);
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-aws-text-2">
      <input type="checkbox" className="size-4 cursor-pointer accent-[var(--aws-link)]" checked={dim} onChange={(e) => store().setDim(e.target.checked)} />
      작업할 곳만 밝게 (주변 어둡게)
    </label>
  );
}

// ---------------------------------------------------------------- 패널

/** 넓은 화면: 오른쪽 열 */
function SidePanel({ view }: { view: TutorialView }) {
  const [listOpen, setListOpen] = useState(false);
  return (
    <aside className="flex h-full flex-col bg-aws-surface" aria-label="튜토리얼 안내" data-testid="tutorial-panel" data-done={view.done || undefined}>
      <header className="space-y-2 border-b border-aws-divider px-5 pt-3 pb-3">
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-aws-text">
            <GraduationCap className="size-[18px] shrink-0 text-aws-link" aria-hidden />
            <span className="truncate">{view.tutorial.title}</span>
          </p>
          <div className="flex shrink-0 items-center">
            <button type="button" className="rounded p-1.5 text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text" aria-label="안내 접기" title="안내 접기 (오른쪽 아래 버튼으로 다시 엽니다)" onClick={() => store().setMinimized(true)}>
              <Minimize2 className="size-4" aria-hidden />
            </button>
            <button type="button" className="rounded p-1.5 text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text" aria-label="튜토리얼 끝내기" title="튜토리얼 끝내기 (상단 '튜토리얼' 메뉴에서 이어서 할 수 있습니다)" onClick={() => store().stop()}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <Progress view={view} />
        <button type="button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)} className="flex w-full items-center justify-between gap-2 text-[13px] font-bold text-aws-text-2 hover:text-aws-link">
          <span data-testid="tutorial-progress">
            {view.index + 1} / {view.total} 단계
          </span>
          <span className="inline-flex items-center gap-1">
            전체 단계 {listOpen ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          </span>
        </button>
        {listOpen && (
          <div className="max-h-56 overflow-y-auto rounded-xl border border-aws-border p-1">
            <StepList view={view} />
          </div>
        )}
      </header>
      {/* 단계가 바뀌면 맨 위부터 보여 준다 */}
      <div key={`${view.tutorial.id}:${view.index}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <StepContent view={view} />
      </div>
      <footer className="space-y-2.5 border-t border-aws-divider px-5 py-3">
        <NavButtons view={view} />
        <DimToggle />
      </footer>
    </aside>
  );
}

/** 좁은 화면: 아래 시트 (기본은 한 줄, 누르면 펼친다) */
function SheetPanel({ view }: { view: TutorialView }) {
  // 단계가 바뀌면 다시 펼쳐 보여 준다
  const stepKey = `${view.tutorial.id}:${view.index}`;
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const open = closedFor !== stepKey;
  const offPage = !!view.expected && !view.onRightPage && !view.done;
  // 화면을 누르거나 입력을 시작하면 시트를 접어 양식을 가리지 않는다 (아래 한 줄은 남는다)
  useEffect(() => {
    if (!open) return;
    const main = document.getElementById("console-main");
    if (!main) return;
    const collapse = () => setClosedFor(stepKey);
    main.addEventListener("pointerdown", collapse);
    main.addEventListener("focusin", collapse);
    return () => {
      main.removeEventListener("pointerdown", collapse);
      main.removeEventListener("focusin", collapse);
    };
  }, [open, stepKey]);
  return (
    <aside
      className="fixed inset-x-0 bottom-0 z-[46] rounded-t-2xl border-t border-aws-border bg-aws-surface shadow-[0_-10px_30px_rgba(0,7,22,0.28)]"
      aria-label="튜토리얼 안내"
      data-testid="tutorial-panel"
      data-done={view.done || undefined}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-expanded={open} aria-label={open ? "안내 접기" : "안내 펼치기"} onClick={() => setClosedFor(open ? stepKey : null)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {view.done ? <CircleCheck className="size-5 shrink-0 text-aws-success" aria-hidden /> : <GraduationCap className="size-5 shrink-0 text-aws-link" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-bold text-aws-text">{view.step.title}</span>
            <span className="block truncate text-xs text-aws-text-2">
              {view.tutorial.title} · {view.index + 1} / {view.total}
            </span>
          </span>
          {open ? <ChevronDown className="size-4 shrink-0 text-aws-text-2" aria-hidden /> : <ChevronUp className="size-4 shrink-0 text-aws-text-2" aria-hidden />}
        </button>
        {!open &&
          (offPage ? (
            <Button variant="primary" onClick={() => navigate(view.expected!)} data-testid="tutorial-go">
              이동
            </Button>
          ) : (
            <NavButtons view={view} compact />
          ))}
        <button type="button" className="rounded p-1.5 text-aws-text-2 hover:bg-aws-surface-2" aria-label="튜토리얼 끝내기" onClick={() => store().stop()}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-aws-divider px-4 pt-3 pb-3">
          <Progress view={view} />
          <div key={stepKey} className="max-h-[42dvh] overflow-y-auto">
            <StepContent view={view} />
          </div>
          <NavButtons view={view} />
        </div>
      )}
    </aside>
  );
}

export function TutorialPanel({ variant }: { variant: "side" | "sheet" }) {
  const view = useTutorialView();
  if (!view) return null;
  return variant === "side" ? <SidePanel view={view} /> : <SheetPanel view={view} />;
}

/** 안내를 접어 두었거나 도움말 패널이 열려 있을 때: 다시 여는 작은 버튼 */
export function TutorialChip({ onOpen }: { onOpen: () => void }) {
  const view = useTutorialView();
  if (!view) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed right-4 bottom-4 z-[46] inline-flex items-center gap-2 rounded-full border-2 border-aws-link bg-aws-surface py-2 pr-4 pl-3 text-[14px] font-bold text-aws-link shadow-xl hover:bg-aws-info-bg"
      data-testid="tutorial-chip"
    >
      {view.done ? <CircleCheck className="size-[18px] text-aws-success" aria-hidden /> : <GraduationCap className="size-[18px]" aria-hidden />}
      튜토리얼 {view.index + 1}/{view.total} 열기
    </button>
  );
}
