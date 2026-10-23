/**
 * 가상 AWS 리소스의 타입과 Zod 스키마.
 * UI, 검증 엔진, 시뮬레이션 엔진이 모두 이 데이터 모델을 공유한다.
 *
 * 스키마는 "구조" (타입, 열거값, 숫자 범위)만 강제한다.
 * CIDR 포함 관계처럼 리소스 간 의미가 필요한 검사는 validation-engine이 담당한다.
 */
import { z } from "zod";

export const RESOURCE_TYPES = [
  "vpc",
  "subnet",
  "internet-gateway",
  "elastic-ip",
  "route-table",
  "nat-gateway",
  "security-group",
  "network-acl",
  "ec2",
  "alb",
  "target-group",
  "db-subnet-group",
  "rds",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** 시뮬레이터가 가정하는 가상 리전과 가용 영역. */
export const VIRTUAL_REGION = "ap-northeast-2";
export const AVAILABILITY_ZONES = [
  "ap-northeast-2a",
  "ap-northeast-2b",
  "ap-northeast-2c",
  "ap-northeast-2d",
] as const;

export const EC2_INSTANCE_TYPES = [
  "t3.micro",
  "t3.small",
  "t3.medium",
  "t3.large",
  "m5.large",
  "c5.large",
] as const;
export type Ec2InstanceType = (typeof EC2_INSTANCE_TYPES)[number];

export const EC2_AMIS = ["amazon-linux-2023", "ubuntu-24.04", "windows-server-2022"] as const;
export const EC2_STATES = ["pending", "running", "stopped", "terminated"] as const;
export type Ec2State = (typeof EC2_STATES)[number];

export const RDS_INSTANCE_CLASSES = ["db.t3.micro", "db.t3.small", "db.t3.medium", "db.m5.large"] as const;
export type RdsInstanceClass = (typeof RDS_INSTANCE_CLASSES)[number];

export const RDS_ENGINES = ["mysql", "postgres"] as const;
export type RdsEngine = (typeof RDS_ENGINES)[number];
export const RDS_DEFAULT_PORT: Record<RdsEngine, number> = { mysql: 3306, postgres: 5432 };

const id = z.string().min(1).max(64);
const cidrText = z.string().max(64);
const ipText = z.string().max(64);
const port = z.number().int().min(0).max(65535);

export const ruleProtocolSchema = z.enum(["tcp", "udp", "icmp", "all"]);
export type RuleProtocol = z.infer<typeof ruleProtocolSchema>;

export const sgRulePeerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cidr"), cidr: cidrText }),
  z.object({ kind: z.literal("security-group"), securityGroupId: id }),
]);
export type SgRulePeer = z.infer<typeof sgRulePeerSchema>;

export const sgRuleSchema = z.object({
  id,
  protocol: ruleProtocolSchema,
  fromPort: port,
  toPort: port,
  peer: sgRulePeerSchema,
  description: z.string().max(255).default(""),
});
export type SgRule = z.infer<typeof sgRuleSchema>;

export const naclRuleSchema = z.object({
  id,
  ruleNumber: z.number().int().min(1).max(32766),
  protocol: ruleProtocolSchema,
  fromPort: port,
  toPort: port,
  cidr: cidrText,
  action: z.enum(["allow", "deny"]),
});
export type NaclRule = z.infer<typeof naclRuleSchema>;

/** 리스너 규칙의 작업: 대상 그룹으로 전달하거나, ALB가 직접 고정 응답을 돌려준다 */
export const listenerRuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forward"), targetGroupId: id }),
  z.object({
    type: z.literal("fixed-response"),
    statusCode: z.number().int().min(200).max(599),
    contentType: z.enum(["text/plain", "text/html", "application/json"]),
    body: z.string().max(1024),
  }),
]);
export type ListenerRuleAction = z.infer<typeof listenerRuleActionSchema>;

/** 리스너 규칙: 경로 조건이 맞으면 기본 작업 대신 이 작업을 한다 (우선순위 숫자가 작은 규칙부터 평가) */
export const listenerRuleSchema = z.object({
  id,
  priority: z.number().int().min(1).max(50000),
  /** 경로 패턴 (예: /api/*). 와일드카드 * 와 ? 사용 가능, 대소문자 구분 */
  pathPatterns: z.array(z.string().min(1).max(128)).min(1).max(5),
  action: listenerRuleActionSchema,
});
export type ListenerRule = z.infer<typeof listenerRuleSchema>;

export const listenerSchema = z.object({
  id,
  protocol: z.enum(["HTTP", "HTTPS"]),
  port: z.number().int().min(1).max(65535),
  rules: z.array(listenerRuleSchema).max(20).default([]),
});
export type Listener = z.infer<typeof listenerSchema>;

