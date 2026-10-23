"use client";

import { Check, ChevronDown, Cloud, Grid3x3, HelpCircle, Menu, Moon, Redo2, Search, Shapes, Sun, SunMoon, Undo2, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropdownMenu as Menu_ } from "radix-ui";
import { RESOURCE_TYPE_INFO } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { exportFileName, exportProjectJson } from "@/lib/project/serialization";
import { useCanRedo, useCanUndo, useProjectStore } from "@/lib/store/project-store";
import { downloadTextFile } from "@/lib/ui/download";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { href, navigate, resourceHref } from "../router";
import { TutorialMenu } from "../tutorial/tutorial-menu";
import { NAV_GROUPS } from "./navigation";
import { navButton } from "./nav-styles";

const menuContent = "z-50 min-w-64 rounded-xl border border-aws-border bg-aws-surface p-1.5 text-aws-text shadow-xl";
const menuItem =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] outline-none data-[highlighted]:bg-aws-info-bg data-[highlighted]:text-aws-link-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-aws-text-3";

export function TopNav() {
  const projectId = useConsoleProjectId();
  const project = useProject();
  const navOpen = useConsoleUi((s) => s.navOpen);
  const setNavOpen = useConsoleUi((s) => s.setNavOpen);
  const toolsOpen = useConsoleUi((s) => s.toolsOpen);
  const setToolsOpen = useConsoleUi((s) => s.setToolsOpen);
  const canUndo = useCanUndo(projectId);
  const canRedo = useCanRedo(projectId);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const undo = () => useProjectStore.getState().undo(projectId);
  const redo = () => useProjectStore.getState().redo(projectId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.getState().undo(projectId);
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        useProjectStore.getState().redo(projectId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId]);

  const saveLabel = { saved: "저장됨", pending: "저장 중…", error: "저장 실패", unavailable: "저장 안 됨" }[saveStatus];

  return (
    <header className="sticky top-0 z-40 flex h-[52px] shrink-0 items-center gap-1 bg-aws-nav px-2 text-aws-nav-fg sm:gap-2 sm:px-3" data-testid="console-top-nav">
      <button type="button" className={navButton} onClick={() => setNavOpen(!navOpen)} aria-label={navOpen ? "탐색 창 닫기" : "탐색 창 열기"} aria-expanded={navOpen}>
        <Menu className="size-5" aria-hidden />
      </button>
      <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-aws-nav-hover" title="샌드박스 목록으로">
        <span className="inline-flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-sky-400 to-indigo-500 text-white">
          <Cloud className="size-4" aria-hidden />
        </span>
        <span className="hidden flex-col leading-tight md:flex">
          <span className="text-[14px] font-bold">AWS Playground</span>
          <span className="text-[11px] text-aws-nav-muted">학습용 가상 콘솔 · 심화 모드</span>
        </span>
      </Link>
      <ServicesMenu />
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
        <TutorialMenu />
        <button
          type="button"
          className={cn(navButton, toolsOpen && "bg-aws-nav-hover")}
          onClick={() => setToolsOpen(!toolsOpen)}
          aria-pressed={toolsOpen}
          aria-label="도움말 및 실습 패널"
          data-tour="help-button"
        >
          <HelpCircle className="size-[18px]" aria-hidden />
          <span className="hidden lg:inline">도움말</span>
        </button>
        <Link href={`/projects/${projectId}`} className={cn(navButton, "hidden md:inline-flex")} title="같은 샌드박스를 그림으로 설계하는 쉬운 모드로 전환" data-tour="mode-switch">
          <Shapes className="size-[18px]" aria-hidden />
          <span className="hidden xl:inline">쉬운 모드</span>
        </Link>
        <span className="mx-1 hidden h-6 w-px bg-aws-nav-muted/30 sm:block" aria-hidden />
        <button type="button" className={navButton} onClick={undo} disabled={!canUndo} aria-label="실행 취소" title="실행 취소 (Ctrl+Z)" data-tour="undo">
          <Undo2 className="size-[18px]" aria-hidden />
        </button>
        <button type="button" className={cn(navButton, "hidden sm:inline-flex")} onClick={redo} disabled={!canRedo} aria-label="다시 실행" title="다시 실행 (Ctrl+Y)">
          <Redo2 className="size-[18px]" aria-hidden />
        </button>
        <span
          className={cn("hidden px-1 text-[13px] lg:inline", saveStatus === "error" ? "text-[#ff8f8f]" : "text-aws-nav-muted")}
          role="status"
          title={saveStatus === "unavailable" ? "브라우저 저장소를 사용할 수 없어 새로고침하면 변경 사항이 사라집니다." : "이 브라우저의 저장소에 자동 저장"}
          data-testid="save-status"
        >
          {saveLabel}
        </span>
        <ThemeMenu />
        <SandboxMenu name={project.name} onExport={() => downloadTextFile(exportFileName(project), exportProjectJson(project))} />
      </div>
    </header>
  );
}

