/**
 * Secrets Manager · Systems Manager · CloudFront의 현재 구성 분석 (리소스 설명 패널의 '현재 구성' 부분).
 * 각 서비스의 엔진을 그대로 써서, 구현된 범위 안에서만 판단한다.
 */
import { CACHE_POLICY_INFO, distributionArn, distributionHealth, evaluateOacAccess, isDefaultBehavior, ORIGIN_KIND_LABEL, originTargetName, VIEWER_POLICY_LABEL } from "@/lib/engine/cloudfront-engine";
import { evaluateIam, objectArn } from "@/lib/engine/iam-engine";
import type { Project } from "@/lib/engine/resource-models";
import { currentVersion, deletionTime, isPendingDeletion, liveSecrets, nextRotationTime, secretArn } from "@/lib/engine/secrets-engine";
import { checkSecretRotation, evaluateParameterAccess, evaluateSecretAccess } from "@/lib/engine/service-access";
import { managedNodeStatus, parameterArn } from "@/lib/engine/ssm-engine";
import { displayName } from "@/lib/engine/topology-engine";
import type { AnalysisCheck, AnalysisInput, AnalysisTone, LinkedItem } from "./resource-analysis";
import type { ServiceAnalysis, ServiceAnalysisOptions } from "./service-analysis";

const day = (ms: number) => new Date(ms).toLocaleDateString("ko-KR");

const resourceItem = (project: Project, id: string, detail?: string, tone?: AnalysisTone): LinkedItem[] => {
  const r = project.resources.find((x) => x.id === id);
  return r ? [{ resourceId: r.id, type: r.type, name: displayName(r), detail, tone }] : [{ name: `${id} (삭제됨)`, detail, tone: "error" }];
};

// ---------------------------------------------------------------- Secrets Manager