export const healthCheckSchema = z.object({
  protocol: z.enum(["HTTP", "HTTPS"]),
  path: z.string().max(1024),
  port: z.union([z.literal("traffic-port"), z.number().int().min(1).max(65535)]),
  healthyThreshold: z.number().int().min(0).max(1000),
  unhealthyThreshold: z.number().int().min(0).max(1000),
  timeoutSeconds: z.number().int().min(0).max(10000),
  intervalSeconds: z.number().int().min(0).max(10000),
  matcher: z.string().max(64),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const configSchemas = {
  vpc: z.object({
    cidr: cidrText,
    enableDnsSupport: z.boolean(),
    enableDnsHostnames: z.boolean(),
    /** AWS 기본 VPC 여부 (콘솔의 "기본 VPC 생성"으로 만든 VPC) */
    isDefault: z.boolean().default(false),
  }),
  subnet: z.object({
    cidr: cidrText,
    availabilityZone: z.string().max(32),
    mapPublicIpOnLaunch: z.boolean(),
  }),
  "internet-gateway": z.object({}),
  "elastic-ip": z.object({
    /** 할당 시 정해지는 가상 퍼블릭 IPv4 주소 (실제 공인 IP 아님) */
    publicIp: ipText,
  }),
  "route-table": z.object({
    /** VPC의 기본(main) 라우팅 테이블 여부. 명시적 연결이 없는 서브넷이 사용한다. */
    main: z.boolean(),
  }),
  "nat-gateway": z.object({
    state: z.enum(["pending", "available", "failed"]),
  }),
  "security-group": z.object({
    description: z.string().max(255),
    inboundRules: z.array(sgRuleSchema).max(60),
    outboundRules: z.array(sgRuleSchema).max(60),
    /** VPC를 만들 때 AWS가 자동으로 만드는 기본 보안 그룹 여부 (삭제 불가) */
    isDefault: z.boolean().default(false),
  }),
  "network-acl": z.object({
    inboundRules: z.array(naclRuleSchema).max(40),
    outboundRules: z.array(naclRuleSchema).max(40),
    /** VPC를 만들 때 AWS가 자동으로 만드는 기본 네트워크 ACL 여부 (삭제 불가) */
    isDefault: z.boolean().default(false),
  }),
  ec2: z.object({
    ami: z.enum(EC2_AMIS),
    instanceType: z.enum(EC2_INSTANCE_TYPES),
    privateIp: ipText,
    publicIpMode: z.enum(["subnet-default", "enabled", "disabled"]),
    state: z.enum(EC2_STATES),
    /** 가상 서비스가 대기 중이라고 가정하는 포트 (실제 프로세스는 없다). */
    listenPorts: z.array(port).max(20),
    /** HTTP 요청(헬스 체크 포함)에 대한 가상 애플리케이션 응답 코드. */
    httpResponseCode: z.number().int().min(100).max(599),
    /** 가상 사용자 데이터 (표시용 스크립트, 실행되지 않음) */
    userData: z.string().max(16384).default(""),
    /** 인스턴스 프로파일로 연결한 IAM 역할 ID */
    iamRoleId: z.string().max(64).nullable().default(null),
  }),
  alb: z.object({
    scheme: z.enum(["internet-facing", "internal"]),
    listeners: z.array(listenerSchema).max(10),
    state: z.enum(["provisioning", "active"]).default("active"),
  }),
  "target-group": z.object({
    protocol: z.enum(["HTTP", "HTTPS"]),
    port: z.number().int().min(1).max(65535),
    healthCheck: healthCheckSchema,
  }),
  "db-subnet-group": z.object({
    description: z.string().max(255),
  }),
  rds: z.object({
    engine: z.enum(RDS_ENGINES),
    instanceClass: z.enum(RDS_INSTANCE_CLASSES),
    port: z.number().int().min(1150).max(65535),
    publiclyAccessible: z.boolean(),
    multiAz: z.boolean(),
    allocatedStorageGb: z.number().int().min(20).max(65536),
    state: z.enum(["creating", "available", "stopped"]),
  }),
} as const;

export const positionSchema = z.object({ x: z.number(), y: z.number() });

const resourceBase = {
  id,
  /** Name 태그. AWS처럼 선택 사항이며 비어 있으면 ID로 표시한다. */
  name: z.string().trim().max(128),
  position: positionSchema,
};

export const resourceSchema = z.discriminatedUnion("type", [
  z.object({ ...resourceBase, type: z.literal("vpc"), config: configSchemas.vpc }),
  z.object({ ...resourceBase, type: z.literal("subnet"), config: configSchemas.subnet }),
  z.object({ ...resourceBase, type: z.literal("internet-gateway"), config: configSchemas["internet-gateway"] }),
  z.object({ ...resourceBase, type: z.literal("elastic-ip"), config: configSchemas["elastic-ip"] }),
  z.object({ ...resourceBase, type: z.literal("route-table"), config: configSchemas["route-table"] }),
  z.object({ ...resourceBase, type: z.literal("nat-gateway"), config: configSchemas["nat-gateway"] }),
  z.object({ ...resourceBase, type: z.literal("security-group"), config: configSchemas["security-group"] }),
  z.object({ ...resourceBase, type: z.literal("network-acl"), config: configSchemas["network-acl"] }),
  z.object({ ...resourceBase, type: z.literal("ec2"), config: configSchemas.ec2 }),
  z.object({ ...resourceBase, type: z.literal("alb"), config: configSchemas.alb }),
  z.object({ ...resourceBase, type: z.literal("target-group"), config: configSchemas["target-group"] }),
  z.object({ ...resourceBase, type: z.literal("db-subnet-group"), config: configSchemas["db-subnet-group"] }),
  z.object({ ...resourceBase, type: z.literal("rds"), config: configSchemas.rds }),
]);

export type Resource = z.infer<typeof resourceSchema>;
export type ResourceOfType<T extends ResourceType> = Extract<Resource, { type: T }>;
export type ConfigOf<T extends ResourceType> = ResourceOfType<T>["config"];

export const RELATION_TYPES = [
  "vpc-subnet",
  "vpc-internet-gateway",
  "vpc-route-table",
  "vpc-security-group",
  "vpc-network-acl",
  "route-table-subnet",
  "route-table-internet-gateway",
  "route-table-nat-gateway",
  "network-acl-subnet",
  "nat-gateway-subnet",
  "ec2-subnet",
  "ec2-security-group",
  "alb-subnet",
  "alb-security-group",
  "alb-target-group",
  "target-group-ec2",
  "db-subnet-group-subnet",
  "rds-db-subnet-group",
  "rds-security-group",
  "elastic-ip-nat-gateway",
  "elastic-ip-ec2",
  "vpc-target-group",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const ROUTE_RELATIONS = ["route-table-internet-gateway", "route-table-nat-gateway"] as const;
export type RouteRelationType = (typeof ROUTE_RELATIONS)[number];

const PLAIN_RELATIONS = RELATION_TYPES.filter(
  (r): r is Exclude<RelationType, RouteRelationType | "alb-target-group"> =>
    r !== "route-table-internet-gateway" && r !== "route-table-nat-gateway" && r !== "alb-target-group",
) as unknown as readonly [
  Exclude<RelationType, RouteRelationType | "alb-target-group">,
  ...Exclude<RelationType, RouteRelationType | "alb-target-group">[],
];

const connectionBase = {
  id,
  sourceResourceId: id,
  targetResourceId: id,
};

export const routeMetadataSchema = z.object({ destinationCidr: cidrText });
export const listenerForwardMetadataSchema = z.object({ listenerId: id });

export const connectionSchema = z.union([
  z.object({
    ...connectionBase,
    relationType: z.enum(ROUTE_RELATIONS),
    metadata: routeMetadataSchema,
  }),
  z.object({
    ...connectionBase,
    relationType: z.literal("alb-target-group"),
    metadata: listenerForwardMetadataSchema,
  }),
  z.object({
    ...connectionBase,
    relationType: z.enum(PLAIN_RELATIONS),
    metadata: z.object({}).default({}),
  }),
]);
export type Connection = z.infer<typeof connectionSchema>;
export type RouteConnection = Extract<Connection, { relationType: RouteRelationType }>;
export type ListenerForwardConnection = Extract<Connection, { relationType: "alb-target-group" }>;

export const endpointSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("internet"), ip: z.string().max(64) }),
  z.object({ kind: z.literal("resource"), resourceId: id, addressing: z.enum(["auto", "private", "public"]).optional() }),
]);

