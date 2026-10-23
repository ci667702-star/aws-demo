"use client";

/**
 * 콘솔 해시 경로 → 페이지 매핑과 이동 경로(breadcrumb).
 */
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
