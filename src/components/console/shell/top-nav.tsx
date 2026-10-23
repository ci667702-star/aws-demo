"use client";

import { Check, ChevronDown, Cloud, Grid3x3, Menu, Moon, Redo2, Search, Sun, SunMoon, Undo2, UserRound } from "lucide-react";
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
import { SERVICES, TOOLS } from "./navigation";

const menuContent = "z-50 min-w-64 rounded-lg border border-aws-border bg-aws-surface p-1 text-aws-text shadow-xl";
const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-aws-info-bg data-[highlighted]:text-aws-link-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-aws-text-3";
const navButton =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-aws-nav-fg hover:bg-aws-nav-hover focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-aws-focus disabled:cursor-not-allowed disabled:text-aws-nav-muted/50 disabled:hover:bg-transparent";

export function TopNav({ showNavToggle }: { showNavToggle: boolean }) {
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
    <header className="sticky top-0 z-40 flex h-11 shrink-0 items-center gap-1 bg-aws-nav px-2 text-aws-nav-fg sm:gap-2 sm:px-3" data-testid="console-top-nav">
      {showNavToggle && (
        <button type="button" className={navButton} onClick={() => setNavOpen(!navOpen)} aria-label={navOpen ? "탐색 창 닫기" : "탐색 창 열기"} aria-expanded={navOpen}>
          <Menu className="size-4" aria-hidden />
        </button>
      )}
      <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-aws-nav-hover" title="샌드박스 목록으로">
        <span className="inline-flex size-6 items-center justify-center rounded bg-gradient-to-br from-sky-400 to-indigo-500 text-white">
          <Cloud className="size-3.5" aria-hidden />
        </span>
        <span className="hidden flex-col leading-none md:flex">
          <span className="text-[13px] font-bold">AWS Playground</span>
          <span className="text-[10px] text-aws-nav-muted">비공식 학습용 · 가상 환경</span>
        </span>
      </Link>
      <ServicesMenu />
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
        <button type="button" className={navButton} onClick={undo} disabled={!canUndo} aria-label="실행 취소" title="실행 취소 (Ctrl+Z)">
          <Undo2 className="size-4" aria-hidden />
        </button>
        <button type="button" className={navButton} onClick={redo} disabled={!canRedo} aria-label="다시 실행" title="다시 실행 (Ctrl+Y)">
          <Redo2 className="size-4" aria-hidden />
        </button>
        <span
          className={cn("hidden px-1 text-xs lg:inline", saveStatus === "error" ? "text-[#ff8f8f]" : "text-aws-nav-muted")}
          role="status"
          title={saveStatus === "unavailable" ? "브라우저 저장소를 사용할 수 없어 새로고침하면 변경 사항이 사라집니다." : "이 브라우저의 저장소에 자동 저장"}
          data-testid="save-status"
        >
          {saveLabel}
        </span>
        <button
          type="button"
          className={cn(navButton, toolsOpen && "bg-aws-nav-hover")}
          onClick={() => setToolsOpen(!toolsOpen)}
          aria-pressed={toolsOpen}
          aria-label="도움말 및 실습 패널"
          title="도움말 및 실습 패널"
        >
          <span className="text-sm font-bold">?</span>
          <span className="hidden text-xs xl:inline">도움말·실습</span>
        </button>
        <ThemeMenu />
        <RegionMenu />
        <SandboxMenu name={project.name} onExport={() => downloadTextFile(exportFileName(project), exportProjectJson(project))} />
      </div>
    </header>
  );
}

