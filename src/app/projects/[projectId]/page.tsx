import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingScreen } from "@/components/app/client-gate";
import { BuilderRoute } from "@/components/builder/builder-route";

export const metadata: Metadata = {
  title: "아키텍처 빌더",
};

export default function ProjectPage({ params }: PageProps<"/projects/[projectId]">) {
  return (
    <Suspense fallback={<LoadingScreen label="빌더를 준비하는 중…" />}>
      {params.then(({ projectId }) => (
        <BuilderRoute projectId={projectId} />
      ))}
    </Suspense>
  );
}