export const simulationRequestSchema = z.object({
  source: endpointSpecSchema,
  destination: endpointSpecSchema,
  protocol: z.enum(["tcp", "udp", "icmp"]),
  port: z.number().int().min(0).max(65535),
  ephemeralPort: z.number().int().min(1024).max(65535).optional(),
  requestCount: z.number().int().min(1).max(100).optional(),
  /** ALB 목적지일 때 리스너 규칙을 평가할 HTTP 경로 (기본 "/") */
  httpPath: z.string().max(256).optional(),
});

/** Reachability Analyzer처럼 저장해 두고 반복 분석하는 네트워크 경로 */
export const networkPathSchema = z.object({
  id,
  name: z.string().trim().max(128).default(""),
  request: simulationRequestSchema,
  createdAt: z.string().min(1),
  lastAnalysis: z
    .object({
      at: z.string().min(1),
      outcome: z.enum(["success", "failure", "invalid-request", "engine-error"]),
      summary: z.string().max(2000),
    })
    .nullable()
    .default(null),
});
export type NetworkPath = z.infer<typeof networkPathSchema>;

export const viewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const costAssumptionsSchema = z.object({
  hoursPerMonth: z.number().min(0).max(744),
  dataProcessedGb: z.number().min(0).max(1_000_000),
  dataTransferOutGb: z.number().min(0).max(1_000_000),
  ec2Hourly: z.record(z.string(), z.number().min(0)),
  rdsHourly: z.record(z.string(), z.number().min(0)),
  rdsStorageGbMonth: z.number().min(0),
  natHourly: z.number().min(0),
  natPerGb: z.number().min(0),
  albHourly: z.number().min(0),
  albPerGb: z.number().min(0),
  publicIpv4Hourly: z.number().min(0),
  dataTransferOutPerGb: z.number().min(0),
});
export type CostAssumptions = z.infer<typeof costAssumptionsSchema>;

