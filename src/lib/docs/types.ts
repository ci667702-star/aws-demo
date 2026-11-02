/**
 * 리소스 설명·설정 도움말 데이터의 타입.
 * 설명 데이터는 UI와 분리된 순수 데이터이며, 실제 AWS 개념(realAws)과 이 시뮬레이터의 동작(simulator)을 구분해 적는다.
 */
import type { ResourceType } from "@/lib/engine/resource-models";

/** VPC 밖에서 동작하는 가상 서비스 (캔버스 노드가 아니라 샌드박스 전체에 하나씩 있다) */
export const SERVICE_DOC_KEYS = ["s3", "iam", "cloudwatch"] as const;
export type ServiceDocKey = (typeof SERVICE_DOC_KEYS)[number];
export type DocKey = ResourceType | ServiceDocKey;

export const isServiceDocKey = (key: string): key is ServiceDocKey => (SERVICE_DOC_KEYS as readonly string[]).includes(key);

/**
 * 리소스마다 도움말을 제공하는 설정 항목.
 * 리소스 설정 스키마(configSchemas)의 모든 키와, 폼에서 편집하는 관계(소속 VPC, 연결된 보안 그룹 등)를 포함한다.
 * (스키마 키가 빠지면 단위 테스트가 실패한다)
 */
export const DOC_FIELDS = {
  vpc: ["cidr", "enableDnsSupport", "enableDnsHostnames", "isDefault", "internetGateway", "mainRouteTable"],
  subnet: ["vpc", "cidr", "availabilityZone", "mapPublicIpOnLaunch", "routeTable", "networkAcl"],
  "internet-gateway": ["vpc", "attachmentState"],
  "elastic-ip": ["publicIp", "association"],
  "route-table": ["vpc", "main", "subnets", "routes", "destinationCidr", "target"],
  "nat-gateway": ["subnet", "elasticIp", "state"],
  "security-group": ["vpc", "description", "inboundRules", "outboundRules", "protocol", "portRange", "peer", "isDefault", "attachedTo"],
  "network-acl": ["vpc", "subnets", "inboundRules", "outboundRules", "ruleNumber", "protocol", "portRange", "cidr", "ruleAction", "isDefault"],
  ec2: ["ami", "instanceType", "subnet", "privateIp", "publicIpMode", "securityGroups", "state", "listenPorts", "httpResponseCode", "userData", "iamRoleId", "sourceDestCheck", "targetGroups"],
  alb: ["scheme", "subnets", "securityGroups", "listeners", "listenerProtocol", "listenerPort", "defaultTargetGroup", "listenerRules", "state"],
  "target-group": ["vpc", "protocol", "port", "targets", "healthCheck", "healthCheckPath", "healthCheckPort", "healthyThreshold", "unhealthyThreshold", "timeoutSeconds", "intervalSeconds", "matcher"],
  "db-subnet-group": ["description", "subnets"],
  rds: ["engine", "instanceClass", "port", "allocatedStorageGb", "dbSubnetGroup", "securityGroups", "publiclyAccessible", "multiAz", "state"],
  s3: ["bucketName", "region", "objectKey", "blockPublicAccess", "blockPublicAcls", "ignorePublicAcls", "blockPublicPolicy", "restrictPublicBuckets", "versioning", "encryption", "bucketPolicy", "staticWebsite", "indexDocument", "errorDocument"],
  iam: ["user", "group", "role", "trustPolicy", "policyDocument", "effect", "action", "resource", "condition", "principal", "managedPolicy", "accessKey", "consoleAccess", "mfa", "instanceProfile", "session", "leastPrivilege"],
  cloudwatch: ["namespace", "metricName", "resourceDimension", "statistic", "period", "threshold", "comparisonOperator", "evaluationPeriods", "datapointsToAlarm", "treatMissingData", "alarmState", "notification", "virtualLoad", "dashboard"],
} as const satisfies Record<DocKey, readonly string[]>;

export type FieldKeyOf<K extends DocKey> = (typeof DOC_FIELDS)[K][number];

/** 설정 항목 하나의 도움말 (7가지 내용) */
export interface FieldHelp {
  /** 설정 이름 (AWS 콘솔 용어 병기) */
  title: string;
  /** 1. 설정 항목의 의미 */
  meaning: string;
  /** 2. 설정하는 목적 */
  purpose: string;
  /** 3. 가능한 값과 입력 조건 */
  values: string;
  /** 4. 실제 AWS에서의 영향 */
  realAws: string;
  /** 5. 이 시뮬레이터에서의 영향 */
  simulator: string;
  /** 6. 잘못 설정했을 때 생기는 문제 */
  mistakes: string[];
  /** 7. 구체적인 설정 예시 */
  example: string;
}

export interface DocUseCase {
  title: string;
  scenario: string;
  expectedBehavior: string;
}

export interface DocRelation {
  type: DocKey;
  /** 두 리소스의 관계 */
  relationship: string;
  /** 왜 필요한가 / 없으면 어떤 문제가 생기는가 */
  why: string;
}

export interface ResourceDoc<K extends DocKey = DocKey> {
  key: K;
  /** 화면에 쓰는 이름 (예: VPC) */
  title: string;
  /** AWS 서비스 정식 명칭 */
  serviceName: string;
  /** 리소스 유형 (분류 · CloudFormation 유형) */
  resourceType: string;
  /** 한 줄 요약 */
  summary: string;
  /** 상세 설명 (문단) */
  description: string[];
  /** 핵심 역할 */
  coreRoles: string[];
  why: {
    /** 어떤 문제를 해결하는가 */
    problem: string;
    /** 필요한 상황 */
    whenNeeded: string[];
    /** 쓰지 않는 상황 */
    whenNotNeeded: string[];
    /** 비슷한 리소스와의 차이 */
    comparisons: { other: string; difference: string }[];
  };
  /** 주요 사용 목적 */
  purposes: string[];
  /** 실무 사례 */
  useCases: DocUseCase[];
  /** 관련 리소스 (일반 개념) */
  relatedResources: DocRelation[];
  /** 설정 항목별 도움말 */
  fields: Record<FieldKeyOf<K>, FieldHelp>;
  /** 시뮬레이터 구현 범위 */
  simulator: {
    implemented: string[];
    differences: string[];
    virtual: string[];
    unsupported: string[];
  };
}

/** 모든 리소스에 공통인 Name 태그 도움말 */
export const NAME_TAG_HELP: FieldHelp = {
  title: "이름 (Name 태그)",
  meaning: "리소스에 붙이는 'Name' 키의 태그 값입니다. 콘솔 목록과 이 시뮬레이터의 캔버스에 ID 대신 표시됩니다.",
  purpose: "여러 리소스 중에서 용도(예: web-1, public-a)를 한눈에 구분하기 위해 붙입니다.",
  values: "최대 128자. 비워 둘 수 있으며, 비우면 리소스 ID로 표시됩니다.",
  realAws: "이름은 태그일 뿐이라 동작에는 영향을 주지 않습니다. 이름에 'public'이 들어가도 퍼블릭 서브넷이 되지 않습니다.",
  simulator: "표시용으로만 쓰입니다. 퍼블릭/프라이빗 판정 같은 계산에는 이름을 쓰지 않고 실제 설정(라우팅 등)만 씁니다.",
  mistakes: ["이름만 public-subnet으로 바꾸고 인터넷 경로를 만들지 않아 통신이 안 되는 경우"],
  example: "prod-web-1, public-a, app-sg",
};
