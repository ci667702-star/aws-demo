"use client";

import { ArrowRight, BookOpen, ChevronRight, GraduationCap, Loader2 } from "lucide-react";
import { cn } from "cn";
import { Suspense, useEffect, useState } from "react";
import { DISCLAIMER } from "@/components/app/brand";
import { LazyBoundary, lazyGroup, preloadLazyGroupsWhenIdle } from "@/components/app/lazy";
import { useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { href, navigate, useHashLocation } from "../router";
import { resolveRoute, type Crumb } from "../routes";
import { serviceItemName } from "../service-names";
import { AlarmWatcher } from "../pages/cloudwatch/alarm-watcher";
import { TutorialHost } from "../tutorial/tutorial-host";
import { openTutorialPanel } from "../tutorial/tutorial-menu";
import { TutorialChip, TutorialPanel } from "../tutorial/tutorial-panel";
import { useTutorialStore } from "../tutorial/tutorial-store";
import { useActiveTutorial } from "../tutorial/use-tutorial";
import { SideNav } from "./side-nav";
import { docTargetForPath } from "./doc-target";
import { IdentityBanner } from "./identity-menu";
import { TopNav } from "./top-nav";

// 도움말·실습·리소스 설명 패널은 열 때 불러온다 (설명 데이터가 커서 첫 화면에서 빼 둔다)
const { ToolsPanel } = lazyGroup(() => import("./tools-panel"), ["ToolsPanel"]);

const TOP = "top-[52px]";
const FULL_HEIGHT = "h-[calc(100dvh-52px)]";

function useMinWidth(px: number) {
  const [matches, setMatches] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [px]);
  return matches;
}

