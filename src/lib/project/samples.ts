/**
 * 샘플 아키텍처. 대시보드의 "샘플 불러오기"와 첫 방문 예시 프로젝트에 사용한다.
 */
import type { Project } from "@/lib/engine/resource-models";
import { ProjectBuilder } from "./builder";
import { NACL, SG } from "./factory";

export interface SampleDefinition {
  id: string;
  title: string;
  description: string;
  create: () => Project;
}

/** Internet → IGW → Public Subnet(ALB) → Private Subnet(EC2 ×2) → DB Subnet(RDS) */
export function createThreeTierSample(name = "예시: 3-Tier 웹 아키텍처"): Project {
  const b = new ProjectBuilder(name, {
    description: "ALB + EC2 2대 + RDS(MySQL)로 구성된 3계층 웹 아키텍처. 시뮬레이션 콘솔에서 '인터넷 → ALB' 요청을 실행해 보세요.",
  });
  const vpc = b.vpc("main-vpc", "10.0.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const pubC = b.subnet("public-c", vpc, "10.0.2.0/24", "ap-northeast-2c");
  const appA = b.subnet("app-a", vpc, "10.0.11.0/24", "ap-northeast-2a");
  const appC = b.subnet("app-c", vpc, "10.0.12.0/24", "ap-northeast-2c");
  const dbA = b.subnet("db-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  const dbC = b.subnet("db-c", vpc, "10.0.22.0/24", "ap-northeast-2c");
  const igw = b.igw("main-igw", vpc);
  const nat = b.nat("nat-a", pubA);
  b.routeTable("public-rt", vpc, { subnets: [pubA, pubC], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [appA, appC], routes: [{ destination: "0.0.0.0/0", nat }] });
  b.routeTable("db-rt", vpc, { subnets: [dbA, dbC] });

  const albSg = b.securityGroup("alb-sg", vpc, {
    description: "인터넷에서 HTTP 허용",
    inbound: [SG.tcp(80, "0.0.0.0/0", "HTTP from internet")],
  });
  const appSg = b.securityGroup("app-sg", vpc, {
    description: "ALB에서 앱 포트 허용",
    inbound: [SG.tcp(80, { sg: albSg }, "HTTP from ALB")],
  });
  const dbSg = b.securityGroup("db-sg", vpc, {
    description: "앱 서버에서 MySQL 허용",
    inbound: [SG.tcp(3306, { sg: appSg }, "MySQL from app")],
  });

  const app1 = b.ec2("app-1", appA, { ip: "10.0.11.10", sgs: [appSg], listenPorts: [80] });
  const app2 = b.ec2("app-2", appC, { ip: "10.0.12.10", sgs: [appSg], listenPorts: [80] });
  const tg = b.targetGroup("web-tg", { port: 80, targets: [app1, app2] });
  b.alb("web-alb", { subnets: [pubA, pubC], sgs: [albSg], listeners: [{ port: 80, targetGroup: tg }] });

  const dbGroup = b.dbSubnetGroup("db-subnets", [dbA, dbC]);
  b.rds("orders-db", { subnetGroup: dbGroup, sgs: [dbSg], engine: "mysql" });
  return b.build();
}

/** Internet → IGW → Public Subnet → EC2 (퍼블릭 IP) */
export function createPublicEc2Sample(name = "샘플: 퍼블릭 EC2 웹 서버"): Project {
  const b = new ProjectBuilder(name, { description: "퍼블릭 서브넷의 EC2 한 대. IGW와 라우팅 테이블의 역할을 확인하기 좋은 구성입니다." });
  const vpc = b.vpc("web-vpc", "10.10.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.10.1.0/24", "ap-northeast-2a", { mapPublicIpOnLaunch: true });
  const igw = b.igw("web-igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  const sg = b.securityGroup("web-sg", vpc, {
    description: "웹 서버",
    inbound: [SG.tcp(80, "0.0.0.0/0", "HTTP"), SG.tcp(22, "203.0.113.0/24", "SSH from admin network")],
  });
  b.ec2("web-1", pub, { ip: "10.10.1.10", publicIp: "subnet-default", sgs: [sg] });
  return b.build();
}

/** Public Subnet(NAT) + Private Subnet(EC2) + 서브넷 NACL */
export function createPrivateNatSample(name = "샘플: 프라이빗 서브넷 + NAT Gateway"): Project {
  const b = new ProjectBuilder(name, {
    description: "프라이빗 서브넷의 EC2가 NAT Gateway를 통해 외부로 나가는 구성. 프라이빗 서브넷에는 NACL이 연결되어 있습니다.",
  });
  const vpc = b.vpc("app-vpc", "10.20.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.20.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.20.11.0/24", "ap-northeast-2a");
  const igw = b.igw("app-igw", vpc);
  const nat = b.nat("nat-a", pub);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", nat }] });
  b.networkAcl("private-nacl", vpc, {
    subnets: [priv],
    inbound: [NACL.allow(100, "all", null, "10.20.0.0/16"), NACL.allow(200, "tcp", [1024, 65535], "0.0.0.0/0")],
    outbound: [NACL.allow(100, "all", null, "0.0.0.0/0")],
  });
  const sg = b.securityGroup("worker-sg", vpc, { description: "외부 API 호출용 워커" });
  b.ec2("worker-1", priv, { ip: "10.20.11.10", sgs: [sg] });
  return b.build();
}

export const SAMPLES: SampleDefinition[] = [
  {
    id: "three-tier",
    title: "3-Tier 웹 애플리케이션",
    description: "ALB → EC2(2대, 프라이빗) → RDS. 요청 분산과 DB 연결을 확인할 수 있습니다.",
    create: () => createThreeTierSample("샘플: 3-Tier 웹 애플리케이션"),
  },
  {
    id: "public-ec2",
    title: "퍼블릭 EC2 웹 서버",
    description: "IGW와 0.0.0.0/0 경로가 있는 퍼블릭 서브넷의 EC2.",
    create: () => createPublicEc2Sample(),
  },
  {
    id: "private-nat",
    title: "프라이빗 서브넷 + NAT Gateway",
    description: "프라이빗 EC2의 아웃바운드 통신과 NACL 동작을 확인합니다.",
    create: () => createPrivateNatSample(),
  },
];
