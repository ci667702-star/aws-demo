"use client";

/**
 * 콘솔에서 현재 샌드박스(프로젝트)와 분석 결과(토폴로지·검증·대상 헬스)를 제공한다.
 */
import { createContext, useCallback, useContext } from "react";
import type { Project } from "@/lib/engine/resource-models";
import type { ActionResult } from "@/lib/project/console-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { errorCode, explainError } from "./error-codes";
import { notify } from "./notify";

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
  /** 성공 시 토스트 제목 */
  success?: (result: Extract<ActionResult, { ok: true }>) => string;
  /** 성공 알림에 붙일 이동 버튼 */
  successAction?: (result: Extract<ActionResult, { ok: true }>) => { label: string; href: string };
  /** 실패를 토스트로 표시 (양식 안에 오류를 표시할 때는 false) */
  flashError?: boolean;
}

/**
 * 콘솔 동작 실행: 프로젝트 스토어에 적용하고(실행 취소 기록 포함) 결과를 토스트로 알린다.
 * eventName은 활동 기록에 남는 API 이름이다 (예: CreateVpc).
 */
export function useRunAction() {
  const projectId = useConsoleProjectId();
  return useCallback(
    (eventName: string, mutate: (project: Project) => ActionResult, options: RunOptions = {}): ActionResult => {
      const result = useProjectStore.getState().apply(projectId, eventName, mutate);
      if (result.ok && options.success) {
        notify({ type: "success", title: options.success(result), notes: result.notes, action: options.successAction?.(result) });
      } else if (!result.ok && options.flashError) {
        const explanation = explainError(result.error);
        const notes = [result.hint ? `해결 방법: ${result.hint}` : null, explanation ? `${errorCode(result.error)} 오류란? ${explanation}` : null].filter((n): n is string => !!n);
        notify({ type: "error", title: "작업을 완료할 수 없습니다", description: result.error, notes });
      }
      return result;
    },
    [projectId],
  );
}
