/**
 * 가상 IAM 정책 엔진.
 * - 정책 JSON 검사(문법·필수 요소·지원 범위)
 * - 와일드카드(*, ?) 일치 판정
 * - 평가: 명시적 Deny > Allow > 암묵적 거부 (같은 계정 기준으로 단순화)
 * 실제 AWS 계정·자격 증명과 연결되지 않는다.
 */
import type { IamGroup, IamPolicy, IamRole, IamUser, Project } from "./resource-models";

/** 예시용 계정 ID (AWS 문서에서 쓰는 예시 값) */
export const SANDBOX_ACCOUNT_ID = "123456789012";

export interface PolicyPrincipal {
  any: boolean;
  aws: string[];
  service: string[];
}

export interface PolicyStatement {
  sid: string | null;
  effect: "Allow" | "Deny";
  actions: string[];
  resources: string[];
  principal: PolicyPrincipal | null;
  hasCondition: boolean;
}

export type PolicyKind = "identity" | "resource" | "trust";

export interface PolicyCheck {
  ok: boolean;
  statements: PolicyStatement[];
  errors: string[];
  warnings: string[];
}

export const KNOWN_SERVICES: Record<string, string> = {
  s3: "Amazon S3",
  ec2: "Amazon EC2 / VPC",
  iam: "IAM",
  rds: "Amazon RDS",
  cloudwatch: "CloudWatch",
  elasticloadbalancing: "Elastic Load Balancing",
  sts: "STS",
  logs: "CloudWatch Logs",
};

/** 정책 시뮬레이터와 편집기 도움말에 쓰는 대표 작업 목록 */
export const SERVICE_ACTIONS: { service: string; action: string; description: string; resource: "bucket" | "object" | "any" }[] = [
  { service: "s3", action: "ListAllMyBuckets", description: "버킷 목록 보기", resource: "any" },
  { service: "s3", action: "ListBucket", description: "버킷 안의 객체 목록 보기", resource: "bucket" },
  { service: "s3", action: "GetObject", description: "객체 내려받기(읽기)", resource: "object" },
  { service: "s3", action: "PutObject", description: "객체 올리기(쓰기)", resource: "object" },
  { service: "s3", action: "DeleteObject", description: "객체 삭제", resource: "object" },
  { service: "s3", action: "CreateBucket", description: "버킷 만들기", resource: "bucket" },
  { service: "s3", action: "DeleteBucket", description: "버킷 삭제", resource: "bucket" },
  { service: "s3", action: "PutBucketPolicy", description: "버킷 정책 변경", resource: "bucket" },
  { service: "ec2", action: "DescribeInstances", description: "인스턴스 목록 보기", resource: "any" },
  { service: "ec2", action: "RunInstances", description: "인스턴스 시작", resource: "any" },
  { service: "ec2", action: "StopInstances", description: "인스턴스 중지", resource: "any" },
  { service: "ec2", action: "TerminateInstances", description: "인스턴스 종료", resource: "any" },
  { service: "ec2", action: "CreateVpc", description: "VPC 만들기", resource: "any" },
  { service: "ec2", action: "AuthorizeSecurityGroupIngress", description: "보안 그룹 인바운드 규칙 추가", resource: "any" },
  { service: "rds", action: "DescribeDBInstances", description: "DB 목록 보기", resource: "any" },
  { service: "rds", action: "CreateDBInstance", description: "DB 만들기", resource: "any" },
  { service: "rds", action: "DeleteDBInstance", description: "DB 삭제", resource: "any" },
  { service: "iam", action: "ListUsers", description: "IAM 사용자 목록 보기", resource: "any" },
  { service: "iam", action: "CreateUser", description: "IAM 사용자 만들기", resource: "any" },
  { service: "iam", action: "CreateAccessKey", description: "액세스 키 만들기", resource: "any" },
  { service: "iam", action: "AttachUserPolicy", description: "사용자에게 정책 연결", resource: "any" },
  { service: "cloudwatch", action: "GetMetricData", description: "지표 조회", resource: "any" },
  { service: "cloudwatch", action: "PutMetricAlarm", description: "경보 만들기/수정", resource: "any" },
  { service: "elasticloadbalancing", action: "DescribeLoadBalancers", description: "로드 밸런서 목록 보기", resource: "any" },
];

export interface ManagedPolicy {
  id: string;
  name: string;
  description: string;
  document: string;
}

const doc = (statements: object[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements }, null, 2);