function ServicesMenu() {
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={navButton} aria-label="서비스 메뉴" data-tour="services-menu">
        <Grid3x3 className="size-[18px]" aria-hidden />
        <span className="hidden sm:inline">서비스</span>
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="start" sideOffset={8} className={cn(menuContent, "max-h-[75vh] w-[min(94vw,30rem)] overflow-y-auto")}>
          <Menu_.Label className="px-3 pt-2 pb-1 text-[13px] font-bold text-aws-text-2">서비스 (모두 가상)</Menu_.Label>
          {NAV_GROUPS.map((g) => (
            <Menu_.Item key={g.id} className={cn(menuItem, "items-start")} onSelect={() => navigate(g.root)}>
              <g.icon className="mt-0.5 size-5 shrink-0 text-aws-link" aria-hidden />
              <span>
                <span className="block font-bold">{g.label}</span>
                <span className="block text-[13px] leading-snug text-aws-text-2">{g.description}</span>
              </span>
            </Menu_.Item>
          ))}
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

interface SearchResult {
  key: string;
  label: string;
  detail: string;
  href: string;
}

function GlobalSearch() {
  const { topology, project } = useAnalysis();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const pages: SearchResult[] = NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => ({ key: `${g.id}:${i.path}`, label: i.label, detail: g.label, href: href(i.path) })),
    ).filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q));
    const resources: SearchResult[] = topology.project.resources
      .filter((r) => `${r.id} ${r.name} ${RESOURCE_TYPE_INFO[r.type].label}`.toLowerCase().includes(q))
      .slice(0, 10)
      .map((r) => ({
        key: r.id,
        label: r.name?.trim() ? `${displayName(r)} (${r.id})` : r.id,
        detail: RESOURCE_TYPE_INFO[r.type].label,
        href: resourceHref(r.type, r.id),
      }));
    const services: SearchResult[] = [
      ...project.services.s3.buckets.map((b) => ({ key: b.id, label: b.name, detail: "S3 버킷", href: href(`/s3/buckets/${b.id}`) })),
      ...project.services.iam.users.map((u) => ({ key: u.id, label: u.name, detail: "IAM 사용자", href: href(`/iam/users/${u.id}`) })),
      ...project.services.iam.roles.map((r) => ({ key: r.id, label: r.name, detail: "IAM 역할", href: href(`/iam/roles/${r.id}`) })),
      ...project.services.cloudwatch.alarms.map((a) => ({ key: a.id, label: a.name, detail: "CloudWatch 경보", href: href(`/cloudwatch/alarms/${a.id}`) })),
    ].filter((r) => r.label.toLowerCase().includes(q));
    return [...pages, ...resources, ...services.slice(0, 10)];
  }, [query, topology, project]);

  const go = (r: SearchResult | undefined) => {
    if (!r) return;
    window.location.hash = r.href.slice(1);
    setQuery("");
    setOpen(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div
      ref={boxRef}
      className="relative max-w-lg min-w-0 flex-1"
      data-tour="search"
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-aws-nav-muted" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="console-search-results"
        aria-label="서비스와 리소스 검색"
        placeholder="화면·리소스 검색 (Alt+S)"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="h-9 w-full rounded-lg border border-aws-nav-muted/40 bg-[#0f141a] pr-3 pl-9 text-[14px] text-white placeholder:text-aws-nav-muted focus:border-aws-focus focus:outline-2 focus:outline-aws-focus [&::-webkit-search-cancel-button]:hidden"
      />
      {open && query.trim() && (
        <ul
          id="console-search-results"
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1.5 max-h-[60vh] overflow-y-auto rounded-xl border border-aws-border bg-aws-surface p-1.5 text-aws-text shadow-xl sm:min-w-96"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-aws-text-2">&quot;{query}&quot;와(과) 일치하는 화면이나 리소스가 없습니다.</li>
          ) : (
            results.map((r, i) => (
              <li key={r.key} role="option" aria-selected={i === active}>
                <a
                  href={r.href}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    go(r);
                  }}
                  className={cn("block rounded-lg px-3 py-2 text-[15px]", i === active ? "bg-aws-info-bg text-aws-link-hover" : "hover:bg-aws-surface-2")}
                >
                  <span className="block font-bold break-all">{r.label}</span>
                  <span className="block text-[13px] text-aws-text-2">{r.detail}</span>
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const options = [
    { id: "light", label: "라이트", icon: Sun },
    { id: "dark", label: "다크", icon: Moon },
    { id: "system", label: "시스템 설정", icon: SunMoon },
  ];
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={navButton} aria-label="화면 테마">
        <SunMoon className="size-[18px]" aria-hidden />
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={8} className={cn(menuContent, "min-w-48")}>
          <Menu_.Label className="px-3 pt-2 pb-1 text-[13px] font-bold text-aws-text-2">화면 테마</Menu_.Label>
          {options.map((o) => (
            <Menu_.Item key={o.id} className={menuItem} onSelect={() => setTheme(o.id)}>
              <o.icon className="size-4" aria-hidden />
              <span className="flex-1">{o.label}</span>
              {theme === o.id && <Check className="size-4 text-aws-link" aria-hidden />}
            </Menu_.Item>
          ))}
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

function SandboxMenu({ name, onExport }: { name: string; onExport: () => void }) {
  const router = useRouter();
  const projectId = useConsoleProjectId();
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={cn(navButton, "max-w-48")} aria-label={`샌드박스: ${name}`}>
        <UserRound className="size-[18px] shrink-0" aria-hidden />
        <span className="hidden truncate md:inline">{name}</span>
        <ChevronDown className="hidden size-4 shrink-0 sm:block" aria-hidden />
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={8} className={cn(menuContent, "w-80")}>
          <div className="space-y-1 px-3 pt-2 pb-2">
            <p className="text-[13px] font-bold text-aws-text-2">샌드박스 (가상 계정)</p>
            <p className="truncate text-[15px] font-bold">{name}</p>
            <p className="text-[13px] text-aws-text-2">리전: 아시아 태평양(서울) ap-northeast-2 · 가상</p>
            <p className="text-[13px] text-aws-text-2">실제 AWS 계정이 아니며 이 브라우저에만 저장됩니다.</p>
          </div>
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
          <Menu_.Item className={menuItem} onSelect={() => router.push(`/projects/${projectId}`)}>
            쉬운 모드(그림 빌더)로 열기
          </Menu_.Item>
          <Menu_.Item className={menuItem} onSelect={() => router.push("/")}>
            샌드박스 목록
          </Menu_.Item>
          <Menu_.Item className={menuItem} onSelect={onExport}>
            JSON으로 내보내기
          </Menu_.Item>
          <Menu_.Item className={menuItem} onSelect={() => router.push("/about")}>
            지원 범위와 가정
          </Menu_.Item>
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}
