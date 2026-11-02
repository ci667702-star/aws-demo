/**
 * 학교에서 AWS를 함께 쓸 때를 가정한 역할 템플릿 (최소 권한 원칙).
 * 템플릿마다 고객 관리형 정책(또는 AWS 관리형 정책)과 그룹, 예시 사용자를 만든다.
 * 정책은 이 시뮬레이터가 평가하는 Action·Resource만 사용한다 (Condition은 평가하지 않는다).
 */
import { evaluateIam, type IamPrincipal } from "./iam-engine";
import type { IamRole, Project } from "./resource-models";

export interface RoleTemplate {
  id: string;
  /** 화면에 보이는 역할 이름 */
  title: string;
  /** 만들 그룹 이름 */
  groupName: string;
  /** 만들 고객 관리형 정책 이름 (managedPolicyId를 쓰면 null) */
  policyName: string | null;
  /** 정책 대신 연결할 AWS 관리형 정책 */
  managedPolicyId?: string;
  /** 예시 사용자 이름 */
  exampleUser: string;
  summary: string;
  can: string[];
  cannot: string[];
  /** 왜 이렇게 나누는지 (최소 권한·직무 분리) */
  why: string;
  /** 정책 문서 (policyName이 있을 때) */
  document: object | null;
}

const statement = (sid: string, actions: string[], resource: string | string[] = "*", effect: "Allow" | "Deny" = "Allow") => ({
  Sid: sid,
  Effect: effect,
  Action: actions,
  Resource: resource,
});

