"use client";

/**
 * 콘솔 해시 경로 → 페이지 매핑과 이동 경로(breadcrumb).
 */
import { lazyGroup } from "@/components/app/lazy";
import { ConsoleHomePage } from "./pages/home";
import { matchPath } from "./router";
import { ButtonLink } from "./ui/button";
import { Container, EmptyState } from "./ui/layout";

// 화면 코드는 파일(서비스)별로 나눠 필요할 때 불러온다 (콘솔 첫 화면이 모든 화면 코드를 기다리지 않게).
// 콘솔이 열리면 한가할 때 미리 받아 두므로(console-shell) 보통은 기다림 없이 열린다.
const { AlarmDetailPage, AlarmListPage, CreateAlarmPage, EditAlarmPage } = lazyGroup(() => import("./pages/cloudwatch/cw-alarms"), ["AlarmDetailPage", "AlarmListPage", "CreateAlarmPage", "EditAlarmPage"]);
const { DashboardDetailPage, DashboardListPage } = lazyGroup(() => import("./pages/cloudwatch/cw-dashboards"), ["DashboardDetailPage", "DashboardListPage"]);
const { LoadTestPage } = lazyGroup(() => import("./pages/cloudwatch/cw-load"), ["LoadTestPage"]);
const { MetricsPage } = lazyGroup(() => import("./pages/cloudwatch/cw-metrics"), ["MetricsPage"]);
const { CloudWatchOverviewPage } = lazyGroup(() => import("./pages/cloudwatch/cw-overview"), ["CloudWatchOverviewPage"]);
const { Ec2DashboardPage, RdsDashboardPage, VpcDashboardPage } = lazyGroup(() => import("./pages/dashboards"), ["Ec2DashboardPage", "RdsDashboardPage", "VpcDashboardPage"]);
const { CreateDatabasePage, CreateDbSubnetGroupPage, DatabaseDetailPage, DatabaseListPage, DbSubnetGroupDetailPage, DbSubnetGroupListPage, EditDbSubnetGroupPage, ModifyDatabasePage } = lazyGroup(() => import("./pages/databases"), ["CreateDatabasePage", "CreateDbSubnetGroupPage", "DatabaseDetailPage", "DatabaseListPage", "DbSubnetGroupDetailPage", "DbSubnetGroupListPage", "EditDbSubnetGroupPage", "ModifyDatabasePage"]);
const { AllocateEipPage, AssociateEipPage, AttachIgwPage, CreateIgwPage, CreateNatPage, EipDetailPage, EipListPage, IgwDetailPage, IgwListPage, NatDetailPage, NatListPage } = lazyGroup(() => import("./pages/gateways"), ["AllocateEipPage", "AssociateEipPage", "AttachIgwPage", "CreateIgwPage", "CreateNatPage", "EipDetailPage", "EipListPage", "IgwDetailPage", "IgwListPage", "NatDetailPage", "NatListPage"]);
const { IamDashboardPage } = lazyGroup(() => import("./pages/iam/iam-dashboard"), ["IamDashboardPage"]);
const { CreateGroupPage, GroupDetailPage, GroupListPage } = lazyGroup(() => import("./pages/iam/iam-groups"), ["CreateGroupPage", "GroupDetailPage", "GroupListPage"]);
const { CreatePolicyPage, EditPolicyPage, PolicyDetailPage, PolicyListPage } = lazyGroup(() => import("./pages/iam/iam-policies"), ["CreatePolicyPage", "EditPolicyPage", "PolicyDetailPage", "PolicyListPage"]);
const { CreateRolePage, RoleDetailPage, RoleListPage } = lazyGroup(() => import("./pages/iam/iam-roles"), ["CreateRolePage", "RoleDetailPage", "RoleListPage"]);
const { CreateAccessKeyPage, CreateUserPage, UserDetailPage, UserListPage } = lazyGroup(() => import("./pages/iam/iam-users"), ["CreateAccessKeyPage", "CreateUserPage", "UserDetailPage", "UserListPage"]);
const { PolicySimulatorPage } = lazyGroup(() => import("./pages/iam/iam-simulator"), ["PolicySimulatorPage"]);
const { RoleTemplatesPage } = lazyGroup(() => import("./pages/iam/iam-templates"), ["RoleTemplatesPage"]);
const { ModifyInstanceRolePage } = lazyGroup(() => import("./pages/iam/instance-role"), ["ModifyInstanceRolePage"]);
const { ChangeInstanceSgsPage, EditUserDataPage, InstanceDetailPage, InstanceListPage } = lazyGroup(() => import("./pages/instances"), ["ChangeInstanceSgsPage", "EditUserDataPage", "InstanceDetailPage", "InstanceListPage"]);
const { LaunchInstancePage } = lazyGroup(() => import("./pages/launch-instance"), ["LaunchInstancePage"]);
const { AddFunctionPermissionPage, CreateFunctionPage, EditFunctionVpcPage, FunctionDetailPage, FunctionListPage } = lazyGroup(() => import("./pages/lambda/lambda-functions"), ["AddFunctionPermissionPage", "CreateFunctionPage", "EditFunctionVpcPage", "FunctionDetailPage", "FunctionListPage"]);
const { CreateRulePage, CreateSchedulePage, EditRulePage, EditSchedulePage, EventBridgeOverviewPage, RuleDetailPage, RuleListPage, ScheduleDetailPage, ScheduleListPage, SendEventPage } = lazyGroup(() => import("./pages/eventbridge/eventbridge-pages"), ["CreateRulePage", "CreateSchedulePage", "EditRulePage", "EditSchedulePage", "EventBridgeOverviewPage", "RuleDetailPage", "RuleListPage", "ScheduleDetailPage", "ScheduleListPage", "SendEventPage"]);
const { CreateLoadBalancerPage, EditLbSecurityGroupsPage, EditLbSubnetsPage, LoadBalancerDetailPage, LoadBalancerListPage, SelectLbTypePage } = lazyGroup(() => import("./pages/load-balancers"), ["CreateLoadBalancerPage", "EditLbSecurityGroupsPage", "EditLbSubnetsPage", "LoadBalancerDetailPage", "LoadBalancerListPage", "SelectLbTypePage"]);
const { CreatePathPage, PathDetailPage, PathListPage } = lazyGroup(() => import("./pages/reachability"), ["CreatePathPage", "PathDetailPage", "PathListPage"]);
const { ResourceMapPage } = lazyGroup(() => import("./pages/resource-map"), ["ResourceMapPage"]);
const { S3AccessTestPage } = lazyGroup(() => import("./pages/s3/s3-access-test"), ["S3AccessTestPage"]);
const { BucketDetailPage } = lazyGroup(() => import("./pages/s3/s3-bucket-detail"), ["BucketDetailPage"]);
const { BucketListPage, CreateBucketPage } = lazyGroup(() => import("./pages/s3/s3-buckets"), ["BucketListPage", "CreateBucketPage"]);
const { EditBpaPage, EditBucketPolicyPage, EditEncryptionPage, EditVersioningPage, EditWebsitePage, UploadPage } = lazyGroup(() => import("./pages/s3/s3-edit"), ["EditBpaPage", "EditBucketPolicyPage", "EditEncryptionPage", "EditVersioningPage", "EditWebsitePage", "UploadPage"]);
const { ObjectDetailPage } = lazyGroup(() => import("./pages/s3/s3-object"), ["ObjectDetailPage"]);
const { CreateRouteTablePage, EditRoutesPage, EditRouteTableAssociationsPage, RouteTableDetailPage, RouteTableListPage } = lazyGroup(() => import("./pages/route-tables"), ["CreateRouteTablePage", "EditRoutesPage", "EditRouteTableAssociationsPage", "RouteTableDetailPage", "RouteTableListPage"]);
const { CreateNaclPage, CreateSecurityGroupPage, EditNaclAssociationsPage, EditNaclRulesPage, EditSgRulesPage, NaclDetailPage, NaclListPage, SecurityGroupDetailPage, SecurityGroupListPage } = lazyGroup(() => import("./pages/security"), ["CreateNaclPage", "CreateSecurityGroupPage", "EditNaclAssociationsPage", "EditNaclRulesPage", "EditSgRulesPage", "NaclDetailPage", "NaclListPage", "SecurityGroupDetailPage", "SecurityGroupListPage"]);
const { CreateSubnetPage, EditSubnetNaclPage, EditSubnetRouteTablePage, EditSubnetSettingsPage, SubnetDetailPage, SubnetListPage } = lazyGroup(() => import("./pages/subnets"), ["CreateSubnetPage", "EditSubnetNaclPage", "EditSubnetRouteTablePage", "EditSubnetSettingsPage", "SubnetDetailPage", "SubnetListPage"]);
const { CreateTargetGroupPage, EditHealthCheckPage, TargetGroupDetailPage, TargetGroupListPage } = lazyGroup(() => import("./pages/target-groups"), ["CreateTargetGroupPage", "EditHealthCheckPage", "TargetGroupDetailPage", "TargetGroupListPage"]);
const { ActivityPage, BillingPage, ChecksPage } = lazyGroup(() => import("./pages/tools"), ["ActivityPage", "BillingPage", "ChecksPage"]);
const { CreateVpcPage, EditVpcSettingsPage, VpcDetailPage, VpcListPage } = lazyGroup(() => import("./pages/vpcs"), ["CreateVpcPage", "EditVpcSettingsPage", "VpcDetailPage", "VpcListPage"]);
const { CreateDistributionPage, DistributionDetailPage, DistributionListPage, EditDistributionPage } = lazyGroup(() => import("./pages/cloudfront/cloudfront-pages"), ["CreateDistributionPage", "DistributionDetailPage", "DistributionListPage", "EditDistributionPage"]);
const { CreateSecretPage, SecretDetailPage, SecretListPage } = lazyGroup(() => import("./pages/secretsmanager/secrets-pages"), ["CreateSecretPage", "SecretDetailPage", "SecretListPage"]);
const { CreateParameterPage, EditParameterPage, ManagedNodesPage, ParameterDetailPage, ParameterListPage, SessionManagerPage, SessionPage, SsmOverviewPage } = lazyGroup(() => import("./pages/ssm/ssm-pages"), [
  "CreateParameterPage",
  "EditParameterPage",
  "ManagedNodesPage",
  "ParameterDetailPage",
  "ParameterListPage",
  "SessionManagerPage",
  "SessionPage",
  "SsmOverviewPage",
]);

