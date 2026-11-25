/**
 * 샘플 아키텍처. 대시보드의 "샘플 불러오기"와 첫 방문 예시 프로젝트에 사용한다.
 */
import { natInstanceScript } from "@/lib/engine/nat-instance";
import type { Project } from "@/lib/engine/resource-models";
import { ProjectBuilder } from "./builder";
import type { ActionResult } from "./console-actions";
import { createRule, createSchedule } from "./eventbridge-actions";
import { NACL, SG } from "./factory";
import { createFunction } from "./lambda-actions";
import { applyAutoLayout } from "./layout";

export interface SampleDefinition {
  id: string;
  title: string;
  description: string;
  create: () => Project;
}

/** Internet → IGW → Public Subnet(ALB) → Private Subnet(EC2 ×2) → DB Subnet(RDS) */
export function createThreeTierSample(name = "예시: 3-Tier 웹 아키텍처"): Project {
  const b = new ProjectBuilder(name, {
    awsDefaults: true,
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
  const tg = b.targetGroup("web-tg", { port: 80, vpc, targets: [app1, app2] });
  b.alb("web-alb", { subnets: [pubA, pubC], sgs: [albSg], listeners: [{ port: 80, targetGroup: tg }] });

  const dbGroup = b.dbSubnetGroup("db-subnets", [dbA, dbC]);
  b.rds("orders-db", { subnetGroup: dbGroup, sgs: [dbSg], engine: "mysql" });
  return b.build();
}

/** Internet → IGW → Public Subnet → EC2 (퍼블릭 IP) */
export function createPublicEc2Sample(name = "샘플: 퍼블릭 EC2 웹 서버"): Project {
  const b = new ProjectBuilder(name, { awsDefaults: true, description: "퍼블릭 서브넷의 EC2 한 대. IGW와 라우팅 테이블의 역할을 확인하기 좋은 구성입니다." });
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
    awsDefaults: true,
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

/** Public Subnet(NAT 인스턴스) + Private Subnet(EC2). NAT 게이트웨이 대신 EC2 한 대로 비용을 줄이는 구성 */
export function createNatInstanceSample(name = "샘플: 프라이빗 서브넷 + NAT 인스턴스"): Project {
  const b = new ProjectBuilder(name, {
    awsDefaults: true,
    description:
      "NAT 게이트웨이 대신 퍼블릭 서브넷의 EC2(NAT 인스턴스)가 프라이빗 서브넷의 외부 통신을 대신합니다. 소스/대상 확인 중지, NAT 설정 스크립트, 인스턴스를 대상으로 하는 경로를 확인할 수 있습니다.",
  });
  const vpc = b.vpc("lab-vpc", "10.30.0.0/16");
  const pub = b.subnet("public-a", vpc, "10.30.1.0/24", "ap-northeast-2a");
  const priv = b.subnet("private-a", vpc, "10.30.11.0/24", "ap-northeast-2a");
  const igw = b.igw("lab-igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pub], routes: [{ destination: "0.0.0.0/0", igw }] });
  const natSg = b.securityGroup("nat-sg", vpc, {
    description: "NAT 인스턴스: 프라이빗 서브넷의 HTTP/HTTPS 허용",
    inbound: [
      SG.tcp(80, "10.30.11.0/24", "HTTP from private subnet"),
      SG.tcp(443, "10.30.11.0/24", "HTTPS from private subnet"),
      SG.tcp(22, "203.0.113.0/24", "SSH from admin network"),
    ],
    outbound: [SG.tcp(80, "0.0.0.0/0", "HTTP to internet"), SG.tcp(443, "0.0.0.0/0", "HTTPS to internet")],
  });
  const nat = b.ec2("nat-instance", pub, {
    ip: "10.30.1.10",
    publicIp: "enabled",
    sgs: [natSg],
    listenPorts: [22],
    sourceDestCheck: false,
    userData: natInstanceScript("amazon-linux-2023") ?? "",
  });
  b.routeTable("private-rt", vpc, { subnets: [priv], routes: [{ destination: "0.0.0.0/0", instance: nat }] });
  const sg = b.securityGroup("worker-sg", vpc, { description: "외부 API 호출용 워커" });
  b.ec2("worker-1", priv, { ip: "10.30.11.10", sgs: [sg] });
  return b.build();
}

/**
 * 서버리스 일정 작업: VPC 안의 RDS를 조회하는 Lambda(평일 09:00), 외부 상태 확인 Lambda(5분마다), EC2 중지 알림 규칙.
 * 함수·일정·규칙은 콘솔과 같은 작업 함수로 만들어 실행 역할과 호출 권한도 콘솔과 똑같이 생긴다.
 */
export function createServerlessSample(name = "샘플: Lambda + EventBridge 일정"): Project {
  const b = new ProjectBuilder(name, {
    awsDefaults: true,
    description:
      "EventBridge Scheduler 일정이 Lambda 함수를 호출합니다. 출결 집계 함수는 VPC의 프라이빗 서브넷에서 RDS를 조회하고, 상태 확인 함수는 VPC 밖에서 외부 API를 호출합니다. 일정은 하루 전에 만든 것으로 가정해 모니터링 탭에 지난 호출 기록이 보입니다.",
  });
  const vpc = b.vpc("app-vpc", "10.40.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.40.1.0/24", "ap-northeast-2a");
  const privA = b.subnet("private-a", vpc, "10.40.11.0/24", "ap-northeast-2a");
  const privC = b.subnet("private-c", vpc, "10.40.12.0/24", "ap-northeast-2c");
  const igw = b.igw("app-igw", vpc);
  const nat = b.nat("nat-a", pubA);
  b.routeTable("public-rt", vpc, { subnets: [pubA], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.routeTable("private-rt", vpc, { subnets: [privA, privC], routes: [{ destination: "0.0.0.0/0", nat }] });
  const lambdaSg = b.securityGroup("lambda-sg", vpc, { description: "Lambda 함수 (인바운드 없음)" });
  const dbSg = b.securityGroup("db-sg", vpc, { description: "MySQL from Lambda", inbound: [SG.tcp(3306, { sg: lambdaSg }, "MySQL from lambda-sg")] });
  const group = b.dbSubnetGroup("db-subnets", [privA, privC], "프라이빗 DB 서브넷");
  const db = b.rds("school-db", { subnetGroup: group, sgs: [dbSg] });

  let p = b.build({ layout: false });
  const step = (r: ActionResult): string => {
    if (!r.ok) throw new Error(`샘플을 만들 수 없습니다: ${r.error}`);
    p = r.project;
    return r.createdId ?? "";
  };
  const report = step(
    createFunction(p, {
      name: "attendance-report",
      runtime: "python3.13",
      architecture: "arm64",
      memoryMb: 256,
      timeoutSeconds: 30,
      roleId: null,
      createRole: true,
      codeTemplate: "rds-query",
      templateTarget: db,
      subnetIds: [privA, privC],
      securityGroupIds: [lambdaSg],
    }),
  );
  const health = step(createFunction(p, { name: "site-health-check", runtime: "nodejs22.x", architecture: "x86_64", roleId: null, createRole: true, codeTemplate: "http-get", templateTarget: "https://school.example.com/health" }));
  const notify = step(createFunction(p, { name: "ec2-stopped-notify", runtime: "nodejs22.x", architecture: "x86_64", roleId: null, createRole: true, codeTemplate: "hello" }));
  const schedule = { timezone: "Asia/Seoul" as const, flexibleWindowMinutes: 0, state: "ENABLED" as const, roleId: null, createRole: true, retryAttempts: 185 };
  step(createSchedule(p, { ...schedule, name: "weekday-attendance-0900", description: "평일 오전 9시 출결 집계", expression: "cron(0 9 ? * MON-FRI *)", targetLambdaId: report, input: JSON.stringify({ report: "attendance" }) }));
  step(createSchedule(p, { ...schedule, name: "health-every-5-minutes", description: "5분마다 학교 홈페이지 상태 확인", expression: "rate(5 minutes)", targetLambdaId: health, input: "{}" }));
  step(
    createRule(p, {
      name: "ec2-stopped",
      description: "EC2 인스턴스가 중지되면 알림 함수 호출",
      eventPattern: JSON.stringify({ source: ["aws.ec2"], "detail-type": ["EC2 Instance State-change Notification"], detail: { state: ["stopped"] } }, null, 2),
      state: "ENABLED",
      targetLambdaIds: [notify],
      addPermissions: true,
    }),
  );
  // 일정은 하루 전에 만든 것으로 가정한다 (지표와 '최근 일정 호출'에 기록이 보이도록)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  p = { ...p, services: { ...p.services, eventbridge: { ...p.services.eventbridge, schedules: p.services.eventbridge.schedules.map((s) => ({ ...s, createdAt: yesterday })) } } };
  return applyAutoLayout(p);
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
  {
    id: "private-nat-instance",
    title: "프라이빗 서브넷 + NAT 인스턴스 (비용 절감)",
    description: "NAT 게이트웨이 대신 EC2 한 대가 주소를 변환합니다. 소스/대상 확인과 NAT 설정 스크립트를 확인합니다.",
    create: () => createNatInstanceSample(),
  },
  {
    id: "serverless-schedule",
    title: "Lambda + EventBridge 일정 (서버리스)",
    description: "일정이 Lambda를 호출합니다. VPC 안 RDS 조회, 5분마다 상태 확인, EC2 중지 알림 규칙을 확인합니다.",
    create: () => createServerlessSample(),
  },
];
