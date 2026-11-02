/**
 * VPC 밖 가상 서비스(S3, IAM, CloudWatch)의 현재 구성 분석.
 * 기존 평가 엔진(evaluateS3Access, evaluateIam, alarmHistory)을 그대로 써서, 구현된 범위 안에서만 판단한다.
 */
import { alarmHistory, buildMetricModel, COMPARISON_SYMBOL, formatMetricValue, loadStatus, metricDefinition, metricSeries, type AlarmState, type MetricModel } from "@/lib/engine/cloudwatch-engine";
import { checkPolicyDocument, effectivePolicyIds, evaluateIam, objectArn, policyAttachments, trustPolicyDocument, allPolicies } from "@/lib/engine/iam-engine";
import { iamRecommendations } from "@/lib/engine/iam-recommendations";
import { instancesUsingRole } from "@/lib/project/iam-actions";
import { bucketAccess, bucketPolicyStatements, evaluateS3Access, findObject, visibleObjects, websiteRequest } from "@/lib/engine/s3-engine";
import type { Project, S3Bucket } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import type { AnalysisCheck, AnalysisInput, AnalysisTone, Fact, LinkedItem, RelationGroup } from "./resource-analysis";
import type { ServiceDocKey } from "./types";

export interface ServiceAnalysis {
  headline: { tone: AnalysisTone; text: string };
  facts: Fact[];
  relations: RelationGroup[];
  checks: AnalysisCheck[];
  recommendations: string[];
  /** 서비스 안에서 고를 수 있는 항목 (버킷, 사용자·역할·정책, 경보) */
  items: { id: string; label: string; detail?: string }[];
  /** 선택한 항목 이름 (없으면 서비스 전체) */
  selectedLabel: string | null;
}

export interface ServiceAnalysisOptions {
  itemId?: string | null;
  now?: number;
  metricModel?: MetricModel;
}

const resourceItem = (project: Project, id: string, detail?: string, tone?: AnalysisTone): LinkedItem[] => {
  const r = project.resources.find((x) => x.id === id);
  return r ? [{ resourceId: r.id, type: r.type, name: displayName(r), detail, tone }] : [{ name: `${id} (삭제됨)`, detail, tone: "error" }];
};

// ---------------------------------------------------------------- S3

const ACCESS_TONE = { public: "warn", "can-be-public": "info", "not-public": "ok" } as const;

