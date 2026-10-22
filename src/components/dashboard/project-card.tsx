"use client";

import Link from "next/link";
import { Copy, Download, Ellipsis, GraduationCap, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResourceIcon } from "@/components/resource-visuals";
import { RESOURCE_TYPES, type Project } from "@/lib/engine/resource-models";
import { labById } from "@/lib/labs/labs";
import { formatDateTime, formatRelativeTime } from "@/lib/ui/format";

export function ProjectCard({
  project,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
}: {
  project: Project;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const lab = labById(project.labId);
  const counts = RESOURCE_TYPES.map((t) => [t, project.resources.filter((r) => r.type === t).length] as const).filter(
    ([, n]) => n > 0,
  );
  return (
    <article
      className="group relative flex flex-col rounded-xl border bg-card p-4 transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring/40"
      data-testid="project-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium">
            <Link href={`/projects/${project.id}`} className="outline-none after:absolute after:inset-0 after:content-['']">
              {project.name}
            </Link>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(project.updatedAt)}>
            마지막 수정 {formatRelativeTime(project.updatedAt)} · 리소스 {project.resources.length}개
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative z-10" aria-label={`${project.name} 작업 메뉴`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRename}>
              <Pencil /> 이름 변경
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy /> 복제
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport}>
              <Download /> JSON 내보내기
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> 삭제
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {project.description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        {lab && (
          <Badge variant="secondary" className="gap-1">
            <GraduationCap className="size-3" aria-hidden /> Lab {lab.order}
          </Badge>
        )}
        {counts.slice(0, 6).map(([type, n]) => (
          <span key={type} className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${type} ${n}개`}>
            <ResourceIcon type={type} size="sm" /> {n}
          </span>
        ))}
        {counts.length === 0 && <span className="text-xs text-muted-foreground">빈 캔버스</span>}
      </div>
    </article>
  );
}
