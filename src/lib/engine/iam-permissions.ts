/**
 * 지금 작업하는 자격 증명(가상 로그인)으로 프로젝트 변경을 허용할지 판단한다.
 *
 * - 변경 전후 프로젝트를 비교해 필요한 IAM 작업을 추론한다 (리소스 생성·삭제·설정 변경·연결, IAM·S3·CloudWatch 항목).
 *   콘솔과 그림 빌더가 같은 규칙으로 검사된다. 위치 이동·화면 설정·가상 부하처럼 AWS API가 없는 변경은 검사하지 않는다.
 * - 루트 사용자는 모두 허용한다. IAM 사용자·역할은 연결된 정책으로 평가한다 (명시적 Deny > Allow > 암묵적 거부).
 * - 조회(Describe/List/Get)는 검사하지 않는다. EC2·RDS 등은 리소스 ARN, S3는 버킷·객체 ARN, IAM은 사용자·역할 등의 ARN으로 평가한다.
 *   Condition, 권한 경계, SCP, 세션 정책은 평가하지 않는다.
 */
import { bucketArn, evaluateIam, groupArn, objectArn, policyArn, roleArn, SANDBOX_ACCOUNT_ID, userArn, type IamDecision } from "./iam-engine";
import { actingArn, actingIdentity, actingLabel, actingPrincipal, type ActingIdentity } from "./iam-session";
import { isRouteRelation, type Connection, type Project, type RelationType, type Resource, type ResourceType } from "./resource-models";

const REGION = "ap-northeast-2";
const ACCOUNT = SANDBOX_ACCOUNT_ID;

/** 변경에 필요한 IAM 작업 하나 */
export interface RequiredAction {
  /** 예: ec2:RunInstances */
  action: string;
  /** 평가할 리소스 ARN */
  resource: string;
  /** 사람이 읽는 작업 설명 (예: "EC2 인스턴스 시작") */
  what: string;
}

// ---------------------------------------------------------------- ARN

const EC2_ARN_TYPE: Partial<Record<ResourceType, string>> = {
  vpc: "vpc",
  subnet: "subnet",
  "internet-gateway": "internet-gateway",
  "elastic-ip": "elastic-ip",
  "route-table": "route-table",
  "nat-gateway": "natgateway",
  "security-group": "security-group",
  "network-acl": "network-acl",
  ec2: "instance",
};

/** 리소스 ARN. 아직 없는 리소스(만들기)는 이름 자리에 *를 쓴다 */
export function resourceArn(type: ResourceType, r?: Pick<Resource, "id" | "name"> | null): string {
  const id = r?.id ?? "*";
  const name = r?.name?.trim() || id;
  const ec2Type = EC2_ARN_TYPE[type];
  if (ec2Type) return `arn:aws:ec2:${REGION}:${ACCOUNT}:${ec2Type}/${id}`;
  if (type === "alb") return r ? `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${name}/${id}` : `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/*`;
  if (type === "target-group") return r ? `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${name}/${id}` : `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/*`;
  if (type === "rds") return `arn:aws:rds:${REGION}:${ACCOUNT}:db:${r ? name : "*"}`;
  return `arn:aws:rds:${REGION}:${ACCOUNT}:subgrp:${r ? name : "*"}`;
}

const alarmArn = (name: string) => `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${name}`;
const dashboardArn = (name: string) => `arn:aws:cloudwatch::${ACCOUNT}:dashboard/${name}`;
const insightsPathArn = (id: string) => `arn:aws:ec2:${REGION}:${ACCOUNT}:network-insights-path/${id}`;

// ---------------------------------------------------------------- 리소스 작업 표

type Op = readonly [action: string, what: string];

const CREATE: Record<ResourceType, Op> = {
  vpc: ["ec2:CreateVpc", "VPC 만들기"],
  subnet: ["ec2:CreateSubnet", "서브넷 만들기"],
  "internet-gateway": ["ec2:CreateInternetGateway", "인터넷 게이트웨이 만들기"],
  "elastic-ip": ["ec2:AllocateAddress", "탄력적 IP 할당"],
  "route-table": ["ec2:CreateRouteTable", "라우팅 테이블 만들기"],
  "nat-gateway": ["ec2:CreateNatGateway", "NAT 게이트웨이 만들기"],
  "security-group": ["ec2:CreateSecurityGroup", "보안 그룹 만들기"],
  "network-acl": ["ec2:CreateNetworkAcl", "네트워크 ACL 만들기"],
  ec2: ["ec2:RunInstances", "EC2 인스턴스 시작"],
  alb: ["elasticloadbalancing:CreateLoadBalancer", "로드 밸런서 만들기"],
  "target-group": ["elasticloadbalancing:CreateTargetGroup", "대상 그룹 만들기"],
  "db-subnet-group": ["rds:CreateDBSubnetGroup", "DB 서브넷 그룹 만들기"],
  rds: ["rds:CreateDBInstance", "RDS DB 인스턴스 만들기"],
};

