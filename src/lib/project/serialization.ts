/**
 * 프로젝트 JSON 내보내기/가져오기.
 * 가져오기는 JSON 문법 → Zod 스키마 → 구조 무결성(리소스 참조) 순으로 검사하며,
 * 하나라도 실패하면 아무것도 바꾸지 않고 오류 목록만 반환한다.
 */
import { projectSchema, type Project } from "@/lib/engine/resource-models";
import { checkProjectIntegrity } from "./integrity";

export const EXPORT_FORMAT = "aws-playground-project";
export const EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function exportProjectJson(project: Project): string {
  return JSON.stringify(
    { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), project },
    null,
    2,
  );
}

export function exportFileName(project: Project): string {
  const safe = project.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "project";
  return `${safe}.aws-playground.json`;
}

export type ImportResult = { ok: true; project: Project } | { ok: false; errors: string[] };

export function parseProjectJson(text: string): ImportResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["파일이 비어 있습니다."] };
  if (text.length > MAX_IMPORT_BYTES) {
    return { ok: false, errors: [`파일이 너무 큽니다. (최대 ${MAX_IMPORT_BYTES / 1024 / 1024}MB)`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON 형식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`] };
  }
  let candidate: unknown = data;
  if (data && typeof data === "object" && "format" in data) {
    const wrapper = data as { format?: unknown; project?: unknown };
    if (wrapper.format !== EXPORT_FORMAT) {
      return { ok: false, errors: [`지원하지 않는 파일 형식입니다: "${String(wrapper.format)}"`] };
    }
    candidate = wrapper.project;
  }
  const parsed = projectSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 15).map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(최상위)";
      return `${path}: ${issue.message}`;
    });
    if (parsed.error.issues.length > 15) errors.push(`... 외 ${parsed.error.issues.length - 15}개 오류`);
    return { ok: false, errors: ["프로젝트 스키마 검증에 실패했습니다.", ...errors] };
  }
  const integrity = checkProjectIntegrity(parsed.data);
  if (integrity.length) {
    return {
      ok: false,
      errors: ["리소스 참조 검증에 실패했습니다.", ...integrity.slice(0, 15).map((i) => `${i.path}: ${i.message}`)],
    };
  }
  return { ok: true, project: parsed.data };
}
