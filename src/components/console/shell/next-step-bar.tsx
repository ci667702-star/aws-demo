"use client";

/**
 * 콘솔 위쪽의 "다음 할 일" 한 줄.
 * 처음 쓰는 사람이 어디서부터 해야 할지 알 수 있게, 첫 웹 서버까지 아직 하지 않은 첫 단계와 그 화면으로 가는 버튼을 보여 준다.
 * 첫 웹 서버와 관계있는 화면(네트워크·네트워크 보안·서버·분석 도구)에서만 보인다 — IAM·S3 같은 화면에서 VPC 단계를 권하면 엉뚱하다.
 * 따라하기 중이거나(안내 패널이 우선), 실습 문제 샌드박스이거나, 모두 끝났거나, 사용자가 숨기면 보이지 않는다.
 */
import { ArrowRight, Compass, X } from "lucide-react";
import { GlossaryText } from "@/components/docs/glossary-text";
import { firstWebServerSteps, nextFirstStep } from "@/lib/project/first-steps";
import { useGuidePrefs } from "@/lib/store/guide-prefs";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { href } from "../router";
import { useActiveTutorial } from "../tutorial/use-tutorial";
import { activeNavItem } from "./navigation";

/** 다음 할 일 줄을 보여 주는 메뉴 묶음 */
const RELATED_GROUPS = new Set(["vpc", "security", "ec2", "tools"]);

export function NextStepBar({ path }: { path: string }) {
  const project = useProject();
  const { topology } = useAnalysis();
  const projectId = useConsoleProjectId();
  const tutorial = useActiveTutorial();
  const hidden = useGuidePrefs((s) => !!s.nextStepHidden[projectId]);
  // 콘솔 홈에는 전체 목록이 있으므로 보이지 않는다
  const group = activeNavItem(path)?.group.id;
  if (path === "/" || !group || !RELATED_GROUPS.has(group) || tutorial || hidden || project.labId) return null;
  const steps = firstWebServerSteps(project, topology);
  const next = nextFirstStep(steps);
  if (!next) return null;
  const doneCount = steps.filter((s) => s.done).length;
  const here = path === next.consolePath;
  return (
    <section aria-label="다음 할 일" data-testid="next-step-bar" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-aws-link/30 bg-aws-info-bg px-4 py-3">
      <Compass className="size-5 shrink-0 text-aws-link" aria-hidden />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-[13px] font-bold text-aws-text-2">
          첫 웹 서버까지 {doneCount}/{steps.length} · 다음 할 일
        </p>
        <p className="text-[15px] leading-relaxed text-aws-text">
          <span className="font-bold">{next.title}</span> — <GlossaryText text={next.detail} limit={2} />
        </p>
      </div>
      {here ? (
        <span className="text-sm font-bold text-aws-success">지금 이 화면에서 하면 됩니다</span>
      ) : (
        <a
          href={href(next.consolePath)}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border-2 border-aws-link bg-aws-surface px-4 text-sm font-bold text-aws-link hover:bg-aws-surface-2"
          data-testid="next-step-go"
        >
          이 화면으로 이동 <ArrowRight className="size-4" aria-hidden />
        </a>
      )}
      <button
        type="button"
        onClick={() => useGuidePrefs.getState().setNextStepHidden(projectId, true)}
        className="shrink-0 rounded-lg p-1.5 text-aws-text-2 hover:bg-aws-surface hover:text-aws-text"
        aria-label="다음 할 일 숨기기"
        title="이 샌드박스에서 숨깁니다. 콘솔 홈에서 다시 켤 수 있습니다."
      >
        <X className="size-4" aria-hidden />
      </button>
    </section>
  );
}