export function analyzeSecrets(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { project, topology: topo } = input;
  const now = options.now ?? Date.now();
  const secrets = liveSecrets(project, now);
  const items = secrets.map((s) => ({ id: s.id, label: s.name, detail: isPendingDeletion(s) ? "삭제 예약됨" : s.kind === "rds" ? "RDS 자격 증명" : "키/값" }));
  const readers = (name: string) => topo.ofType("lambda").filter((f) => f.config.codeTemplate === "secret-get" && f.config.templateTarget.trim() === name);

  const secret = secrets.find((s) => s.id === options.itemId);
  if (secret) {
    const arn = secretArn(secret);
    const version = currentVersion(secret);
    const pending = isPendingDeletion(secret);
    const fns = readers(secret.name);
    const checks: AnalysisCheck[] = [];
    if (pending) checks.push({ tone: "warn", title: "삭제 예약됨", detail: `${day(deletionTime(secret)!)}에 완전히 삭제됩니다. 그 전에는 값을 읽을 수 없고, '삭제 취소'로 복원할 수 있습니다.`, field: "deletion" });
    const fnItems: LinkedItem[] = fns.flatMap((f) => {
      const access = evaluateSecretAccess(project, topo, secret.id, { kind: "lambda", functionId: f.id }, now);
      if (!access.ok) checks.push({ tone: "error", title: `${displayName(f)}: 값을 읽지 못함`, detail: `${access.code} — ${access.steps.find((s) => s.status === "fail")?.detail ?? access.summary}`, field: "secretAccess" });
      return resourceItem(project, f.id, access.ok ? "읽기 가능" : access.code, access.ok ? "ok" : "error");
    });
    const rotation = secret.rotation;
    const nextRotation = nextRotationTime(secret);
    if (rotation.enabled) {
      const check = checkSecretRotation(project, topo, secret);
      const failed = check.checks.find((c) => c.status === "fail");
      checks.push(check.ok ? { tone: "ok", title: "교체 조건", detail: "교체 함수·호출 권한·실행 역할 권한·네트워크가 모두 준비되어 있습니다.", field: "rotation" } : { tone: "error", title: `교체 실패 예상: ${failed?.title ?? ""}`, detail: failed?.detail ?? "", field: "rotationFunction" });
    } else if (secret.kind === "rds" && !pending) {
      checks.push({ tone: "info", title: "자동 교체 꺼짐", detail: "DB 자격 증명은 주기적으로 교체하는 것이 권장됩니다. 교체 구성에서 주기와 교체 함수를 정하세요.", field: "rotation" });
    }
    const principals: LinkedItem[] = [];
    for (const r of project.services.iam.roles) {
      if (evaluateIam(project, { kind: "role", role: r }, "secretsmanager:GetSecretValue", arn).decision === "allowed") principals.push({ service: { key: "iam", itemId: r.id, consolePath: `/iam/roles/${r.id}` }, name: `역할 ${r.name}`, detail: `신뢰: ${r.trustedEntity}` });
    }
    for (const u of project.services.iam.users) {
      if (evaluateIam(project, { kind: "user", user: u }, "secretsmanager:GetSecretValue", arn).decision === "allowed") principals.push({ service: { key: "iam", itemId: u.id, consolePath: `/iam/users/${u.id}` }, name: `사용자 ${u.name}` });
    }
    if (principals.length > 3) checks.push({ tone: "info", title: `읽을 수 있는 주체 ${principals.length}개`, detail: "필요한 프로그램만 읽도록 정책의 Resource를 이 보안 암호의 ARN으로 좁히는 것이 권장됩니다.", field: "secretAccess" });
    return {
      headline: { tone: pending ? "warn" : checks.some((c) => c.tone === "error") ? "error" : "ok", text: `${pending ? "삭제 예약됨" : "사용 가능"} · ${secret.kind === "rds" ? "RDS 자격 증명" : `키 ${secret.keys.length}개`} · 버전 ${secret.versions.length}개` },
      facts: [
        { label: "이름", value: secret.name, field: "secretName" },
        { label: "유형", value: secret.kind === "rds" ? "Amazon RDS 데이터베이스의 자격 증명" : "다른 유형의 보안 암호 (키/값)", field: "secretType" },
        { label: "키", value: secret.kind === "rds" ? "username, password, engine, host, port, dbInstanceIdentifier" : secret.keys.join(", "), field: "secretKeys" },
        { label: "값", value: "저장하지 않음 (연습용 가상 값 PGSIM-…)", field: "secretValue" },
        { label: "현재 버전", value: `${version.versionId} (AWSCURRENT)`, field: "secretVersion" },
        { label: "자동 교체", value: rotation.enabled ? `${rotation.days}일마다${nextRotation ? ` · 다음 예정 ${day(nextRotation)}` : ""}` : "꺼짐", field: "rotation" },
        { label: "암호화 키", value: "aws/secretsmanager", field: "encryptionKey" },
        { label: "ARN (가상)", value: arn, field: "secretArn" },
      ],
      relations: [
        { label: "이 보안 암호를 읽는 Lambda 함수", explanation: "코드 템플릿 '보안 암호 읽기'의 대상으로 이 이름을 지정한 함수입니다.", items: fnItems, empty: "이 보안 암호를 읽도록 설정한 함수가 없습니다.", field: "secretAccess" },
        ...(secret.kind === "rds" && secret.rdsId ? [{ label: "대상 데이터베이스", explanation: "이 자격 증명으로 접속하는 DB입니다.", items: resourceItem(project, secret.rdsId), field: "secretType" }] : []),
        ...(rotation.lambdaId ? [{ label: "교체 함수", explanation: "교체할 때 Secrets Manager가 호출하는 함수입니다.", items: resourceItem(project, rotation.lambdaId), field: "rotationFunction" }] : []),
        { label: "값을 읽을 수 있는 IAM 주체", explanation: "자격 증명 기반 정책이 이 보안 암호의 secretsmanager:GetSecretValue를 허용하는 역할·사용자입니다.", items: principals, empty: "읽을 수 있는 IAM 역할·사용자가 없습니다 (루트 제외).", field: "secretAccess" },
      ],
      checks,
      recommendations: [],
      items,
      selectedLabel: secret.name,
    };
  }

  const pendingList = secrets.filter(isPendingDeletion);
  const checks: AnalysisCheck[] = [];
  for (const s of secrets) {
    for (const f of readers(s.name)) {
      const access = evaluateSecretAccess(project, topo, s.id, { kind: "lambda", functionId: f.id }, now);
      if (!access.ok) checks.push({ tone: "error", title: `${displayName(f)} → ${s.name}: 값을 읽지 못함`, detail: `${access.code} — ${access.steps.find((x) => x.status === "fail")?.detail ?? access.summary}`, field: "secretAccess" });
    }
  }
  if (!secrets.length) checks.push({ tone: "info", title: "보안 암호 없음", detail: "DB 암호나 API 키를 코드 밖에 보관하려면 보안 암호를 만드세요 (이 시뮬레이터는 값을 입력받지 않습니다).", field: "secretName" });
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : pendingList.length ? "warn" : "ok", text: secrets.length ? `보안 암호 ${secrets.length}개 · 삭제 예약 ${pendingList.length}개 · 교체 켜짐 ${secrets.filter((s) => s.rotation.enabled).length}개` : "보안 암호 없음" },
    facts: [
      { label: "보안 암호", value: `${secrets.length}개`, field: "secretName" },
      { label: "자동 교체", value: `${secrets.filter((s) => s.rotation.enabled).length}개 켜짐`, field: "rotation" },
      { label: "삭제 예약", value: `${pendingList.length}개`, field: "deletion" },
    ],
    relations: [
      {
        label: "보안 암호",
        explanation: "이 샌드박스의 가상 보안 암호입니다. 값은 저장하지 않습니다.",
        items: secrets.map((s) => ({ service: { key: "secretsmanager" as const, itemId: s.id, consolePath: `/secretsmanager/secrets/${s.id}` }, name: s.name, detail: isPendingDeletion(s) ? "삭제 예약됨" : s.rotation.enabled ? `교체 ${s.rotation.days}일` : "교체 꺼짐", tone: isPendingDeletion(s) ? ("warn" as const) : undefined })),
        empty: "보안 암호가 없습니다. 심화 모드의 Secrets Manager에서 만들 수 있습니다.",
        field: "secretName",
      },
    ],
    checks,
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

