"use client";

/**
 * 프로젝트 스토어 (Zustand).
 * - 브라우저 저장소에서 프로젝트를 복원하고 변경 시 자동 저장한다 (디바운스).
 * - 모든 편집은 apply()를 통해 순수 변경 연산(mutations.ts)을 실행하고 Undo/Redo 기록을 남긴다.
 */
import { create } from "zustand";
import type { Project, Viewport } from "@/lib/engine/resource-models";
import { labById } from "@/lib/labs/labs";
import { createEmptyProject } from "@/lib/project/factory";
import {
  duplicateProject as duplicate,
  renameProject as rename,
  setViewport as withViewport,
  type MutationResult,
} from "@/lib/project/mutations";
import { browserStorage, loadProjects, saveProjects, type StorageLike } from "@/lib/project/persistence";
import { createThreeTierSample, SAMPLES } from "@/lib/project/samples";
import { createId } from "@/lib/engine/ids";

export const HISTORY_LIMIT = 100;

interface History {
  past: Project[];
  future: Project[];
}

export type SaveStatus = "saved" | "pending" | "error" | "unavailable";

export interface ActivityEntry {
  id: string;
  at: string;
  projectId: string;
  kind: "edit" | "undo" | "redo" | "error" | "simulation" | "validation" | "system";
  message: string;
}

interface ProjectStoreState {
  status: "idle" | "ready";
  loadErrors: string[];
  projects: Record<string, Project>;
  history: Record<string, History>;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
  activity: ActivityEntry[];

  hydrate: (storage?: StorageLike | null) => void;
  createProject: (name: string, description?: string) => string;
  createFromSample: (sampleId: string) => string | null;
  startLab: (labId: string) => string | null;
  addImportedProject: (project: Project) => string;
  renameProject: (id: string, name: string) => MutationResult;
  duplicateProject: (id: string) => string | null;
  deleteProject: (id: string) => void;
  apply: (projectId: string, label: string, mutate: (project: Project) => MutationResult) => MutationResult;
  setViewport: (projectId: string, viewport: Viewport) => void;
  undo: (projectId: string) => boolean;
  redo: (projectId: string) => boolean;
  log: (entry: Omit<ActivityEntry, "id" | "at">) => void;
  dismissLoadErrors: () => void;
}

let storageRef: StorageLike | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DELAY_MS = 350;