/** AWS 관리형 정책 (학습용으로 단순화한 버전) */
export const AWS_MANAGED_POLICIES: ManagedPolicy[] = [
  { id: "aws:AdministratorAccess", name: "AdministratorAccess", description: "모든 서비스와 리소스에 대한 전체 권한", document: doc([{ Effect: "Allow", Action: "*", Resource: "*" }]) },
  {
    id: "aws:ReadOnlyAccess",
    name: "ReadOnlyAccess",
    description: "모든 서비스의 조회(Get/List/Describe) 권한",
    document: doc([{ Effect: "Allow", Action: ["*:Get*", "*:List*", "*:Describe*"], Resource: "*" }]),
  },
  { id: "aws:AmazonS3FullAccess", name: "AmazonS3FullAccess", description: "S3 전체 권한", document: doc([{ Effect: "Allow", Action: "s3:*", Resource: "*" }]) },
  { id: "aws:AmazonS3ReadOnlyAccess", name: "AmazonS3ReadOnlyAccess", description: "S3 읽기 전용", document: doc([{ Effect: "Allow", Action: ["s3:Get*", "s3:List*"], Resource: "*" }]) },
  {
    id: "aws:AmazonEC2FullAccess",
    name: "AmazonEC2FullAccess",
    description: "EC2·로드 밸런서·지표 전체 권한",
    document: doc([{ Effect: "Allow", Action: ["ec2:*", "elasticloadbalancing:*", "cloudwatch:*"], Resource: "*" }]),
  },
  {
    id: "aws:AmazonEC2ReadOnlyAccess",
    name: "AmazonEC2ReadOnlyAccess",
    description: "EC2 조회 권한",
    document: doc([{ Effect: "Allow", Action: ["ec2:Describe*", "elasticloadbalancing:Describe*", "cloudwatch:Get*", "cloudwatch:List*", "cloudwatch:Describe*"], Resource: "*" }]),
  },
  {
    id: "aws:AmazonVPCFullAccess",
    name: "AmazonVPCFullAccess",
    description: "VPC 네트워크 리소스 전체 권한",
    document: doc([
      {
        Effect: "Allow",
        Action: ["ec2:*Vpc*", "ec2:*Subnet*", "ec2:*Route*", "ec2:*Gateway*", "ec2:*Address*", "ec2:*SecurityGroup*", "ec2:*NetworkAcl*", "ec2:Describe*"],
        Resource: "*",
      },
    ]),
  },
  { id: "aws:AmazonRDSFullAccess", name: "AmazonRDSFullAccess", description: "RDS 전체 권한", document: doc([{ Effect: "Allow", Action: ["rds:*", "ec2:Describe*", "cloudwatch:GetMetricData"], Resource: "*" }]) },
  { id: "aws:CloudWatchFullAccess", name: "CloudWatchFullAccess", description: "CloudWatch 전체 권한", document: doc([{ Effect: "Allow", Action: ["cloudwatch:*", "logs:*"], Resource: "*" }]) },
  { id: "aws:CloudWatchReadOnlyAccess", name: "CloudWatchReadOnlyAccess", description: "CloudWatch 조회 권한", document: doc([{ Effect: "Allow", Action: ["cloudwatch:Get*", "cloudwatch:List*", "cloudwatch:Describe*"], Resource: "*" }]) },
  { id: "aws:IAMReadOnlyAccess", name: "IAMReadOnlyAccess", description: "IAM 조회 권한", document: doc([{ Effect: "Allow", Action: ["iam:Get*", "iam:List*"], Resource: "*" }]) },
];

export function managedPolicy(id: string): ManagedPolicy | undefined {
  return AWS_MANAGED_POLICIES.find((p) => p.id === id);
}

// ---------------------------------------------------------------- ARN

export const userArn = (name: string) => `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:user/${name}`;
export const roleArn = (name: string) => `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:role/${name}`;
export const groupArn = (name: string) => `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:group/${name}`;
export const policyArn = (p: { id: string; name: string }) =>
  p.id.startsWith("aws:") ? `arn:aws:iam::aws:policy/${p.name}` : `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:policy/${p.name}`;
export const bucketArn = (bucket: string) => `arn:aws:s3:::${bucket}`;
export const objectArn = (bucket: string, key: string) => `arn:aws:s3:::${bucket}/${key}`;
export const ACCOUNT_ROOT_ARN = `arn:aws:iam::${SANDBOX_ACCOUNT_ID}:root`;

// ---------------------------------------------------------------- 정책 검사

