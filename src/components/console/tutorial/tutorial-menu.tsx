"use client";

import { GraduationCap } from "lucide-react";
import { cn } from "cn";
import { DropdownMenu as Menu_ } from "radix-ui";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { navButton } from "../shell/nav-styles";
import { Button, type ButtonVariant } from "../ui/button";
import { useTutorialStore } from "./tutorial-store";
import { tutorialById, tutorialProgress, TUTORIALS } from "./tutorials";

const menuItem =
  "flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 text-[15px] outline-none data-[highlighted]:bg-aws-info-bg data-[highlighted]:text-aws-link-hover";

/** 상단 메뉴의 "튜토리얼" 버튼 */
export function TutorialMenu() {
  const active = useTutorialStore((s) => s.active);
  const project = useProject();
  const { topology } = useAnalysis();
  const ctx = { project, topo: topology };
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={cn(navButton, active && "bg-aws-nav-hover")} aria-label="튜토리얼" data-tour="tutorial-menu">
        <GraduationCap className="size-[18px]" aria-hidden />
        <span className="hidden lg:inline">튜토리얼</span>
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={8} className="z-50 w-[min(92vw,24rem)] rounded-xl border border-aws-border bg-aws-surface p-1.5 text-aws-text shadow-xl">
          <Menu_.Label className="px-3 pt-2 pb-1 text-[13px] font-bold text-aws-text-2">팝업 안내를 따라 하는 튜토리얼</Menu_.Label>
          {TUTORIALS.map((t) => {
            const progress = tutorialProgress(t, ctx);
            return (
              <Menu_.Item key={t.id} className={menuItem} onSelect={() => useTutorialStore.getState().start(t.id)}>
                <span className="font-bold">
                  {t.title} <span className="font-normal text-aws-text-2">· 약 {t.minutes}분</span>
                </span>
                <span className="text-[13px] leading-snug text-aws-text-2">{t.description}</span>
                {progress.total > 0 && (
                  <span className="text-[13px] font-bold text-aws-success">
                    진행 {progress.done}/{progress.total}
                  </span>
                )}
              </Menu_.Item>
            );
          })}
          {active && (
            <>
              <Menu_.Separator className="my-1 h-px bg-aws-divider" />
              <Menu_.Item className={menuItem} onSelect={() => useTutorialStore.getState().stop()}>
                진행 중인 튜토리얼 종료 ({tutorialById(active.tutorialId)?.title})
              </Menu_.Item>
            </>
          )}
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

/** 특정 튜토리얼을 시작하는 버튼 (콘솔 홈 등) */
export function StartTutorialButton({ tutorialId, variant = "normal", label }: { tutorialId: string; variant?: ButtonVariant; label?: string }) {
  const project = useProject();
  const { topology } = useAnalysis();
  const tutorial = tutorialById(tutorialId);
  if (!tutorial) return null;
  const progress = tutorialProgress(tutorial, { project, topo: topology });
  const text = label ?? (progress.done > 0 && progress.done < progress.total ? "튜토리얼 이어서 하기" : "튜토리얼 시작");
  return (
    <Button variant={variant} onClick={() => useTutorialStore.getState().start(tutorialId)}>
      {text}
    </Button>
  );
}
