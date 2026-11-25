/**
 * 콘솔 경로 → 설명할 대상.
 * 콘솔 셸이 '이 화면의 리소스 설명' 버튼을 보여 줄지 정할 때 쓰므로, 설명 데이터(lib/docs 본문)를 불러오지 않는 가벼운 모듈로 둔다.
 */
import type { ServiceDocKey } from "@/lib/docs/types";
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import { RESOURCE_LIST_PATH } from "../router";

export type ConsoleDocTarget =
  | { kind: "resource"; id: string }
  | { kind: "service"; key: ServiceDocKey; itemId: string | null }
  | { kind: "type"; type: ResourceType }
  | null;

const EXTRA_LIST_PATHS: Record<string, ResourceType> = {
  "/ec2/security-groups": "security-group",
  "/ec2/eips": "elastic-ip",
};

/** 상세 화면이면 그 리소스, 목록 화면이면 리소스 유형, VPC 밖 서비스(S3·IAM·CloudWatch·EventBridge·CloudFront·Secrets Manager·Systems Manager)는 서비스 */
export function docTargetForPath(project: Project, segments: string[]): ConsoleDocTarget {
  const parts = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const [service, section, id] = parts;
  if (service === "s3") return { kind: "service", key: "s3", itemId: section === "buckets" && id ? id : null };
  if (service === "iam") return { kind: "service", key: "iam", itemId: id ?? null };
  if (service === "cloudwatch") return { kind: "service", key: "cloudwatch", itemId: section === "alarms" && id ? id : null };
  if (service === "eventbridge") return { kind: "service", key: "eventbridge", itemId: (section === "rules" || section === "schedules") && id ? id : null };
  if (service === "cloudfront") return { kind: "service", key: "cloudfront", itemId: section === "distributions" && id && id !== "create" ? id : null };
  if (service === "secretsmanager") return { kind: "service", key: "secretsmanager", itemId: section === "secrets" && id && id !== "create" ? id : null };
  if (service === "ssm") return { kind: "service", key: "ssm", itemId: (section === "parameters" || section === "sessions") && id && id !== "create" ? id : null };
  for (const part of parts) {
    const r = project.resources.find((x) => x.id === part);
    if (r) return { kind: "resource", id: r.id };
  }
  const base = `/${service ?? ""}/${section ?? ""}`;
  const type = (Object.entries(RESOURCE_LIST_PATH) as [ResourceType, string][]).find(([, p]) => p === base)?.[0] ?? EXTRA_LIST_PATHS[base];
  return type ? { kind: "type", type } : null;
}