const asArray = (v: unknown): unknown[] | null => (v === undefined ? null : Array.isArray(v) ? v : [v]);

function parsePrincipal(raw: unknown, errors: string[], index: number): PolicyPrincipal | null {
  if (raw === undefined) return null;
  if (raw === "*") return { any: true, aws: [], service: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`문장 ${index + 1}: Principal은 "*" 또는 {"AWS": ...}, {"Service": ...} 형식이어야 합니다.`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const principal: PolicyPrincipal = { any: false, aws: [], service: [] };
  for (const [key, value] of Object.entries(obj)) {
    const values = asArray(value);
    if (!values || values.some((v) => typeof v !== "string")) {
      errors.push(`문장 ${index + 1}: Principal.${key} 값은 문자열 또는 문자열 배열이어야 합니다.`);
      continue;
    }
    if (key === "AWS") {
      for (const v of values as string[]) {
        if (v === "*") principal.any = true;
        else principal.aws.push(v);
      }
    } else if (key === "Service") principal.service.push(...(values as string[]));
    else errors.push(`문장 ${index + 1}: 지원하지 않는 Principal 유형 "${key}"입니다. (AWS, Service만 지원)`);
  }
  return principal;
}

/** 정책 JSON을 검사한다. kind에 따라 Principal·Resource 필수 여부가 달라진다. */
export function checkPolicyDocument(text: string, kind: PolicyKind): PolicyCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, statements: [], errors: [`JSON 문법 오류: ${e instanceof Error ? e.message : String(e)}`], warnings };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, statements: [], errors: ["정책은 { } 객체여야 합니다."], warnings };
  }
  const root = parsed as Record<string, unknown>;
  if (root.Version === undefined) warnings.push('Version이 없습니다. 보통 "2012-10-17"을 씁니다.');
  else if (root.Version !== "2012-10-17") warnings.push(`Version "${String(root.Version)}"보다 "2012-10-17"을 권장합니다.`);
  const rawStatements = asArray(root.Statement);
  if (!rawStatements || rawStatements.length === 0) {
    return { ok: false, statements: [], errors: ["Statement가 없습니다. 하나 이상의 문장이 필요합니다."], warnings };
  }
  const statements: PolicyStatement[] = [];
  rawStatements.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`문장 ${i + 1}: 객체여야 합니다.`);
      return;
    }
    const s = raw as Record<string, unknown>;
    if (s.Effect !== "Allow" && s.Effect !== "Deny") errors.push(`문장 ${i + 1}: Effect는 "Allow" 또는 "Deny"여야 합니다.`);
    if (s.NotAction !== undefined || s.NotResource !== undefined || s.NotPrincipal !== undefined) {
      errors.push(`문장 ${i + 1}: NotAction/NotResource/NotPrincipal은 이 시뮬레이터에서 지원하지 않습니다.`);
    }
    const actions = asArray(s.Action);
    if (!actions || actions.length === 0) errors.push(`문장 ${i + 1}: Action이 필요합니다.`);
    else if (actions.some((a) => typeof a !== "string")) errors.push(`문장 ${i + 1}: Action은 문자열 또는 문자열 배열이어야 합니다.`);
    else {
      for (const a of actions as string[]) {
        if (a === "*") continue;
        const m = /^([a-z0-9*-]+):([A-Za-z0-9*?]+)$/.exec(a);
        if (!m) errors.push(`문장 ${i + 1}: Action "${a}"은(는) "서비스:작업" 형식이어야 합니다. 예: s3:GetObject`);
        else if (m[1] !== "*" && !KNOWN_SERVICES[m[1]]) warnings.push(`문장 ${i + 1}: "${m[1]}" 서비스는 이 시뮬레이터에서 다루지 않아 평가에 영향이 없습니다.`);
      }
    }
    const resources = asArray(s.Resource);
    if (kind !== "trust") {
      if (!resources || resources.length === 0) errors.push(`문장 ${i + 1}: Resource가 필요합니다.`);
      else if (resources.some((r) => typeof r !== "string")) errors.push(`문장 ${i + 1}: Resource는 문자열 또는 문자열 배열이어야 합니다.`);
      else for (const r of resources as string[]) if (r !== "*" && !r.startsWith("arn:")) errors.push(`문장 ${i + 1}: Resource "${r}"은(는) "*" 또는 ARN(arn:...)이어야 합니다.`);
    }
    let principal: PolicyPrincipal | null = null;
    if (kind === "identity") {
      if (s.Principal !== undefined) errors.push(`문장 ${i + 1}: IAM 자격 증명 정책에는 Principal을 쓸 수 없습니다. (버킷 정책 등 리소스 기반 정책에서만 사용)`);
    } else {
      if (s.Principal === undefined) errors.push(`문장 ${i + 1}: ${kind === "trust" ? "신뢰 정책" : "리소스 기반 정책"}에는 Principal이 필요합니다.`);
      principal = parsePrincipal(s.Principal, errors, i);
    }
    if (s.Condition !== undefined) warnings.push(`문장 ${i + 1}: Condition은 이 시뮬레이터에서 평가하지 않고 무시합니다.`);
    statements.push({
      sid: typeof s.Sid === "string" ? s.Sid : null,
      effect: s.Effect === "Deny" ? "Deny" : "Allow",
      actions: ((actions ?? []) as unknown[]).filter((a): a is string => typeof a === "string"),
      resources: ((resources ?? []) as unknown[]).filter((r): r is string => typeof r === "string"),
      principal,
      hasCondition: s.Condition !== undefined,
    });
  });
  return { ok: errors.length === 0, statements, errors, warnings };
}