// ---------------------------------------------------------------- Systems Manager

export function analyzeSsm(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { project, topology: topo } = input;
  const { parameters } = project.services.ssm;
  const instances = topo.ofType("ec2").filter((e) => e.config.state !== "terminated");
  const nodes = instances.map((e) => ({ inst: e, status: managedNodeStatus(project, topo, e) }));
  const items = [
    ...parameters.map((p) => ({ id: p.id, label: `파라미터 ${p.name}`, detail: p.type })),
    ...nodes.map((n) => ({ id: n.inst.id, label: `노드 ${displayName(n.inst)}`, detail: n.status.managed ? "온라인" : "연결 안 됨" })),
  ];
  const readers = (name: string) => topo.ofType("lambda").filter((f) => f.config.codeTemplate === "ssm-get" && f.config.templateTarget.trim() === name);

  const param = parameters.find((p) => p.id === options.itemId);
  if (param) {
    const checks: AnalysisCheck[] = [];
    const fnItems: LinkedItem[] = readers(param.name).flatMap((f) => {
      const access = evaluateParameterAccess(project, topo, param.id, { kind: "lambda", functionId: f.id }, true);
      if (!access.ok) checks.push({ tone: "error", title: `${displayName(f)}: 값을 읽지 못함`, detail: `${access.code} — ${access.steps.find((s) => s.status === "fail")?.detail ?? access.summary}`, field: "parameterAccess" });
      return resourceItem(project, f.id, access.ok ? "읽기 가능" : access.code, access.ok ? "ok" : "error");
    });
    if (param.tier === "Advanced") checks.push({ tone: "info", title: "고급(Advanced) 계층", detail: "개수만큼 요금이 붙고 표준으로 되돌릴 수 없습니다.", field: "parameterTier" });
    return {
      headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: `${param.type} · ${param.tier === "Standard" ? "표준" : "고급"} · 버전 ${param.version}` },
      facts: [
        { label: "이름", value: param.name, field: "parameterName" },
        { label: "유형", value: param.type, field: "parameterType" },
        { label: "계층", value: param.tier === "Standard" ? "표준 (Standard)" : "고급 (Advanced)", field: "parameterTier" },
        { label: "값", value: param.type === "SecureString" ? "저장하지 않음 (연습용 가상 값 PGSIM-…)" : (param.value ?? ""), field: "parameterValue" },
        { label: "버전", value: String(param.version), field: "parameterVersion" },
        { label: "ARN (가상)", value: parameterArn(param.name), field: "parameterAccess" },
      ],
      relations: [{ label: "이 파라미터를 읽는 Lambda 함수", explanation: "코드 템플릿 '파라미터 읽기'의 대상으로 이 이름을 지정한 함수입니다.", items: fnItems, empty: "이 파라미터를 읽도록 설정한 함수가 없습니다.", field: "parameterAccess" }],
      checks,
      recommendations: [],
      items,
      selectedLabel: `파라미터 ${param.name}`,
    };
  }

  const node = nodes.find((n) => n.inst.id === options.itemId);
  if (node) {
    const { inst, status } = node;
    return {
      headline: { tone: status.managed ? "ok" : "warn", text: status.managed ? "관리형 노드 · 온라인 (세션을 열 수 있음)" : "관리형 노드 아님 (세션을 열 수 없음)" },
      facts: [
        { label: "인스턴스", value: `${displayName(inst)} (${inst.id})`, field: "managedNode" },
        { label: "AMI", value: inst.config.ami, field: "ssmAgent" },
        { label: "IAM 역할", value: status.role?.name ?? "없음", field: "instanceProfile" },
      ],
      relations: [{ label: "인스턴스", explanation: "Systems Manager에 등록되는 EC2 인스턴스입니다.", items: resourceItem(project, inst.id, inst.config.state), field: "managedNode" }],
      checks: status.checks.map((c) => ({ tone: c.status === "pass" ? ("ok" as const) : c.status === "fail" ? ("error" as const) : ("info" as const), title: c.title, detail: c.fix ? `${c.detail} 해결: ${c.fix}` : c.detail, field: c.id === "profile" ? "instanceProfile" : c.id === "network" ? "ssmEndpoint" : c.id === "agent" ? "ssmAgent" : c.id === "inbound" ? "sessionManager" : "managedNode" })),
      recommendations: [],
      items,
      selectedLabel: `노드 ${displayName(inst)}`,
    };
  }

  const online = nodes.filter((n) => n.status.managed);
  const checks: AnalysisCheck[] = [];
  for (const n of nodes) {
    // 역할에 SSM 권한을 준 인스턴스가 등록되지 않으면 의도와 다른 상태다
    const profileOk = n.status.checks.find((c) => c.id === "profile")?.status === "pass";
    const failed = n.status.checks.find((c) => c.status === "fail");
    if (profileOk && failed) checks.push({ tone: "warn", title: `${displayName(n.inst)}: 관리형 노드가 되지 못함`, detail: failed.detail, field: failed.id === "network" ? "ssmEndpoint" : "managedNode" });
  }
  for (const p of parameters) {
    for (const f of readers(p.name)) {
      const access = evaluateParameterAccess(project, topo, p.id, { kind: "lambda", functionId: f.id }, true);
      if (!access.ok) checks.push({ tone: "error", title: `${displayName(f)} → ${p.name}: 값을 읽지 못함`, detail: `${access.code} — ${access.steps.find((x) => x.status === "fail")?.detail ?? access.summary}`, field: "parameterAccess" });
    }
  }
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : checks.length ? "warn" : "ok", text: `파라미터 ${parameters.length}개 · 관리형 노드 ${online.length}/${nodes.length}대 온라인` },
    facts: [
      { label: "파라미터", value: `${parameters.length}개 (SecureString ${parameters.filter((p) => p.type === "SecureString").length}개)`, field: "parameterName" },
      { label: "관리형 노드", value: `${online.length}대 온라인 / 인스턴스 ${nodes.length}대`, field: "managedNode" },
    ],
    relations: [
      {
        label: "관리형 노드 (EC2 인스턴스)",
        explanation: "SSM Agent·인스턴스 프로파일 권한·엔드포인트로 나가는 길이 모두 준비된 인스턴스만 온라인이 됩니다.",
        items: nodes.flatMap((n) => resourceItem(project, n.inst.id, n.status.managed ? "온라인" : (n.status.checks.find((c) => c.status === "fail")?.title ?? "연결 안 됨"), n.status.managed ? "ok" : "info")),
        empty: "EC2 인스턴스가 없습니다.",
        field: "managedNode",
      },
      {
        label: "파라미터",
        explanation: "Parameter Store에 보관한 설정 값입니다.",
        items: parameters.map((p) => ({ service: { key: "ssm" as const, itemId: p.id, consolePath: `/ssm/parameters/${p.id}` }, name: p.name, detail: `${p.type} · v${p.version}` })),
        empty: "파라미터가 없습니다.",
        field: "parameterName",
      },
    ],
    checks,
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

