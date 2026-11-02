import { describe, expect, it } from "vitest";
import { ALL_DOC_KEYS, DOC_FIELDS, getFieldHelp, getResourceDoc, hasResourceDoc, RESOURCE_DOCS, type DocKey, type FieldHelp } from "@/lib/docs";
import { RULE_FIELDS } from "@/lib/docs/rule-fields";
import { configSchemas, RESOURCE_TYPES } from "@/lib/engine/resource-models";
import { VALIDATION_RULES } from "@/lib/engine/validation-engine";
import { docTargetForPath } from "@/components/console/shell/resource-doc-tab";
import { serviceConsolePath } from "@/lib/docs/service-analysis";
import * as iam from "@/lib/project/iam-actions";
import { createThreeTierSample } from "@/lib/project/samples";

const PARTS: (keyof FieldHelp)[] = ["title", "meaning", "purpose", "values", "realAws", "simulator", "example"];

describe("리소스 설명 데이터", () => {
  it("모든 지원 리소스와 서비스에 설명이 있고, 키가 리소스 유형과 일치한다", () => {
    for (const key of ALL_DOC_KEYS) {
      const doc = RESOURCE_DOCS[key];
      expect(doc, key).toBeDefined();
      expect(doc.key).toBe(key);
      expect(doc.summary.length, key).toBeGreaterThan(20);
      expect(doc.description.length, key).toBeGreaterThan(0);
      expect(doc.coreRoles.length, key).toBeGreaterThan(0);
      expect(doc.why.problem, key).not.toBe("");
      expect(doc.why.whenNeeded.length, key).toBeGreaterThan(0);
      expect(doc.why.whenNotNeeded.length, key).toBeGreaterThan(0);
      expect(doc.useCases.length, key).toBeGreaterThan(0);
      expect(doc.relatedResources.length, key).toBeGreaterThan(0);
      expect(doc.simulator.implemented.length, key).toBeGreaterThan(0);
      expect(doc.simulator.virtual.length, key).toBeGreaterThan(0);
      expect(doc.simulator.unsupported.length, key).toBeGreaterThan(0);
    }
  });

  it("관련 리소스는 실제로 있는 설명 키만 가리킨다", () => {
    for (const key of ALL_DOC_KEYS) {
      for (const rel of RESOURCE_DOCS[key].relatedResources) expect(hasResourceDoc(rel.type), `${key} → ${rel.type}`).toBe(true);
    }
  });
});

describe("설정 항목 도움말", () => {
  it("리소스 설정 스키마의 모든 키에 도움말이 있다", () => {
    for (const type of RESOURCE_TYPES) {
      const keys = Object.keys((configSchemas[type] as unknown as { shape: Record<string, unknown> }).shape);
      for (const k of keys) expect(DOC_FIELDS[type] as readonly string[], `${type}.${k}`).toContain(k);
    }
  });

  it("도움말마다 7가지 내용(의미·목적·값·실제 AWS·시뮬레이터·실수·예시)이 모두 채워져 있다", () => {
    for (const key of ALL_DOC_KEYS) {
      for (const field of DOC_FIELDS[key]) {
        const help = getFieldHelp(key, field);
        expect(help, `${key}.${field}`).not.toBeNull();
        for (const part of PARTS) expect(String(help![part]).trim().length, `${key}.${field}.${part}`).toBeGreaterThan(0);
        expect(help!.mistakes.length, `${key}.${field}.mistakes`).toBeGreaterThan(0);
      }
    }
  });

  it("같은 설명을 여러 리소스에 복사하지 않는다 (의미 문장이 서로 다르다)", () => {
    const seen = new Map<string, string>();
    for (const key of ALL_DOC_KEYS) {
      for (const field of DOC_FIELDS[key]) {
        const meaning = getFieldHelp(key, field)!.meaning;
        expect(seen.get(meaning), `${key}.${field} 와 ${seen.get(meaning)} 설명이 같습니다`).toBeUndefined();
        seen.set(meaning, `${key}.${field}`);
      }
    }
  });

  it("이름 도움말은 리소스 특성에 맞다: Name 태그인 리소스와 이름이 리소스 속성인 리소스를 구분한다", () => {
    for (const key of ["vpc", "subnet", "ec2", "route-table", "internet-gateway", "nat-gateway", "network-acl", "elastic-ip"] as const) {
      expect(getFieldHelp(key, "name")?.title, key).toContain("Name 태그");
    }
    expect(getFieldHelp("security-group", "name")?.title).toContain("GroupName");
    expect(getFieldHelp("alb", "name")?.title).toBe("로드 밸런서 이름");
    expect(getFieldHelp("target-group", "name")?.title).toBe("대상 그룹 이름");
    expect(getFieldHelp("rds", "name")?.title).toBe("DB 인스턴스 식별자");
    expect(getFieldHelp("db-subnet-group", "name")?.title).toBe("DB 서브넷 그룹 이름");
    for (const key of ["security-group", "alb", "target-group", "rds", "db-subnet-group"] as const) {
      expect(getFieldHelp(key, "name")?.realAws, key).not.toContain("태그일 뿐");
    }
  });

  it("공통 Name 태그 도움말과 누락된 설명의 기본 안내", () => {
    expect(getFieldHelp("vpc", "name")?.title).toContain("Name");
    expect(getFieldHelp("vpc", "no-such-field")).toBeNull();
    const fallback = getResourceDoc("no-such-resource");
    expect(fallback.description[0]).toContain("준비되지 않았습니다");
    expect(fallback.simulator.virtual.length).toBeGreaterThan(0);
  });
});