// ---------------------------------------------------------------- 일치 판정

function wildcardRegex(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
}

/** 작업 이름은 대소문자를 구분하지 않는다 (AWS와 같음) */
export function actionMatches(pattern: string, action: string): boolean {
  return pattern === "*" || wildcardRegex(pattern, true).test(action);
}

/** ARN은 대소문자를 구분한다 */
export function resourceMatches(pattern: string, resource: string): boolean {
  return pattern === "*" || wildcardRegex(pattern, false).test(resource);
}

// ---------------------------------------------------------------- 평가

export type IamPrincipal = { kind: "user"; user: IamUser } | { kind: "role"; role: IamRole } | { kind: "anonymous" };

export interface PolicySource {
  /** 예: "사용자 alice에 직접 연결: AmazonS3ReadOnlyAccess" */
  label: string;
  type: "identity" | "resource";
  statements: PolicyStatement[];
}

export interface MatchedStatement {
  source: string;
  type: "identity" | "resource";
  statement: PolicyStatement;
}

export interface IamDecision {
  decision: "allowed" | "explicit-deny" | "implicit-deny";
  matched: MatchedStatement[];
  explanation: string[];
}

export function principalArn(p: IamPrincipal): string | null {
  if (p.kind === "user") return userArn(p.user.name);
  if (p.kind === "role") return roleArn(p.role.name);
  return null;
}

export function principalLabel(p: IamPrincipal): string {
  if (p.kind === "user") return `IAM 사용자 ${p.user.name}`;
  if (p.kind === "role") return `IAM 역할 ${p.role.name}`;
  return "익명 사용자(인터넷의 누구나)";
}

/** 정책 ID(관리형 또는 고객 관리형)의 문서 */
export function policyDocumentById(project: Project, id: string): { name: string; document: string } | null {
  const m = managedPolicy(id);
  if (m) return { name: m.name, document: m.document };
  const c = project.services.iam.policies.find((p) => p.id === id);
  return c ? { name: c.name, document: c.document } : null;
}

/** 주체에게 적용되는 자격 증명 기반 정책 */
export function identitySources(project: Project, p: IamPrincipal): PolicySource[] {
  if (p.kind === "anonymous") return [];
  const sources: PolicySource[] = [];
  const add = (policyIds: string[], via: string) => {
    for (const id of policyIds) {
      const d = policyDocumentById(project, id);
      if (!d) continue;
      const check = checkPolicyDocument(d.document, "identity");
      sources.push({ label: `${via}: ${d.name}`, type: "identity", statements: check.statements });
    }
  };
  if (p.kind === "user") {
    add(p.user.policyIds, `사용자 ${p.user.name}에 직접 연결`);
    for (const gid of p.user.groupIds) {
      const g = project.services.iam.groups.find((x) => x.id === gid);
      if (g) add(g.policyIds, `그룹 ${g.name}을(를) 통해`);
    }
  } else {
    add(p.role.policyIds, `역할 ${p.role.name}의 권한 정책`);
  }
  return sources;
}

function principalMatchesStatement(st: PolicyStatement, p: IamPrincipal): boolean {
  if (!st.principal) return false;
  if (st.principal.any) return true;
  const arn = principalArn(p);
  if (!arn) return false;
  // 계정 루트(arn:...:root)를 지정하면 같은 계정의 IAM 정책에 판단을 맡긴다 → 직접 허용으로 보지 않는다
  return st.principal.aws.includes(arn);
}