export interface Crumb {
  text: string;
  path?: string;
}

interface RouteDef {
  pattern: string;
  title: string | ((p: Record<string, string>) => string);
  crumbs: (p: Record<string, string>) => Crumb[];
  render: (p: Record<string, string>) => React.ReactNode;
  fullWidth?: boolean;
}

export interface ResolvedRoute {
  title: string;
  crumbs: Crumb[];
  element: React.ReactNode;
  fullWidth: boolean;
}

const VPC: Crumb = { text: "VPC", path: "/vpc" };
const EC2: Crumb = { text: "EC2", path: "/ec2" };
const RDS: Crumb = { text: "RDS", path: "/rds" };
const IAM: Crumb = { text: "IAM", path: "/iam" };
const S3: Crumb = { text: "S3", path: "/s3" };
const BUCKETS: Crumb = { text: "범용 버킷", path: "/s3" };
const CW: Crumb = { text: "CloudWatch", path: "/cloudwatch" };
const LAMBDA: Crumb = { text: "Lambda", path: "/lambda/functions" };
const EB: Crumb = { text: "EventBridge", path: "/eventbridge" };
const CF: Crumb = { text: "CloudFront", path: "/cloudfront/distributions" };
const SM: Crumb = { text: "Secrets Manager", path: "/secretsmanager/secrets" };
const SSM: Crumb = { text: "Systems Manager", path: "/ssm" };
const TOOLS: Crumb = { text: "도구" };