export const PROJECT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// VPC 밖의 서비스 (IAM, S3, CloudWatch). 모두 가상이며 실제 AWS와 연결되지 않는다.
// ---------------------------------------------------------------------------

const timestamp = z.string().min(1).max(40);
const iamName = z.string().trim().min(1).max(128);
/** AWS 관리형 정책은 "aws:정책이름", 고객 관리형 정책은 정책 ID */
const policyRef = z.string().min(1).max(160);

export const iamAccessKeySchema = z.object({
  /** 가상 액세스 키 ID — 실제 AWS 키와 구별되도록 PGSIM으로 시작한다 */
  id: z.string().min(1).max(64),
  /** 비밀 키는 저장하지 않고 마지막 4자리만 보관한다 (AWS도 다시 보여 주지 않음) */
  secretHint: z.string().max(16),
  status: z.enum(["Active", "Inactive"]),
  useCase: z.string().max(64).default(""),
  description: z.string().max(256).default(""),
  createdAt: timestamp,
});
export type IamAccessKey = z.infer<typeof iamAccessKeySchema>;

export const iamUserSchema = z.object({
  id,
  name: iamName,
  createdAt: timestamp,
  groupIds: z.array(id).max(10).default([]),
  policyIds: z.array(policyRef).max(20).default([]),
  accessKeys: z.array(iamAccessKeySchema).max(2).default([]),
  /** 콘솔 로그인 허용 여부 (가상 — 암호는 받지 않는다) */
  consoleAccess: z.boolean().default(false),
  mfaEnabled: z.boolean().default(false),
});
export type IamUser = z.infer<typeof iamUserSchema>;

export const iamGroupSchema = z.object({
  id,
  name: iamName,
  createdAt: timestamp,
  policyIds: z.array(policyRef).max(20).default([]),
});
export type IamGroup = z.infer<typeof iamGroupSchema>;

export const IAM_TRUSTED_ENTITIES = ["ec2.amazonaws.com", "lambda.amazonaws.com", "account"] as const;

export const iamRoleSchema = z.object({
  id,
  name: iamName,
  description: z.string().max(1000).default(""),
  trustedEntity: z.enum(IAM_TRUSTED_ENTITIES),
  createdAt: timestamp,
  policyIds: z.array(policyRef).max(20).default([]),
});
export type IamRole = z.infer<typeof iamRoleSchema>;

