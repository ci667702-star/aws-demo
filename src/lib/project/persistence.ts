/**
 * 브라우저 저장소(localStorage) 영속화.
 * 불러올 때 모든 프로젝트를 스키마와 무결성으로 검사하고, 손상된 데이터는 덮어쓰기 전에 백업 키로 보존한다.
 */
import { projectSchema, type Project } from "@/lib/engine/resource-models";
import { checkProjectIntegrity } from "./integrity";

export const STORAGE_KEY = "aws-playground:projects:v1";
export const STORAGE_VERSION = 1;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LoadResult {
  projects: Project[];
  /** 저장된 데이터가 전혀 없었는지 (첫 방문) */
  firstRun: boolean;
  errors: string[];
}

function backup(storage: StorageLike, raw: string): string | null {
  const key = `${STORAGE_KEY}:backup:${Date.now()}`;
  try {
    storage.setItem(key, raw);
    return key;
  } catch {
    return null;
  }
}

export function loadProjects(storage: StorageLike | null): LoadResult {
  if (!storage) return { projects: [], firstRun: true, errors: ["브라우저 저장소를 사용할 수 없습니다. 변경 사항이 저장되지 않습니다."] };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (e) {
    return { projects: [], firstRun: false, errors: [`저장소를 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (raw === null) return { projects: [], firstRun: true, errors: [] };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    const key = backup(storage, raw);
    return {
      projects: [],
      firstRun: false,
      errors: [`저장된 데이터가 손상되어 불러오지 못했습니다.${key ? ` 원본은 "${key}"에 백업했습니다.` : ""}`],
    };
  }
  const list =
    data && typeof data === "object" && Array.isArray((data as { projects?: unknown }).projects)
      ? (data as { projects: unknown[] }).projects
      : null;
  if (!list) {
    const key = backup(storage, raw);
    return { projects: [], firstRun: false, errors: [`저장 형식을 인식할 수 없습니다.${key ? ` 원본은 "${key}"에 백업했습니다.` : ""}`] };
  }

  const projects: Project[] = [];
  const errors: string[] = [];
  let needsBackup = false;
  list.forEach((item, i) => {
    const parsed = projectSchema.safeParse(item);
    if (!parsed.success) {
      needsBackup = true;
      errors.push(`저장된 프로젝트 #${i + 1}의 형식이 올바르지 않아 제외했습니다.`);
      return;
    }
    const issues = checkProjectIntegrity(parsed.data);
    if (issues.length) {
      needsBackup = true;
      errors.push(`프로젝트 "${parsed.data.name}"에 잘못된 리소스 참조가 있어 제외했습니다: ${issues[0].message}`);
      return;
    }
    projects.push(parsed.data);
  });
  if (needsBackup) {
    const key = backup(storage, raw);
    if (key) errors.push(`원본 데이터는 "${key}"에 백업했습니다.`);
  }
  return { projects, firstRun: false, errors };
}

export type SaveResult = { ok: true } | { ok: false; error: string };

export function saveProjects(storage: StorageLike | null, projects: Project[]): SaveResult {
  if (!storage) return { ok: false, error: "브라우저 저장소를 사용할 수 없습니다." };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, savedAt: new Date().toISOString(), projects }));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22);
    return {
      ok: false,
      error: quota
        ? "브라우저 저장 공간이 부족해 저장하지 못했습니다. 사용하지 않는 프로젝트를 삭제하거나 JSON으로 내보내세요."
        : `저장에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probe = "aws-playground:probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