export const useProjectStore = create<ProjectStoreState>()((set, get) => {
  const scheduleSave = () => {
    if (!storageRef) {
      set({ saveStatus: "unavailable" });
      return;
    }
    set({ saveStatus: "pending" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const result = saveProjects(storageRef, Object.values(get().projects));
      if (result.ok) set({ saveStatus: "saved", saveError: null, lastSavedAt: new Date().toISOString() });
      else set({ saveStatus: "error", saveError: result.error });
    }, SAVE_DELAY_MS);
  };

  const putProject = (project: Project) => {
    set((s) => ({ projects: { ...s.projects, [project.id]: project } }));
    scheduleSave();
    return project.id;
  };

  const uniqueProject = (project: Project): Project => {
    if (!get().projects[project.id]) return project;
    return { ...project, id: createId("proj") };
  };

  return {
    status: "idle",
    loadErrors: [],
    projects: {},
    history: {},
    saveStatus: "saved",
    saveError: null,
    lastSavedAt: null,
    activity: [],

    hydrate: (storage) => {
      if (get().status === "ready") return;
      storageRef = storage === undefined ? browserStorage() : storage;
      const result = loadProjects(storageRef);
      const projects: Record<string, Project> = {};
      for (const p of result.projects) projects[p.id] = p;
      let seeded = false;
      if (result.firstRun && storageRef) {
        const example = createThreeTierSample();
        projects[example.id] = example;
        seeded = true;
      }
      set({
        status: "ready",
        projects,
        loadErrors: result.errors,
        saveStatus: storageRef ? "saved" : "unavailable",
      });
      if (seeded) scheduleSave();
    },

    createProject: (name, description = "") => putProject(createEmptyProject(name, { description })),

    createFromSample: (sampleId) => {
      const sample = SAMPLES.find((s) => s.id === sampleId);
      if (!sample) return null;
      return putProject(uniqueProject(sample.create()));
    },

    startLab: (labId) => {
      const lab = labById(labId);
      if (!lab) return null;
      return putProject(uniqueProject(lab.createStarter()));
    },

    addImportedProject: (project) => {
      const now = new Date().toISOString();
      return putProject({ ...uniqueProject(project), updatedAt: now });
    },

    renameProject: (id, name) => {
      const project = get().projects[id];
      if (!project) return { ok: false, error: "프로젝트를 찾을 수 없습니다." };
      const result = rename(project, name);
      if (result.ok) putProject(result.project);
      return result;
    },

    duplicateProject: (id) => {
      const project = get().projects[id];
      if (!project) return null;
      return putProject(duplicate(project));
    },

    deleteProject: (id) => {
      set((s) => {
        const projects = { ...s.projects };
        const history = { ...s.history };
        delete projects[id];
        delete history[id];
        return { projects, history };
      });
      scheduleSave();
    },

    apply: (projectId, label, mutate) => {
      const current = get().projects[projectId];
      if (!current) return { ok: false, error: "프로젝트를 찾을 수 없습니다." };
      let result: MutationResult;
      try {
        result = mutate(current);
      } catch (e) {
        result = { ok: false, error: `변경을 적용하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!result.ok) {
        get().log({ projectId, kind: "error", message: `${label} 실패: ${result.error}` });
        return result;
      }
      if (result.project === current) return result;
      set((s) => {
        const h = s.history[projectId] ?? { past: [], future: [] };
        return {
          projects: { ...s.projects, [projectId]: result.project },
          history: {
            ...s.history,
            [projectId]: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: [] },
          },
        };
      });
      get().log({ projectId, kind: "edit", message: [label, ...result.notes].join(" — ") });
      scheduleSave();
      return result;
    },

    setViewport: (projectId, viewport) => {
      const current = get().projects[projectId];
      if (!current) return;
      const v = current.viewport;
      if (v && Math.abs(v.x - viewport.x) < 0.5 && Math.abs(v.y - viewport.y) < 0.5 && Math.abs(v.zoom - viewport.zoom) < 0.001) return;
      set((s) => ({ projects: { ...s.projects, [projectId]: withViewport(current, viewport) } }));
      scheduleSave();
    },

    undo: (projectId) => {
      const h = get().history[projectId];
      const current = get().projects[projectId];
      if (!h?.past.length || !current) return false;
      const previous = h.past[h.past.length - 1];
      set((s) => ({
        projects: { ...s.projects, [projectId]: { ...previous, viewport: current.viewport } },
        history: { ...s.history, [projectId]: { past: h.past.slice(0, -1), future: [current, ...h.future] } },
      }));
      get().log({ projectId, kind: "undo", message: "실행 취소" });
      scheduleSave();
      return true;
    },

    redo: (projectId) => {
      const h = get().history[projectId];
      const current = get().projects[projectId];
      if (!h?.future.length || !current) return false;
      const next = h.future[0];
      set((s) => ({
        projects: { ...s.projects, [projectId]: { ...next, viewport: current.viewport } },
        history: { ...s.history, [projectId]: { past: [...h.past, current], future: h.future.slice(1) } },
      }));
      get().log({ projectId, kind: "redo", message: "다시 실행" });
      scheduleSave();
      return true;
    },

    log: (entry) => {
      set((s) => ({
        activity: [{ ...entry, id: createId("log"), at: new Date().toISOString() }, ...s.activity].slice(0, 200),
      }));
    },

    dismissLoadErrors: () => set({ loadErrors: [] }),
  };
});

/** 테스트용: 스토어를 초기 상태로 되돌린다. */
export function resetProjectStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  storageRef = null;
  useProjectStore.setState({
    status: "idle",
    loadErrors: [],
    projects: {},
    history: {},
    saveStatus: "saved",
    saveError: null,
    lastSavedAt: null,
    activity: [],
  });
}

/** 저장 대기 중인 변경을 즉시 저장한다 (페이지 이탈 시). */
export function flushPendingSave() {
  if (!saveTimer || !storageRef) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const result = saveProjects(storageRef, Object.values(useProjectStore.getState().projects));
  useProjectStore.setState(
    result.ok
      ? { saveStatus: "saved", saveError: null, lastSavedAt: new Date().toISOString() }
      : { saveStatus: "error", saveError: result.error },
  );
}

export function useCanUndo(projectId: string) {
  return useProjectStore((s) => (s.history[projectId]?.past.length ?? 0) > 0);
}

export function useCanRedo(projectId: string) {
  return useProjectStore((s) => (s.history[projectId]?.future.length ?? 0) > 0);
}