function analyzeBucket(input: AnalysisInput, bucket: S3Bucket): Omit<ServiceAnalysis, "items" | "selectedLabel"> {
  const { project } = input;
  const access = bucketAccess(bucket);
  const statements = bucketPolicyStatements(bucket);
  const objects = visibleObjects(bucket);
  const sampleKey = findObject(bucket, bucket.website.indexDocument || "index.html")?.key ?? objects[0]?.key ?? bucket.website.indexDocument ?? "index.html";
  const anon = evaluateS3Access(project, { bucketId: bucket.id, key: sampleKey, action: "s3:GetObject", caller: { kind: "anonymous" } });
  const checks: AnalysisCheck[] = [
    {
      tone: anon.ok ? "warn" : "ok",
      title: `익명 사용자 → s3:GetObject ${sampleKey}`,
      detail: anon.ok
        ? `인터넷의 누구나 읽을 수 있습니다 (HTTP ${anon.httpStatus}). 웹 사이트처럼 공개가 목적일 때만 이 상태가 맞습니다.`
        : `거부됩니다 (HTTP ${anon.httpStatus} ${anon.code}). ${anon.steps.filter((s) => s.status === "fail").map((s) => s.detail).join(" ")}`,
      field: anon.ok ? "bucketPolicy" : "blockPublicAccess",
    },
  ];
  if (bucket.website.enabled) {
    const site = websiteRequest(project, bucket.id, "/");
    checks.push({
      tone: site.status === 200 ? "ok" : "warn",
      title: `정적 웹 사이트 / 요청 → ${site.status} ${site.code}`,
      detail: site.explanation.join(" "),
      field: site.status === 403 ? "bucketPolicy" : site.status === 404 ? "indexDocument" : "staticWebsite",
    });
  }
  if (!bucket.blockPublicAccess.blockPublicPolicy && !statements.length && !bucket.website.enabled) {
    checks.push({ tone: "info", title: "공개 정책 없이 퍼블릭 액세스 차단이 꺼져 있음", detail: "필요하지 않다면 다시 켜 두는 것이 안전합니다.", field: "blockPublicPolicy" });
  }
  const principals: LinkedItem[] = [];
  for (const u of project.services.iam.users) {
    const d = evaluateIam(project, { kind: "user", user: u }, "s3:GetObject", objectArn(bucket.name, sampleKey), { resourcePolicy: statements.length ? { label: "버킷 정책", statements } : null, restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets });
    if (d.decision === "allowed") principals.push({ service: { key: "iam", itemId: u.id, consolePath: `/iam/users/${u.id}` }, name: `사용자 ${u.name}`, detail: "읽기 허용", tone: "info" });
  }
  for (const r of project.services.iam.roles) {
    const d = evaluateIam(project, { kind: "role", role: r }, "s3:GetObject", objectArn(bucket.name, sampleKey), { resourcePolicy: statements.length ? { label: "버킷 정책", statements } : null, restrictPublic: bucket.blockPublicAccess.restrictPublicBuckets });
    if (d.decision === "allowed") principals.push({ service: { key: "iam", itemId: r.id, consolePath: `/iam/roles/${r.id}` }, name: `역할 ${r.name}`, detail: `읽기 허용 · 사용 인스턴스 ${instancesUsingRole(project, r.id).length}대`, tone: "info" });
  }
  const bpa = bucket.blockPublicAccess;
  return {
    headline: { tone: ACCESS_TONE[access.kind], text: `${access.label} · 객체 ${objects.length}개 · 버전 관리 ${bucket.versioning}` },
    facts: [
      { label: "버킷 이름", value: bucket.name, field: "bucketName" },
      { label: "리전", value: "ap-northeast-2 (가상)", field: "region" },
      { label: "퍼블릭 액세스 차단", value: `ACL 차단 ${bpa.blockPublicAcls ? "켜짐" : "꺼짐"} · ACL 무시 ${bpa.ignorePublicAcls ? "켜짐" : "꺼짐"} · 정책 차단 ${bpa.blockPublicPolicy ? "켜짐" : "꺼짐"} · 퍼블릭 버킷 제한 ${bpa.restrictPublicBuckets ? "켜짐" : "꺼짐"}`, field: "blockPublicAccess" },
      { label: "버전 관리", value: { Disabled: "비활성화", Enabled: "활성화", Suspended: "일시 중지" }[bucket.versioning], field: "versioning" },
      { label: "기본 암호화", value: bucket.encryption, field: "encryption" },
      { label: "버킷 정책", value: statements.length ? statements.map((s) => `${s.effect} ${s.principal?.any ? "*" : "지정 주체"} ${s.actions.join(",")}`).join(" / ") : "없음", field: "bucketPolicy" },
      { label: "정적 웹 사이트", value: bucket.website.enabled ? `켜짐 (인덱스 ${bucket.website.indexDocument}${bucket.website.errorDocument ? `, 오류 ${bucket.website.errorDocument}` : ""})` : "꺼짐", field: "staticWebsite" },
    ],
    relations: [
      { label: "이 버킷의 객체를 읽을 수 있는 IAM 주체", explanation: `IAM 정책과 버킷 정책을 함께 평가한 결과입니다 (s3:GetObject ${sampleKey} 기준, Condition 미평가).`, items: principals, empty: "읽을 수 있는 IAM 사용자·역할이 없습니다." },
    ],
    checks,
    recommendations: access.kind === "public" && !bucket.website.enabled ? ["웹 사이트가 아닌데 공개 상태입니다. 퍼블릭 액세스 차단을 켜거나 버킷 정책의 Principal \"*\" 문장을 지우세요."] : [],
  };
}

