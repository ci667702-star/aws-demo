/**
 * 콘솔 탐색 구조.
 * AWS 콘솔은 서비스마다 탐색 창이 바뀌지만, 처음 배우는 사람도 전체를 한눈에 보도록
 * 모든 서비스를 하나의 사이드바에 묶어서 보여 준다.
 */
import {
  Activity,
  Database,
  HardDrive,
  KeyRound,
  Network,
  Server,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "@/lib/engine/resource-models";
import type { Topology } from "@/lib/engine/topology-engine";

export interface NavItem {
  label: string;
  path: string;
  /** 사이드바에 표시할 리소스 개수 */
  count?: (topo: Topology, project: Project) => number;
}

export interface NavGroup {
  id: string;
  label: string;
  /** 쉬운 설명 (서비스 메뉴·홈 화면) */
  description: string;
  icon: LucideIcon;
  /** 그룹 대표 화면 */
  root: string;
  items: NavItem[];
}

const n = (type: Parameters<Topology["ofType"]>[0]) => (t: Topology) => t.ofType(type).length;

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "vpc",
    label: "네트워크 (VPC)",
    description: "나만의 가상 네트워크를 만들고 구역(서브넷)과 길(라우팅)을 정합니다.",
    icon: Network,
    root: "/vpc",
    items: [
      { label: "VPC 대시보드", path: "/vpc" },
      { label: "VPC", path: "/vpc/vpcs", count: n("vpc") },
      { label: "서브넷", path: "/vpc/subnets", count: n("subnet") },
      { label: "라우팅 테이블", path: "/vpc/route-tables", count: n("route-table") },
      { label: "인터넷 게이트웨이", path: "/vpc/igws", count: n("internet-gateway") },
      { label: "NAT 게이트웨이", path: "/vpc/nat-gateways", count: n("nat-gateway") },
      { label: "탄력적 IP", path: "/vpc/eips", count: n("elastic-ip") },
    ],
  },
  {
    id: "security",
    label: "네트워크 보안",
    description: "어떤 트래픽을 들여보내고 내보낼지 방화벽 규칙을 정합니다.",
    icon: ShieldCheck,
    root: "/vpc/security-groups",
    items: [
      { label: "보안 그룹", path: "/vpc/security-groups", count: n("security-group") },
      { label: "네트워크 ACL", path: "/vpc/network-acls", count: n("network-acl") },
    ],
  },
  {
    id: "ec2",
    label: "서버 (EC2)",
    description: "가상 서버를 실행하고, 로드 밸런서로 요청을 나눠 보냅니다.",
    icon: Server,
    root: "/ec2",
    items: [
      { label: "EC2 대시보드", path: "/ec2" },
      { label: "인스턴스", path: "/ec2/instances", count: (t) => t.ofType("ec2").filter((e) => e.config.state !== "terminated").length },
      { label: "로드 밸런서", path: "/ec2/load-balancers", count: n("alb") },
      { label: "대상 그룹", path: "/ec2/target-groups", count: n("target-group") },
    ],
  },
  {
    id: "rds",
    label: "데이터베이스 (RDS)",
    description: "관계형 데이터베이스를 프라이빗 서브넷에 배치합니다.",
    icon: Database,
    root: "/rds",
    items: [
      { label: "RDS 대시보드", path: "/rds" },
      { label: "데이터베이스", path: "/rds/databases", count: n("rds") },
      { label: "DB 서브넷 그룹", path: "/rds/subnet-groups", count: n("db-subnet-group") },
    ],
  },
  {
    id: "s3",
    label: "스토리지 (S3)",
    description: "파일(객체)을 버킷에 저장하고 공개 범위를 관리합니다.",
    icon: HardDrive,
    root: "/s3",
    items: [
      { label: "버킷", path: "/s3", count: (_t, p) => p.services.s3.buckets.length },
      { label: "S3 접근 테스트", path: "/s3/access-test" },
    ],
  },
  {
    id: "iam",
    label: "권한 관리 (IAM)",
    description: "사용자·역할을 만들고 누가 무엇을 할 수 있는지 정책으로 정합니다.",
    icon: KeyRound,
    root: "/iam",
    items: [
      { label: "IAM 대시보드", path: "/iam" },
      { label: "사용자", path: "/iam/users", count: (_t, p) => p.services.iam.users.length },
      { label: "사용자 그룹", path: "/iam/groups", count: (_t, p) => p.services.iam.groups.length },
      { label: "역할", path: "/iam/roles", count: (_t, p) => p.services.iam.roles.length },
      { label: "정책", path: "/iam/policies" },
      { label: "정책 시뮬레이터", path: "/iam/simulator" },
    ],
  },
  {
    id: "cloudwatch",
    label: "모니터링 (CloudWatch)",
    description: "서버·로드 밸런서·DB 상태를 그래프로 보고 경보를 설정합니다.",
    icon: Activity,
    root: "/cloudwatch",
    items: [
      { label: "개요", path: "/cloudwatch" },
      { label: "지표", path: "/cloudwatch/metrics" },
      { label: "경보", path: "/cloudwatch/alarms", count: (_t, p) => p.services.cloudwatch.alarms.length },
      { label: "대시보드", path: "/cloudwatch/dashboards", count: (_t, p) => p.services.cloudwatch.dashboards.length },
      { label: "가상 부하", path: "/cloudwatch/load", count: (_t, p) => p.services.cloudwatch.loads.length },
    ],
  },
  {
    id: "tools",
    label: "분석 도구",
    description: "통신 경로 분석, 구성 검사, 리소스 맵, 비용 추정, 작업 기록",
    icon: Waypoints,
    root: "/vpc/reachability",
    items: [
      { label: "Reachability Analyzer", path: "/vpc/reachability", count: (_t, p) => p.networkPaths.length },
      { label: "리소스 맵", path: "/map" },
      { label: "구성 검사", path: "/checks" },
      { label: "가상 비용 추정", path: "/billing" },
      { label: "이벤트 기록", path: "/activity" },
    ],
  },
];

/** 다른 경로로도 열리는 화면 (EC2 콘솔의 보안 그룹·탄력적 IP 등) */
const ALIASES: [string, string][] = [
  ["/ec2/security-groups", "/vpc/security-groups"],
  ["/ec2/eips", "/vpc/eips"],
];

function normalize(path: string): string {
  for (const [from, to] of ALIASES) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

/** 현재 경로와 가장 길게 일치하는 탐색 항목 */
export function activeNavItem(path: string): { group: NavGroup; item: NavItem } | null {
  const p = normalize(path);
  let best: { group: NavGroup; item: NavItem } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const match = p === item.path || (item.path !== "/vpc" && item.path !== "/ec2" && item.path !== "/rds" && item.path !== "/iam" && item.path !== "/cloudwatch" && p.startsWith(`${item.path}/`));
      if (match && (!best || item.path.length > best.item.path.length)) best = { group, item };
    }
  }
  if (!best) {
    const group = NAV_GROUPS.find((g) => p.startsWith(`${g.root}/`) || p === g.root);
    if (group) best = { group, item: group.items[0] };
  }
  return best;
}
