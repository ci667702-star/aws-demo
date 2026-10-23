import { ClipboardCheck, Database, History, LayoutGrid, Network, ReceiptText, Server, Waypoints, type LucideIcon } from "lucide-react";

export type ServiceId = "vpc" | "ec2" | "rds" | "tools";

export interface ServiceInfo {
  id: Exclude<ServiceId, "tools">;
  name: string;
  description: string;
  icon: LucideIcon;
  root: string;
}

export const SERVICES: ServiceInfo[] = [
  { id: "vpc", name: "VPC", description: "VPC, 서브넷, 라우팅 테이블, 게이트웨이, 보안 그룹, 네트워크 ACL", icon: Network, root: "/vpc" },
  { id: "ec2", name: "EC2", description: "가상 서버 인스턴스, 로드 밸런서, 대상 그룹", icon: Server, root: "/ec2" },
  { id: "rds", name: "RDS", description: "관계형 데이터베이스(가상)와 DB 서브넷 그룹", icon: Database, root: "/rds" },
];

export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  path: string;
}

export const TOOLS: ToolInfo[] = [
  { id: "reachability", name: "Reachability Analyzer", description: "두 지점 사이의 가상 통신 경로를 단계별로 분석", icon: Waypoints, path: "/vpc/reachability" },
  { id: "map", name: "리소스 맵", description: "샌드박스의 리소스와 관계를 다이어그램으로 보기", icon: LayoutGrid, path: "/map" },
  { id: "checks", name: "구성 검사", description: "설정 오류와 위험한 구성을 규칙으로 검사", icon: ClipboardCheck, path: "/checks" },
  { id: "billing", name: "가상 비용 추정", description: "구성 기준 교육용 월 비용 추정 (실제 요금 아님)", icon: ReceiptText, path: "/billing" },
  { id: "activity", name: "이벤트 기록", description: "이 샌드박스에서 실행한 작업 기록", icon: History, path: "/activity" },
];

export interface NavLink {
  label: string;
  path: string;
}

export interface NavSection {
  title?: string;
  links: NavLink[];
}

export interface ServiceNav {
  title: string;
  root: string;
  sections: NavSection[];
}

export const NAVIGATION: Record<ServiceId, ServiceNav> = {
  vpc: {
    title: "VPC 대시보드",
    root: "/vpc",
    sections: [
      {
        title: "Virtual Private Cloud",
        links: [
          { label: "VPC", path: "/vpc/vpcs" },
          { label: "서브넷", path: "/vpc/subnets" },
          { label: "라우팅 테이블", path: "/vpc/route-tables" },
          { label: "인터넷 게이트웨이", path: "/vpc/igws" },
          { label: "탄력적 IP", path: "/vpc/eips" },
          { label: "NAT 게이트웨이", path: "/vpc/nat-gateways" },
        ],
      },
      {
        title: "보안",
        links: [
          { label: "네트워크 ACL", path: "/vpc/network-acls" },
          { label: "보안 그룹", path: "/vpc/security-groups" },
        ],
      },
      { title: "네트워크 분석", links: [{ label: "Reachability Analyzer", path: "/vpc/reachability" }] },
    ],
  },
  ec2: {
    title: "EC2 대시보드",
    root: "/ec2",
    sections: [
      { title: "인스턴스", links: [{ label: "인스턴스", path: "/ec2/instances" }] },
      {
        title: "네트워크 및 보안",
        links: [
          { label: "보안 그룹", path: "/ec2/security-groups" },
          { label: "탄력적 IP", path: "/ec2/eips" },
        ],
      },
      {
        title: "로드 밸런싱",
        links: [
          { label: "로드 밸런서", path: "/ec2/load-balancers" },
          { label: "대상 그룹", path: "/ec2/target-groups" },
        ],
      },
    ],
  },
  rds: {
    title: "RDS 대시보드",
    root: "/rds",
    sections: [
      {
        links: [
          { label: "데이터베이스", path: "/rds/databases" },
          { label: "서브넷 그룹", path: "/rds/subnet-groups" },
        ],
      },
    ],
  },
  tools: {
    title: "도구",
    root: "/map",
    sections: [{ links: TOOLS.filter((t) => t.id !== "reachability").map((t) => ({ label: t.name, path: t.path })) }],
  },
};

export function serviceOfPath(segments: string[]): ServiceId | null {
  const first = segments[0];
  if (first === "vpc" || first === "ec2" || first === "rds") return first;
  if (first === "map" || first === "checks" || first === "billing" || first === "activity") return "tools";
  return null;
}

/** 현재 경로에서 가장 길게 일치하는 탐색 링크 */
export function activeNavPath(service: ServiceId, path: string): string | null {
  const nav = NAVIGATION[service];
  let best: string | null = path === nav.root ? nav.root : null;
  for (const section of nav.sections) {
    for (const link of section.links) {
      if ((path === link.path || path.startsWith(`${link.path}/`)) && (!best || link.path.length > best.length)) best = link.path;
    }
  }
  return best;
}