const READ_INFRA = statement("ReadInfrastructure", ["ec2:Describe*", "elasticloadbalancing:Describe*", "rds:Describe*", "cloudwatch:Get*", "cloudwatch:List*", "cloudwatch:Describe*"]);

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "network-admin",
    title: "네트워크 관리자",
    groupName: "NetworkAdmins",
    policyName: "School-NetworkAdmin",
    exampleUser: "net-admin",
    summary: "VPC·서브넷·라우팅·게이트웨이·보안 그룹·NACL을 설계하고 관리합니다.",
    can: ["VPC·서브넷 만들기·삭제", "라우팅 테이블·경로, 인터넷·NAT 게이트웨이, 탄력적 IP 관리", "보안 그룹·네트워크 ACL 규칙 관리", "Reachability Analyzer로 경로 분석"],
    cannot: ["EC2 인스턴스 시작·종료", "로드 밸런서·RDS 만들기", "S3·IAM 변경"],
    why: "네트워크는 모든 서버의 통신 경로를 바꿀 수 있어 영향이 큽니다. 담당자를 정해 두면 실수로 경로나 방화벽을 바꾸는 일을 줄이고, 누가 바꿨는지도 분명해집니다.",
    document: {
      Version: "2012-10-17",
      Statement: [
        statement("ManageVpcAndSubnets", ["ec2:CreateVpc", "ec2:DeleteVpc", "ec2:ModifyVpcAttribute", "ec2:CreateDefaultVpc", "ec2:AssociateVpcCidrBlock", "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute"]),
        statement("ManageRouting", [
          "ec2:CreateRouteTable",
          "ec2:DeleteRouteTable",
          "ec2:CreateRoute",
          "ec2:ReplaceRoute",
          "ec2:DeleteRoute",
          "ec2:AssociateRouteTable",
          "ec2:DisassociateRouteTable",
          "ec2:ReplaceRouteTableAssociation",
        ]),
        statement("ManageGateways", [
          "ec2:CreateInternetGateway",
          "ec2:DeleteInternetGateway",
          "ec2:AttachInternetGateway",
          "ec2:DetachInternetGateway",
          "ec2:CreateNatGateway",
          "ec2:DeleteNatGateway",
          "ec2:AllocateAddress",
          "ec2:ReleaseAddress",
          "ec2:AssociateAddress",
          "ec2:DisassociateAddress",
        ]),
        statement("ManageFirewalls", [
          "ec2:CreateSecurityGroup",
          "ec2:DeleteSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:ModifySecurityGroupRules",
          "ec2:CreateNetworkAcl",
          "ec2:DeleteNetworkAcl",
          "ec2:CreateNetworkAclEntry",
          "ec2:ReplaceNetworkAclEntry",
          "ec2:DeleteNetworkAclEntry",
          "ec2:ReplaceNetworkAclAssociation",
        ]),
        statement("AnalyzeAndTag", ["ec2:CreateNetworkInsightsPath", "ec2:DeleteNetworkInsightsPath", "ec2:StartNetworkInsightsAnalysis", "ec2:CreateTags"]),
        READ_INFRA,
      ],
    },
  },
  {
    id: "server-operator",
    title: "서버 운영자",
    groupName: "ServerOperators",
    policyName: "School-ServerOperator",
    exampleUser: "server-op",
    summary: "EC2 인스턴스와 로드 밸런서를 운영하고, 서버 경보를 관리합니다. 네트워크는 바꾸지 않습니다.",
    can: ["EC2 시작·중지·재부팅·종료, 인스턴스 속성 변경", "School-Ec2-로 시작하는 IAM 역할만 인스턴스에 연결", "로드 밸런서·대상 그룹·리스너 관리", "CloudWatch 경보·대시보드 관리"],
    cannot: ["VPC·서브넷·경로·보안 그룹 만들기 (네트워크 관리자가 만든 것을 골라 씀)", "RDS·S3·IAM 변경", "School-Ec2- 이외의 역할을 인스턴스에 넘기기"],
    why: "서버 담당자가 방화벽이나 경로까지 바꿀 수 있으면 의도치 않게 서버를 인터넷에 열 수 있습니다. 보안 그룹은 네트워크 관리자가 만들고, 서버 운영자는 골라서 붙이기만 합니다. iam:PassRole을 이름으로 제한하면 더 강한 권한의 역할을 서버에 넘겨 권한을 키우는 일도 막을 수 있습니다.",
    document: {
      Version: "2012-10-17",
      Statement: [
        statement("ManageInstances", [
          "ec2:RunInstances",
          "ec2:StartInstances",
          "ec2:StopInstances",
          "ec2:RebootInstances",
          "ec2:TerminateInstances",
          "ec2:ModifyInstanceAttribute",
          "ec2:AssociateIamInstanceProfile",
          "ec2:ReplaceIamInstanceProfileAssociation",
          "ec2:DisassociateIamInstanceProfile",
          "ec2:CreateTags",
        ]),
        statement("PassOnlySchoolEc2Roles", ["iam:PassRole"], "arn:aws:iam::123456789012:role/School-Ec2-*"),
        statement("ManageLoadBalancers", [
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:SetSubnets",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:AddTags",
        ]),
        statement("ManageServerAlarms", ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards"]),
        READ_INFRA,
      ],
    },
  },
  {
    id: "db-admin",
    title: "DB 관리자",
    groupName: "DatabaseAdmins",
    policyName: "School-DatabaseAdmin",
    exampleUser: "db-admin",
    summary: "RDS DB 인스턴스와 DB 서브넷 그룹을 관리합니다.",
    can: ["RDS DB 인스턴스 만들기·수정·시작·중지·삭제", "DB 서브넷 그룹 관리"],
    cannot: ["보안 그룹·서브넷 만들기 (네트워크 관리자에게 요청)", "EC2·로드 밸런서·S3·IAM 변경"],
    why: "학생 성적·출결처럼 중요한 데이터가 있는 DB는 지우거나 공개로 바꾸는 사고가 가장 위험합니다. DB 작업은 DB 관리자에게만 열어 둡니다.",
    document: {
      Version: "2012-10-17",
      Statement: [
        statement("ManageDatabases", [
          "rds:CreateDBInstance",
          "rds:ModifyDBInstance",
          "rds:DeleteDBInstance",
          "rds:StartDBInstance",
          "rds:StopDBInstance",
          "rds:RebootDBInstance",
          "rds:CreateDBSubnetGroup",
          "rds:ModifyDBSubnetGroup",
          "rds:DeleteDBSubnetGroup",
          "rds:AddTagsToResource",
        ]),
        READ_INFRA,
      ],
    },
  },
  {
    id: "storage-manager",
    title: "스토리지 담당",
    groupName: "StorageManagers",
    policyName: "School-StorageManager",
    exampleUser: "storage-mgr",
    summary: "이름이 school-로 시작하는 S3 버킷만 만들고 관리합니다.",
    can: ["school-로 시작하는 버킷 만들기·설정·삭제", "그 버킷의 객체 올리기·삭제", "버킷 목록 보기"],
    cannot: ["다른 이름의 버킷 만들기·변경", "EC2·VPC·RDS·IAM 변경"],
    why: "Resource에 버킷 이름 패턴(arn:aws:s3:::school-*)을 적으면 권한이 그 버킷들로만 좁혀집니다. 같은 s3:* 권한이라도 대상 리소스를 제한하는 것이 최소 권한의 핵심입니다.",
    document: {
      Version: "2012-10-17",
      Statement: [
        statement("ListAllBuckets", ["s3:ListAllMyBuckets"]),
        statement("ManageSchoolBuckets", ["s3:*"], ["arn:aws:s3:::school-*", "arn:aws:s3:::school-*/*"]),
      ],
    },
  },
  {
    id: "monitoring",
    title: "모니터링 담당",
    groupName: "MonitoringTeam",
    policyName: "School-Monitoring",
    exampleUser: "monitor",
    summary: "CloudWatch 경보·대시보드를 만들고, 모든 리소스를 조회합니다.",
    can: ["CloudWatch 경보·대시보드 만들기·삭제", "모든 리소스 조회"],
    cannot: ["서버·네트워크·DB·S3·IAM 변경"],
    why: "장애를 지켜보는 사람은 모든 것을 볼 수 있어야 하지만 바꿀 필요는 없습니다. 보기 권한과 바꾸기 권한을 나누는 대표적인 예입니다.",
    document: {
      Version: "2012-10-17",
      Statement: [statement("ManageMonitoring", ["cloudwatch:*"]), READ_INFRA],
    },
  },
  {
    id: "auditor",
    title: "감사·읽기 전용",
    groupName: "Auditors",
    policyName: null,
    managedPolicyId: "aws:ReadOnlyAccess",
    exampleUser: "auditor",
    summary: "AWS 관리형 정책 ReadOnlyAccess로 모든 것을 보기만 합니다.",
    can: ["모든 서비스 조회 (Describe·List·Get)"],
    cannot: ["어떤 리소스도 만들거나 바꾸거나 삭제하지 못함"],
    why: "점검·감사 담당자나 수업 참관자에게 알맞습니다. 직접 정책을 쓰지 않고 AWS 관리형 정책을 연결하는 예이기도 합니다.",
    document: null,
  },
  {
    id: "student",
    title: "학생 실습",
    groupName: "Students",
    policyName: "School-Student",
    exampleUser: "student01",
    summary: "실습용 EC2를 켜고 끄고, student-로 시작하는 버킷만 씁니다. 네트워크·IAM 변경은 명시적으로 막습니다.",
    can: ["EC2 시작·중지·재부팅·종료", "student-로 시작하는 S3 버킷 만들기·사용", "모든 리소스 조회"],
    cannot: ["IAM 변경 (명시적 Deny)", "VPC·서브넷·경로·게이트웨이 변경, 보안 그룹 인바운드 열기 (명시적 Deny)", "RDS·로드 밸런서 변경"],
    why: "Deny 문장은 다른 정책이 허용해도 항상 이깁니다. 학생이 실수로 다른 그룹에 들어가도 네트워크와 권한은 바꿀 수 없게 하는 안전장치입니다. (실제 AWS에서는 Condition으로 인스턴스 유형을 t3.micro로 제한하기도 하지만, 이 시뮬레이터는 Condition을 평가하지 않습니다.)",
    document: {
      Version: "2012-10-17",
      Statement: [
        statement("RunLabInstances", ["ec2:RunInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances", "ec2:TerminateInstances", "ec2:CreateTags"]),
        statement("UseStudentBuckets", ["s3:*"], ["arn:aws:s3:::student-*", "arn:aws:s3:::student-*/*"]),
        statement("ListAllBuckets", ["s3:ListAllMyBuckets"]),
        READ_INFRA,
        statement(
          "DenyIamAndNetworkChanges",
          [
            "iam:*",
            "ec2:CreateVpc",
            "ec2:DeleteVpc",
            "ec2:CreateSubnet",
            "ec2:DeleteSubnet",
            "ec2:CreateRoute",
            "ec2:ReplaceRoute",
            "ec2:DeleteRoute",
            "ec2:CreateInternetGateway",
            "ec2:AttachInternetGateway",
            "ec2:CreateNatGateway",
            "ec2:AuthorizeSecurityGroupIngress",
          ],
          "*",
          "Deny",
        ),
      ],
    },
  },
  {
    id: "iam-admin",
    title: "권한 관리자 (IAM)",
    groupName: "IamAdmins",
    policyName: "School-IamAdmin",
    exampleUser: "iam-admin",
    summary: "사용자·그룹·역할·정책을 관리합니다. 인프라는 만들지 않습니다.",
    can: ["IAM 사용자·그룹·역할·정책 관리", "모든 리소스 조회"],
    cannot: ["EC2·VPC·RDS·S3 등 인프라 변경"],
    why: "권한을 주는 사람과 인프라를 다루는 사람을 나누는 '직무 분리'입니다. 다만 IAM 전체 권한이 있으면 자기 자신에게 관리자 정책을 붙일 수도 있어, 실제 AWS에서는 권한 경계(Permissions boundary)로 한 번 더 막습니다 (이 시뮬레이터는 권한 경계를 평가하지 않습니다).",
    document: {
      Version: "2012-10-17",
      Statement: [statement("ManageIam", ["iam:*"]), READ_INFRA],
    },
  },
  {
    id: "instructor",
    title: "강사 (관리자)",
    groupName: "Instructors",
    policyName: null,
    managedPolicyId: "aws:AdministratorAccess",
    exampleUser: "teacher",
    summary: "AWS 관리형 정책 AdministratorAccess로 모든 작업을 합니다. 루트 사용자 대신 씁니다.",
    can: ["모든 서비스의 모든 작업"],
    cannot: ["(제한 없음) — 꼭 필요한 사람에게만 주고 MFA를 켜세요"],
    why: "루트 사용자는 계정 해지·결제 같은 일만 하고 평소에는 쓰지 않는 것이 AWS 권장 사항입니다. 관리 작업도 관리자 그룹의 IAM 사용자로 합니다.",
    document: null,
  },
];

