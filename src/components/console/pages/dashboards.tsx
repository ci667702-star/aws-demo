"use client";

/** 서비스별 대시보드 (리소스 요약) */
import { useAnalysis } from "../analysis-context";
import { useProject } from "../console-context";
import { href } from "../router";
import { ButtonLink } from "../ui/button";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink } from "../ui/links";
import { StatusIndicator } from "../ui/status";

interface Tile {
  label: string;
  value: number;
  path: string;
  detail?: string;
}

function ResourceTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((t) => (
        <a key={t.label} href={href(t.path)} className="group flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-aws-surface-2">
          <span>
            <span className="block text-sm font-bold text-aws-link group-hover:underline">{t.label}</span>
            {t.detail && <span className="block text-xs text-aws-text-2">{t.detail}</span>}
          </span>
          <span className="text-2xl font-bold text-aws-text">{t.value}</span>
        </a>
      ))}
    </div>
  );
}

export function VpcDashboardPage() {
  const { topology: topo } = useAnalysis();
  const project = useProject();
  const vpcs = topo.ofType("vpc");
  const subnets = topo.ofType("subnet");
  const publicSubnets = subnets.filter((s) => topo.classifySubnet(s.id).kind === "public").length;
  return (
    <SpaceBetween>
      <PageHeader
        title="VPC 대시보드"
        info={<InfoLink topic="vpc" />}
        description="가상 네트워크 리소스 요약입니다. 리소스는 이 샌드박스에만 존재합니다."
        actions={
          <ButtonLink variant="primary" href={href("/vpc/vpcs/create")}>
            VPC 생성
          </ButtonLink>
        }
      />
      <Container header={<ContainerHeader title="리소스 (리전: 서울, 가상)" />}>
        <ResourceTiles
          tiles={[
            { label: "VPC", value: vpcs.length, path: "/vpc/vpcs" },
            { label: "서브넷", value: subnets.length, path: "/vpc/subnets", detail: `퍼블릭 ${publicSubnets} · 프라이빗 ${subnets.length - publicSubnets} (라우팅 기준)` },
            { label: "라우팅 테이블", value: topo.ofType("route-table").length, path: "/vpc/route-tables" },
            { label: "인터넷 게이트웨이", value: topo.ofType("internet-gateway").length, path: "/vpc/igws", detail: `연결됨 ${topo.ofType("internet-gateway").filter((g) => topo.vpcOfIgw(g.id)).length}` },
            { label: "탄력적 IP", value: topo.ofType("elastic-ip").length, path: "/vpc/eips" },
            { label: "NAT 게이트웨이", value: topo.ofType("nat-gateway").length, path: "/vpc/nat-gateways" },
            { label: "네트워크 ACL", value: topo.ofType("network-acl").length, path: "/vpc/network-acls" },
            { label: "보안 그룹", value: topo.ofType("security-group").length, path: "/vpc/security-groups" },
            { label: "Reachability Analyzer 경로", value: project.networkPaths.length, path: "/vpc/reachability" },
          ]}
        />
      </Container>
      {vpcs.length === 0 && (
        <Container header={<ContainerHeader title="시작하기" />}>
          <p className="text-sm text-aws-text-2">
            이 샌드박스에는 기본 VPC가 없습니다. <a className="text-aws-link hover:underline" href={href("/vpc/vpcs/create")}>VPC를 직접 생성</a>하거나, VPC 목록의{" "}
            <a className="text-aws-link hover:underline" href={href("/vpc/vpcs")}>작업 → 기본 VPC 생성</a>으로 AWS 기본 VPC와 같은 구성을 만들 수 있습니다.
          </p>
        </Container>
      )}
    </SpaceBetween>
  );
}

export function Ec2DashboardPage() {
  const { topology: topo, health } = useAnalysis();
  const instances = topo.ofType("ec2");
  const running = instances.filter((i) => i.config.state === "running").length;
  const unhealthy = [...health.values()].flat().filter((h) => h.state === "unhealthy").length;
  return (
    <SpaceBetween>
      <PageHeader
        title="EC2 대시보드"
        info={<InfoLink topic="ec2-launch" />}
        description="가상 인스턴스와 로드 밸런싱 리소스 요약입니다. 실제 서버는 실행되지 않습니다."
        actions={
          <ButtonLink variant="primary" href={href("/ec2/instances/launch")}>
            인스턴스 시작
          </ButtonLink>
        }
      />
      <Container header={<ContainerHeader title="리소스 (리전: 서울, 가상)" />}>
        <ResourceTiles
          tiles={[
            { label: "인스턴스(실행 중)", value: running, path: "/ec2/instances" },
            { label: "인스턴스(전체)", value: instances.length, path: "/ec2/instances", detail: `중지 ${instances.filter((i) => i.config.state === "stopped").length} · 종료 ${instances.filter((i) => i.config.state === "terminated").length}` },
            { label: "탄력적 IP", value: topo.ofType("elastic-ip").length, path: "/ec2/eips" },
            { label: "보안 그룹", value: topo.ofType("security-group").length, path: "/ec2/security-groups" },
            { label: "로드 밸런서", value: topo.ofType("alb").length, path: "/ec2/load-balancers" },
            { label: "대상 그룹", value: topo.ofType("target-group").length, path: "/ec2/target-groups" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="서비스 상태" />}>
        {unhealthy ? (
          <StatusIndicator type="warning">비정상(unhealthy) 대상 {unhealthy}개 — 대상 그룹의 대상 탭에서 원인을 확인하세요.</StatusIndicator>
        ) : (
          <StatusIndicator type="success">비정상 대상 없음</StatusIndicator>
        )}
      </Container>
    </SpaceBetween>
  );
}

export function RdsDashboardPage() {
  const { topology: topo } = useAnalysis();
  const dbs = topo.ofType("rds");
  return (
    <SpaceBetween>
      <PageHeader
        title="RDS 대시보드"
        info={<InfoLink topic="rds" />}
        description="가상 데이터베이스 리소스 요약입니다. 실제 데이터베이스 엔진은 실행되지 않으며 네트워크 연결만 시뮬레이션합니다."
        actions={
          <ButtonLink variant="primary" href={href("/rds/databases/create")}>
            데이터베이스 생성
          </ButtonLink>
        }
      />
      <Container header={<ContainerHeader title="리소스 (리전: 서울, 가상)" />}>
        <ResourceTiles
          tiles={[
            { label: "DB 인스턴스", value: dbs.length, path: "/rds/databases", detail: `사용 가능 ${dbs.filter((d) => d.config.state === "available").length}` },
            { label: "DB 서브넷 그룹", value: topo.ofType("db-subnet-group").length, path: "/rds/subnet-groups" },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
}