function ServicesMenu() {
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={navButton} aria-label="서비스 메뉴">
        <Grid3x3 className="size-4" aria-hidden />
        <span className="hidden sm:inline">서비스</span>
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="start" sideOffset={6} className={cn(menuContent, "w-[min(92vw,26rem)]")}>
          <Menu_.Label className="px-3 pt-2 pb-1 text-xs font-bold text-aws-text-2">서비스 (가상)</Menu_.Label>
          {SERVICES.map((s) => (
            <Menu_.Item key={s.id} className={cn(menuItem, "items-start")} onSelect={() => navigate(s.root)}>
              <s.icon className="mt-0.5 size-4 shrink-0 text-aws-text-2" aria-hidden />
              <span>
                <span className="block font-bold">{s.name}</span>
                <span className="block text-xs text-aws-text-2">{s.description}</span>
              </span>
            </Menu_.Item>
          ))}
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
          <Menu_.Label className="px-3 pt-1 pb-1 text-xs font-bold text-aws-text-2">도구</Menu_.Label>
          {TOOLS.map((t) => (
            <Menu_.Item key={t.id} className={cn(menuItem, "items-start")} onSelect={() => navigate(t.path)}>
              <t.icon className="mt-0.5 size-4 shrink-0 text-aws-text-2" aria-hidden />
              <span>
                <span className="block font-bold">{t.name}</span>
                <span className="block text-xs text-aws-text-2">{t.description}</span>
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
  const { topology } = useAnalysis();
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
    const services: SearchResult[] = [
      ...SERVICES.map((s) => ({ key: s.id, label: s.name, detail: `서비스 · ${s.description}`, href: href(s.root) })),
      ...TOOLS.map((t) => ({ key: t.id, label: t.name, detail: `도구 · ${t.description}`, href: href(t.path) })),
    ].filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q));
    const resources: SearchResult[] = topology.project.resources
      .filter((r) => `${r.id} ${r.name} ${RESOURCE_TYPE_INFO[r.type].label}`.toLowerCase().includes(q))
      .slice(0, 12)
      .map((r) => ({
        key: r.id,
        label: r.name?.trim() ? `${displayName(r)} (${r.id})` : r.id,
        detail: RESOURCE_TYPE_INFO[r.type].label,
        href: resourceHref(r.type, r.id),
      }));
    return [...services, ...resources];
  }, [query, topology]);

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
      className="relative max-w-md min-w-0 flex-1"
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-aws-nav-muted" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="console-search-results"
        aria-label="서비스와 리소스 검색"
        placeholder="검색 [Alt+S]"
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
        className="h-8 w-full rounded-lg border border-aws-nav-muted/40 bg-[#0f141a] pr-2 pl-8 text-sm text-white placeholder:text-aws-nav-muted focus:border-aws-focus focus:outline-2 focus:outline-aws-focus [&::-webkit-search-cancel-button]:hidden"
      />
      {open && query.trim() && (
        <ul
          id="console-search-results"
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-aws-border bg-aws-surface p-1 text-aws-text shadow-xl sm:min-w-96"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-aws-text-2">&quot;{query}&quot;와(과) 일치하는 서비스나 리소스가 없습니다.</li>
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
                  className={cn("block rounded-md px-3 py-1.5 text-sm", i === active ? "bg-aws-info-bg text-aws-link-hover" : "hover:bg-aws-surface-2")}
                >
                  <span className="block font-bold break-all">{r.label}</span>
                  <span className="block text-xs text-aws-text-2">{r.detail}</span>
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
        <SunMoon className="size-4" aria-hidden />
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={6} className={cn(menuContent, "min-w-44")}>
          <Menu_.Label className="px-3 pt-2 pb-1 text-xs font-bold text-aws-text-2">화면 테마</Menu_.Label>
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

function RegionMenu() {
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={navButton} aria-label="리전: 아시아 태평양(서울) 가상 리전">
        <span className="hidden sm:inline">서울</span>
        <span className="text-[11px] text-aws-nav-muted sm:hidden">ap-ne-2</span>
        <ChevronDown className="size-3.5" aria-hidden />
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={6} className={cn(menuContent, "w-72")}>
          <Menu_.Item className={menuItem} onSelect={() => undefined}>
            <span className="flex-1">
              <span className="block font-bold">아시아 태평양(서울)</span>
              <span className="block text-xs text-aws-text-2">ap-northeast-2 · 가상 리전</span>
            </span>
            <Check className="size-4 text-aws-link" aria-hidden />
          </Menu_.Item>
          <p className="px-3 py-2 text-xs text-aws-text-2">이 시뮬레이터는 가상 리전 하나만 제공합니다. 가용 영역은 ap-northeast-2a ~ 2d입니다.</p>
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

function SandboxMenu({ name, onExport }: { name: string; onExport: () => void }) {
  const router = useRouter();
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger className={cn(navButton, "max-w-44")} aria-label={`샌드박스: ${name}`}>
        <UserRound className="size-4 shrink-0" aria-hidden />
        <span className="hidden truncate md:inline">{name}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={6} className={cn(menuContent, "w-72")}>
          <div className="px-3 pt-2 pb-2">
            <p className="text-xs font-bold text-aws-text-2">샌드박스 (가상 계정)</p>
            <p className="truncate text-sm font-bold">{name}</p>
            <p className="mt-1 text-xs text-aws-text-2">실제 AWS 계정이 아니며 이 브라우저에만 저장됩니다.</p>
          </div>
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
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