export const iamPolicySchema = z.object({
  id,
  name: iamName,
  description: z.string().max(1000).default(""),
  /** 정책 문서 JSON (검증 후 저장) */
  document: z.string().max(10000),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type IamPolicy = z.infer<typeof iamPolicySchema>;

export const s3ObjectVersionSchema = z.object({
  versionId: z.string().max(64),
  size: z.number().int().min(0),
  etag: z.string().max(64),
  lastModified: timestamp,
  contentType: z.string().max(128).default("application/octet-stream"),
  text: z.string().max(65536).nullable().default(null),
  /** 이 버전이 삭제 마커인지 */
  deleteMarker: z.boolean().default(false),
});
export type S3ObjectVersion = z.infer<typeof s3ObjectVersionSchema>;

export const s3ObjectSchema = z.object({
  key: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  contentType: z.string().max(128).default("application/octet-stream"),
  etag: z.string().max(64),
  lastModified: timestamp,
  versionId: z.string().max(64).default("null"),
  /** 작은 텍스트 파일만 내용을 보관한다 (미리보기·웹사이트 응답용) */
  text: z.string().max(65536).nullable().default(null),
  /** 버전 관리가 켜진 버킷에서 삭제하면 삭제 마커만 남는다 */
  deleteMarker: z.boolean().default(false),
  /** 이전 버전 (최신순) */
  previousVersions: z.array(s3ObjectVersionSchema).max(20).default([]),
});
export type S3Object = z.infer<typeof s3ObjectSchema>;

export const s3BucketSchema = z.object({
  id,
  name: z.string().min(3).max(63),
  createdAt: timestamp,
  blockPublicAccess: z.object({
    blockPublicAcls: z.boolean(),
    ignorePublicAcls: z.boolean(),
    blockPublicPolicy: z.boolean(),
    restrictPublicBuckets: z.boolean(),
  }),
  versioning: z.enum(["Disabled", "Enabled", "Suspended"]).default("Disabled"),
  encryption: z.enum(["SSE-S3", "SSE-KMS"]).default("SSE-S3"),
  policy: z.string().max(20000).default(""),
  website: z
    .object({ enabled: z.boolean(), indexDocument: z.string().max(1024), errorDocument: z.string().max(1024) })
    .default({ enabled: false, indexDocument: "index.html", errorDocument: "" }),
  objects: z.array(s3ObjectSchema).max(500).default([]),
});
export type S3Bucket = z.infer<typeof s3BucketSchema>;

export const METRIC_NAMESPACES = ["AWS/EC2", "AWS/ApplicationELB", "AWS/RDS", "AWS/NATGateway"] as const;
export const METRIC_STATS = ["Average", "Sum", "Maximum", "Minimum"] as const;

export const metricRefSchema = z.object({
  namespace: z.enum(METRIC_NAMESPACES),
  metricName: z.string().min(1).max(64),
  resourceId: id,
  stat: z.enum(METRIC_STATS).default("Average"),
});
export type MetricRef = z.infer<typeof metricRefSchema>;

export const ALARM_COMPARISONS = ["GreaterThanThreshold", "GreaterThanOrEqualToThreshold", "LessThanThreshold", "LessThanOrEqualToThreshold"] as const;

export const alarmSchema = z.object({
  id,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(1024).default(""),
  metric: metricRefSchema,
  /** 기간 (초) */
  period: z.number().int().refine((v) => v === 60 || v === 300 || v === 900, "기간은 60, 300, 900초 중 하나입니다."),
  comparison: z.enum(ALARM_COMPARISONS),
  threshold: z.number().finite(),
  evaluationPeriods: z.number().int().min(1).max(10),
  datapointsToAlarm: z.number().int().min(1).max(10),
  treatMissingData: z.enum(["missing", "notBreaching", "breaching", "ignore"]).default("missing"),
  /** 경보 상태가 바뀌면 가상 알림(SNS 대신 콘솔 토스트·알림 기록)을 남긴다 */
  notify: z.boolean().default(true),
  createdAt: timestamp,
});
export type Alarm = z.infer<typeof alarmSchema>;

export const dashboardWidgetSchema = z.object({
  id,
  title: z.string().trim().min(1).max(100),
  type: z.enum(["line", "number"]),
  metrics: z.array(metricRefSchema).min(1).max(5),
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardSchema = z.object({
  id,
  name: z.string().trim().min(1).max(255),
  createdAt: timestamp,
  widgets: z.array(dashboardWidgetSchema).max(20).default([]),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

/** 가상 부하: 정해진 시간 동안 대상(ALB 또는 EC2)에 분당 요청을 보낸다고 가정한다 */
export const loadTestSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  targetId: id,
  port: port,
  requestsPerMinute: z.number().int().min(1).max(100000),
  startAt: timestamp,
  durationMinutes: z.number().int().min(1).max(1440),
  createdAt: timestamp,
});
export type LoadTest = z.infer<typeof loadTestSchema>;

export const EMPTY_SERVICES = {
  iam: { users: [], groups: [], roles: [], policies: [] },
  s3: { buckets: [] },
  cloudwatch: { alarms: [], dashboards: [], loads: [] },
};

export const servicesSchema = z
  .object({
    iam: z
      .object({
        users: z.array(iamUserSchema).max(100).default([]),
        groups: z.array(iamGroupSchema).max(50).default([]),
        roles: z.array(iamRoleSchema).max(50).default([]),
        policies: z.array(iamPolicySchema).max(100).default([]),
      })
      .default({ users: [], groups: [], roles: [], policies: [] }),
    s3: z.object({ buckets: z.array(s3BucketSchema).max(100).default([]) }).default({ buckets: [] }),
    cloudwatch: z
      .object({
        alarms: z.array(alarmSchema).max(100).default([]),
        dashboards: z.array(dashboardSchema).max(20).default([]),
        loads: z.array(loadTestSchema).max(50).default([]),
      })
      .default({ alarms: [], dashboards: [], loads: [] }),
  })
  .default(EMPTY_SERVICES);
export type Services = z.infer<typeof servicesSchema>;

export const projectSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(""),
  resources: z.array(resourceSchema).max(500),
  connections: z.array(connectionSchema).max(3000),
  viewport: viewportSchema.nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  labId: z.string().nullable().default(null),
  costAssumptions: costAssumptionsSchema.nullable().default(null),
  networkPaths: z.array(networkPathSchema).max(200).default([]),
  services: servicesSchema,
  /** 이 샌드박스를 열 때 쓰는 화면 (쉬운 모드: 그림 빌더, 심화 모드: 콘솔) */
  preferredMode: z.enum(["easy", "console"]).default("console"),
});
export type Project = z.infer<typeof projectSchema>;

// ---------------------------------------------------------------------------
// 관계(연결) 카탈로그
// ---------------------------------------------------------------------------

export type RelationCategory =
  | "membership"
  | "attachment"
  | "association"
  | "route"
  | "placement"
  | "security"
  | "traffic";

export interface RelationSpec {
  type: RelationType;
  source: ResourceType;
  target: ResourceType;
  /** 캔버스 연결선에 표시하는 짧은 이름 */
  label: string;
  description: string;
  category: RelationCategory;
  /** 하나의 source가 가질 수 있는 최대 연결 수 */
  maxPerSource?: number;
  /** 하나의 target이 가질 수 있는 최대 연결 수 */
  maxPerTarget?: number;
  /** AWS에서 리소스를 만들 때 정해지고 이후 변경할 수 없는 관계 */
  immutable?: boolean;
}

export const RELATION_SPECS: Record<RelationType, RelationSpec> = {
  "vpc-subnet": {
    type: "vpc-subnet",
    source: "vpc",
    target: "subnet",
    label: "소속",
    description: "서브넷은 정확히 하나의 VPC에 속하며 VPC CIDR 범위 안의 주소를 사용합니다.",
    category: "membership",
    maxPerTarget: 1,
    immutable: true,
  },
  "vpc-internet-gateway": {
    type: "vpc-internet-gateway",
    source: "vpc",
    target: "internet-gateway",
    label: "연결(Attach)",
    description: "인터넷 게이트웨이는 한 번에 하나의 VPC에만 연결되며, VPC도 하나의 인터넷 게이트웨이만 가질 수 있습니다.",
    category: "attachment",
    maxPerSource: 1,
    maxPerTarget: 1,
  },
  "vpc-route-table": {
    type: "vpc-route-table",
    source: "vpc",
    target: "route-table",
    label: "소속",
    description: "라우팅 테이블은 하나의 VPC에 속합니다.",
    category: "membership",
    maxPerTarget: 1,
    immutable: true,
  },
  "vpc-security-group": {
    type: "vpc-security-group",
    source: "vpc",
    target: "security-group",
    label: "소속",
    description: "보안 그룹은 하나의 VPC에 속하며 같은 VPC의 리소스에만 연결할 수 있습니다.",
    category: "membership",
    maxPerTarget: 1,
    immutable: true,
  },
  "vpc-network-acl": {
    type: "vpc-network-acl",
    source: "vpc",
    target: "network-acl",
    label: "소속",
    description: "네트워크 ACL은 하나의 VPC에 속합니다.",
    category: "membership",
    maxPerTarget: 1,
    immutable: true,
  },
  "route-table-subnet": {
    type: "route-table-subnet",
    source: "route-table",
    target: "subnet",
    label: "연결(Association)",
    description: "서브넷은 한 번에 하나의 라우팅 테이블과 명시적으로 연결됩니다. 연결이 없으면 VPC의 기본(main) 라우팅 테이블을 사용합니다.",
    category: "association",
    maxPerTarget: 1,
  },
  "route-table-internet-gateway": {
    type: "route-table-internet-gateway",
    source: "route-table",
    target: "internet-gateway",
    label: "경로",
    description: "라우팅 테이블의 경로(Destination → Internet Gateway). 보통 0.0.0.0/0 기본 경로로 사용합니다.",
    category: "route",
  },
  "route-table-nat-gateway": {
    type: "route-table-nat-gateway",
    source: "route-table",
    target: "nat-gateway",
    label: "경로",
    description: "라우팅 테이블의 경로(Destination → NAT Gateway). 프라이빗 서브넷의 외부 IPv4 통신에 사용합니다.",
    category: "route",
  },
  "network-acl-subnet": {
    type: "network-acl-subnet",
    source: "network-acl",
    target: "subnet",
    label: "연결(Association)",
    description: "서브넷은 하나의 네트워크 ACL과 연결됩니다. 연결이 없으면 VPC 기본 NACL(모두 허용)을 사용한다고 가정합니다.",
    category: "association",
    maxPerTarget: 1,
  },
  "nat-gateway-subnet": {
    type: "nat-gateway-subnet",
    source: "nat-gateway",
    target: "subnet",
    label: "배치",
    description: "퍼블릭 NAT 게이트웨이는 하나의 (퍼블릭) 서브넷에 배치됩니다.",
    category: "placement",
    maxPerSource: 1,
    immutable: true,
  },
  "ec2-subnet": {
    type: "ec2-subnet",
    source: "ec2",
    target: "subnet",
    label: "배치",
    description: "EC2 인스턴스의 기본 네트워크 인터페이스는 하나의 서브넷에 배치됩니다.",
    category: "placement",
    maxPerSource: 1,
    immutable: true,
  },
  "ec2-security-group": {
    type: "ec2-security-group",
    source: "ec2",
    target: "security-group",
    label: "보안 그룹",
    description: "인스턴스에는 같은 VPC의 보안 그룹을 최대 5개까지 연결할 수 있습니다.",
    category: "security",
    maxPerSource: 5,
  },
  "alb-subnet": {
    type: "alb-subnet",
    source: "alb",
    target: "subnet",
    label: "배치",
    description: "ALB는 가용 영역당 하나의 서브넷에 노드를 배치하며, 최소 2개의 가용 영역이 필요합니다.",
    category: "placement",
  },
  "alb-security-group": {
    type: "alb-security-group",
    source: "alb",
    target: "security-group",
    label: "보안 그룹",
    description: "ALB에는 같은 VPC의 보안 그룹을 최대 5개까지 연결할 수 있습니다.",
    category: "security",
    maxPerSource: 5,
  },
  "alb-target-group": {
    type: "alb-target-group",
    source: "alb",
    target: "target-group",
    label: "전달",
    description: "리스너의 기본 작업이 대상 그룹으로 요청을 전달(forward)합니다.",
    category: "traffic",
  },
  "target-group-ec2": {
    type: "target-group-ec2",
    source: "target-group",
    target: "ec2",
    label: "대상 등록",
    description: "대상 그룹에 EC2 인스턴스를 대상으로 등록합니다. 대상은 같은 VPC에 있어야 합니다.",
    category: "traffic",
  },
  "db-subnet-group-subnet": {
    type: "db-subnet-group-subnet",
    source: "db-subnet-group",
    target: "subnet",
    label: "포함",
    description: "DB 서브넷 그룹은 같은 VPC의 서브넷으로 구성되며, 최소 2개 가용 영역의 서브넷이 필요합니다.",
    category: "membership",
  },
  "rds-db-subnet-group": {
    type: "rds-db-subnet-group",
    source: "rds",
    target: "db-subnet-group",
    label: "배치",
    description: "RDS 인스턴스는 DB 서브넷 그룹의 서브넷에 배치됩니다.",
    category: "placement",
    maxPerSource: 1,
    immutable: true,
  },
  "elastic-ip-nat-gateway": {
    type: "elastic-ip-nat-gateway",
    source: "elastic-ip",
    target: "nat-gateway",
    label: "EIP",
    description: "퍼블릭 NAT 게이트웨이는 만들 때 탄력적 IP 하나를 지정하며, 이 주소로 아웃바운드 트래픽을 변환합니다.",
    category: "attachment",
    maxPerSource: 1,
    maxPerTarget: 1,
    immutable: true,
  },
  "elastic-ip-ec2": {
    type: "elastic-ip-ec2",
    source: "elastic-ip",
    target: "ec2",
    label: "EIP 연결",
    description: "탄력적 IP를 인스턴스에 연결하면 고정 퍼블릭 IPv4 주소가 됩니다. 인스턴스의 VPC에 인터넷 게이트웨이가 연결되어 있어야 합니다.",
    category: "attachment",
    maxPerSource: 1,
    maxPerTarget: 1,
  },
  "vpc-target-group": {
    type: "vpc-target-group",
    source: "vpc",
    target: "target-group",
    label: "소속",
    description: "대상 그룹은 만들 때 지정한 VPC에 속하며, 같은 VPC의 인스턴스만 대상으로 등록할 수 있습니다.",
    category: "membership",
    maxPerTarget: 1,
    immutable: true,
  },
  "rds-security-group": {
    type: "rds-security-group",
    source: "rds",
    target: "security-group",
    label: "보안 그룹",
    description: "RDS 인스턴스에는 같은 VPC의 보안 그룹을 연결합니다.",
    category: "security",
    maxPerSource: 5,
  },
};

/** 두 리소스 타입 사이의 관계를 (방향과 무관하게) 찾는다. */
export function findRelationSpec(
  a: ResourceType,
  b: ResourceType,
): { spec: RelationSpec; reversed: boolean } | null {
  for (const spec of Object.values(RELATION_SPECS)) {
    if (spec.source === a && spec.target === b) return { spec, reversed: false };
    if (spec.source === b && spec.target === a) return { spec, reversed: true };
  }
  return null;
}

export function relationsForType(type: ResourceType): RelationSpec[] {
  return Object.values(RELATION_SPECS).filter((s) => s.source === type || s.target === type);
}

// ---------------------------------------------------------------------------
// 표시용 메타데이터
// ---------------------------------------------------------------------------

export interface ResourceTypeInfo {
  type: ResourceType;
  label: string;
  shortLabel: string;
  idPrefix: string;
  category: "networking" | "security" | "compute" | "load-balancing" | "database";
  description: string;
}

export const RESOURCE_TYPE_INFO: Record<ResourceType, ResourceTypeInfo> = {
  vpc: {
    type: "vpc",
    label: "VPC",
    shortLabel: "VPC",
    idPrefix: "vpc",
    category: "networking",
    description: "격리된 가상 네트워크. IPv4 CIDR 블록으로 주소 범위를 정의합니다.",
  },
  subnet: {
    type: "subnet",
    label: "Subnet",
    shortLabel: "Subnet",
    idPrefix: "subnet",
    category: "networking",
    description: "VPC 주소 범위의 일부. 하나의 가용 영역에 속합니다.",
  },
  "internet-gateway": {
    type: "internet-gateway",
    label: "Internet Gateway",
    shortLabel: "IGW",
    idPrefix: "igw",
    category: "networking",
    description: "VPC와 인터넷 사이의 통신을 가능하게 하는 게이트웨이.",
  },
  "elastic-ip": {
    type: "elastic-ip",
    label: "Elastic IP",
    shortLabel: "EIP",
    idPrefix: "eipalloc",
    category: "networking",
    description: "계정에 할당해 두는 고정 퍼블릭 IPv4 주소 (시뮬레이터에서는 문서화용 대역의 가상 주소).",
  },
  "route-table": {
    type: "route-table",
    label: "Route Table",
    shortLabel: "Route Table",
    idPrefix: "rtb",
    category: "networking",
    description: "서브넷의 트래픽이 어디로 향할지 결정하는 경로 목록.",
  },
  "nat-gateway": {
    type: "nat-gateway",
    label: "NAT Gateway",
    shortLabel: "NAT",
    idPrefix: "nat",
    category: "networking",
    description: "프라이빗 서브넷의 아웃바운드 IPv4 인터넷 통신을 중계합니다.",
  },
  "security-group": {
    type: "security-group",
    label: "Security Group",
    shortLabel: "SG",
    idPrefix: "sg",
    category: "security",
    description: "리소스(ENI) 단위의 상태 저장형(Stateful) 방화벽.",
  },
  "network-acl": {
    type: "network-acl",
    label: "Network ACL",
    shortLabel: "NACL",
    idPrefix: "acl",
    category: "security",
    description: "서브넷 경계의 상태 비저장형(Stateless) 방화벽. 규칙 번호 순서로 평가합니다.",
  },
  ec2: {
    type: "ec2",
    label: "EC2 Instance",
    shortLabel: "EC2",
    idPrefix: "i",
    category: "compute",
    description: "가상 서버 인스턴스 (시뮬레이터에서는 실제 OS가 실행되지 않습니다).",
  },
  alb: {
    type: "alb",
    label: "Application Load Balancer",
    shortLabel: "ALB",
    idPrefix: "alb",
    category: "load-balancing",
    description: "HTTP/HTTPS 요청을 대상 그룹으로 분산하는 L7 로드 밸런서.",
  },
  "target-group": {
    type: "target-group",
    label: "Target Group",
    shortLabel: "TG",
    idPrefix: "tg",
    category: "load-balancing",
    description: "요청을 받을 대상(EC2)과 헬스 체크 설정의 묶음.",
  },
  "db-subnet-group": {
    type: "db-subnet-group",
    label: "DB Subnet Group",
    shortLabel: "DB Subnet Group",
    idPrefix: "dbsg",
    category: "database",
    description: "RDS를 배치할 서브넷 묶음 (최소 2개 가용 영역).",
  },
  rds: {
    type: "rds",
    label: "RDS DB Instance",
    shortLabel: "RDS",
    idPrefix: "db",
    category: "database",
    description: "관리형 관계형 데이터베이스 (시뮬레이터는 네트워크/포트 접근만 검사합니다).",
  },
};

export function isResourceType(value: string): value is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}
