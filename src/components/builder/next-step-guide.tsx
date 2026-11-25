"use client";

/**
 * 쉬운 모드 캔버스 위의 "다음 할 일".
 * 빈 캔버스에서는 '1단계: VPC 만들기'처럼 무엇부터 놓을지 크게 보여 주고, 리소스가 생기면 아래쪽에 한 줄로 다음 단계를 알려 준다.
 * 완료 여부는 첫 화면·콘솔과 같은 판정(first-steps.ts)으로 지금 설정에서 매번 계산한다.
 */
import { Compass, MousePointerClick, X } from "lucide-react";
import { useAnalysis } from "@/components/console/analysis-context";
import { GlossaryText } from "@/components/docs/glossary-text";
import { Button } from "@/components/ui/button";
import { RESOURCE_PLAIN_NAME } from "@/lib/docs/glossary";
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import { firstWebServerSteps, nextFirstStep } from "@/lib/project/first-steps";
import { useEditorStore } from "@/lib/store/editor-store";
import { useGuidePrefs } from "@/lib/store/guide-prefs";

export function NextStepGuide({ project, onFind }: { project: Project; onFind: (type: ResourceType) => void }) {
  const { topology } = useAnalysis();
  const hidden = useGuidePrefs((s) => !!s.nextStepHidden[project.id]);
  const empty = project.resources.length === 0;
  const guided = !hidden && !project.labId;
  const steps = firstWebServerSteps(project, topology);
  const next = guided ? nextFirstStep(steps) : null;

  if (!next) {
    // 안내를 숨겼거나 실습 문제여도 빈 캔버스에서는 무엇을 하면 되는지 알려 준다
    if (!empty) return null;
    return (
      <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center px-4">
        <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-dashed bg-background/90 p-6 text-center shadow-sm">
          <MousePointerClick className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-medium">빈 캔버스입니다</p>
          <p className="text-sm text-muted-foreground">왼쪽 팔레트에서 VPC부터 끌어다 놓거나 눌러서 추가하세요. 리소스 아래/위의 연결점을 끌면 관계를 만들 수 있습니다.</p>
        </div>
      </div>
    );
  }

  const index = steps.indexOf(next);
  const action = next.paletteType ? (
    <Button size="sm" variant="outline" onClick={() => onFind(next.paletteType!)} data-testid="next-step-find">
      팔레트에서 {RESOURCE_PLAIN_NAME[next.paletteType].ko.replace(/ \(.+\)$/, "")} 찾기
    </Button>
  ) : (
    <Button size="sm" variant="outline" onClick={() => useEditorStore.getState().setBottomTab("simulation")} data-testid="next-step-find">
      시뮬레이션 열기
    </Button>
  );
  const dismiss = (
    <button
      type="button"
      onClick={() => useGuidePrefs.getState().setNextStepHidden(project.id, true)}
      className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label="다음 할 일 숨기기"
      title="이 샌드박스에서 숨깁니다. 다시 보려면 심화 모드의 콘솔 홈에서 켭니다."
    >
      <X className="size-4" aria-hidden />
    </button>
  );

  if (empty) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-12 z-10 flex justify-center px-4">
        <section aria-label="다음 할 일" data-testid="builder-next-step" className="pointer-events-auto flex max-w-md flex-col gap-2 rounded-xl border bg-background/95 p-5 shadow-md">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold text-sky-700 dark:text-sky-300">
              첫 웹 서버 만들기 · {index + 1}단계 / {steps.length}
            </p>
            {dismiss}
          </div>
          <p className="text-base font-semibold">{next.title}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <GlossaryText text={next.detail} limit={2} />
          </p>
          <p className="text-sm leading-relaxed">{next.builderHint}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div>
          <p className="text-xs text-muted-foreground">리소스 아래/위의 연결점을 끌면 두 리소스를 선으로 이을 수 있습니다.</p>
        </section>
      </div>
    );
  }

  return (
    // 왼쪽 아래 확대 버튼과 오른쪽 아래 미니맵(넓은 화면)을 가리지 않는 자리
    <div className="pointer-events-none absolute right-3 bottom-3 left-14 z-10 flex justify-center md:right-44">
      <section
        aria-label="다음 할 일"
        data-testid="builder-next-step"
        className="pointer-events-auto flex max-w-[min(100%,40rem)] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-background/95 px-3 py-2 shadow-md"
      >
        <Compass className="size-4 shrink-0 text-sky-600" aria-hidden />
        <p className="min-w-0 flex-1 basis-56 text-sm leading-snug">
          <span className="text-xs font-semibold text-muted-foreground">
            첫 웹 서버까지 {steps.filter((s) => s.done).length}/{steps.length} · 다음
          </span>{" "}
          <span className="font-semibold">{next.title}</span>
          <span className="block text-xs text-muted-foreground">{next.builderHint}</span>
        </p>
        {action}
        {dismiss}
      </section>
    </div>
  );
}