const DELETE: Record<ResourceType, Op> = {
  vpc: ["ec2:DeleteVpc", "VPC 삭제"],
  subnet: ["ec2:DeleteSubnet", "서브넷 삭제"],
  "internet-gateway": ["ec2:DeleteInternetGateway", "인터넷 게이트웨이 삭제"],
  "elastic-ip": ["ec2:ReleaseAddress", "탄력적 IP 릴리스"],
  "route-table": ["ec2:DeleteRouteTable", "라우팅 테이블 삭제"],
  "nat-gateway": ["ec2:DeleteNatGateway", "NAT 게이트웨이 삭제"],
  "security-group": ["ec2:DeleteSecurityGroup", "보안 그룹 삭제"],
  "network-acl": ["ec2:DeleteNetworkAcl", "네트워크 ACL 삭제"],
  ec2: ["ec2:TerminateInstances", "EC2 인스턴스 종료"],
  alb: ["elasticloadbalancing:DeleteLoadBalancer", "로드 밸런서 삭제"],
  "target-group": ["elasticloadbalancing:DeleteTargetGroup", "대상 그룹 삭제"],
  "db-subnet-group": ["rds:DeleteDBSubnetGroup", "DB 서브넷 그룹 삭제"],
  rds: ["rds:DeleteDBInstance", "RDS DB 인스턴스 삭제"],
};

/** 이름 바꾸기 (EC2·VPC 리소스는 Name 태그, 나머지는 각 서비스의 수정 작업) */
const RENAME: Record<ResourceType, Op> = {
  vpc: ["ec2:CreateTags", "Name 태그 변경"],
  subnet: ["ec2:CreateTags", "Name 태그 변경"],
  "internet-gateway": ["ec2:CreateTags", "Name 태그 변경"],
  "elastic-ip": ["ec2:CreateTags", "Name 태그 변경"],
  "route-table": ["ec2:CreateTags", "Name 태그 변경"],
  "nat-gateway": ["ec2:CreateTags", "Name 태그 변경"],
  "security-group": ["ec2:CreateTags", "Name 태그 변경"],
  "network-acl": ["ec2:CreateTags", "Name 태그 변경"],
  ec2: ["ec2:CreateTags", "Name 태그 변경"],
  alb: ["elasticloadbalancing:AddTags", "로드 밸런서 태그 변경"],
  "target-group": ["elasticloadbalancing:AddTags", "대상 그룹 태그 변경"],
  "db-subnet-group": ["rds:ModifyDBSubnetGroup", "DB 서브넷 그룹 수정"],
  rds: ["rds:ModifyDBInstance", "DB 식별자 변경"],
};

