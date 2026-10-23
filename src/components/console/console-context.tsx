"use client";

/**
 * 콘솔에서 현재 샌드박스(프로젝트)와 분석 결과(토폴로지·검증·대상 헬스)를 제공한다.
 */
import { createContext, useCallback, useContext } from "react";
import type { Project } from "@/lib/engine/resource-models";
import type { ActionResult } from "@/lib/project/console-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { useConsoleUi } from "./console-store";

const ProjectIdContext = createContext<string | null>(null);

export const ConsoleProjectProvider = ProjectIdContext.Provider;

export function useConsoleProjectId(): string {
  const id = useContext(ProjectIdContext);
  if (!id) throw new Error("콘솔 프로젝트 컨텍스트가 없습니다.");
  return id;
}

export function useProject(): Project {
  const id = useConsoleProjectId();
  const project = useProjectStore((s) => s.projects[id]);
  if (!project) throw new Error("샌드박스를 찾을 수 없습니다.");
  return project;
}

export interface RunOptions {
  /** 성공 시 알림 표시줄에 보여줄 메시지 */
  success?: (result: Extract<ActionResult, { ok: true }>) => string;
  /** 성공 알림에 붙일 이동 버튼 */
  successAction?: (result: Extract<ActionResult, { ok: true }>) => { label: string; href: string };
  /** 실패를 알림 표시줄에 표시 (양식 안에 표시할 때는 false) */
  flashError?: boolean;
}

/**
 * 콘솔 동작 실행: 프로젝트 스토어에 적용하고(실행 취소 기록 포함) 결과를 알림 표시줄로 알린다.
 * eventName은 활동 기록에 남는 API 이름이다 (예: CreateVpc).
 */
export function useRunAction() {
  const projectId = useConsoleProjectId();
  return useCallback(
    (eventName: string, mutate: (project: Project) => ActionResult, options: RunOptions = {}): ActionResult => {
      const result = useProjectStore.getState().apply(projectId, eventName, mutate);
      const ui = useConsoleUi.getState();
      if (result.ok && options.success) {
        ui.pushFlash({
          type: "success",
          content: options.success(result),
          notes: result.notes.length ? result.notes : undefined,
          action: options.successAction?.(result),
        });
      } else if (!result.ok && options.flashError) {
        ui.pushFlash({ type: "error", header: `${eventName} 실패`, content: result.error, notes: result.hint ? [result.hint] : undefined });
      }
      return result;
    },
    [projectId],
  );
}
