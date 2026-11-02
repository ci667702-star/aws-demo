"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ClientGate } from "@/components/app/client-gate";
import { useProjectStore } from "@/lib/store/project-store";
import { analyzeProject, AnalysisProvider } from "./analysis-context";
import { ConsoleProjectProvider } from "./console-context";
import { useConsoleUi } from "./console-store";
import { ConsoleShell } from "./shell/console-shell";

export function ConsoleRoute({ projectId }: { projectId: string }) {
  return (
    <ClientGate>
      <ConsoleOrMissing projectId={projectId} />
    </ClientGate>
  );
}

function ConsoleOrMissing({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId]);
  const reset = useConsoleUi((s) => s.reset);
  useEffect(() => reset(projectId), [projectId, reset]);
  const exists = !!project;
  useEffect(() => {
    if (exists) useProjectStore.getState().setPreferredMode(projectId, "console");
  }, [exists, projectId]);
  const analysis = useMemo(() => (project ? analyzeProject(project) : null), [project]);
  if (!project || !analysis) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-aws-page p-8 text-center text-aws-text">
        <h1 className="text-xl font-bold">샌드박스를 찾을 수 없습니다</h1>
        <p className="max-w-md text-sm text-aws-text-2">
          삭제되었거나 다른 브라우저에서 만든 샌드박스일 수 있습니다. 샌드박스는 이 브라우저의 저장소에만 저장됩니다.
        </p>
        <Link href="/" className="text-sm font-bold text-aws-link hover:underline">
          샌드박스 목록으로 돌아가기
        </Link>
      </div>
    );
  }
  return (
    <ConsoleProjectProvider value={projectId}>
      <AnalysisProvider value={analysis}>
        <ConsoleShell />
      </AnalysisProvider>
    </ConsoleProjectProvider>
  );
}