/** 리소스 사이의 연결(관계) 추가·삭제. subject는 권한을 평가할 쪽 리소스 */
const RELATION: Record<RelationType, { add: Op; remove: Op; subject: "source" | "target" }> = {
  "vpc-subnet": { add: ["ec2:CreateSubnet", "서브넷의 VPC 지정"], remove: ["ec2:DeleteSubnet", "서브넷의 VPC 해제"], subject: "target" },
  "vpc-internet-gateway": { add: ["ec2:AttachInternetGateway", "인터넷 게이트웨이 연결"], remove: ["ec2:DetachInternetGateway", "인터넷 게이트웨이 분리"], subject: "target" },
  "vpc-route-table": { add: ["ec2:CreateRouteTable", "라우팅 테이블의 VPC 지정"], remove: ["ec2:DeleteRouteTable", "라우팅 테이블의 VPC 해제"], subject: "target" },
  "vpc-security-group": { add: ["ec2:CreateSecurityGroup", "보안 그룹의 VPC 지정"], remove: ["ec2:DeleteSecurityGroup", "보안 그룹의 VPC 해제"], subject: "target" },
  "vpc-network-acl": { add: ["ec2:CreateNetworkAcl", "네트워크 ACL의 VPC 지정"], remove: ["ec2:DeleteNetworkAcl", "네트워크 ACL의 VPC 해제"], subject: "target" },
  "route-table-subnet": { add: ["ec2:AssociateRouteTable", "서브넷에 라우팅 테이블 연결"], remove: ["ec2:DisassociateRouteTable", "라우팅 테이블 연결 해제"], subject: "source" },
  "route-table-internet-gateway": { add: ["ec2:CreateRoute", "경로 추가"], remove: ["ec2:DeleteRoute", "경로 삭제"], subject: "source" },
  "route-table-nat-gateway": { add: ["ec2:CreateRoute", "경로 추가"], remove: ["ec2:DeleteRoute", "경로 삭제"], subject: "source" },
  "route-table-ec2": { add: ["ec2:CreateRoute", "경로 추가"], remove: ["ec2:DeleteRoute", "경로 삭제"], subject: "source" },
  "network-acl-subnet": { add: ["ec2:ReplaceNetworkAclAssociation", "서브넷의 네트워크 ACL 변경"], remove: ["ec2:ReplaceNetworkAclAssociation", "서브넷의 네트워크 ACL 변경"], subject: "source" },
  "nat-gateway-subnet": { add: ["ec2:CreateNatGateway", "NAT 게이트웨이 서브넷 지정"], remove: ["ec2:DeleteNatGateway", "NAT 게이트웨이 서브넷 해제"], subject: "source" },
  "ec2-subnet": { add: ["ec2:ModifyInstanceAttribute", "인스턴스 서브넷 변경"], remove: ["ec2:ModifyInstanceAttribute", "인스턴스 서브넷 변경"], subject: "source" },
  "ec2-security-group": { add: ["ec2:ModifyInstanceAttribute", "인스턴스 보안 그룹 변경"], remove: ["ec2:ModifyInstanceAttribute", "인스턴스 보안 그룹 변경"], subject: "source" },
  "alb-subnet": { add: ["elasticloadbalancing:SetSubnets", "로드 밸런서 서브넷 변경"], remove: ["elasticloadbalancing:SetSubnets", "로드 밸런서 서브넷 변경"], subject: "source" },
  "alb-security-group": { add: ["elasticloadbalancing:SetSecurityGroups", "로드 밸런서 보안 그룹 변경"], remove: ["elasticloadbalancing:SetSecurityGroups", "로드 밸런서 보안 그룹 변경"], subject: "source" },
  "alb-target-group": { add: ["elasticloadbalancing:ModifyListener", "리스너 전달 대상 변경"], remove: ["elasticloadbalancing:ModifyListener", "리스너 전달 대상 변경"], subject: "source" },
  "target-group-ec2": { add: ["elasticloadbalancing:RegisterTargets", "대상 등록"], remove: ["elasticloadbalancing:DeregisterTargets", "대상 등록 해제"], subject: "source" },
  "db-subnet-group-subnet": { add: ["rds:ModifyDBSubnetGroup", "DB 서브넷 그룹 서브넷 변경"], remove: ["rds:ModifyDBSubnetGroup", "DB 서브넷 그룹 서브넷 변경"], subject: "source" },
  "rds-db-subnet-group": { add: ["rds:ModifyDBInstance", "DB 서브넷 그룹 변경"], remove: ["rds:ModifyDBInstance", "DB 서브넷 그룹 변경"], subject: "source" },
  "rds-security-group": { add: ["rds:ModifyDBInstance", "DB 보안 그룹 변경"], remove: ["rds:ModifyDBInstance", "DB 보안 그룹 변경"], subject: "source" },
  "elastic-ip-nat-gateway": { add: ["ec2:AssociateAddress", "탄력적 IP 연결"], remove: ["ec2:DisassociateAddress", "탄력적 IP 연결 해제"], subject: "source" },
  "elastic-ip-ec2": { add: ["ec2:AssociateAddress", "탄력적 IP 연결"], remove: ["ec2:DisassociateAddress", "탄력적 IP 연결 해제"], subject: "source" },
  "vpc-target-group": { add: ["elasticloadbalancing:CreateTargetGroup", "대상 그룹의 VPC 지정"], remove: ["elasticloadbalancing:DeleteTargetGroup", "대상 그룹의 VPC 해제"], subject: "target" },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** id로 비교해 추가·삭제·변경된 항목 */
function diffById<T extends { id: string }>(before: T[], after: T[]) {
  const b = new Map(before.map((x) => [x.id, x]));
  const a = new Map(after.map((x) => [x.id, x]));
  return {
    added: after.filter((x) => !b.has(x.id)),
    removed: before.filter((x) => !a.has(x.id)),
    changed: after.filter((x) => b.has(x.id) && !same(b.get(x.id), x)).map((x) => ({ before: b.get(x.id)!, after: x })),
  };
}

// ---------------------------------------------------------------- 리소스 설정 변경

function ruleChanges(before: { id: string }[], after: { id: string }[]) {
  const d = diffById(before, after);
  return { added: d.added.length > 0, removed: d.removed.length > 0, changed: d.changed.length > 0 };
}

function configChanges(before: Resource, after: Resource, label: string): Op[] {
  const ops: Op[] = [];
  const b = before.config as Record<string, unknown>;
  const a = after.config as Record<string, unknown>;
  const changed = (key: string) => !same(b[key], a[key]);
  switch (after.type) {
    case "vpc":
      if (changed("enableDnsSupport") || changed("enableDnsHostnames")) ops.push(["ec2:ModifyVpcAttribute", "VPC DNS 설정 변경"]);
      if (changed("cidr")) ops.push(["ec2:AssociateVpcCidrBlock", "VPC CIDR 변경"]);
      break;
    case "subnet":
      if (changed("mapPublicIpOnLaunch") || changed("cidr") || changed("availabilityZone")) ops.push(["ec2:ModifySubnetAttribute", "서브넷 설정 변경"]);
      break;
    case "route-table":
      if (changed("main")) ops.push(["ec2:ReplaceRouteTableAssociation", "기본(main) 라우팅 테이블 변경"]);
      break;
    case "security-group": {
      const inbound = ruleChanges(b.inboundRules as { id: string }[], a.inboundRules as { id: string }[]);
      const outbound = ruleChanges(b.outboundRules as { id: string }[], a.outboundRules as { id: string }[]);
      if (inbound.added) ops.push(["ec2:AuthorizeSecurityGroupIngress", "인바운드 규칙 추가"]);
      if (inbound.removed) ops.push(["ec2:RevokeSecurityGroupIngress", "인바운드 규칙 삭제"]);
      if (outbound.added) ops.push(["ec2:AuthorizeSecurityGroupEgress", "아웃바운드 규칙 추가"]);
      if (outbound.removed) ops.push(["ec2:RevokeSecurityGroupEgress", "아웃바운드 규칙 삭제"]);
      if (inbound.changed || outbound.changed || changed("description")) ops.push(["ec2:ModifySecurityGroupRules", "보안 그룹 규칙 수정"]);
      break;
    }
    case "network-acl": {
      const rules = [ruleChanges(b.inboundRules as { id: string }[], a.inboundRules as { id: string }[]), ruleChanges(b.outboundRules as { id: string }[], a.outboundRules as { id: string }[])];
      if (rules.some((r) => r.added)) ops.push(["ec2:CreateNetworkAclEntry", "NACL 규칙 추가"]);
      if (rules.some((r) => r.removed)) ops.push(["ec2:DeleteNetworkAclEntry", "NACL 규칙 삭제"]);
      if (rules.some((r) => r.changed)) ops.push(["ec2:ReplaceNetworkAclEntry", "NACL 규칙 수정"]);
      break;
    }
    case "ec2": {
      if (changed("state")) {
        const to = a.state;
        if (label === "RebootInstances") ops.push(["ec2:RebootInstances", "인스턴스 재부팅"]);
        else if (to === "terminated") ops.push(["ec2:TerminateInstances", "인스턴스 종료"]);
        else if (to === "stopped") ops.push(["ec2:StopInstances", "인스턴스 중지"]);
        else if (b.state === "stopped") ops.push(["ec2:StartInstances", "인스턴스 시작"]);
      }
      if (["instanceType", "ami", "privateIp", "publicIpMode", "userData", "sourceDestCheck"].some(changed)) ops.push(["ec2:ModifyInstanceAttribute", "인스턴스 속성 변경"]);
      if (changed("iamRoleId")) {
        ops.push(
          a.iamRoleId
            ? b.iamRoleId
              ? ["ec2:ReplaceIamInstanceProfileAssociation", "인스턴스 IAM 역할 교체"]
              : ["ec2:AssociateIamInstanceProfile", "인스턴스에 IAM 역할 연결"]
            : ["ec2:DisassociateIamInstanceProfile", "인스턴스 IAM 역할 해제"],
        );
      }
      // listenPorts·httpResponseCode는 서버 안의 가상 애플리케이션 가정이라 AWS API가 없다
      break;
    }
    case "alb": {
      const listeners = diffById(b.listeners as { id: string }[], a.listeners as { id: string }[]);
      if (listeners.added.length) ops.push(["elasticloadbalancing:CreateListener", "리스너 추가"]);
      if (listeners.removed.length) ops.push(["elasticloadbalancing:DeleteListener", "리스너 삭제"]);
      for (const { before: lb, after: la } of listeners.changed as { before: { rules?: { id: string }[] } & Record<string, unknown>; after: { rules?: { id: string }[] } & Record<string, unknown> }[]) {
        const rules = ruleChanges(lb.rules ?? [], la.rules ?? []);
        if (rules.added) ops.push(["elasticloadbalancing:CreateRule", "리스너 규칙 추가"]);
        if (rules.removed) ops.push(["elasticloadbalancing:DeleteRule", "리스너 규칙 삭제"]);
        if (rules.changed) ops.push(["elasticloadbalancing:ModifyRule", "리스너 규칙 수정"]);
        if (!same({ ...lb, rules: undefined }, { ...la, rules: undefined })) ops.push(["elasticloadbalancing:ModifyListener", "리스너 수정"]);
      }
      if (changed("scheme")) ops.push(["elasticloadbalancing:ModifyLoadBalancerAttributes", "로드 밸런서 체계 변경"]);
      // state는 가상 프로비저닝 상태라 AWS API가 없다
      break;
    }
    case "target-group":
      if (changed("protocol") || changed("port") || changed("healthCheck")) ops.push(["elasticloadbalancing:ModifyTargetGroup", "대상 그룹·헬스 체크 수정"]);
      break;
    case "db-subnet-group":
      if (changed("description")) ops.push(["rds:ModifyDBSubnetGroup", "DB 서브넷 그룹 수정"]);
      break;
    case "rds":
      if (changed("state")) {
        if (a.state === "stopped") ops.push(["rds:StopDBInstance", "DB 인스턴스 중지"]);
        else if (b.state === "stopped") ops.push(["rds:StartDBInstance", "DB 인스턴스 시작"]);
      }
      if (["engine", "instanceClass", "port", "allocatedStorageGb", "publiclyAccessible", "multiAz"].some(changed)) ops.push(["rds:ModifyDBInstance", "DB 인스턴스 수정"]);
      break;
    // nat-gateway(가상 상태), elastic-ip(주소), internet-gateway: 수정 API 없음
  }
  return ops;
}

// ---------------------------------------------------------------- 추론

/**
 * 변경 전후를 비교해 필요한 IAM 작업 목록을 만든다.
 * label은 콘솔이 넘기는 API 이름(예: RebootInstances)으로, 내용 변화가 없는 작업을 구분할 때만 쓴다.
 */
export function requiredActions(before: Project, after: Project, label = ""): RequiredAction[] {
  const out: RequiredAction[] = [];
  const add = (action: string, resource: string, what: string) => out.push({ action, resource, what });

  // ---- 리소스
  const res = diffById(before.resources, after.resources);
  const createdIds = new Set(res.added.map((r) => r.id));
  const removedIds = new Set(res.removed.map((r) => r.id));
  const afterById = new Map(after.resources.map((r) => [r.id, r]));
  const beforeById = new Map(before.resources.map((r) => [r.id, r]));

  // 새 VPC와 함께 자동으로 만들어지는 기본 리소스 (AWS도 CreateVpc만 확인한다)
  const newVpcIds = new Set(res.added.filter((r) => r.type === "vpc").map((r) => r.id));
  const newDefaultVpcIds = new Set(res.added.filter((r) => r.type === "vpc" && (r.config as { isDefault?: boolean }).isDefault).map((r) => r.id));
  const vpcOf = (id: string): string | null => {
    for (const c of after.connections) {
      if (c.targetResourceId === id && c.relationType.startsWith("vpc-")) return c.sourceResourceId;
      if (c.sourceResourceId === id && (c.relationType === "ec2-subnet" || c.relationType === "nat-gateway-subnet")) return vpcOf(c.targetResourceId);
    }
    return null;
  };
  const autoCreated = (r: Resource): boolean => {
    const vpc = vpcOf(r.id);
    if (!vpc) return false;
    if (newDefaultVpcIds.has(vpc)) return true; // CreateDefaultVpc는 서브넷·IGW·경로까지 함께 만든다
    if (!newVpcIds.has(vpc)) return false;
    const c = r.config as { isDefault?: boolean; main?: boolean };
    return (r.type === "security-group" || r.type === "network-acl") ? !!c.isDefault : r.type === "route-table" ? !!c.main : false;
  };

  for (const r of res.added) {
    if (r.type === "vpc" && newDefaultVpcIds.has(r.id)) {
      add("ec2:CreateDefaultVpc", resourceArn("vpc"), "기본 VPC 만들기");
      continue;
    }
    if (autoCreated(r)) continue;
    const [action, what] = CREATE[r.type];
    add(action, resourceArn(r.type), what);
    if (r.type === "alb" && ((r.config as { listeners?: unknown[] }).listeners ?? []).length) add("elasticloadbalancing:CreateListener", resourceArn("alb"), "리스너 추가");
    if (r.type === "ec2") {
      const roleId = (r.config as { iamRoleId?: string | null }).iamRoleId;
      const role = roleId ? after.services.iam.roles.find((x) => x.id === roleId) : undefined;
      if (role) add("iam:PassRole", roleArn(role.name), `인스턴스에 역할 ${role.name} 넘기기`);
    }
    if (r.type === "security-group") {
      const c = r.config as { inboundRules: unknown[] };
      if (c.inboundRules.length) add("ec2:AuthorizeSecurityGroupIngress", resourceArn("security-group"), "인바운드 규칙 추가");
    }
  }
  for (const r of res.removed) {
    const [action, what] = DELETE[r.type];
    add(action, resourceArn(r.type, r), what);
  }
  for (const { before: rb, after: ra } of res.changed) {
    if (rb.name !== ra.name) {
      const [action, what] = RENAME[ra.type];
      add(action, resourceArn(ra.type, ra), what);
    }
    for (const [action, what] of configChanges(rb, ra, label)) add(action, resourceArn(ra.type, ra), what);
    if (ra.type === "ec2") {
      const roleId = (ra.config as { iamRoleId?: string | null }).iamRoleId;
      if (roleId && roleId !== (rb.config as { iamRoleId?: string | null }).iamRoleId) {
        const role = after.services.iam.roles.find((x) => x.id === roleId);
        if (role) add("iam:PassRole", roleArn(role.name), `인스턴스에 역할 ${role.name} 넘기기`);
      }
    }
  }
  if (label === "RebootInstances" && !out.some((o) => o.action === "ec2:RebootInstances")) add("ec2:RebootInstances", resourceArn("ec2"), "인스턴스 재부팅");

  // ---- 연결 (새로 만들거나 지운 리소스에 딸린 연결은 그 작업에 포함된다)
  const conns = diffById<Connection>(before.connections, after.connections);
  const involved = (c: Connection) => createdIds.has(c.sourceResourceId) || createdIds.has(c.targetResourceId) || removedIds.has(c.sourceResourceId) || removedIds.has(c.targetResourceId);
  const subjectOf = (c: Connection, side: "source" | "target") => {
    const id = side === "source" ? c.sourceResourceId : c.targetResourceId;
    return afterById.get(id) ?? beforeById.get(id) ?? null;
  };
  for (const [list, kind] of [
    [conns.added, "add"],
    [conns.removed, "remove"],
  ] as const) {
    for (const c of list) {
      if (involved(c)) continue;
      const spec = RELATION[c.relationType];
      const [action, what] = spec[kind];
      const subject = subjectOf(c, spec.subject);
      add(action, subject ? resourceArn(subject.type, subject) : "*", what);
    }
  }
  for (const { after: c } of conns.changed) {
    if (involved(c)) continue;
    const subject = subjectOf(c, RELATION[c.relationType].subject);
    const isRoute = isRouteRelation(c.relationType);
    add(isRoute ? "ec2:ReplaceRoute" : RELATION[c.relationType].add[0], subject ? resourceArn(subject.type, subject) : "*", isRoute ? "경로 수정" : RELATION[c.relationType].add[1]);
  }

  // ---- IAM
  const iamB = before.services.iam;
  const iamA = after.services.iam;
  const users = diffById(iamB.users, iamA.users);
  for (const u of users.added) {
    add("iam:CreateUser", userArn(u.name), `IAM 사용자 ${u.name} 만들기`);
    for (const g of u.groupIds) add("iam:AddUserToGroup", groupArn(iamA.groups.find((x) => x.id === g)?.name ?? g), "사용자를 그룹에 추가");
    if (u.policyIds.length) add("iam:AttachUserPolicy", userArn(u.name), "사용자에게 정책 연결");
    if (u.consoleAccess) add("iam:CreateLoginProfile", userArn(u.name), "콘솔 액세스 허용");
  }
  for (const u of users.removed) add("iam:DeleteUser", userArn(u.name), `IAM 사용자 ${u.name} 삭제`);
  for (const { before: ub, after: ua } of users.changed) {
    const arn = userArn(ua.name);
    if (ub.name !== ua.name) add("iam:UpdateUser", userArn(ub.name), "사용자 이름 변경");
    for (const g of ua.groupIds.filter((x) => !ub.groupIds.includes(x))) add("iam:AddUserToGroup", groupArn(iamA.groups.find((x) => x.id === g)?.name ?? g), "사용자를 그룹에 추가");
    for (const g of ub.groupIds.filter((x) => !ua.groupIds.includes(x))) add("iam:RemoveUserFromGroup", groupArn(iamB.groups.find((x) => x.id === g)?.name ?? g), "사용자를 그룹에서 제거");
    if (ua.policyIds.some((p) => !ub.policyIds.includes(p))) add("iam:AttachUserPolicy", arn, "사용자에게 정책 연결");
    if (ub.policyIds.some((p) => !ua.policyIds.includes(p))) add("iam:DetachUserPolicy", arn, "사용자 정책 분리");
    const keys = diffById(ub.accessKeys, ua.accessKeys);
    if (keys.added.length) add("iam:CreateAccessKey", arn, "액세스 키 만들기");
    if (keys.removed.length) add("iam:DeleteAccessKey", arn, "액세스 키 삭제");
    if (keys.changed.length) add("iam:UpdateAccessKey", arn, "액세스 키 상태 변경");
    if (ub.consoleAccess !== ua.consoleAccess) add(ua.consoleAccess ? "iam:CreateLoginProfile" : "iam:DeleteLoginProfile", arn, ua.consoleAccess ? "콘솔 액세스 허용" : "콘솔 액세스 해제");
    if (ub.mfaEnabled !== ua.mfaEnabled) add(ua.mfaEnabled ? "iam:EnableMFADevice" : "iam:DeactivateMFADevice", arn, ua.mfaEnabled ? "MFA 켜기" : "MFA 끄기");
  }
  const groups = diffById(iamB.groups, iamA.groups);
  for (const g of groups.added) {
    add("iam:CreateGroup", groupArn(g.name), `그룹 ${g.name} 만들기`);
    if (g.policyIds.length) add("iam:AttachGroupPolicy", groupArn(g.name), "그룹에 정책 연결");
  }
  for (const g of groups.removed) add("iam:DeleteGroup", groupArn(g.name), `그룹 ${g.name} 삭제`);
  for (const { before: gb, after: ga } of groups.changed) {
    if (gb.name !== ga.name) add("iam:UpdateGroup", groupArn(gb.name), "그룹 이름 변경");
    if (ga.policyIds.some((p) => !gb.policyIds.includes(p))) add("iam:AttachGroupPolicy", groupArn(ga.name), "그룹에 정책 연결");
    if (gb.policyIds.some((p) => !ga.policyIds.includes(p))) add("iam:DetachGroupPolicy", groupArn(ga.name), "그룹 정책 분리");
  }
  const roles = diffById(iamB.roles, iamA.roles);
  for (const r of roles.added) {
    add("iam:CreateRole", roleArn(r.name), `역할 ${r.name} 만들기`);
    if (r.policyIds.length) add("iam:AttachRolePolicy", roleArn(r.name), "역할에 정책 연결");
  }
  for (const r of roles.removed) add("iam:DeleteRole", roleArn(r.name), `역할 ${r.name} 삭제`);
  for (const { before: rb, after: ra } of roles.changed) {
    if (ra.policyIds.some((p) => !rb.policyIds.includes(p))) add("iam:AttachRolePolicy", roleArn(ra.name), "역할에 정책 연결");
    if (rb.policyIds.some((p) => !ra.policyIds.includes(p))) add("iam:DetachRolePolicy", roleArn(ra.name), "역할 정책 분리");
    if (rb.trustedEntity !== ra.trustedEntity) add("iam:UpdateAssumeRolePolicy", roleArn(ra.name), "신뢰 정책 변경");
    if (rb.description !== ra.description || rb.name !== ra.name) add("iam:UpdateRole", roleArn(rb.name), "역할 수정");
  }
  const policies = diffById(iamB.policies, iamA.policies);
  for (const p of policies.added) add("iam:CreatePolicy", policyArn(p), `정책 ${p.name} 만들기`);
  for (const p of policies.removed) add("iam:DeletePolicy", policyArn(p), `정책 ${p.name} 삭제`);
  for (const { after: p } of policies.changed) add("iam:CreatePolicyVersion", policyArn(p), `정책 ${p.name} 수정`);

  // ---- S3
  const buckets = diffById(before.services.s3.buckets, after.services.s3.buckets);
  for (const b of buckets.added) {
    add("s3:CreateBucket", bucketArn(b.name), `버킷 ${b.name} 만들기`);
    for (const o of b.objects) add("s3:PutObject", objectArn(b.name, o.key), "객체 올리기");
  }
  for (const b of buckets.removed) add("s3:DeleteBucket", bucketArn(b.name), `버킷 ${b.name} 삭제`);
  for (const { before: bb, after: ba } of buckets.changed) {
    const arn = bucketArn(ba.name);
    if (bb.policy !== ba.policy) add(ba.policy.trim() ? "s3:PutBucketPolicy" : "s3:DeleteBucketPolicy", arn, ba.policy.trim() ? "버킷 정책 변경" : "버킷 정책 삭제");
    if (!same(bb.website, ba.website)) add(ba.website.enabled ? "s3:PutBucketWebsite" : "s3:DeleteBucketWebsite", arn, "정적 웹 사이트 호스팅 변경");
    if (!same(bb.blockPublicAccess, ba.blockPublicAccess)) add("s3:PutBucketPublicAccessBlock", arn, "퍼블릭 액세스 차단 변경");
    if (bb.versioning !== ba.versioning) add("s3:PutBucketVersioning", arn, "버전 관리 변경");
    if (bb.encryption !== ba.encryption) add("s3:PutEncryptionConfiguration", arn, "기본 암호화 변경");
    const before = new Map(bb.objects.map((o) => [o.key, o]));
    const afterKeys = new Set(ba.objects.map((o) => o.key));
    for (const o of ba.objects) {
      const prev = before.get(o.key);
      if (!prev) {
        add(o.deleteMarker ? "s3:DeleteObject" : "s3:PutObject", objectArn(ba.name, o.key), o.deleteMarker ? "객체 삭제" : "객체 올리기");
        continue;
      }
      if (same(prev, o)) continue;
      if (o.deleteMarker && !prev.deleteMarker) add("s3:DeleteObject", objectArn(ba.name, o.key), "객체 삭제");
      else if (o.previousVersions.length < prev.previousVersions.length && o.versionId === prev.versionId) add("s3:DeleteObjectVersion", objectArn(ba.name, o.key), "객체 버전 삭제");
      else add("s3:PutObject", objectArn(ba.name, o.key), "객체 올리기");
    }
    for (const key of before.keys()) if (!afterKeys.has(key)) add("s3:DeleteObject", objectArn(ba.name, key), "객체 삭제");
  }

  // ---- CloudWatch (가상 부하는 시뮬레이터 기능이라 검사하지 않는다)
  const cw = before.services.cloudwatch;
  const cwA = after.services.cloudwatch;
  const alarms = diffById(cw.alarms, cwA.alarms);
  for (const a of [...alarms.added, ...alarms.changed.map((x) => x.after)]) add("cloudwatch:PutMetricAlarm", alarmArn(a.name), `경보 ${a.name} 만들기·수정`);
  for (const a of alarms.removed) add("cloudwatch:DeleteAlarms", alarmArn(a.name), `경보 ${a.name} 삭제`);
  const dashboards = diffById(cw.dashboards, cwA.dashboards);
  for (const d of [...dashboards.added, ...dashboards.changed.map((x) => x.after)]) add("cloudwatch:PutDashboard", dashboardArn(d.name), `대시보드 ${d.name} 만들기·수정`);
  for (const d of dashboards.removed) add("cloudwatch:DeleteDashboards", dashboardArn(d.name), `대시보드 ${d.name} 삭제`);

  // ---- Reachability Analyzer 경로
  const paths = diffById(before.networkPaths, after.networkPaths);
  for (const p of paths.added) add("ec2:CreateNetworkInsightsPath", insightsPathArn(p.id), "도달 가능성 분석 경로 만들기");
  for (const p of paths.removed) add("ec2:DeleteNetworkInsightsPath", insightsPathArn(p.id), "도달 가능성 분석 경로 삭제");
  for (const { after: p } of paths.changed) add("ec2:StartNetworkInsightsAnalysis", insightsPathArn(p.id), "도달 가능성 분석 실행");

  // 같은 작업·리소스는 한 번만
  const seen = new Set<string>();
  return out.filter((o) => {
    const key = `${o.action}|${o.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- 판단

export type AuthorizationResult =
  | { ok: true; checked: RequiredAction[] }
  | { ok: false; error: string; hint: string; denied: RequiredAction; decision: IamDecision; identity: ActingIdentity };

/** 오류 코드: EC2(VPC 포함)는 UnauthorizedOperation, 나머지 서비스는 AccessDenied */
function errorCodeFor(action: string): string {
  return action.startsWith("ec2:") ? "UnauthorizedOperation" : "AccessDenied";
}

/** AWS 콘솔이 보여 주는 형식의 영어 메시지 (학습용으로 함께 보여 준다) */
export function awsDeniedMessage(identity: ActingIdentity, req: RequiredAction, decision: IamDecision): string {
  const why =
    decision.decision === "explicit-deny"
      ? `with an explicit deny in an identity-based policy`
      : `because no identity-based policy allows the ${req.action} action`;
  const head = errorCodeFor(req.action) === "UnauthorizedOperation" ? "You are not authorized to perform this operation. " : "";
  return `${head}User: ${actingArn(identity)} is not authorized to perform: ${req.action} on resource: ${req.resource} ${why}`;
}

/**
 * 변경을 허용할지 판단한다. before의 세션·정책으로 평가한다 (같은 변경 안에서 스스로 권한을 늘릴 수 없다).
 * suggest는 거부된 작업을 맡는 역할 이름을 알려 줄 때 쓴다 (예: 학교 역할 템플릿).
 */
export function authorizeChange(before: Project, after: Project, label = "", suggest?: (action: string) => string | null): AuthorizationResult {
  const identity = actingIdentity(before);
  const principal = actingPrincipal(identity);
  const required = requiredActions(before, after, label);
  if (!principal) return { ok: true, checked: required };
  for (const req of required) {
    const decision = evaluateIam(before, principal, req.action, req.resource);
    if (decision.decision === "allowed") continue;
    const who = actingLabel(identity);
    const reason = decision.decision === "explicit-deny" ? "명시적 Deny 정책 때문에 거부되었습니다" : "허용하는 정책이 없어 거부되었습니다 (암묵적 거부)";
    const owner = suggest?.(req.action);
    return {
      ok: false,
      error: `[${errorCodeFor(req.action)}] ${who}은(는) ${req.what}(${req.action}) 권한이 없습니다. ${reason}.`,
      hint: [
        `AWS 메시지: ${awsDeniedMessage(identity, req, decision)}`,
        owner ? `이 작업은 '${owner}' 역할의 일입니다.` : null,
        decision.decision === "explicit-deny"
          ? "Deny는 어떤 Allow보다 우선합니다. Deny 문장을 고치거나, 이 작업을 맡은 사용자·역할로 전환하세요."
          : `${req.action}을(를) 허용하는 정책을 연결하거나, 권한이 있는 사용자·역할로 전환하세요 (상단 계정 메뉴의 '자격 증명 전환').`,
      ]
        .filter(Boolean)
        .join(" "),
      denied: req,
      decision,
      identity,
    };
  }
  return { ok: true, checked: required };
}
