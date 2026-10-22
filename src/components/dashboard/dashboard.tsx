"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BookOpen,
  CircleCheck,
  FileJson,
  FlaskConical,
  GraduationCap,
  LayoutGrid,
  Plus,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { Brand, DISCLAIMER } from "@/components/app/brand";
import { ClientGate } from "@/components/app/client-gate";
import { ImportDialog } from "@/components/app/import-dialog";
import { TextPromptDialog } from "@/components/app/text-prompt-dialog";
import { ThemeToggle } from "@/components/app/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLabContext, evaluateLab, LABS } from "@/lib/labs/labs";
import type { Project } from "@/lib/engine/resource-models";
import { SAMPLES } from "@/lib/project/samples";
import { exportFileName, exportProjectJson } from "@/lib/project/serialization";
import { useProjectStore } from "@/lib/store/project-store";
import { downloadTextFile } from "@/lib/ui/download";
import { ProjectCard } from "./project-card";

export function Dashboard() {
  return (
    <div className="flex min-h-full flex-col bg-muted/30">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
        <Brand />
        <nav className="flex items-center gap-1" aria-label="주 메뉴">
          <Button asChild variant="ghost" size="sm">
            <Link href="/about">
              <BookOpen /> <span className="hidden sm:inline">지원 범위</span>
            </Link>
          </Button>
          <ThemeToggle />
        </nav>
      </header>
      <ClientGate>
        <DashboardContent />
      </ClientGate>
      <footer className="border-t bg-background px-4 py-4 text-center text-xs text-muted-foreground">{DISCLAIMER}</footer>
    </div>
  );
}

type SortKey = "updated" | "name";