export function ConsoleShell() {
  const location = useHashLocation();
  const project = useProject();
  const navOpen = useConsoleUi((s) => s.navOpen);
  const setNavOpen = useConsoleUi((s) => s.setNavOpen);
  const toolsOpen = useConsoleUi((s) => s.toolsOpen);
  const setToolsOpen = useConsoleUi((s) => s.setToolsOpen);
  const toolsTab = useConsoleUi((s) => s.toolsTab);
  const openResourceDoc = useConsoleUi((s) => s.openResourceDoc);
  const desktop = useMinWidth(1024);
  // 튜토리얼 안내는 화면이 충분히 넓을 때만 오른쪽 열에 두고, 좁으면 아래 시트로 보여 준다 (양식이 너무 좁아지지 않게)
  const wide = useMinWidth(1180);
  const tutorialActive = !!useActiveTutorial();
  const tutorialMinimized = useTutorialStore((s) => s.minimized);
  const tutorialShown = tutorialActive && !tutorialMinimized && !toolsOpen;
  const resolved = resolveRoute(location.segments);
  // IAM·S3·CloudWatch 항목은 ID 대신 이름을 보여 준다
  const named = (text: string) =>
    text
      .split(" - ")
      .map((part) => serviceItemName(project, part) ?? part)
      .join(" - ");
  const route = { ...resolved, title: named(resolved.title), crumbs: resolved.crumbs.map((c) => ({ ...c, text: named(c.text) })) };

  // 모바일에서는 탐색 창을 기본으로 닫는다
  useEffect(() => {
    if (!desktop) setNavOpen(false);
  }, [desktop, setNavOpen]);

  useEffect(() => {
    document.title = `${route.title} · ${project.name} · AWS Playground`;
  }, [route.title, project.name]);

  // 대시보드에서 실습을 시작하면 실습 패널을 연다 (#/?tools=labs)
  const toolsParam = location.query.get("tools");
  useEffect(() => {
    if (toolsParam !== "labs") return;
    useConsoleUi.getState().openLabs();
    navigate(location.path, { replace: true });
  }, [toolsParam, location.path]);

  // 페이지가 바뀌면 맨 위로
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.path]);

  // 첫 화면을 그린 뒤 한가할 때 나머지 화면 코드를 미리 받아 둔다 (화면 전환이 끊기지 않게)
  useEffect(() => preloadLazyGroupsWhenIdle(), []);

  const closeNavOnMobile = () => {
    if (!desktop) setNavOpen(false);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-aws-page text-aws-text">
      <TopNav />
      <IdentityBanner />
      <div className="relative flex min-h-0 flex-1">
        {navOpen && (
          <>
            {!desktop && <div className={cn("fixed inset-0 z-30 bg-[#0f141a]/50", TOP)} onClick={() => setNavOpen(false)} aria-hidden />}
            <div
              className={cn(
                "w-[288px] shrink-0 border-r border-aws-border bg-aws-surface",
                desktop ? cn("sticky", TOP, FULL_HEIGHT) : cn("fixed bottom-0 left-0 z-30 shadow-xl", TOP),
              )}
            >
              <SideNav path={location.path} onNavigate={closeNavOnMobile} onClose={() => setNavOpen(false)} />
            </div>
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col" id="console-main">
          <div className={cn("mx-auto flex w-full flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-10", route.fullWidth ? "max-w-none" : "max-w-[1240px]")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Breadcrumbs crumbs={route.crumbs} />
              {docTargetForPath(project, location.segments) && !(toolsOpen && toolsTab === "resource") && (
                <button
                  type="button"
                  onClick={openResourceDoc}
                  className="inline-flex items-center gap-1.5 rounded-full border border-aws-border px-3 py-1 text-[13px] font-bold text-aws-link hover:border-aws-link hover:bg-aws-info-bg"
                  data-testid="open-resource-doc"
                >
                  <BookOpen className="size-4" aria-hidden /> 이 화면의 리소스 설명
                </button>
              )}
            </div>
            {/* 본문 너비 기준 배치(@container/main): 오른쪽 패널이 열려 본문이 좁아지면 여러 열이 한 열로 접힌다 */}
            <div className="@container/main flex-1" key={location.path} data-tour="page-content">
              <LazyBoundary resetKey={location.path} fallback={(retry) => <PageLoadFailed onRetry={retry} />}>
                <Suspense fallback={<PageLoading />}>{route.element}</Suspense>
              </LazyBoundary>
            </div>
          </div>
          <footer className="border-t border-aws-border px-4 py-4 text-[13px] text-aws-text-2 sm:px-10">
            {DISCLAIMER} 화면 구성은 학습을 위해 AWS 콘솔을 참고했으며 실제 AWS 서비스가 아닙니다.
          </footer>
          {/* 아래 시트가 페이지 맨 아래 버튼을 가리지 않게 여백을 둔다 */}
          {tutorialShown && !wide && <div className="h-24 shrink-0" aria-hidden />}
        </main>
        {toolsOpen && (
          <>
            {!desktop && <div className={cn("fixed inset-0 z-30 bg-[#0f141a]/50", TOP)} onClick={() => setToolsOpen(false)} aria-hidden />}
            <div
              className={cn(
                "flex w-[min(100vw,380px)] shrink-0 flex-col border-l border-aws-border bg-aws-surface",
                desktop ? cn("sticky z-[46]", TOP, FULL_HEIGHT) : cn("fixed right-0 bottom-0 z-[47] shadow-xl", TOP),
              )}
            >
              {tutorialActive && (
                <button
                  type="button"
                  onClick={openTutorialPanel}
                  className="flex shrink-0 items-center justify-between gap-2 border-b border-aws-divider bg-aws-info-bg px-4 py-2 text-left text-[13px] font-bold text-aws-link hover:underline"
                  data-testid="tutorial-return"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <GraduationCap className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">튜토리얼 진행 중 · 안내로 돌아가기</span>
                  </span>
                  <ArrowRight className="size-4 shrink-0" aria-hidden />
                </button>
              )}
              <div className="min-h-0 flex-1">
                <LazyBoundary fallback={(retry) => <PageLoadFailed onRetry={retry} />}>
                  <Suspense fallback={<PageLoading />}>
                    <ToolsPanel onClose={() => setToolsOpen(false)} />
                  </Suspense>
                </LazyBoundary>
              </div>
            </div>
          </>
        )}
        {tutorialShown && wide && (
          <div className={cn("sticky z-[46] w-[360px] shrink-0 border-l border-aws-border", TOP, FULL_HEIGHT)}>
            <TutorialPanel variant="side" />
          </div>
        )}
      </div>
      {tutorialShown && !wide && <TutorialPanel variant="sheet" />}
      {tutorialActive && tutorialMinimized && <TutorialChip onOpen={openTutorialPanel} />}
      <TutorialHost />
      <AlarmWatcher />
    </div>
  );
}

/** 화면 코드를 받는 동안 잠깐 보이는 표시 (바로 받아지면 깜빡이지 않게 조금 늦게 나타난다) */
function PageLoading() {
  return (
    <div className="pg-delayed-fade flex items-center justify-center gap-2 px-4 py-16 text-[15px] text-aws-text-2" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      화면을 불러오는 중…
    </div>
  );
}

function PageLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center" role="alert">
      <p className="text-base font-bold text-aws-text">화면을 불러오지 못했습니다</p>
      <p className="max-w-md text-[15px] text-aws-text-2">네트워크 연결을 확인한 뒤 다시 시도하세요. 계속 안 되면 페이지를 새로고침하세요. 샌드박스 내용은 그대로 저장되어 있습니다.</p>
      <button type="button" onClick={onRetry} className="rounded-full border-2 border-aws-link px-4 py-1.5 text-sm font-bold text-aws-link hover:bg-aws-info-bg">
        다시 시도
      </button>
    </div>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  return (
    <nav aria-label="이동 경로">
      <ol className="flex flex-wrap items-center gap-1.5 text-[14px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={i} className="flex items-center gap-1.5">
              {c.path && !last ? (
                <a href={href(c.path)} className="text-aws-link hover:underline">
                  {c.text}
                </a>
              ) : (
                <span className="break-all text-aws-text-2" aria-current={last ? "page" : undefined}>
                  {c.text}
                </span>
              )}
              {!last && <ChevronRight className="size-4 text-aws-text-3" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
