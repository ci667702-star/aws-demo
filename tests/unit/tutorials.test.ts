import { describe, expect, it } from "vitest";
import { resumeStepIndex, tutorialById, tutorialProgress, type TutorialContext } from "@/components/console/tutorial/tutorials";
import { buildTopology } from "@/lib/engine/topology-engine";
import type { Project } from "@/lib/engine/resource-models";
import { createEmptyProject } from "@/lib/project/factory";
import * as s3 from "@/lib/project/s3-actions";

const ctxOf = (project: Project): TutorialContext => ({ project, topo: buildTopology(project) });

describe("튜토리얼 이어서 하기", () => {
  const tutorial = tutorialById("s3-static-site")!;

  it("아무것도 하지 않았으면 처음부터 시작한다", () => {
    const ctx = ctxOf(createEmptyProject("빈 샌드박스"));
    expect(tutorialProgress(tutorial, ctx).done).toBe(0);
    expect(resumeStepIndex(tutorial, ctx)).toBe(0);
  });

  it("일부를 마쳤으면 아직 완료하지 않은 첫 판정 단계부터 시작한다 (완료한 단계를 다시 누르지 않아도 된다)", () => {
    const created = s3.createBucket(createEmptyProject("버킷 있음"), {
      name: "resume-site-2026",
      blockPublicAccess: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
      versioning: "Disabled",
      encryption: "SSE-S3",
    });
    if (!created.ok) throw new Error(created.error);
    const ctx = ctxOf(created.project);
    expect(tutorialProgress(tutorial, ctx).done).toBe(1);
    const index = resumeStepIndex(tutorial, ctx);
    expect(tutorial.steps[index].id).toBe("upload");
  });
});
