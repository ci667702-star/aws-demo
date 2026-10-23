import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingScreen } from "@/components/app/client-gate";
import { ConsoleRoute } from "@/components/console/console-route";

export const metadata: Metadata = {
  title: "콘솔",
};

export default function ConsolePage({ params }: PageProps<"/console/[projectId]">) {
  return (
    <Suspense fallback={<LoadingScreen label="콘솔을 준비하는 중…" />}>
      {params.then(({ projectId }) => (
        <ConsoleRoute projectId={projectId} />
      ))}
    </Suspense>
  );
}
