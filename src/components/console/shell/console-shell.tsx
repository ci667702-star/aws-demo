"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { useEffect, useState } from "react";
import { DISCLAIMER } from "@/components/app/brand";
import { useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { href, navigate, useHashLocation } from "../router";
import { resolveRoute, type Crumb } from "../routes";
import { serviceItemName } from "../service-names";
import { AlarmWatcher } from "../pages/cloudwatch/cw-overview";
import { TutorialHost } from "../tutorial/tutorial-host";
import { SideNav } from "./side-nav";
import { ToolsPanel } from "./tools-panel";
import { TopNav } from "./top-nav";

const TOP = "top-[52px]";
const FULL_HEIGHT = "h-[calc(100dvh-52px)]";

function useIsDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

export function ConsoleShell() {
  const location = useHashLocation();
  const project = useProject();
  const navOpen = useConsoleUi((s) => s.navOpen);
  const setNavOpen = useConsoleUi((s) => s.setNavOpen);
  const toolsOpen = useConsoleUi((s) => s.toolsOpen);
  const setToolsOpen = useConsoleUi((s) => s.setToolsOpen);
  const desktop = useIsDesktop();
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

  const closeNavOnMobile = () => {
    if (!desktop) setNavOpen(false);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-aws-page text-aws-text">
      <TopNav />
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
            <Breadcrumbs crumbs={route.crumbs} />
            <div className="flex-1" key={location.path} data-tour="page-content">
              {route.element}
            </div>
          </div>
          <footer className="border-t border-aws-border px-4 py-4 text-[13px] text-aws-text-2 sm:px-10">
            {DISCLAIMER} 화면 구성은 학습을 위해 AWS 콘솔을 참고했으며 실제 AWS 서비스가 아닙니다.
          </footer>
        </main>
        {toolsOpen && (
          <>
            {!desktop && <div className={cn("fixed inset-0 z-30 bg-[#0f141a]/50", TOP)} onClick={() => setToolsOpen(false)} aria-hidden />}
            <div
              className={cn(
                "w-[min(100vw,380px)] shrink-0 border-l border-aws-border",
                desktop ? cn("sticky", TOP, FULL_HEIGHT) : cn("fixed right-0 bottom-0 z-30 shadow-xl", TOP),
              )}
            >
              <ToolsPanel onClose={() => setToolsOpen(false)} />
            </div>
          </>
        )}
      </div>
      <TutorialHost />
      <AlarmWatcher />
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