// ---------------------------------------------------------------- CloudFront

export function analyzeCloudFront(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { project, topology: topo } = input;
  const { distributions } = project.services.cloudfront;
  const items = distributions.map((d) => ({ id: d.id, label: d.comment || d.domainName, detail: d.enabled ? d.state : "비활성화" }));

  const dist = distributions.find((d) => d.id === options.itemId);
  if (dist) {
    const health = distributionHealth(project, topo, dist);
    const checks: AnalysisCheck[] = [{ tone: health.ok ? "ok" : "error", title: `루트(/) 요청 → ${health.status || "응답 없음"}`, detail: health.detail, field: health.ok ? "origin" : dist.defaultRootObject ? "originAccess" : "defaultRootObject" }];
    const originItems: LinkedItem[] = dist.origins.flatMap((o): LinkedItem[] => {
      if (o.kind === "alb") return resourceItem(project, o.targetId, `${o.id} · ${ORIGIN_KIND_LABEL[o.kind]}`);
      const bucket = project.services.s3.buckets.find((b) => b.id === o.targetId);
      if (!bucket) return [{ name: `${o.id}: 삭제된 버킷`, tone: "error" }];
      if (o.kind === "s3" && o.originAccess === "oac") {
        const read = evaluateOacAccess(bucket, dist.id, "s3:GetObject", objectArn(bucket.name, dist.defaultRootObject || "index.html"));
        if (!read.allowed) checks.push({ tone: "error", title: `원본 ${o.id}: 버킷 정책이 이 배포를 허용하지 않음`, detail: read.detail, field: "originAccess" });
        else if (!read.scoped) checks.push({ tone: "warn", title: `원본 ${o.id}: AWS:SourceArn 조건 없음`, detail: read.detail, field: "originAccess" });
      }
      if (o.kind === "s3" && o.originAccess === "public") checks.push({ tone: "warn", title: `원본 ${o.id}: 버킷을 공개하는 구성`, detail: "버킷이 공개되어 있어야 동작하며 S3 주소로도 직접 읽힙니다. OAC로 바꾸는 것이 권장됩니다.", field: "originAccess" });
      return [{ service: { key: "s3", itemId: bucket.id, consolePath: `/s3/buckets/${bucket.id}` }, name: bucket.name, detail: `${o.id} · ${ORIGIN_KIND_LABEL[o.kind]}${o.kind === "s3" ? ` · ${o.originAccess === "oac" ? "OAC" : "퍼블릭"}` : ""}` }];
    });
    for (const b of dist.behaviors) {
      if (b.viewerProtocolPolicy === "allow-all") checks.push({ tone: "warn", title: `동작 ${isDefaultBehavior(b) ? "기본(*)" : b.pathPattern}: HTTP 허용`, detail: "HTTP 요청이 암호화 없이 처리됩니다. 'Redirect HTTP to HTTPS'가 권장됩니다.", field: "viewerProtocolPolicy" });
    }
    if (!dist.enabled) checks.push({ tone: "info", title: "비활성화된 배포", detail: "요청을 처리하지 않습니다. 삭제하려면 비활성화가 배포된 뒤(Deployed) 삭제하세요.", field: "distributionState" });
    return {
      headline: { tone: !dist.enabled ? "info" : checks.some((c) => c.tone === "error") ? "error" : checks.some((c) => c.tone === "warn") ? "warn" : "ok", text: `${dist.enabled ? "활성화" : "비활성화"} · ${dist.state} · 원본 ${dist.origins.length}개 · 동작 ${dist.behaviors.length}개` },
      facts: [
        { label: "도메인 (가상)", value: dist.domainName, field: "domainName" },
        { label: "상태", value: `${dist.state} · ${dist.enabled ? "활성화됨" : "비활성화됨"}`, field: "distributionState" },
        { label: "기본 루트 객체", value: dist.defaultRootObject || "없음", field: "defaultRootObject" },
        ...dist.behaviors.map((b) => ({
          label: `동작 ${isDefaultBehavior(b) ? "기본 (*)" : b.pathPattern}`,
          value: `→ ${b.originId} · ${VIEWER_POLICY_LABEL[b.viewerProtocolPolicy]} · ${CACHE_POLICY_INFO[b.cachePolicy].label.split(" ")[0]}`,
          field: "cacheBehavior",
        })),
        { label: "엣지 캐시 (가상)", value: `${dist.cache.length}개 경로`, field: "edgeCache" },
        { label: "배포 ARN (가상)", value: distributionArn(dist.id) },
      ],
      relations: [{ label: "원본", explanation: "캐시에 없을 때 콘텐츠를 가져오는 곳입니다.", items: originItems, field: "origin" }],
      checks,
      recommendations: [],
      items,
      selectedLabel: dist.comment || dist.domainName,
    };
  }

  const checks: AnalysisCheck[] = [];
  const list: LinkedItem[] = distributions.map((d) => {
    const health = d.enabled ? distributionHealth(project, topo, d) : null;
    if (health && !health.ok) checks.push({ tone: "error", title: `${d.comment || d.domainName}: 루트(/) 요청 실패 (${health.status || "응답 없음"})`, detail: health.detail, field: "origin" });
    return {
      service: { key: "cloudfront" as const, itemId: d.id, consolePath: `/cloudfront/distributions/${d.id}` },
      name: d.comment || d.domainName,
      detail: `${d.enabled ? d.state : "비활성화"} · 원본 ${d.origins.map((o) => originTargetName(project, o)).join(", ")}`,
      tone: !d.enabled ? ("info" as const) : health?.ok ? ("ok" as const) : ("error" as const),
    };
  });
  if (!distributions.length) checks.push({ tone: "info", title: "배포 없음", detail: "S3 버킷이나 로드 밸런서 앞에 CloudFront 배포를 만들어 HTTPS와 캐시를 적용해 보세요.", field: "origin" });
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: distributions.length ? `배포 ${distributions.length}개 (활성 ${distributions.filter((d) => d.enabled).length}개)` : "배포 없음" },
    facts: [{ label: "배포", value: `${distributions.length}개`, field: "domainName" }],
    relations: [{ label: "배포", explanation: "이 샌드박스의 가상 CloudFront 배포입니다.", items: list, empty: "배포가 없습니다. 심화 모드의 CloudFront에서 만들 수 있습니다.", field: "domainName" }],
    checks,
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

/** 서비스 항목을 직접 설정하는 심화 모드(콘솔) 경로 */
export function platformConsolePath(project: Project, key: "secretsmanager" | "ssm" | "cloudfront", itemId: string | null): string {
  if (key === "secretsmanager") return itemId && project.services.secretsmanager.secrets.some((s) => s.id === itemId) ? `/secretsmanager/secrets/${itemId}` : "/secretsmanager/secrets";
  if (key === "cloudfront") return itemId && project.services.cloudfront.distributions.some((d) => d.id === itemId) ? `/cloudfront/distributions/${itemId}` : "/cloudfront/distributions";
  if (itemId && project.services.ssm.parameters.some((p) => p.id === itemId)) return `/ssm/parameters/${itemId}`;
  if (itemId && project.resources.some((r) => r.id === itemId && r.type === "ec2")) return `/ssm/sessions/${itemId}`;
  return "/ssm";
}