export function roleTemplate(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.id === id);
}

export function templatePolicyDocument(t: RoleTemplate): string | null {
  return t.document ? JSON.stringify(t.document, null, 2) : null;
}

// ---------------------------------------------------------------- 권한 표

export interface Capability {
  id: string;
  label: string;
  /** 대표 작업과 리소스 (모두 허용되어야 "가능") */
  checks: { action: string; resource: string }[];
}

/** 권한 표의 열: 역할마다 이 일을 할 수 있는지 대표 작업으로 확인한다 */
export const CAPABILITIES: Capability[] = [
  { id: "network", label: "VPC·서브넷·경로", checks: [{ action: "ec2:CreateVpc", resource: "*" }, { action: "ec2:CreateRoute", resource: "*" }] },
  { id: "firewall", label: "보안 그룹·NACL", checks: [{ action: "ec2:CreateSecurityGroup", resource: "*" }, { action: "ec2:AuthorizeSecurityGroupIngress", resource: "*" }] },
  { id: "ec2", label: "EC2 인스턴스", checks: [{ action: "ec2:RunInstances", resource: "*" }] },
  { id: "elb", label: "로드 밸런서", checks: [{ action: "elasticloadbalancing:CreateLoadBalancer", resource: "*" }] },
  { id: "rds", label: "RDS", checks: [{ action: "rds:CreateDBInstance", resource: "*" }] },
  { id: "s3-school", label: "S3 school-*", checks: [{ action: "s3:CreateBucket", resource: "arn:aws:s3:::school-data" }] },
  { id: "s3-student", label: "S3 student-*", checks: [{ action: "s3:CreateBucket", resource: "arn:aws:s3:::student-lab" }] },
  { id: "s3-other", label: "S3 그 밖의 버킷", checks: [{ action: "s3:CreateBucket", resource: "arn:aws:s3:::other-bucket" }] },
  { id: "cloudwatch", label: "CloudWatch 경보", checks: [{ action: "cloudwatch:PutMetricAlarm", resource: "*" }] },
  { id: "iam", label: "IAM", checks: [{ action: "iam:CreateUser", resource: "*" }] },
  { id: "read", label: "조회", checks: [{ action: "ec2:DescribeInstances", resource: "*" }] },
];