interface ResourcePages {
  list: () => React.ReactNode;
  create?: { segment: string; label: string; render: () => React.ReactNode }[];
  detail?: (id: string) => React.ReactNode;
  actions?: { segment: string; label: string; render: (id: string) => React.ReactNode }[];
}

/** 목록 / 생성 / 상세 / 하위 작업 경로를 한 번에 정의 */
function resourceRoutes(service: Crumb, base: string, listLabel: string, pages: ResourcePages): RouteDef[] {
  const list: Crumb = { text: listLabel, path: base };
  const routes: RouteDef[] = [{ pattern: base, title: listLabel, crumbs: () => [service, { text: listLabel }], render: pages.list }];
  for (const c of pages.create ?? []) {
    routes.push({ pattern: `${base}/${c.segment}`, title: c.label, crumbs: () => [service, list, { text: c.label }], render: c.render });
  }
  for (const a of pages.actions ?? []) {
    routes.push({
      pattern: `${base}/:id/${a.segment}`,
      title: (p) => `${a.label} - ${p.id}`,
      crumbs: (p) => [service, list, { text: p.id, path: `${base}/${encodeURIComponent(p.id)}` }, { text: a.label }],
      render: (p) => a.render(p.id),
    });
  }
  if (pages.detail) {
    const d = pages.detail;
    routes.push({ pattern: `${base}/:id`, title: (p) => p.id, crumbs: (p) => [service, list, { text: p.id }], render: (p) => d(p.id) });
  }
  return routes;
}