describe("콘솔 화면 ↔ 설명 대상", () => {
  it("상세 화면은 그 리소스, 목록 화면은 리소스 유형, S3·IAM·CloudWatch는 서비스 항목을 가리킨다", () => {
    const p = createThreeTierSample();
    const app1 = p.resources.find((r) => r.name === "app-1")!;
    expect(docTargetForPath(p, ["ec2", "instances", app1.id])).toEqual({ kind: "resource", id: app1.id });
    expect(docTargetForPath(p, ["ec2", "instances", app1.id, "edit-security-groups"])).toEqual({ kind: "resource", id: app1.id });
    expect(docTargetForPath(p, ["vpc", "subnets"])).toEqual({ kind: "type", type: "subnet" });
    expect(docTargetForPath(p, ["ec2", "security-groups"])).toEqual({ kind: "type", type: "security-group" });
    expect(docTargetForPath(p, ["s3", "buckets", "bkt-1"])).toEqual({ kind: "service", key: "s3", itemId: "bkt-1" });
    expect(docTargetForPath(p, ["cloudwatch"])).toEqual({ kind: "service", key: "cloudwatch", itemId: null });
    expect(docTargetForPath(p, [])).toBeNull();
    expect(docTargetForPath(p, ["map"])).toBeNull();
  });

  it("서비스 항목의 콘솔 경로는 실제로 있는 항목만 가리킨다", () => {
    let p = createThreeTierSample();
    const r = iam.createRole(p, { name: "reader", description: "", trustedEntity: "ec2.amazonaws.com", policyIds: [] });
    if (!r.ok) throw new Error(r.error);
    p = r.project;
    expect(serviceConsolePath(p, "iam", r.createdId!)).toBe(`/iam/roles/${r.createdId}`);
    expect(serviceConsolePath(p, "iam", "aws:AmazonS3ReadOnlyAccess")).toBe("/iam/policies/aws%3AAmazonS3ReadOnlyAccess");
    expect(serviceConsolePath(p, "s3", "missing")).toBe("/s3");
    expect(serviceConsolePath(p, "cloudwatch", null)).toBe("/cloudwatch");
  });
});

describe("검증 규칙 ↔ 설정 항목 연결", () => {
  it("모든 검증 규칙이 매핑되어 있고, 매핑된 설정 키는 실제 도움말에 있다", () => {
    for (const rule of VALIDATION_RULES) expect(RULE_FIELDS[rule.id], rule.id).toBeDefined();
    for (const [ruleId, targets] of Object.entries(RULE_FIELDS)) {
      for (const [type, field] of Object.entries(targets)) {
        expect(getFieldHelp(type as DocKey, field!), `${ruleId} → ${type}.${field}`).not.toBeNull();
      }
    }
  });
});
