"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ClientGate } from "@/components/app/client-gate";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/lib/store/project-store";
import { Builder } from "./builder";

export function BuilderRoute({ projectId }: { projectId: string }) {
  return (
    <ClientGate>
      <BuilderOrMissing projectId={projectId} />
    </ClientGate>
  );
}

function BuilderOrMissing({ projectId }: { projectId: string }) {
  const exists = useProjectStore((s) => !!s.projects[projectId]);
  if (!exists) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold">프로젝트를 찾을 수 없습니다</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          삭제되었거나 다른 브라우저에서 만든 프로젝트일 수 있습니다. 프로젝트는 이 브라우저의 저장소에만 저장됩니다.
        </p>
        <Button asChild variant="outline">
          <Link href="/">
            <ArrowLeft /> 대시보드로 돌아가기
          </Link>
        </Button>
      </div>
    );
  }
  return <Builder projectId={projectId} />;
}