function DashboardContent() {
  const router = useRouter();
  const projectsMap = useProjectStore((s) => s.projects);
  const loadErrors = useProjectStore((s) => s.loadErrors);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const saveError = useProjectStore((s) => s.saveError);
  const dismissLoadErrors = useProjectStore((s) => s.dismissLoadErrors);
  const store = useProjectStore.getState;

  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");

  const projects = useMemo(
    () => Object.values(projectsMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projectsMap],
  );
  const recent = projects.slice(0, 3);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      : projects;
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name, "ko")) : list;
  }, [projects, query, sort]);

  const labProgress = useMemo(() => {
    const map = new Map<string, { projectId: string; done: number; total: number; completed: boolean }>();
    for (const lab of LABS) {
      const project = projects.find((p) => p.labId === lab.id);
      if (!project) continue;
      const progress = evaluateLab(lab, createLabContext(project));
      map.set(lab.id, {
        projectId: project.id,
        done: progress.completedCount,
        total: lab.steps.length,
        completed: progress.completed,
      });
    }
    return map;
  }, [projects]);

  const open = (id: string | null) => {
    if (id) router.push(`/projects/${id}`);
  };

  const exportProject = (p: Project) => {
    downloadTextFile(exportFileName(p), exportProjectJson(p));
    toast.success(`"${p.name}"을(를) JSON으로 내보냈습니다.`);
  };

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-10 px-4 py-8">
      {loadErrors.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <div className="flex-1 space-y-1">
            <p className="font-medium">저장된 데이터 일부를 불러오지 못했습니다.</p>
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {loadErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={dismissLoadErrors} aria-label="알림 닫기">
            <X />
          </Button>
        </div>
      )}
      {saveStatus === "error" && saveError && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {saveError}
        </div>
      )}
      {saveStatus === "unavailable" && (
        <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          브라우저 저장소를 사용할 수 없어 변경 사항이 저장되지 않습니다. (비공개 창 또는 저장소 차단 설정을 확인하세요.)
        </div>
      )}

      <section className="flex flex-col gap-6 rounded-2xl border bg-card p-6 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl space-y-2">
          <Badge variant="outline" className="gap-1">
            <FlaskConical className="size-3" aria-hidden /> 실제 AWS 리소스를 만들지 않는 가상 실습
          </Badge>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">클라우드 인프라를 설계하고, 깨뜨리고, 고쳐 보세요</h1>
          <p className="text-sm text-muted-foreground">
            VPC·서브넷·라우팅·보안 그룹·NACL·ALB·RDS를 캔버스에 배치하면 설정값을 바탕으로 검증과 통신 시뮬레이션이 실행됩니다.
            계정 연결, 자격 증명, 요금이 필요하지 않습니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> 새 프로젝트
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <FileJson /> JSON 가져오기
          </Button>
        </div>
      </section>

      {recent.length > 0 && (
        <section aria-labelledby="recent-heading" className="space-y-3">
          <h2 id="recent-heading" className="text-sm font-semibold text-muted-foreground">
            최근 작업
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onRename={() => setRenameTarget(p)}
                onDuplicate={() => {
                  store().duplicateProject(p.id);
                  toast.success(`"${p.name}"을(를) 복제했습니다.`);
                }}
                onExport={() => exportProject(p)}
                onDelete={() => setDeleteTarget(p)}
              />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="projects-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="projects-heading" className="flex items-center gap-2 font-semibold">
            <LayoutGrid className="size-4" aria-hidden /> 내 프로젝트
            <Badge variant="secondary">{projects.length}</Badge>
          </h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="프로젝트 검색"
                aria-label="프로젝트 검색"
                className="h-8 w-44 pl-7"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="정렬"
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
            >
              <option value="updated">최근 수정순</option>
              <option value="name">이름순</option>
            </select>
          </div>
        </div>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-10 text-center">
            <p className="font-medium">아직 프로젝트가 없습니다</p>
            <p className="mt-1 text-sm text-muted-foreground">빈 프로젝트를 만들거나 아래의 샘플·실습으로 시작해 보세요.</p>
            <Button className="mt-4" onClick={() => setNewOpen(true)}>
              <Plus /> 새 프로젝트
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            &quot;{query}&quot;와(과) 일치하는 프로젝트가 없습니다.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onRename={() => setRenameTarget(p)}
                onDuplicate={() => {
                  store().duplicateProject(p.id);
                  toast.success(`"${p.name}"을(를) 복제했습니다.`);
                }}
                onExport={() => exportProject(p)}
                onDelete={() => setDeleteTarget(p)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="labs-heading" className="space-y-3">
        <h2 id="labs-heading" className="flex items-center gap-2 font-semibold">
          <GraduationCap className="size-4" aria-hidden /> Guided Labs
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {LABS.map((lab) => {
            const progress = labProgress.get(lab.id);
            return (
              <article key={lab.id} className="flex flex-col rounded-xl border bg-card p-4" data-testid="lab-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Lab {lab.order} · {lab.level}
                  </span>
                  {progress &&
                    (progress.completed ? (
                      <Badge className="gap-1 bg-emerald-600 text-white">
                        <CircleCheck className="size-3" aria-hidden /> 완료
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {progress.done}/{progress.total} 단계
                      </Badge>
                    ))}
                </div>
                <h3 className="mt-1 font-medium">{lab.title}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{lab.summary}</p>
                <div className="mt-3 flex gap-2">
                  {progress ? (
                    <>
                      <Button size="sm" onClick={() => open(progress.projectId)}>
                        이어하기
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => open(store().startLab(lab.id))}>
                        처음부터
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => open(store().startLab(lab.id))}>
                      실습 시작
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="samples-heading" className="space-y-3">
        <h2 id="samples-heading" className="font-semibold">
          샘플 아키텍처
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {SAMPLES.map((sample) => (
            <article key={sample.id} className="flex flex-col rounded-xl border bg-card p-4">
              <h3 className="font-medium">{sample.title}</h3>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{sample.description}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 self-start"
                onClick={() => {
                  const id = store().createFromSample(sample.id);
                  if (id) toast.success(`샘플 "${sample.title}"을(를) 새 프로젝트로 불러왔습니다.`);
                  open(id);
                }}
              >
                불러오기
              </Button>
            </article>
          ))}
        </div>
      </section>

      <TextPromptDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        title="새 아키텍처 프로젝트"
        description="빈 캔버스로 시작합니다. 프로젝트는 이 브라우저에 저장됩니다."
        submitLabel="만들기"
        initialName="새 프로젝트"
        withDescription
        onSubmit={({ name, description }) => {
          const id = store().createProject(name, description);
          setNewOpen(false);
          open(id);
        }}
      />
      <TextPromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="프로젝트 이름 변경"
        submitLabel="변경"
        initialName={renameTarget?.name ?? ""}
        onSubmit={({ name }) => {
          if (!renameTarget) return;
          const r = store().renameProject(renameTarget.id, name);
          if (!r.ok) return r.error;
          toast.success("이름을 변경했습니다.");
          setRenameTarget(null);
        }}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={(project) => {
          const id = store().addImportedProject(project);
          toast.success(`"${project.name}"을(를) 가져왔습니다.`);
          open(id);
        }}
      />
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>프로젝트를 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.name}&quot;이(가) 이 브라우저에서 삭제됩니다. 필요하면 먼저 JSON으로 내보내세요. 이 작업은 되돌릴 수 없습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                store().deleteProject(deleteTarget.id);
                toast.success(`"${deleteTarget.name}"을(를) 삭제했습니다.`);
                setDeleteTarget(null);
              }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