export interface EvaluateOptions {
  /** 리소스 기반 정책 (예: 버킷 정책) */
  resourcePolicy?: { label: string; statements: PolicyStatement[] } | null;
  /** 퍼블릭 버킷 제한(RestrictPublicBuckets): Principal "*" 허용을 익명 사용자에게 적용하지 않는다 */
  restrictPublic?: boolean;
}

/** IAM 평가 (같은 계정 기준): 명시적 Deny → Allow → 암묵적 거부 */
export function evaluateIam(project: Project, principal: IamPrincipal, action: string, resource: string, options: EvaluateOptions = {}): IamDecision {
  const explanation: string[] = [];
  const matched: MatchedStatement[] = [];
  const identity = identitySources(project, principal);
  if (principal.kind !== "anonymous") {
    explanation.push(identity.length ? `${principalLabel(principal)}에게 적용되는 IAM 정책 ${identity.length}개를 검사했습니다.` : `${principalLabel(principal)}에게 연결된 IAM 정책이 없습니다.`);
  }
  for (const src of identity) {
    for (const st of src.statements) {
      if (st.actions.some((a) => actionMatches(a, action)) && st.resources.some((r) => resourceMatches(r, resource))) matched.push({ source: src.label, type: "identity", statement: st });
    }
  }
  const rp = options.resourcePolicy;
  if (rp) {
    for (const st of rp.statements) {
      if (!principalMatchesStatement(st, principal)) continue;
      if (!(st.actions.some((a) => actionMatches(a, action)) && st.resources.some((r) => resourceMatches(r, resource)))) continue;
      if (options.restrictPublic && st.principal?.any && st.effect === "Allow" && principal.kind === "anonymous") {
        explanation.push(`${rp.label}에 익명 접근을 허용하는 문장이 있지만, 퍼블릭 액세스 차단(퍼블릭 버킷 제한)이 켜져 있어 적용되지 않습니다.`);
        continue;
      }
      matched.push({ source: rp.label, type: "resource", statement: st });
    }
  }
  const deny = matched.find((m) => m.statement.effect === "Deny");
  if (deny) {
    explanation.push(`명시적 Deny가 있습니다 (${deny.source}). Deny는 어떤 Allow보다 우선합니다.`);
    return { decision: "explicit-deny", matched, explanation };
  }
  const allow = matched.find((m) => m.statement.effect === "Allow");
  if (allow) {
    explanation.push(`Allow 문장이 일치합니다 (${allow.source}).`);
    return { decision: "allowed", matched, explanation };
  }
  explanation.push(`${action} 작업을 허용하는 문장이 없어 기본으로 거부됩니다 (암묵적 거부).`);
  return { decision: "implicit-deny", matched, explanation };
}

/** 역할의 신뢰 정책 문서 */
export function trustPolicyDocument(role: Pick<IamRole, "trustedEntity">): string {
  const principal = role.trustedEntity === "account" ? { AWS: ACCOUNT_ROOT_ARN } : { Service: role.trustedEntity };
  return JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: principal, Action: "sts:AssumeRole" }] }, null, 2);
}

/** 주체가 가진 정책 ID 전체 (그룹 포함) */
export function effectivePolicyIds(project: Project, p: IamPrincipal): string[] {
  if (p.kind === "user") {
    const ids = [...p.user.policyIds];
    for (const gid of p.user.groupIds) ids.push(...(project.services.iam.groups.find((g) => g.id === gid)?.policyIds ?? []));
    return [...new Set(ids)];
  }
  if (p.kind === "role") return p.role.policyIds;
  return [];
}

export function policyAttachments(project: Project, policyId: string): { users: IamUser[]; groups: IamGroup[]; roles: IamRole[] } {
  const { users, groups, roles } = project.services.iam;
  return {
    users: users.filter((u) => u.policyIds.includes(policyId)),
    groups: groups.filter((g) => g.policyIds.includes(policyId)),
    roles: roles.filter((r) => r.policyIds.includes(policyId)),
  };
}

export function allPolicies(project: Project): { id: string; name: string; description: string; managed: boolean; document: string; source?: IamPolicy }[] {
  return [
    ...AWS_MANAGED_POLICIES.map((p) => ({ id: p.id, name: p.name, description: p.description, managed: true, document: p.document })),
    ...project.services.iam.policies.map((p) => ({ id: p.id, name: p.name, description: p.description, managed: false, document: p.document, source: p })),
  ];
}
