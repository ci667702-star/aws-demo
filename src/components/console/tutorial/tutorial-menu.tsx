"use client";

import { GraduationCap } from "lucide-react";
import { cn } from "cn";
import { DropdownMenu as Menu_ } from "radix-ui";
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { navButton } from "../shell/nav-styles";
import { Button, type ButtonVariant } from "../ui/button";
import { useTutorialStore } from "./tutorial-store";
import { resumeStepIndex, tutorialById, tutorialProgress, TUTORIALS } from "./tutorials";
import { useActiveTutorial } from "./use-tutorial";

const menuItem =
  "flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 text-[15px] outline-none data-[highlighted]:bg-aws-info-bg data-[highlighted]:text-aws-link-hover";

/** 따라하기를 시작한다: 안내 패널이 보이도록 도움말 패널은 닫는다 */
export function startTutorial(tutorialId: string, stepIndex: number) {
  useConsoleUi.getState().setToolsOpen(false);
  useTutorialStore.getState().start(tutorialId, stepIndex);
}

/** 안내 패널을 다시 연다 (접어 두었거나 도움말 패널에 가려진 경우) */
export function openTutorialPanel() {
  useConsoleUi.getState().setToolsOpen(false);
  useTutorialStore.getState().setMinimized(false);
}

/** 상단 메뉴의 "따라하기" 버튼 */
export function TutorialMenu() {
  const active = useActiveTutorial();
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={cn(navButton, active && "bg-aws-nav-hover")} aria-label="따라하기" data-tour="tutorial-menu">
        <GraduationCap className="size-[18px]" aria-hidden />
        <span className="hidden lg:inline">따라하기</span>
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={8} className="z-50 max-h-[80vh] w-[min(92vw,24rem)] overflow-y-auto rounded-xl border border-aws-border bg-aws-surface p-1.5 text-aws-text shadow-xl">
          <TutorialMenuItems />
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

/** 메뉴를 열었을 때만 그린다 (튜토리얼마다 진행 상황을 판정하므로 닫혀 있을 때는 계산하지 않는다) */
function TutorialMenuItems() {
  const active = useActiveTutorial();
  const project = useProject();
  const { topology } = useAnalysis();
  const ctx = { project, topo: topology };
  return (
    <>
      {active && (
        <>
          <Menu_.Label className="px-3 pt-2 pb-1 text-[13px] font-bold text-aws-text-2">진행 중: {tutorialById(active.tutorialId)?.title}</Menu_.Label>
          <Menu_.Item className={menuItem} onSelect={openTutorialPanel}>
            안내 패널 열기
          </Menu_.Item>
          <Menu_.Item className={menuItem} onSelect={() => useTutorialStore.getState().stop()}>
            진행 중인 따라하기 끝내기
          </Menu_.Item>
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
        </>
      )}
      <Menu_.Label className="px-3 pt-2 pb-1 text-[13px] font-bold text-aws-text-2">따라하기 — 오른쪽 안내가 한 단계씩 알려 줍니다</Menu_.Label>
      {TUTORIALS.map((t) => {
        const progress = tutorialProgress(t, ctx);
        return (
          <Menu_.Item key={t.id} className={menuItem} onSelect={() => startTutorial(t.id, resumeStepIndex(t, ctx))}>
            <span className="font-bold">
              {t.title} <span className="font-normal text-aws-text-2">· 약 {t.minutes}분</span>
            </span>
            <span className="text-[13px] leading-snug text-aws-text-2">{t.description}</span>
            {progress.total > 0 && (
              <span className="text-[13px] font-bold text-aws-success">
                진행 {progress.done}/{progress.total}
                {progress.done > 0 && progress.done < progress.total && " · 남은 단계부터 이어서"}
              </span>
            )}
          </Menu_.Item>
        );
      })}
    </>
  );
}

/** 특정 튜토리얼을 시작하는 버튼 (콘솔 홈 등) */
export function StartTutorialButton({ tutorialId, variant = "normal", label }: { tutorialId: string; variant?: ButtonVariant; label?: string }) {
  const project = useProject();
  const { topology } = useAnalysis();
  const tutorial = tutorialById(tutorialId);
  if (!tutorial) return null;
  const ctx = { project, topo: topology };
  const progress = tutorialProgress(tutorial, ctx);
  const text = label ?? (progress.done > 0 && progress.done < progress.total ? "따라하기 이어서 하기" : "따라하기 시작");
  return (
    <Button variant={variant} onClick={() => startTutorial(tutorialId, resumeStepIndex(tutorial, ctx))}>
      {text}
    </Button>
  );
}