const ROUTES: RouteDef[] = [
  { pattern: "/", title: "콘솔 홈", crumbs: () => [], render: () => <ConsoleHomePage /> },

  // ------------------------------------------------------------ VPC
  { pattern: "/vpc", title: "VPC 대시보드", crumbs: () => [VPC, { text: "VPC 대시보드" }], render: () => <VpcDashboardPage /> },
  ...resourceRoutes(VPC, "/vpc/vpcs", "VPC", {
    list: () => <VpcListPage />,
    create: [{ segment: "create", label: "VPC 생성", render: () => <CreateVpcPage /> }],
    actions: [{ segment: "edit-settings", label: "VPC 설정 편집", render: (id) => <EditVpcSettingsPage id={id} /> }],
    detail: (id) => <VpcDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/subnets", "서브넷", {
    list: () => <SubnetListPage />,
    create: [{ segment: "create", label: "서브넷 생성", render: () => <CreateSubnetPage /> }],
    actions: [
      { segment: "edit-settings", label: "서브넷 설정 편집", render: (id) => <EditSubnetSettingsPage id={id} /> },
      { segment: "edit-route-table", label: "라우팅 테이블 연결 편집", render: (id) => <EditSubnetRouteTablePage id={id} /> },
      { segment: "edit-network-acl", label: "네트워크 ACL 연결 편집", render: (id) => <EditSubnetNaclPage id={id} /> },
    ],
    detail: (id) => <SubnetDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/route-tables", "라우팅 테이블", {
    list: () => <RouteTableListPage />,
    create: [{ segment: "create", label: "라우팅 테이블 생성", render: () => <CreateRouteTablePage /> }],
    actions: [
      { segment: "edit-routes", label: "라우팅 편집", render: (id) => <EditRoutesPage id={id} /> },
      { segment: "edit-associations", label: "서브넷 연결 편집", render: (id) => <EditRouteTableAssociationsPage id={id} /> },
    ],
    detail: (id) => <RouteTableDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/igws", "인터넷 게이트웨이", {
    list: () => <IgwListPage />,
    create: [{ segment: "create", label: "인터넷 게이트웨이 생성", render: () => <CreateIgwPage /> }],
    actions: [{ segment: "attach", label: "VPC에 연결", render: (id) => <AttachIgwPage id={id} /> }],
    detail: (id) => <IgwDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/eips", "탄력적 IP", {
    list: () => <EipListPage />,
    create: [{ segment: "allocate", label: "탄력적 IP 주소 할당", render: () => <AllocateEipPage /> }],
    actions: [{ segment: "associate", label: "탄력적 IP 주소 연결", render: (id) => <AssociateEipPage id={id} /> }],
    detail: (id) => <EipDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/nat-gateways", "NAT 게이트웨이", {
    list: () => <NatListPage />,
    create: [{ segment: "create", label: "NAT 게이트웨이 생성", render: () => <CreateNatPage /> }],
    detail: (id) => <NatDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/network-acls", "네트워크 ACL", {
    list: () => <NaclListPage />,
    create: [{ segment: "create", label: "네트워크 ACL 생성", render: () => <CreateNaclPage /> }],
    actions: [
      { segment: "edit-inbound", label: "인바운드 규칙 편집", render: (id) => <EditNaclRulesPage id={id} direction="inbound" /> },
      { segment: "edit-outbound", label: "아웃바운드 규칙 편집", render: (id) => <EditNaclRulesPage id={id} direction="outbound" /> },
      { segment: "edit-associations", label: "서브넷 연결 편집", render: (id) => <EditNaclAssociationsPage id={id} /> },
    ],
    detail: (id) => <NaclDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/security-groups", "보안 그룹", {
    list: () => <SecurityGroupListPage />,
    create: [{ segment: "create", label: "보안 그룹 생성", render: () => <CreateSecurityGroupPage /> }],
    actions: [
      { segment: "edit-inbound", label: "인바운드 규칙 편집", render: (id) => <EditSgRulesPage key={`${id}-in`} id={id} direction="inbound" /> },
      { segment: "edit-outbound", label: "아웃바운드 규칙 편집", render: (id) => <EditSgRulesPage key={`${id}-out`} id={id} direction="outbound" /> },
    ],
    detail: (id) => <SecurityGroupDetailPage id={id} />,
  }),
  ...resourceRoutes(VPC, "/vpc/reachability", "Reachability Analyzer", {
    list: () => <PathListPage />,
    create: [{ segment: "create", label: "경로 생성 및 분석", render: () => <CreatePathPage /> }],
    detail: (id) => <PathDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ EC2
  { pattern: "/ec2", title: "EC2 대시보드", crumbs: () => [EC2, { text: "EC2 대시보드" }], render: () => <Ec2DashboardPage /> },
  ...resourceRoutes(EC2, "/ec2/instances", "인스턴스", {
    list: () => <InstanceListPage />,
    create: [{ segment: "launch", label: "인스턴스 시작", render: () => <LaunchInstancePage /> }],
    actions: [
      { segment: "security-groups", label: "보안 그룹 변경", render: (id) => <ChangeInstanceSgsPage id={id} /> },
      { segment: "user-data", label: "사용자 데이터 편집", render: (id) => <EditUserDataPage id={id} /> },
      { segment: "iam-role", label: "IAM 역할 수정", render: (id) => <ModifyInstanceRolePage id={id} /> },
    ],
    detail: (id) => <InstanceDetailPage id={id} />,
  }),
  ...resourceRoutes(EC2, "/ec2/security-groups", "보안 그룹", {
    list: () => <SecurityGroupListPage base="/ec2" />,
    create: [{ segment: "create", label: "보안 그룹 생성", render: () => <CreateSecurityGroupPage base="/ec2" /> }],
  }),
  ...resourceRoutes(EC2, "/ec2/eips", "탄력적 IP", {
    list: () => <EipListPage base="/ec2" />,
    create: [{ segment: "allocate", label: "탄력적 IP 주소 할당", render: () => <AllocateEipPage base="/ec2" /> }],
  }),
  ...resourceRoutes(EC2, "/ec2/load-balancers", "로드 밸런서", {
    list: () => <LoadBalancerListPage />,
    create: [
      { segment: "select-type", label: "로드 밸런서 유형 선택", render: () => <SelectLbTypePage /> },
      { segment: "create", label: "Application Load Balancer 생성", render: () => <CreateLoadBalancerPage /> },
    ],
    actions: [
      { segment: "edit-subnets", label: "서브넷 편집", render: (id) => <EditLbSubnetsPage id={id} /> },
      { segment: "edit-security-groups", label: "보안 그룹 편집", render: (id) => <EditLbSecurityGroupsPage id={id} /> },
    ],
    detail: (id) => <LoadBalancerDetailPage id={id} />,
  }),
  ...resourceRoutes(EC2, "/ec2/target-groups", "대상 그룹", {
    list: () => <TargetGroupListPage />,
    create: [{ segment: "create", label: "대상 그룹 생성", render: () => <CreateTargetGroupPage /> }],
    actions: [{ segment: "edit-health-check", label: "상태 검사 설정 편집", render: (id) => <EditHealthCheckPage id={id} /> }],
    detail: (id) => <TargetGroupDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ Lambda
  { pattern: "/lambda", title: "함수", crumbs: () => [LAMBDA, { text: "함수" }], render: () => <FunctionListPage /> },
  ...resourceRoutes(LAMBDA, "/lambda/functions", "함수", {
    list: () => <FunctionListPage />,
    create: [{ segment: "create", label: "함수 생성", render: () => <CreateFunctionPage /> }],
    actions: [
      { segment: "edit-vpc", label: "VPC 편집", render: (id) => <EditFunctionVpcPage id={id} /> },
      { segment: "add-permission", label: "권한 추가", render: (id) => <AddFunctionPermissionPage id={id} /> },
    ],
    detail: (id) => <FunctionDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ EventBridge
  { pattern: "/eventbridge", title: "EventBridge", crumbs: () => [EB, { text: "개요" }], render: () => <EventBridgeOverviewPage /> },
  { pattern: "/eventbridge/send-event", title: "테스트 이벤트 보내기", crumbs: () => [EB, { text: "테스트 이벤트 보내기" }], render: () => <SendEventPage /> },
  ...resourceRoutes(EB, "/eventbridge/schedules", "일정", {
    list: () => <ScheduleListPage />,
    create: [{ segment: "create", label: "일정 생성", render: () => <CreateSchedulePage /> }],
    actions: [{ segment: "edit", label: "일정 편집", render: (id) => <EditSchedulePage id={id} /> }],
    detail: (id) => <ScheduleDetailPage id={id} />,
  }),
  ...resourceRoutes(EB, "/eventbridge/rules", "규칙", {
    list: () => <RuleListPage />,
    create: [{ segment: "create", label: "규칙 생성", render: () => <CreateRulePage /> }],
    actions: [{ segment: "edit", label: "규칙 편집", render: (id) => <EditRulePage id={id} /> }],
    detail: (id) => <RuleDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ RDS
  { pattern: "/rds", title: "RDS 대시보드", crumbs: () => [RDS, { text: "RDS 대시보드" }], render: () => <RdsDashboardPage /> },
  ...resourceRoutes(RDS, "/rds/databases", "데이터베이스", {
    list: () => <DatabaseListPage />,
    create: [{ segment: "create", label: "데이터베이스 생성", render: () => <CreateDatabasePage /> }],
    actions: [{ segment: "modify", label: "수정", render: (id) => <ModifyDatabasePage id={id} /> }],
    detail: (id) => <DatabaseDetailPage id={id} />,
  }),
  ...resourceRoutes(RDS, "/rds/subnet-groups", "서브넷 그룹", {
    list: () => <DbSubnetGroupListPage />,
    create: [{ segment: "create", label: "DB 서브넷 그룹 생성", render: () => <CreateDbSubnetGroupPage /> }],
    actions: [{ segment: "edit", label: "편집", render: (id) => <EditDbSubnetGroupPage id={id} /> }],
    detail: (id) => <DbSubnetGroupDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ IAM
  { pattern: "/iam", title: "IAM 대시보드", crumbs: () => [IAM, { text: "대시보드" }], render: () => <IamDashboardPage /> },
  ...resourceRoutes(IAM, "/iam/users", "사용자", {
    list: () => <UserListPage />,
    create: [{ segment: "create", label: "사용자 생성", render: () => <CreateUserPage /> }],
    actions: [{ segment: "create-access-key", label: "액세스 키 만들기", render: (id) => <CreateAccessKeyPage id={id} /> }],
    detail: (id) => <UserDetailPage id={id} />,
  }),
  ...resourceRoutes(IAM, "/iam/groups", "사용자 그룹", {
    list: () => <GroupListPage />,
    create: [{ segment: "create", label: "사용자 그룹 생성", render: () => <CreateGroupPage /> }],
    detail: (id) => <GroupDetailPage id={id} />,
  }),
  ...resourceRoutes(IAM, "/iam/roles", "역할", {
    list: () => <RoleListPage />,
    create: [{ segment: "create", label: "역할 생성", render: () => <CreateRolePage /> }],
    detail: (id) => <RoleDetailPage id={id} />,
  }),
  ...resourceRoutes(IAM, "/iam/policies", "정책", {
    list: () => <PolicyListPage />,
    create: [{ segment: "create", label: "정책 생성", render: () => <CreatePolicyPage /> }],
    actions: [{ segment: "edit", label: "정책 편집", render: (id) => <EditPolicyPage id={id} /> }],
    detail: (id) => <PolicyDetailPage id={id} />,
  }),
  { pattern: "/iam/simulator", title: "정책 시뮬레이터", crumbs: () => [IAM, { text: "정책 시뮬레이터" }], render: () => <PolicySimulatorPage /> },
  { pattern: "/iam/templates", title: "학교 역할 템플릿", crumbs: () => [IAM, { text: "학교 역할 템플릿" }], render: () => <RoleTemplatesPage /> },

  // ------------------------------------------------------------ S3
  { pattern: "/s3", title: "범용 버킷", crumbs: () => [S3, { text: "범용 버킷" }], render: () => <BucketListPage /> },
  { pattern: "/s3/create", title: "버킷 만들기", crumbs: () => [S3, BUCKETS, { text: "버킷 만들기" }], render: () => <CreateBucketPage /> },
  { pattern: "/s3/access-test", title: "S3 접근 테스트", crumbs: () => [S3, { text: "S3 접근 테스트" }], render: () => <S3AccessTestPage /> },
  ...[
    { segment: "upload", label: "업로드", render: (id: string) => <UploadPage id={id} /> },
    { segment: "object", label: "객체", render: (id: string) => <ObjectDetailPage id={id} /> },
    { segment: "edit-bpa", label: "퍼블릭 액세스 차단 편집", render: (id: string) => <EditBpaPage id={id} /> },
    { segment: "edit-policy", label: "버킷 정책 편집", render: (id: string) => <EditBucketPolicyPage id={id} /> },
    { segment: "edit-versioning", label: "버전 관리 편집", render: (id: string) => <EditVersioningPage id={id} /> },
    { segment: "edit-encryption", label: "기본 암호화 편집", render: (id: string) => <EditEncryptionPage id={id} /> },
    { segment: "edit-website", label: "정적 웹 사이트 호스팅 편집", render: (id: string) => <EditWebsitePage id={id} /> },
  ].map(
    (a): RouteDef => ({
      pattern: `/s3/buckets/:id/${a.segment}`,
      title: (p) => `${a.label} - ${p.id}`,
      crumbs: (p) => [S3, BUCKETS, { text: p.id, path: `/s3/buckets/${p.id}` }, { text: a.label }],
      render: (p) => a.render(p.id),
    }),
  ),
  { pattern: "/s3/buckets/:id", title: (p) => p.id, crumbs: (p) => [S3, BUCKETS, { text: p.id }], render: (p) => <BucketDetailPage id={p.id} /> },

  // ------------------------------------------------------------ CloudFront
  { pattern: "/cloudfront", title: "배포", crumbs: () => [CF, { text: "배포" }], render: () => <DistributionListPage /> },
  ...resourceRoutes(CF, "/cloudfront/distributions", "배포", {
    list: () => <DistributionListPage />,
    create: [{ segment: "create", label: "배포 생성", render: () => <CreateDistributionPage /> }],
    actions: [{ segment: "edit", label: "배포 편집", render: (id) => <EditDistributionPage id={id} /> }],
    detail: (id) => <DistributionDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ Secrets Manager
  { pattern: "/secretsmanager", title: "보안 암호", crumbs: () => [SM, { text: "보안 암호" }], render: () => <SecretListPage /> },
  ...resourceRoutes(SM, "/secretsmanager/secrets", "보안 암호", {
    list: () => <SecretListPage />,
    create: [{ segment: "create", label: "새 보안 암호 저장", render: () => <CreateSecretPage /> }],
    detail: (id) => <SecretDetailPage id={id} />,
  }),

  // ------------------------------------------------------------ Systems Manager
  { pattern: "/ssm", title: "Systems Manager", crumbs: () => [SSM, { text: "개요" }], render: () => <SsmOverviewPage /> },
  ...resourceRoutes(SSM, "/ssm/parameters", "Parameter Store", {
    list: () => <ParameterListPage />,
    create: [{ segment: "create", label: "파라미터 생성", render: () => <CreateParameterPage /> }],
    actions: [{ segment: "edit", label: "파라미터 편집", render: (id) => <EditParameterPage id={id} /> }],
    detail: (id) => <ParameterDetailPage id={id} />,
  }),
  { pattern: "/ssm/nodes", title: "관리형 노드", crumbs: () => [SSM, { text: "관리형 노드" }], render: () => <ManagedNodesPage /> },
  ...resourceRoutes(SSM, "/ssm/sessions", "Session Manager", {
    list: () => <SessionManagerPage />,
    // 인스턴스마다 세션 화면(가상 셸) 상태가 따로 있도록 key를 준다
    detail: (id) => <SessionPage key={id} id={id} />,
  }),

  // ------------------------------------------------------------ CloudWatch
  { pattern: "/cloudwatch", title: "CloudWatch 개요", crumbs: () => [CW, { text: "개요" }], render: () => <CloudWatchOverviewPage /> },
  { pattern: "/cloudwatch/metrics", title: "지표", crumbs: () => [CW, { text: "지표" }], render: () => <MetricsPage /> },
  ...resourceRoutes(CW, "/cloudwatch/alarms", "경보", {
    list: () => <AlarmListPage />,
    create: [{ segment: "create", label: "경보 생성", render: () => <CreateAlarmPage /> }],
    actions: [{ segment: "edit", label: "경보 편집", render: (id) => <EditAlarmPage id={id} /> }],
    detail: (id) => <AlarmDetailPage id={id} />,
  }),
  ...resourceRoutes(CW, "/cloudwatch/dashboards", "대시보드", {
    list: () => <DashboardListPage />,
    detail: (id) => <DashboardDetailPage id={id} />,
  }),
  { pattern: "/cloudwatch/load", title: "가상 부하", crumbs: () => [CW, { text: "가상 부하" }], render: () => <LoadTestPage /> },

  // ------------------------------------------------------------ 도구
  { pattern: "/map", title: "리소스 맵", crumbs: () => [TOOLS, { text: "리소스 맵" }], render: () => <ResourceMapPage />, fullWidth: true },
  { pattern: "/checks", title: "구성 검사", crumbs: () => [TOOLS, { text: "구성 검사" }], render: () => <ChecksPage /> },
  { pattern: "/billing", title: "가상 비용 추정", crumbs: () => [TOOLS, { text: "가상 비용 추정" }], render: () => <BillingPage /> },
  { pattern: "/activity", title: "이벤트 기록", crumbs: () => [TOOLS, { text: "이벤트 기록" }], render: () => <ActivityPage /> },
];

function NotFoundPage() {
  return (
    <Container>
      <EmptyState title="페이지를 찾을 수 없습니다" description="주소가 올바르지 않거나 이 시뮬레이터가 지원하지 않는 화면입니다." action={<ButtonLink href="#/">콘솔 홈으로</ButtonLink>} />
    </Container>
  );
}

export function resolveRoute(segments: string[]): ResolvedRoute {
  for (const route of ROUTES) {
    const params = matchPath(route.pattern, segments);
    if (params) {
      return {
        title: typeof route.title === "function" ? route.title(params) : route.title,
        crumbs: route.crumbs(params),
        element: route.render(params),
        fullWidth: !!route.fullWidth,
      };
    }
  }
  return { title: "페이지 없음", crumbs: [], element: <NotFoundPage />, fullWidth: false };
}
