/**
 * 프로젝트 구조 무결성 검사 (JSON 가져오기 / 저장소 복원 시 사용).
 * 존재하지 않는 리소스 참조, 잘못된 관계 방향, 개수 제한 위반처럼
 * 엔진이 해석할 수 없는 구조 오류를 찾는다. 이런 프로젝트는 거부한다.
 * (CIDR 범위 같은 의미상의 문제는 불러온 뒤 validation-engine이 보고한다.)
 */
import { RELATION_SPECS, type Project } from "@/lib/engine/resource-models";

export interface IntegrityIssue {
  path: string;
  message: string;
}

export function checkProjectIntegrity(project: Project): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const byId = new Map<string, Project["resources"][number]>();

  project.resources.forEach((r, i) => {
    if (byId.has(r.id)) issues.push({ path: `resources[${i}].id`, message: `리소스 ID "${r.id}"가 중복되었습니다.` });
    byId.set(r.id, r);
  });

  const connectionIds = new Set<string>();
  const perSource = new Map<string, number>();
  const perTarget = new Map<string, number>();
  const forwardsPerListener = new Map<string, number>();

  project.connections.forEach((c, i) => {
    const path = `connections[${i}]`;
    if (connectionIds.has(c.id)) issues.push({ path: `${path}.id`, message: `연결 ID "${c.id}"가 중복되었습니다.` });
    connectionIds.add(c.id);
    const source = byId.get(c.sourceResourceId);
    const target = byId.get(c.targetResourceId);
    if (!source) {
      issues.push({ path: `${path}.sourceResourceId`, message: `존재하지 않는 리소스 "${c.sourceResourceId}"를 참조합니다.` });
    }
    if (!target) {
      issues.push({ path: `${path}.targetResourceId`, message: `존재하지 않는 리소스 "${c.targetResourceId}"를 참조합니다.` });
    }
    if (!source || !target) return;
    const spec = RELATION_SPECS[c.relationType];
    if (spec.source !== source.type || spec.target !== target.type) {
      issues.push({
        path: `${path}.relationType`,
        message: `관계 "${c.relationType}"는 ${spec.source} → ${spec.target} 방향이어야 하지만 ${source.type} → ${target.type}입니다.`,
      });
      return;
    }
    const sk = `${c.relationType}|${c.sourceResourceId}`;
    const tk = `${c.relationType}|${c.targetResourceId}`;
    perSource.set(sk, (perSource.get(sk) ?? 0) + 1);
    perTarget.set(tk, (perTarget.get(tk) ?? 0) + 1);
    if (spec.maxPerSource !== undefined && perSource.get(sk)! > spec.maxPerSource) {
      issues.push({ path, message: `${source.name}의 "${c.relationType}" 연결이 최대 개수(${spec.maxPerSource})를 넘었습니다.` });
    }
    if (spec.maxPerTarget !== undefined && perTarget.get(tk)! > spec.maxPerTarget) {
      issues.push({ path, message: `${target.name}의 "${c.relationType}" 연결이 최대 개수(${spec.maxPerTarget})를 넘었습니다.` });
    }
    if (c.relationType === "alb-target-group" && source.type === "alb") {
      const listener = source.config.listeners.find((l) => l.id === c.metadata.listenerId);
      if (!listener) {
        issues.push({ path: `${path}.metadata.listenerId`, message: `ALB ${source.name}에 리스너 "${c.metadata.listenerId}"가 없습니다.` });
      }
      const key = `${source.id}|${c.metadata.listenerId}`;
      forwardsPerListener.set(key, (forwardsPerListener.get(key) ?? 0) + 1);
      if (forwardsPerListener.get(key)! > 1) {
        issues.push({ path, message: `ALB ${source.name}의 리스너 하나가 여러 대상 그룹으로 전달하도록 정의되었습니다.` });
      }
    }
  });

  project.resources.forEach((r, i) => {
    if (r.type === "security-group") {
      const rules = [...r.config.inboundRules, ...r.config.outboundRules];
      rules.forEach((rule) => {
        if (rule.peer.kind === "security-group") {
          const ref = byId.get(rule.peer.securityGroupId);
          if (!ref || ref.type !== "security-group") {
            issues.push({
              path: `resources[${i}].config`,
              message: `보안 그룹 ${r.name}의 규칙이 존재하지 않는 보안 그룹 "${rule.peer.securityGroupId}"를 참조합니다.`,
            });
          }
        }
      });
    }
    if (r.type === "alb") {
      const ids = new Set<string>();
      for (const l of r.config.listeners) {
        if (ids.has(l.id)) issues.push({ path: `resources[${i}].config.listeners`, message: `ALB ${r.name}의 리스너 ID가 중복되었습니다.` });
        ids.add(l.id);
      }
    }
  });

  return issues;
}
