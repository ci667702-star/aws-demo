"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Download,
  Ellipsis,
  Eye,
  GraduationCap,
  LayoutGrid,
  MonitorCog,
  Loader2,
  PanelLeft,
  PanelRight,
  Redo2,
  ShieldAlert,
  Undo2,
  Upload,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Brand } from "@/components/app/brand";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { labById } from "@/lib/labs/labs";
import { autoLayout, renameProject } from "@/lib/project/mutations";
import { useEditorStore } from "@/lib/store/editor-store";
import { useCanRedo, useCanUndo, useProjectStore } from "@/lib/store/project-store";
import { formatTime } from "@/lib/ui/format";
import { useAnalysis } from "@/components/console/analysis-context";
import { startBuilderTour } from "./builder-tour";

function IconButton({ label, shortcut, onClick, disabled, children }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-1 opacity-70">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function ProjectName({ projectId }: { projectId: string }) {
  const name = useProjectStore((s) => s.projects[projectId]?.name ?? "");
  const apply = useProjectStore((s) => s.apply);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => {
    setEditing(false);
    if (draft.trim() === name) return;
    const r = apply(projectId, "프로젝트 이름 변경", (p) => renameProject(p, draft));
    if (!r.ok) {
      toast.error(r.error);
      setDraft(name);
    }
  };
  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={100}
        aria-label="프로젝트 이름"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        className="h-7 w-48 text-sm font-medium"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      className="max-w-[16rem] truncate rounded px-1 text-sm font-semibold hover:bg-muted"
      title="클릭하여 이름 변경"
      data-testid="project-name"
    >
      {name}
    </button>
  );
}

function SaveIndicator() {
  const status = useProjectStore((s) => s.saveStatus);
  const error = useProjectStore((s) => s.saveError);
  const savedAt = useProjectStore((s) => s.lastSavedAt);
  if (status === "pending") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3 animate-spin" aria-hidden /> 저장 중…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" role="alert" title={error ?? undefined}>
        <CircleAlert className="size-3" aria-hidden /> 저장 실패
      </span>
    );
  }
  if (status === "unavailable") {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600" title="브라우저 저장소를 사용할 수 없습니다.">
        <CloudOff className="size-3" aria-hidden /> 저장 안 됨
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status" data-testid="save-status">
      <CircleCheck className="size-3 text-emerald-600" aria-hidden /> 저장됨{savedAt ? ` ${formatTime(savedAt)}` : ""}
    </span>
  );
}

export function BuilderToolbar({
  projectId,
  onToggleLeft,
  onToggleRight,
  onExport,
  onImport,
}: {
  projectId: string;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
  const labId = useProjectStore((s) => s.projects[projectId]?.labId);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const apply = useProjectStore((s) => s.apply);
  const canUndo = useCanUndo(projectId);
  const canRedo = useCanRedo(projectId);
  const analysis = useAnalysis();
  const setBottomTab = useEditorStore((s) => s.setBottomTab);
  const showZones = useEditorStore((s) => s.showZones);
  const showMembershipEdges = useEditorStore((s) => s.showMembershipEdges);
  const toggleZones = useEditorStore((s) => s.toggleZones);
  const toggleMembershipEdges = useEditorStore((s) => s.toggleMembershipEdges);
  const lab = labById(labId);
  const runAutoLayout = () => {
    const r = apply(projectId, "자동 정렬", (p) => autoLayout(p));
    if (r.ok) toast.success("리소스를 VPC/서브넷 기준으로 정렬했습니다.");
  };

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-2 [&>*]:shrink-0"
      aria-label="빌더 도구 모음"
    >
      <Button asChild variant="ghost" size="icon-sm" aria-label="대시보드로 돌아가기">
        <Link href="/">
          <ArrowLeft />
        </Link>
      </Button>
      <div className="hidden sm:block">
        <Brand compact />
      </div>
      <IconButton label="리소스 팔레트" onClick={onToggleLeft}>
        <PanelLeft />
      </IconButton>
      <div className="flex min-w-24 items-center gap-2">
        <ProjectName projectId={projectId} />
        {lab && (
          <span className="hidden items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 md:flex dark:text-emerald-300">
            <GraduationCap className="size-3" aria-hidden /> Lab {lab.order}
          </span>
        )}
        <span className="hidden md:inline">
          <SaveIndicator />
        </span>
      </div>
      <div className="mx-1 h-5 w-px bg-border" aria-hidden />
      <IconButton label="실행 취소" shortcut="Ctrl+Z" onClick={() => undo(projectId)} disabled={!canUndo}>
        <Undo2 />
      </IconButton>
      <IconButton label="다시 실행" shortcut="Ctrl+Shift+Z" onClick={() => redo(projectId)} disabled={!canRedo}>
        <Redo2 />
      </IconButton>
      <span className="hidden sm:inline-flex">
        <IconButton label="자동 정렬" onClick={runAutoLayout}>
          <LayoutGrid />
        </IconButton>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="보기 옵션" className="hidden sm:inline-flex">
            <Eye />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>캔버스 보기</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={showZones} onCheckedChange={toggleZones}>
            네트워크 영역(VPC/서브넷) 표시
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showMembershipEdges} onCheckedChange={toggleMembershipEdges}>
            소속 관계선 표시
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex items-center gap-1">
        <span className="hidden rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 xl:inline dark:text-amber-300">쉬운 모드</span>
        <Button variant="ghost" size="sm" onClick={startBuilderTour} data-testid="builder-tour">
          <GraduationCap />
          <span className="hidden md:inline">둘러보기</span>
        </Button>
        <Button asChild variant="outline" size="sm" data-testid="open-console-mode">
          <Link href={`/console/${projectId}#/`} title="같은 샌드박스를 AWS 콘솔처럼 직접 설정하는 심화 모드로 전환">
            <MonitorCog />
            <span className="hidden md:inline">심화 모드(콘솔)</span>
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => setBottomTab("validation")} data-testid="open-validation">
          <ShieldAlert />
          <span className="hidden lg:inline">검증</span>
          {analysis.counts.error > 0 && <span className="rounded bg-red-500/15 px-1 text-[11px] text-red-700 dark:text-red-300">{analysis.counts.error}</span>}
          {analysis.counts.warning > 0 && <span className="rounded bg-amber-500/15 px-1 text-[11px] text-amber-800 dark:text-amber-300">{analysis.counts.warning}</span>}
          {analysis.counts.error === 0 && analysis.counts.warning === 0 && <CircleCheck className="text-emerald-600" />}
        </Button>
        <Button size="sm" onClick={() => setBottomTab("simulation")} data-testid="open-simulation">
          <Zap /> <span className="hidden lg:inline">시뮬레이션</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="더 보기">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={runAutoLayout} className="sm:hidden">
              <LayoutGrid /> 자동 정렬
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={showZones} onCheckedChange={toggleZones} className="sm:hidden">
              네트워크 영역 표시
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showMembershipEdges} onCheckedChange={toggleMembershipEdges} className="sm:hidden">
              소속 관계선 표시
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator className="sm:hidden" />
            <DropdownMenuItem onSelect={onExport}>
              <Download /> JSON 내보내기
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onImport}>
              <Upload /> JSON 가져오기 (새 프로젝트)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/about">
                <BookOpen /> 지원 범위와 가정
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="hidden sm:inline-flex">
          <ThemeToggle />
        </span>
        <IconButton label="설정 패널" onClick={onToggleRight}>
          <PanelRight />
        </IconButton>
      </div>
    </header>
  );
}