export type CapabilityDecision = "allowed" | "explicit-deny" | "implicit-deny";

/** 주체(사용자·역할)의 능력 표. 하나라도 막히면 그 칸은 막힘으로 본다 (명시적 Deny가 있으면 Deny로 표시) */
export function capabilityRow(project: Project, principal: IamPrincipal): Record<string, CapabilityDecision> {
  const row: Record<string, CapabilityDecision> = {};
  for (const cap of CAPABILITIES) {
    let result: CapabilityDecision = "allowed";
    for (const c of cap.checks) {
      const d = evaluateIam(project, principal, c.action, c.resource).decision;
      if (d === "explicit-deny") {
        result = "explicit-deny";
        break;
      }
      if (d === "implicit-deny") result = "implicit-deny";
    }
    row[cap.id] = result;
  }
  return row;
}

/** 템플릿 정책 하나만 붙은 가상의 역할 (프로젝트에 아직 만들지 않았어도 권한을 미리 계산할 수 있다) */
function previewPrincipal(project: Project, t: RoleTemplate): { project: Project; principal: IamPrincipal } {
  const policyId = t.managedPolicyId ?? `template:${t.id}`;
  const preview: Project = t.managedPolicyId
    ? project
    : {
        ...project,
        services: {
          ...project.services,
          iam: {
            ...project.services.iam,
            policies: [
              ...project.services.iam.policies,
              { id: policyId, name: t.policyName ?? t.id, description: "", document: templatePolicyDocument(t) ?? "{}", createdAt: "", updatedAt: "" },
            ],
          },
        },
      };
  const role: IamRole = { id: `preview-${t.id}`, name: t.groupName, description: "", trustedEntity: "account", createdAt: "", policyIds: [policyId] };
  return { project: preview, principal: { kind: "role", role } };
}

export function templateCapabilityRow(project: Project, t: RoleTemplate): Record<string, CapabilityDecision> {
  const p = previewPrincipal(project, t);
  return capabilityRow(p.project, p.principal);
}

/** 거부된 작업을 맡는 템플릿 이름 (오류 안내용). 전체 관리자·읽기 전용을 빼고 그 작업을 허용하는 첫 템플릿 */
export function templateOwnerOf(project: Project, action: string): string | null {
  for (const t of ROLE_TEMPLATES) {
    if (t.managedPolicyId) continue;
    const p = previewPrincipal(project, t);
    if (evaluateIam(p.project, p.principal, action, "*").decision === "allowed") return t.title;
  }
  return null;
}