function analyzeS3(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { buckets } = input.project.services.s3;
  const items = buckets.map((b) => ({ id: b.id, label: b.name, detail: bucketAccess(b).label }));
  const selected = buckets.find((b) => b.id === options.itemId);
  if (selected) return { ...analyzeBucket(input, selected), items, selectedLabel: selected.name };
  const publicBuckets = buckets.filter((b) => bucketAccess(b).kind === "public");
  const objects = buckets.reduce((n, b) => n + visibleObjects(b).length, 0);
  return {
    headline: { tone: publicBuckets.length ? "warn" : "ok", text: buckets.length ? `버킷 ${buckets.length}개 · 퍼블릭 ${publicBuckets.length}개 · 객체 ${objects}개` : "버킷 없음" },
    facts: [
      { label: "버킷", value: `${buckets.length}개`, field: "bucketName" },
      { label: "퍼블릭 버킷", value: `${publicBuckets.length}개`, field: "blockPublicAccess" },
      { label: "객체 (가상)", value: `${objects}개`, field: "objectKey" },
    ],
    relations: [
      {
        label: "버킷",
        explanation: "이 샌드박스의 가상 버킷입니다. 버킷이 있다는 것만으로 공개되지는 않습니다.",
        items: buckets.map((b) => ({ service: { key: "s3", itemId: b.id, consolePath: `/s3/buckets/${b.id}` }, name: b.name, detail: bucketAccess(b).label, tone: ACCESS_TONE[bucketAccess(b).kind] })),
        empty: "버킷이 없습니다. 심화 모드의 S3에서 만들 수 있습니다.",
      },
    ],
    checks: publicBuckets.map((b) => ({ tone: "warn" as const, title: `${b.name}: 퍼블릭`, detail: bucketAccess(b).detail, field: "bucketPolicy" })),
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

// ---------------------------------------------------------------- IAM

function analyzeIam(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { project } = input;
  const { users, groups, roles, policies } = project.services.iam;
  const items = [
    ...users.map((u) => ({ id: u.id, label: `사용자 ${u.name}` })),
    ...roles.map((r) => ({ id: r.id, label: `역할 ${r.name}` })),
    ...groups.map((g) => ({ id: g.id, label: `그룹 ${g.name}` })),
    ...policies.map((p) => ({ id: p.id, label: `정책 ${p.name}` })),
  ];
  const id = options.itemId;
  const user = users.find((u) => u.id === id);
  const role = roles.find((r) => r.id === id);
  const group = groups.find((g) => g.id === id);
  const policy = allPolicies(project).find((p) => p.id === id);
  const policyName = (pid: string) => allPolicies(project).find((p) => p.id === pid)?.name ?? pid;
  const statementSummary = (pids: string[]) =>
    pids.flatMap((pid) => {
      const doc = allPolicies(project).find((p) => p.id === pid);
      if (!doc) return [];
      return checkPolicyDocument(doc.document, "identity").statements.map((s) => ({ label: `${doc.name}`, value: `${s.effect} ${s.actions.join(", ")} → ${s.resources.join(", ")}${s.hasCondition ? " (Condition 미평가)" : ""}`, field: s.effect === "Deny" ? "effect" : "action" }));
    });

  if (user) {
    const ids = effectivePolicyIds(project, { kind: "user", user });
    const active = user.accessKeys.filter((k) => k.status === "Active").length;
    const s3Read = evaluateIam(project, { kind: "user", user }, "s3:GetObject", "*");
    return {
      headline: { tone: ids.length ? "ok" : "info", text: `정책 ${ids.length}개 · 그룹 ${user.groupIds.length}개 · 활성 키 ${active}개` },
      facts: [
        { label: "콘솔 액세스", value: user.consoleAccess ? "활성 (가상, 암호 없음)" : "없음", field: "consoleAccess" },
        { label: "MFA", value: user.mfaEnabled ? "할당됨 (가상)" : "없음", field: "mfa" },
        { label: "액세스 키", value: user.accessKeys.map((k) => `${k.id} (${k.status})`).join(", ") || "없음", field: "accessKey" },
        ...statementSummary(ids).slice(0, 8),
      ],
      relations: [
        { label: "그룹", explanation: "그룹의 정책을 물려받습니다.", items: user.groupIds.map((g) => ({ service: { key: "iam" as const, itemId: g, consolePath: `/iam/groups/${g}` }, name: groups.find((x) => x.id === g)?.name ?? g })), empty: "속한 그룹이 없습니다.", field: "group" },
        { label: "적용되는 정책", explanation: "직접 연결 + 그룹 정책의 합입니다.", items: ids.map((pid) => ({ service: { key: "iam" as const, itemId: pid, consolePath: `/iam/policies/${encodeURIComponent(pid)}` }, name: policyName(pid) })), empty: "정책이 없어 모든 작업이 암묵적으로 거부됩니다.", field: "policyDocument" },
      ],
      checks: [{ tone: s3Read.decision === "allowed" ? "info" : "ok", title: "예시 평가: s3:GetObject (*)", detail: s3Read.explanation.join(" "), field: "effect" }],
      recommendations: user.consoleAccess && !user.mfaEnabled ? ["콘솔 로그인 사용자에게는 MFA를 할당하세요."] : [],
      items,
      selectedLabel: `사용자 ${user.name}`,
    };
  }
  if (role) {
    const used = instancesUsingRole(project, role.id);
    const trust = checkPolicyDocument(trustPolicyDocument(role), "trust").statements[0];
    return {
      headline: { tone: "info", text: `신뢰: ${role.trustedEntity} · 정책 ${role.policyIds.length}개 · 사용 인스턴스 ${used.length}대` },
      facts: [
        { label: "신뢰 정책", value: `${trust?.effect ?? "Allow"} ${trust?.principal?.service.join(", ") || trust?.principal?.aws.join(", ") || ""} → sts:AssumeRole`, field: "trustPolicy" },
        ...statementSummary(role.policyIds).slice(0, 8),
      ],
      relations: [
        { label: "이 역할을 쓰는 EC2 인스턴스", explanation: "인스턴스 프로파일로 연결되어 있습니다.", items: used.flatMap((e) => resourceItem(project, e.id, e.config.state)), empty: role.trustedEntity === "ec2.amazonaws.com" ? "연결된 인스턴스가 없습니다." : "EC2를 신뢰하지 않는 역할이라 인스턴스에 연결할 수 없습니다.", field: "instanceProfile" },
        { label: "권한 정책", explanation: "역할을 넘겨받은 쪽이 할 수 있는 일입니다.", items: role.policyIds.map((pid) => ({ service: { key: "iam" as const, itemId: pid, consolePath: `/iam/policies/${encodeURIComponent(pid)}` }, name: policyName(pid) })), empty: "정책이 없어 역할을 넘겨받아도 아무것도 할 수 없습니다.", field: "policyDocument" },
      ],
      checks: role.policyIds.length ? [] : [{ tone: "warn", title: "권한 정책 없음", detail: "역할이 아무 작업도 허용하지 않습니다.", field: "policyDocument" }],
      recommendations: [],
      items,
      selectedLabel: `역할 ${role.name}`,
    };
  }
  if (group) {
    const members = users.filter((u) => u.groupIds.includes(group.id));
    return {
      headline: { tone: "info", text: `구성원 ${members.length}명 · 정책 ${group.policyIds.length}개` },
      facts: statementSummary(group.policyIds).slice(0, 8),
      relations: [
        { label: "구성원", explanation: "이 그룹의 정책을 물려받는 사용자입니다.", items: members.map((u) => ({ service: { key: "iam" as const, itemId: u.id, consolePath: `/iam/users/${u.id}` }, name: u.name })), empty: "구성원이 없습니다.", field: "user" },
        { label: "연결된 정책", explanation: "모든 구성원에게 적용됩니다.", items: group.policyIds.map((pid) => ({ service: { key: "iam" as const, itemId: pid, consolePath: `/iam/policies/${encodeURIComponent(pid)}` }, name: policyName(pid) })), empty: "연결된 정책이 없습니다.", field: "policyDocument" },
      ],
      checks: [],
      recommendations: [],
      items,
      selectedLabel: `그룹 ${group.name}`,
    };
  }
  if (policy) {
    const check = checkPolicyDocument(policy.document, "identity");
    const a = policyAttachments(project, policy.id);
    const attached: LinkedItem[] = [
      ...a.users.map((u) => ({ service: { key: "iam" as const, itemId: u.id, consolePath: `/iam/users/${u.id}` }, name: `사용자 ${u.name}` })),
      ...a.groups.map((g) => ({ service: { key: "iam" as const, itemId: g.id, consolePath: `/iam/groups/${g.id}` }, name: `그룹 ${g.name}` })),
      ...a.roles.map((r) => ({ service: { key: "iam" as const, itemId: r.id, consolePath: `/iam/roles/${r.id}` }, name: `역할 ${r.name}` })),
    ];
    return {
      headline: { tone: "info", text: `${policy.managed ? "AWS 관리형" : "고객 관리형"} · 문장 ${check.statements.length}개 · 연결 ${attached.length}곳` },
      facts: check.statements.map((s) => ({ label: `${s.sid ?? "문장"} (${s.effect})`, value: `${s.actions.join(", ")} → ${s.resources.join(", ")}${s.hasCondition ? " · Condition 미평가" : ""}`, field: s.effect === "Deny" ? "effect" : "action" })),
      relations: [{ label: "이 정책이 적용되는 대상", explanation: "정책 자체는 주체가 아니며, 연결된 사용자·그룹·역할에 권한을 줍니다.", items: attached, empty: "아무 곳에도 연결되지 않았습니다.", field: "managedPolicy" }],
      checks: [
        ...check.warnings.map((w) => ({ tone: "info" as const, title: "참고", detail: w, field: "condition" })),
        ...(check.statements.some((s) => s.effect === "Allow" && s.actions.includes("*") && s.resources.includes("*")) ? [{ tone: "warn" as const, title: "모든 작업·모든 리소스 허용", detail: "관리자 권한과 같습니다. 최소 권한 원칙에 맞는지 확인하세요.", field: "action" }] : []),
      ],
      recommendations: [],
      items,
      selectedLabel: `정책 ${policy.name}`,
    };
  }
  const recs = iamRecommendations(project);
  const roleUsers = roles.map((r) => ({ role: r, used: instancesUsingRole(project, r.id) }));
  return {
    headline: { tone: recs.some((r) => r.tone === "warn") ? "warn" : "ok", text: `사용자 ${users.length} · 그룹 ${groups.length} · 역할 ${roles.length} · 고객 관리형 정책 ${policies.length}` },
    facts: [
      { label: "사용자", value: `${users.length}명`, field: "user" },
      { label: "역할", value: `${roles.length}개`, field: "role" },
      { label: "활성 액세스 키 (가상)", value: `${users.reduce((n, u) => n + u.accessKeys.filter((k) => k.status === "Active").length, 0)}개`, field: "accessKey" },
    ],
    relations: [
      { label: "EC2가 쓰는 역할", explanation: "인스턴스 프로파일로 연결된 역할입니다.", items: roleUsers.filter((x) => x.used.length).map((x) => ({ service: { key: "iam" as const, itemId: x.role.id, consolePath: `/iam/roles/${x.role.id}` }, name: x.role.name, detail: `인스턴스 ${x.used.map((e) => displayName(e)).join(", ")}` })), empty: "역할을 쓰는 인스턴스가 없습니다.", field: "instanceProfile" },
      { label: "사용자", explanation: "사람이나 프로그램 하나를 나타냅니다.", items: users.map((u) => ({ service: { key: "iam" as const, itemId: u.id, consolePath: `/iam/users/${u.id}` }, name: u.name, detail: `정책 ${effectivePolicyIds(project, { kind: "user", user: u }).length}개 · 키 ${u.accessKeys.length}개` })), empty: "사용자가 없습니다. 심화 모드의 IAM에서 만들 수 있습니다.", field: "user" },
    ],
    checks: recs.map((r) => ({ tone: r.tone, title: r.title, detail: r.detail })),
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

// ---------------------------------------------------------------- CloudWatch

const ALARM_TONE: Record<AlarmState, AnalysisTone> = { OK: "ok", ALARM: "error", INSUFFICIENT_DATA: "info" };

function analyzeCloudWatch(input: AnalysisInput, options: ServiceAnalysisOptions): ServiceAnalysis {
  const { project } = input;
  const model = options.metricModel ?? buildMetricModel(project, input.topology, input.health);
  const now = options.now ?? Date.now();
  const { alarms, loads, dashboards } = project.services.cloudwatch;
  const states = alarms.map((a) => ({ alarm: a, history: alarmHistory(model, a, now, 120) }));
  const items = alarms.map((a) => ({ id: a.id, label: a.name }));
  const selected = states.find((s) => s.alarm.id === options.itemId);
  if (selected) {
    const { alarm, history } = selected;
    const def = metricDefinition(alarm.metric);
    const latest = [...metricSeries(model, alarm.metric, alarm.period, now - alarm.period * 1000 * 3, now)].reverse().find((d) => d.value !== null);
    return {
      headline: { tone: ALARM_TONE[history.current.state], text: `${history.current.state} · ${def?.label ?? alarm.metric.metricName} ${COMPARISON_SYMBOL[alarm.comparison]} ${alarm.threshold}` },
      facts: [
        { label: "지표", value: `${alarm.metric.namespace} · ${alarm.metric.metricName} (${alarm.metric.stat})`, field: "metricName" },
        { label: "기간", value: `${alarm.period}초`, field: "period" },
        { label: "조건", value: `${COMPARISON_SYMBOL[alarm.comparison]} ${alarm.threshold} · ${alarm.evaluationPeriods}개 중 ${alarm.datapointsToAlarm}개`, field: "threshold" },
        { label: "누락 데이터", value: alarm.treatMissingData, field: "treatMissingData" },
        { label: "최근 가상 측정값", value: latest ? formatMetricValue(latest.value, def?.unit) : "데이터 없음", field: "statistic" },
        { label: "알림", value: alarm.notify ? "콘솔 알림 (외부로 보내지 않음)" : "없음", field: "notification" },
      ],
      relations: [{ label: "감시 대상 리소스", explanation: "이 경보가 지켜보는 가상 리소스입니다.", items: resourceItem(project, alarm.metric.resourceId), field: "resourceDimension" }],
      checks: [
        { tone: ALARM_TONE[history.current.state], title: `현재 상태: ${history.current.state}`, detail: history.current.reason, field: "alarmState" },
        ...history.transitions.slice(0, 3).map((t) => ({ tone: ALARM_TONE[t.to], title: `${new Date(t.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} ${t.from} → ${t.to}`, detail: t.reason, field: "alarmState" })),
      ],
      recommendations: [],
      items,
      selectedLabel: alarm.name,
    };
  }
  const monitored = [...new Set(alarms.map((a) => a.metric.resourceId))];
  const activeLoads = loads.filter((l) => loadStatus(l, now) === "running");
  const checks: AnalysisCheck[] = states
    .filter((s) => s.history.current.state !== "OK")
    .map((s) => ({ tone: ALARM_TONE[s.history.current.state], title: `${s.alarm.name}: ${s.history.current.state}`, detail: s.history.current.reason, field: "alarmState" }));
  for (const l of model.loads.filter((x) => !x.reaches && loadStatus(x.load, now) !== "finished")) {
    checks.push({ tone: "warn", title: `가상 부하 ${l.load.name}: 대상에 도달하지 못함`, detail: l.reason, field: "virtualLoad" });
  }
  if (!alarms.length) checks.push({ tone: "info", title: "경보 없음", detail: "예: EC2 CPUUtilization > 70 경보를 만들어 과부하를 감지해 보세요.", field: "threshold" });
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: `경보 ${alarms.length}개 (ALARM ${states.filter((s) => s.history.current.state === "ALARM").length}) · 진행 중인 부하 ${activeLoads.length}개 · 대시보드 ${dashboards.length}개` },
    facts: [
      { label: "경보", value: `${alarms.length}개`, field: "alarmState" },
      { label: "진행 중인 가상 부하", value: `${activeLoads.length}개`, field: "virtualLoad" },
      { label: "대시보드", value: `${dashboards.length}개`, field: "dashboard" },
    ],
    relations: [
      { label: "모니터링 대상 리소스", explanation: "경보가 감시하는 가상 리소스입니다.", items: monitored.flatMap((id) => resourceItem(project, id)), empty: "경보가 감시하는 리소스가 없습니다.", field: "resourceDimension" },
      { label: "경보", explanation: "가상 지표와 임계값으로 계산한 상태입니다 (실제 수집값 아님).", items: states.map((s) => ({ service: { key: "cloudwatch" as const, itemId: s.alarm.id, consolePath: `/cloudwatch/alarms/${s.alarm.id}` }, name: s.alarm.name, detail: s.history.current.state, tone: ALARM_TONE[s.history.current.state] })), empty: "경보가 없습니다.", field: "alarmState" },
    ],
    checks,
    recommendations: [],
    items,
    selectedLabel: null,
  };
}

/** 서비스 항목을 직접 설정하는 심화 모드(콘솔) 경로 */
export function serviceConsolePath(project: Project, key: ServiceDocKey, itemId: string | null): string {
  if (key === "s3") return itemId && project.services.s3.buckets.some((b) => b.id === itemId) ? `/s3/buckets/${itemId}` : "/s3";
  if (key === "cloudwatch") return itemId && project.services.cloudwatch.alarms.some((a) => a.id === itemId) ? `/cloudwatch/alarms/${itemId}` : "/cloudwatch";
  if (!itemId) return "/iam";
  const { users, roles, groups } = project.services.iam;
  if (users.some((u) => u.id === itemId)) return `/iam/users/${itemId}`;
  if (roles.some((r) => r.id === itemId)) return `/iam/roles/${itemId}`;
  if (groups.some((g) => g.id === itemId)) return `/iam/groups/${itemId}`;
  if (allPolicies(project).some((p) => p.id === itemId)) return `/iam/policies/${encodeURIComponent(itemId)}`;
  return "/iam";
}

export function analyzeService(input: AnalysisInput, key: ServiceDocKey, options: ServiceAnalysisOptions = {}): ServiceAnalysis {
  if (key === "s3") return analyzeS3(input, options);
  if (key === "iam") return analyzeIam(input, options);
  return analyzeCloudWatch(input, options);
}
