/**
 * 리소스 설명 조회.
 * 설명이 없는 리소스나 설정 키를 요청해도 빈 화면 대신 기본 안내를 돌려준다.
 */
import { RESOURCE_TYPE_INFO, RESOURCE_TYPES, type ResourceType } from "@/lib/engine/resource-models";
import { CLOUDWATCH_DOC } from "./content/cloudwatch";
import { ALB_DOC, EC2_DOC, TARGET_GROUP_DOC } from "./content/compute";
import { DB_SUBNET_GROUP_DOC, RDS_DOC } from "./content/database";
import { IAM_DOC } from "./content/iam";
import { RESOURCE_NAME_HELP } from "./content/names";
import { EIP_DOC, IGW_DOC, NAT_DOC, ROUTE_TABLE_DOC, SUBNET_DOC, VPC_DOC } from "./content/network";
import { S3_DOC } from "./content/s3";
import { NACL_DOC, SECURITY_GROUP_DOC } from "./content/security";
import { DOC_FIELDS, NAME_TAG_HELP, SERVICE_DOC_KEYS, type DocKey, type FieldHelp, type ResourceDoc } from "./types";

export * from "./types";

export const RESOURCE_DOCS: { [K in DocKey]: ResourceDoc<K> } = {
  vpc: VPC_DOC,
  subnet: SUBNET_DOC,
  "internet-gateway": IGW_DOC,
  "elastic-ip": EIP_DOC,
  "route-table": ROUTE_TABLE_DOC,
  "nat-gateway": NAT_DOC,
  "security-group": SECURITY_GROUP_DOC,
  "network-acl": NACL_DOC,
  ec2: EC2_DOC,
  alb: ALB_DOC,
  "target-group": TARGET_GROUP_DOC,
  "db-subnet-group": DB_SUBNET_GROUP_DOC,
  rds: RDS_DOC,
  s3: S3_DOC,
  iam: IAM_DOC,
  cloudwatch: CLOUDWATCH_DOC,
};

export const ALL_DOC_KEYS: DocKey[] = [...RESOURCE_TYPES, ...SERVICE_DOC_KEYS];

/** 설명 데이터가 없을 때 쓰는 기본 안내 */
function fallbackDoc(key: string): ResourceDoc {
  const info = (RESOURCE_TYPE_INFO as Record<string, { label: string; description: string } | undefined>)[key];
  const title = info?.label ?? key;
  return {
    key: key as DocKey,
    title,
    serviceName: title,
    resourceType: "설명 준비 중",
    summary: info?.description ?? "이 리소스의 상세 설명이 아직 준비되지 않았습니다.",
    description: ["이 리소스의 상세 설명은 아직 준비되지 않았습니다. 설정 화면과 검증 결과는 그대로 사용할 수 있습니다."],
    coreRoles: [],
    why: { problem: "", whenNeeded: [], whenNotNeeded: [], comparisons: [] },
    purposes: [],
    useCases: [],
    relatedResources: [],
    fields: {} as ResourceDoc["fields"],
    simulator: { implemented: [], differences: [], virtual: ["모든 리소스는 이 브라우저 안의 가상 객체입니다"], unsupported: [] },
  };
}

export function getResourceDoc(key: string | null | undefined): ResourceDoc {
  if (key && key in RESOURCE_DOCS) return RESOURCE_DOCS[key as DocKey] as unknown as ResourceDoc;
  return fallbackDoc(key ?? "unknown");
}

export function hasResourceDoc(key: string): key is DocKey {
  return key in RESOURCE_DOCS;
}

/** 설정 항목 도움말. "name"은 모든 리소스 공통(Name 태그). 없으면 null */
/** 설정 도움말. "name"은 리소스마다 다르다: 이름이 리소스 속성인 유형(보안 그룹, ALB 등)은 전용 설명, 나머지는 Name 태그 설명 */
export function getFieldHelp(key: string | null | undefined, field: string): FieldHelp | null {
  if (field === "name") return (key && RESOURCE_NAME_HELP[key as DocKey]) || NAME_TAG_HELP;
  if (!key || !(key in RESOURCE_DOCS)) return null;
  const fields = RESOURCE_DOCS[key as DocKey].fields as Record<string, FieldHelp>;
  return fields[field] ?? null;
}

export function fieldKeysOf(key: DocKey): readonly string[] {
  return DOC_FIELDS[key];
}

export const docLabel = (key: string) => getResourceDoc(key).title;

/** 리소스 유형의 짧은 이름 (아이콘 옆 표시용) */
export function docShortLabel(key: DocKey): string {
  if ((RESOURCE_TYPES as readonly string[]).includes(key)) return RESOURCE_TYPE_INFO[key as ResourceType].shortLabel;
  return { s3: "S3", iam: "IAM", cloudwatch: "CloudWatch" }[key as "s3" | "iam" | "cloudwatch"];
}
