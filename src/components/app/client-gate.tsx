"use client";

import { Loader2 } from "lucide-react";
import { useProjectStore } from "@/lib/store/project-store";

/** 브라우저 저장소에서 프로젝트를 복원할 때까지 자식을 렌더링하지 않는다. */
export function ClientGate({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const ready = useProjectStore((s) => s.status === "ready");
  if (!ready) return <>{fallback ?? <LoadingScreen />}</>;
  return <>{children}</>;
}

export function LoadingScreen({ label = "프로젝트를 불러오는 중…" }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
