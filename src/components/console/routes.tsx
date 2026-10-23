"use client";

/**
 * 콘솔 해시 경로 → 페이지 매핑과 이동 경로(breadcrumb).
 */
import { AlarmDetailPage, AlarmListPage, CreateAlarmPage, EditAlarmPage } from "./pages/cloudwatch/cw-alarms";
import { DashboardDetailPage, DashboardListPage } from "./pages/cloudwatch/cw-dashboards";
import { LoadTestPage } from "./pages/cloudwatch/cw-load";
import { MetricsPage } from "./pages/cloudwatch/cw-metrics";
import { CloudWatchOverviewPage } from "./pages/cloudwatch/cw-overview";
import { Ec2DashboardPage, RdsDashboardPage, VpcDashboardPage } from "./pages/dashboards";
import {
  CreateDatabasePage,
  CreateDbSubnetGroupPage,
  DatabaseDetailPage,
  DatabaseListPage,
  DbSubnetGroupDetailPage,
  DbSubnetGroupListPage,
  EditDbSubnetGroupPage,
  ModifyDatabasePage,
} from "./pages/databases";
import {
  AllocateEipPage,
  AssociateEipPage,
  AttachIgwPage,
  CreateIgwPage,
  CreateNatPage,
  EipDetailPage,
  EipListPage,
  IgwDetailPage,
  IgwListPage,
  NatDetailPage,
  NatListPage,
} from "./pages/gateways";
import { ConsoleHomePage } from "./pages/home";
import { IamDashboardPage } from "./pages/iam/iam-dashboard";
import { CreateGroupPage, GroupDetailPage, GroupListPage } from "./pages/iam/iam-groups";
import { CreatePolicyPage, EditPolicyPage, PolicyDetailPage, PolicyListPage } from "./pages/iam/iam-policies";
import { CreateRolePage, RoleDetailPage, RoleListPage } from "./pages/iam/iam-roles";
import { CreateAccessKeyPage, CreateUserPage, UserDetailPage, UserListPage } from "./pages/iam/iam-users";
import { PolicySimulatorPage } from "./pages/iam/iam-simulator";
import { ModifyInstanceRolePage } from "./pages/iam/instance-role";
import { ChangeInstanceSgsPage, EditUserDataPage, InstanceDetailPage, InstanceListPage } from "./pages/instances";
import { LaunchInstancePage } from "./pages/launch-instance";
import {
  CreateLoadBalancerPage,
  EditLbSecurityGroupsPage,
  EditLbSubnetsPage,
  LoadBalancerDetailPage,
  LoadBalancerListPage,
  SelectLbTypePage,
} from "./pages/load-balancers";
import { CreatePathPage, PathDetailPage, PathListPage } from "./pages/reachability";
import { ResourceMapPage } from "./pages/resource-map";
import { S3AccessTestPage } from "./pages/s3/s3-access-test";
import { BucketDetailPage } from "./pages/s3/s3-bucket-detail";
import { BucketListPage, CreateBucketPage } from "./pages/s3/s3-buckets";
import { EditBpaPage, EditBucketPolicyPage, EditEncryptionPage, EditVersioningPage, EditWebsitePage, UploadPage } from "./pages/s3/s3-edit";
import { ObjectDetailPage } from "./pages/s3/s3-object";
import { CreateRouteTablePage, EditRoutesPage, EditRouteTableAssociationsPage, RouteTableDetailPage, RouteTableListPage } from "./pages/route-tables";
import {
  CreateNaclPage,
  CreateSecurityGroupPage,
  EditNaclAssociationsPage,
  EditNaclRulesPage,
  EditSgRulesPage,
  NaclDetailPage,
  NaclListPage,
  SecurityGroupDetailPage,
  SecurityGroupListPage,
} from "./pages/security";
import { CreateSubnetPage, EditSubnetNaclPage, EditSubnetRouteTablePage, EditSubnetSettingsPage, SubnetDetailPage, SubnetListPage } from "./pages/subnets";
import { CreateTargetGroupPage, EditHealthCheckPage, TargetGroupDetailPage, TargetGroupListPage } from "./pages/target-groups";
import { ActivityPage, BillingPage, ChecksPage } from "./pages/tools";
import { CreateVpcPage, EditVpcSettingsPage, VpcDetailPage, VpcListPage } from "./pages/vpcs";
import { matchPath } from "./router";
import { ButtonLink } from "./ui/button";
import { Container, EmptyState } from "./ui/layout";

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
