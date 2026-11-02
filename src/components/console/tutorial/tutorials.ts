/**
 * 콘솔 튜토리얼 정의.
 * 모든 단계는 사용자가 "다음"을 눌러 넘어간다. 판정(isDone)이 있는 단계는 실제 설정이 맞으면 '완료'로 표시되고 그때 "다음"을 누를 수 있다.
 * 화면 이동도 자동으로 하지 않는다 (팝업의 '이 단계 화면으로 이동' 버튼이나 메뉴로 사용자가 직접 이동).
 */
import { parseIpv4 } from "@/lib/engine/cidr-utils";
import { buildMetricModel } from "@/lib/engine/cloudwatch-engine";
import { DEFAULT_INTERNET_CLIENT_IP, simulateWithTopology } from "@/lib/engine/connectivity-engine";
import { hasNatSoftware } from "@/lib/engine/nat-instance";
import type { Project, ResourceOfType, S3Bucket } from "@/lib/engine/resource-models";
import { findObject, websiteRequest } from "@/lib/engine/s3-engine";
import { evaluateSecurityGroups } from "@/lib/engine/security-group-engine";
import type { Topology } from "@/lib/engine/topology-engine";

export interface TutorialContext {
  project: Project;
  topo: Topology;
}

export interface TutorialStep {
  id: string;
  title: string;
  /** 설명 문단 */
  body: string[];
  /** 지금 해야 할 일 (판정 단계) */
  task?: string;
  /** 이 단계의 화면 (해시 경로) */
  path?: string | ((ctx: TutorialContext) => string | null);
  /** 강조할 요소의 CSS 선택자 (보통 [data-tour="..."]) */
  target?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** 완료 판정 — 참이면 '완료'로 표시하고 "다음" 버튼을 켠다 (자동으로 넘어가지 않음) */
  isDone?: (ctx: TutorialContext) => boolean;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  minutes: number;
  steps: TutorialStep[];
}

const internetIp = parseIpv4(DEFAULT_INTERNET_CLIENT_IP)!;

function allowsHttpFromInternet(groups: ResourceOfType<"security-group">[]): boolean {
  return evaluateSecurityGroups(groups, "inbound", { protocol: "tcp", port: 80, peerIp: internetIp, peerSecurityGroupIds: [] }).allowed;
}

const publicSubnets = (t: Topology) => t.ofType("subnet").filter((s) => t.classifySubnet(s.id).kind === "public");

function webServers(t: Topology): ResourceOfType<"ec2">[] {
  const pub = new Set(publicSubnets(t).map((s) => s.id));
  return t
    .ofType("ec2")
    .filter((e) => e.config.state === "running" && pub.has(t.subnetOf(e.id) ?? "") && t.enisOf(e.id)[0]?.publicIp !== null && e.config.listenPorts.includes(80))
    .filter((e) => allowsHttpFromInternet(t.securityGroupsOf(e.id)));
}

function firstVpc(t: Topology) {
  return t.ofType("vpc")[0];
}

/** S3 튜토리얼에서 쓰는 버킷: index.html이 있는 버킷, 없으면 가장 최근 버킷 */
function siteBucket(project: Project): S3Bucket | undefined {
  const buckets = project.services.s3.buckets;
  return buckets.find((b) => findObject(b, "index.html")) ?? buckets[buckets.length - 1];
}

/** IAM 튜토리얼에서 쓰는 사용자: 그룹에 속한 사용자, 없으면 가장 최근 사용자 */
function tutorialUser(project: Project) {
  const users = project.services.iam.users;
  return users.find((u) => u.groupIds.length > 0) ?? users[users.length - 1];
}

/** NAT 인스턴스 튜토리얼: 퍼블릭 서브넷이 있는 VPC */
function natLabVpc(t: Topology): string | null {
  const pub = publicSubnets(t)[0];
  return pub ? t.vpcOfSubnet(pub.id) : null;
}

/** 같은 VPC의 퍼블릭이 아닌 서브넷 */
function privateSubnetsOf(t: Topology, vpcId: string | null) {
  return vpcId ? t.subnetsOfVpc(vpcId).filter((s) => t.classifySubnet(s.id).kind !== "public") : [];
}

/** NAT 인스턴스 경로(0.0.0.0/0 → 인스턴스)를 쓰는 프라이빗 서브넷 */
function natInstanceSubnets(t: Topology) {
  return t.ofType("subnet").filter((s) => {
    const cls = t.classifySubnet(s.id);
    return cls.kind === "private-nat" && cls.route?.targetKind === "instance";
  });
}

/** NAT 인스턴스 후보: 퍼블릭 서브넷에 있고 NAT 설정 스크립트가 있는 EC2 */
function natCandidate(t: Topology): ResourceOfType<"ec2"> | undefined {
  const pub = new Set(publicSubnets(t).map((s) => s.id));
  return t.ofType("ec2").find((e) => e.config.state !== "terminated" && pub.has(t.subnetOf(e.id) ?? "") && hasNatSoftware(e.config.userData));
}

/** 프라이빗 서브넷이 쓸 라우팅 테이블: 프라이빗 서브넷에 명시적으로 연결된 테이블, 없으면 IGW 경로가 없는 기본이 아닌 테이블 */
function privateRouteTable(t: Topology): ResourceOfType<"route-table"> | undefined {
  const vpc = natLabVpc(t);
  for (const s of privateSubnetsOf(t, vpc)) {
    const ref = t.routeTableRefFor(s.id);
    if (ref.kind === "explicit") return t.getOfType(ref.routeTableId, "route-table");
  }
  return vpc ? t.routeTablesOfVpc(vpc).find((rt) => !rt.config.main && !t.routesOf(rt.id, vpc).some((r) => r.targetKind === "internet-gateway")) : undefined;
}

/** CloudWatch 튜토리얼에서 부하를 받을 대상 (실행 중인 EC2 또는 활성 ALB) */
function loadTarget(t: Topology) {
  return t.ofType("alb").find((a) => a.config.state === "active") ?? t.ofType("ec2").find((e) => e.config.state === "running");
}

export const TUTORIALS: Tutorial[] = [
  {
    id: "console-tour",
    title: "콘솔 둘러보기",
    description: "화면의 각 부분이 무엇인지 1분 안에 살펴봅니다.",
    minutes: 1,
    steps: [
      {
        id: "welcome",
        title: "AWS Playground 콘솔에 오신 것을 환영합니다",
        body: [
          "이 화면은 AWS 콘솔을 본떠 만든 학습용 가상 콘솔입니다. 실제 AWS 계정이나 요금 없이 리소스를 만들고 설정을 연습할 수 있습니다.",
          "중요한 부분을 차례로 보여 드릴게요. '다음'을 누르세요.",
        ],
        path: "/",
      },
      {
        id: "side-nav",
        title: "왼쪽 메뉴: 모든 서비스",
        body: ["네트워크(VPC), 서버(EC2), 데이터베이스(RDS), 스토리지(S3), 권한(IAM), 모니터링(CloudWatch)이 모여 있습니다.", "오른쪽 숫자는 지금 만들어진 리소스 개수입니다."],
        target: '[data-tour="side-nav"]',
        side: "right",
      },
      {
        id: "services",
        title: "서비스 메뉴",
        body: ["서비스마다 무엇을 하는지 짧은 설명과 함께 볼 수 있습니다."],
        target: '[data-tour="services-menu"]',
        side: "bottom",
      },
      {
        id: "search",
        title: "검색",
        body: ["화면 이름이나 리소스 ID·이름으로 바로 이동합니다. 키보드 Alt+S로도 열 수 있습니다."],
        target: '[data-tour="search"]',
        side: "bottom",
      },
      {
        id: "home-cards",
        title: "무엇부터 할지 모르겠다면",
        body: ["따라하기 튜토리얼은 팝업 안내를 따라 첫 웹 서버를 직접 만들어 보는 과정입니다. 실습 가이드는 목표만 주어지는 연습 문제입니다."],
        target: '[data-tour="home-tutorial"]',
        side: "bottom",
        path: "/",
      },
      {
        id: "help",
        title: "도움말",
        body: ["각 화면의 '정보' 링크나 이 버튼을 누르면 오른쪽에 쉬운 설명(비유, 순서, 자주 하는 실수)이 열립니다. 실습 가이드도 여기에 있습니다."],
        target: '[data-tour="help-button"]',
        side: "bottom",
      },
      {
        id: "mode",
        title: "쉬운 모드",
        body: ["같은 샌드박스를 그림으로 보며 끌어다 놓아 설계하는 쉬운 모드로 언제든 바꿀 수 있습니다."],
        target: '[data-tour="mode-switch"]',
        side: "bottom",
      },
      {
        id: "undo",
        title: "실행 취소",
        body: ["잘못 만들거나 지웠다면 실행 취소(Ctrl+Z)로 되돌리세요. 모든 변경은 이 브라우저에 자동 저장됩니다."],
        target: '[data-tour="undo"]',
        side: "bottom",
      },
      {
        id: "end",
        title: "준비 완료!",
        body: ["이제 '따라하기 튜토리얼: 첫 웹 서버 만들기'로 직접 만들어 보세요. 상단의 '튜토리얼' 메뉴에서 언제든 다시 볼 수 있습니다."],
      },
    ],
  },
  {
    id: "first-web-server",
    title: "첫 웹 서버 만들기",
    description: "VPC부터 EC2까지 직접 만들고 인터넷에서 접속되는지 확인합니다. 단계마다 실제 설정이 맞는지 확인해 '완료'로 표시합니다.",
    minutes: 10,
    steps: [
      {
        id: "intro",
        title: "무엇을 만들까요?",
        body: [
          "인터넷에서 접속할 수 있는 웹 서버를 VPC부터 차례로 만듭니다.",
          "밝게 표시된 곳을 따라 설정하세요. 다른 화면은 '이 단계 화면으로 이동'으로 열고, 완료되면 다음을 누릅니다.",
        ],
      },
      {
        id: "vpc",
        title: "① VPC 만들기",
        body: ["VPC는 내 리소스만 들어가는 가상 네트워크입니다. 주소 범위(CIDR)를 정합니다."],
        task: "이름 태그 my-vpc, IPv4 CIDR 10.0.0.0/16을 입력하고 VPC 생성.",
        path: "/vpc/vpcs/create",
        target: '[data-tour="vpc-fields"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("vpc").length > 0,
      },
      {
        id: "subnet",
        title: "② 서브넷 만들기",
        body: ["서브넷은 VPC를 나눈 구역입니다. 서버는 서브넷 안에 놓입니다. 서브넷 CIDR은 VPC 범위 안이어야 합니다."],
        task: "VPC를 고르고 이름 public-a, 가용 영역 ap-northeast-2a, CIDR 10.0.1.0/24를 입력한 뒤 서브넷 생성.",
        path: "/vpc/subnets/create",
        target: '[data-tour="subnet-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("subnet").some((s) => !!topo.vpcOfSubnet(s.id)),
      },
      {
        id: "igw",
        title: "③-1 인터넷 게이트웨이 만들기",
        body: ["인터넷 게이트웨이는 VPC와 인터넷을 잇는 정문입니다. 만든 직후에는 어느 VPC에도 연결되어 있지 않습니다."],
        task: "인터넷 게이트웨이 생성을 누르세요. 이름은 비워도 됩니다.",
        path: "/vpc/igws/create",
        target: '[data-tour="igw-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("internet-gateway").length > 0,
      },
      {
        id: "igw-attach",
        title: "③-2 VPC에 연결하기",
        body: ["정문을 만들었으니 건물(VPC)에 달아야 합니다. VPC 하나에는 인터넷 게이트웨이를 하나만 연결할 수 있습니다."],
        task: "사용 가능한 VPC에서 방금 만든 VPC를 고르고 연결을 누르세요.",
        path: ({ topo }) => {
          const igw = topo.ofType("internet-gateway").find((g) => !topo.vpcOfIgw(g.id));
          return igw ? `/vpc/igws/${igw.id}/attach` : null;
        },
        target: '[data-tour="igw-attach"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("vpc").some((v) => !!topo.igwOfVpc(v.id)),
      },
      {
        id: "route",
        title: "④ 라우팅: 인터넷으로 가는 길 만들기",
        body: [
          "서브넷이 '퍼블릭'이 되려면 라우팅 테이블에 '0.0.0.0/0(그 밖의 모든 곳) → 인터넷 게이트웨이' 경로가 있어야 합니다.",
          "지금 서브넷은 VPC의 기본(main) 라우팅 테이블을 쓰고 있으니 그 표에 경로를 추가합니다.",
        ],
        task: "라우팅 추가에서 0.0.0.0/0 → 인터넷 게이트웨이를 설정하고 저장하세요.",
        path: ({ topo }) => {
          const vpc = topo.ofType("vpc").find((v) => !!topo.igwOfVpc(v.id)) ?? firstVpc(topo);
          const rt = vpc ? topo.mainRouteTableOf(vpc.id) : undefined;
          return rt ? `/vpc/route-tables/${rt.id}/edit-routes` : null;
        },
        target: '[data-tour="routes-form"]',
        side: "left",
        isDone: ({ topo }) => publicSubnets(topo).length > 0,
      },
      {
        id: "sg",
        title: "⑤ 보안 그룹: 웹 요청 허용하기",
        body: ["보안 그룹은 서버의 출입 명단입니다. 명단에 없는 트래픽은 모두 거부됩니다. 웹 서버는 HTTP(80) 요청을 받아야 합니다."],
        task: "이름 web-sg와 VPC를 지정하고, 인바운드에 HTTP(80) · Anywhere-IPv4를 추가한 뒤 생성하세요.",
        path: "/vpc/security-groups/create",
        target: '[data-tour="sg-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("security-group").some((g) => !g.config.isDefault && allowsHttpFromInternet([g])),
      },
      {
        id: "ec2",
        title: "⑥ 웹 서버(EC2) 시작하기",
        body: ["이제 서버를 퍼블릭 서브넷에 놓습니다. 인터넷에서 접속하려면 퍼블릭 IP와 웹 서버 프로그램(사용자 데이터)이 필요합니다.", "시작하면 Pending을 거쳐 몇 초 뒤 Running이 됩니다."],
        task: "서브넷 public-a, 퍼블릭 IP 활성화, 보안 그룹 web-sg를 선택하세요. 사용자 데이터에서 웹 서버 설치를 고르고 시작하세요.",
        path: "/ec2/instances/launch",
        target: '[data-tour="launch-form"]',
        side: "left",
        isDone: ({ topo }) => webServers(topo).length > 0,
      },
      {
        id: "analyze",
        title: "⑦ 인터넷에서 접속되는지 분석하기",
        body: ["Reachability Analyzer는 가상 패킷이 라우팅·네트워크 ACL·보안 그룹을 통과하는지 단계별로 보여 줍니다."],
        task: "인터넷에서 웹 서버까지 TCP 80 경로를 생성하고 분석하세요.",
        path: "/vpc/reachability/create",
        target: '[data-tour="path-form"]',
        side: "left",
        isDone: ({ project, topo }) =>
          project.networkPaths.some(
            (p) =>
              p.lastAnalysis?.outcome === "success" &&
              p.request.source.kind === "internet" &&
              p.request.destination.kind === "resource" &&
              topo.get(p.request.destination.resourceId)?.type === "ec2" &&
              simulateWithTopology(topo, p.request).outcome === "success",
          ),
      },
      {
        id: "done",
        title: "완성했습니다! 🎉",
        body: [
          "인터넷 → 인터넷 게이트웨이 → 퍼블릭 서브넷 → 보안 그룹 → 웹 서버까지 통신 경로를 직접 만들었습니다.",
          "다음 도전: 보안 그룹의 HTTP 규칙을 지우고 다시 분석해 보세요(막히는 위치가 보입니다). 또는 실습 가이드의 'ALB와 EC2 구성', CloudWatch의 가상 부하와 경보를 해 보세요.",
        ],
      },
    ],
  },
  {
    id: "iam-access-key",
    title: "IAM 사용자와 가상 액세스 키 발급",
    description: "그룹으로 권한을 주고, 사용자를 만든 뒤 가상 액세스 키를 발급해 봅니다. 실제 키는 만들어지지 않습니다.",
    minutes: 5,
    steps: [
      {
        id: "intro",
        title: "IAM: 누가 무엇을 할 수 있는지",
        body: [
          "IAM은 AWS의 출입 관리 부서입니다. 사람이나 프로그램마다 사용자를 만들고, 필요한 권한(정책)만 줍니다.",
          "순서: ① 그룹 만들기(권한 묶음) → ② 사용자 만들기 → ③ 가상 액세스 키 발급 → ④ 정책 시뮬레이터로 확인",
          "여기서 만드는 키는 PGSIM으로 시작하는 연습용 가상 값입니다. 실제 AWS 키나 비밀번호를 입력하지 마세요.",
        ],
      },
      {
        id: "group",
        title: "① 사용자 그룹 만들기",
        body: ["권한은 사람마다 따로 주기보다 그룹에 붙여 두는 것이 관리하기 쉽습니다. 그룹에 들어간 사용자는 그룹의 권한을 물려받습니다."],
        task: "그룹 이름 developers를 입력하고, 권한 정책에서 AmazonS3ReadOnlyAccess를 체크한 뒤 '그룹 생성'을 누르세요.",
        path: "/iam/groups/create",
        target: '[data-tour="iam-group-form"]',
        side: "left",
        isDone: ({ project }) => project.services.iam.groups.some((g) => g.policyIds.length > 0),
      },
      {
        id: "user",
        title: "② 사용자 만들기",
        body: ["사용자는 사람 한 명이나 프로그램 하나입니다. 권한 설정 단계에서 방금 만든 그룹에 넣으면 됩니다."],
        task: "사용자 이름 dev-kim → '다음' → '그룹에 사용자 추가'에서 developers 선택 → '다음' → '사용자 생성'을 누르세요.",
        path: "/iam/users/create",
        target: '[data-tour="iam-user-form"]',
        side: "left",
        isDone: ({ project }) => project.services.iam.users.some((u) => u.groupIds.length > 0),
      },
      {
        id: "key",
        title: "③ 가상 액세스 키 발급",
        body: [
          "액세스 키는 프로그램(CLI·SDK)이 이 사용자로 AWS를 부를 때 쓰는 ID + 비밀 키입니다. 비밀 키는 만들 때 한 번만 보입니다.",
          "AWS는 키를 만들기 전에 더 안전한 대안(역할, 임시 자격 증명)을 먼저 권합니다. 용도를 바꿔 가며 안내 문구를 읽어 보세요.",
        ],
        task: "사용 사례 '명령줄 인터페이스(CLI)' → 확인 체크 → '다음' → '액세스 키 만들기'를 누르세요. 비밀 키를 '표시'로 확인한 뒤 '완료'를 누르세요.",
        path: ({ project }) => {
          const user = tutorialUser(project);
          return user ? `/iam/users/${user.id}/create-access-key` : "/iam/users";
        },
        target: '[data-tour="iam-key-form"]',
        side: "left",
        isDone: ({ project }) => project.services.iam.users.some((u) => u.accessKeys.length > 0),
      },
      {
        id: "simulator",
        title: "④ 정책 시뮬레이터로 확인",
        body: [
          "dev-kim을 고르고 S3의 GetObject를 시뮬레이션하면 '허용됨', PutObject는 '거부됨(암묵적)'이 나옵니다. 그룹 정책이 읽기만 허용하기 때문입니다.",
          "'이 서비스의 모든 작업 평가'로 한 번에 비교해 보세요.",
        ],
        path: "/iam/simulator",
        target: '[data-tour="iam-simulator"]',
        side: "left",
      },
      {
        id: "done",
        title: "IAM 기본 흐름을 익혔습니다! 🎉",
        body: [
          "그룹 → 사용자 → 액세스 키 → 권한 확인 순서를 직접 해 봤습니다.",
          "다음 도전: 역할 메뉴에서 'AWS 서비스 - EC2' 역할을 만들어 인스턴스에 연결하고, S3 접근 테스트에서 'EC2 인스턴스'로 시험해 보세요. 서버에 키를 넣지 않아도 접근되는 것을 볼 수 있습니다.",
        ],
      },
    ],
  },
  {
    id: "s3-static-site",
    title: "S3로 정적 웹 사이트 공개하기",
    description: "버킷을 만들고 index.html을 올린 뒤, 퍼블릭 액세스 차단·버킷 정책을 바꿔 웹 사이트로 공개합니다.",
    minutes: 7,
    steps: [
      {
        id: "intro",
        title: "S3: 파일을 담는 버킷",
        body: [
          "S3는 파일(객체)을 버킷에 저장하는 서비스입니다. HTML 파일을 올리면 간단한 웹 사이트로도 쓸 수 있습니다.",
          "순서: ① 버킷 만들기 → ② index.html 올리기 → ③ 웹 사이트 호스팅 켜기 → ④ 퍼블릭 액세스 차단 끄기 → ⑤ 버킷 정책으로 공개 → ⑥ 열어 보기",
          "기본값은 '비공개'입니다. 공개하려면 두 단계(차단 해제 + 정책)를 모두 해야 한다는 점이 핵심입니다.",
        ],
      },
      {
        id: "bucket",
        title: "① 버킷 만들기",
        body: ["버킷 이름은 전 세계 모든 AWS 계정에서 하나뿐이어야 합니다. test 같은 흔한 이름은 이미 쓰이고 있다고 나옵니다."],
        task: "버킷 이름에 my-site-날짜-이니셜(예: my-site-1023-kim)을 입력하고, 나머지는 그대로 둔 채 '버킷 만들기'를 누르세요.",
        path: "/s3/create",
        target: '[data-tour="s3-create-form"]',
        side: "left",
        isDone: ({ project }) => project.services.s3.buckets.length > 0,
      },
      {
        id: "upload",
        title: "② index.html 올리기",
        body: ["'텍스트 파일 직접 만들기'에 예시 HTML이 들어 있습니다. 그대로 써도 되고 내용을 바꿔도 됩니다."],
        task: "파일 이름이 index.html인지 확인하고 '목록에 추가' → '업로드'를 누르세요.",
        path: ({ project }) => {
          const b = siteBucket(project);
          return b ? `/s3/buckets/${b.id}/upload` : null;
        },
        target: '[data-tour="s3-upload-form"]',
        side: "left",
        isDone: ({ project }) => project.services.s3.buckets.some((b) => !!findObject(b, "index.html")),
      },
      {
        id: "website",
        title: "③ 정적 웹 사이트 호스팅 켜기",
        body: ["호스팅을 켜면 버킷에 웹 사이트 주소(엔드포인트)가 생깁니다. 주소가 /로 끝나면 인덱스 문서(index.html)를 보여 줍니다."],
        task: "'정적 웹 사이트 호스팅 활성화'를 켜고 인덱스 문서가 index.html인지 확인한 뒤 '변경 사항 저장'을 누르세요.",
        path: ({ project }) => {
          const b = siteBucket(project);
          return b ? `/s3/buckets/${b.id}/edit-website` : null;
        },
        target: '[data-tour="s3-website-form"]',
        side: "left",
        isDone: ({ project }) => !!siteBucket(project)?.website.enabled,
      },
      {
        id: "bpa",
        title: "④ 퍼블릭 액세스 차단 끄기",
        body: [
          "웹 사이트 방문자는 로그인하지 않은 익명 사용자입니다. 퍼블릭 액세스 차단이 켜져 있으면 공개 정책을 저장할 수도, 적용할 수도 없습니다.",
          "실제 AWS에서는 데이터 유출 사고가 자주 나는 설정이니, 꼭 공개해야 하는 버킷에서만 끄세요.",
        ],
        task: "'모든 퍼블릭 액세스 차단' 체크를 해제하고, 확인 칸에 확인을 입력한 뒤 '변경 사항 저장'을 누르세요.",
        path: ({ project }) => {
          const b = siteBucket(project);
          return b ? `/s3/buckets/${b.id}/edit-bpa` : null;
        },
        target: '[data-tour="s3-bpa-form"]',
        side: "left",
        isDone: ({ project }) => {
          const b = siteBucket(project);
          return !!b && !b.blockPublicAccess.blockPublicPolicy && !b.blockPublicAccess.restrictPublicBuckets;
        },
      },
      {
        id: "policy",
        title: "⑤ 버킷 정책으로 공개하기",
        body: ["버킷 정책에 'Principal \"*\"(누구나)에게 s3:GetObject(읽기)를 허용'을 적으면 객체를 인터넷에서 읽을 수 있습니다."],
        task: "'퍼블릭 읽기 (정적 웹 사이트용)' 예시를 누르고 내용을 확인한 뒤 '변경 사항 저장'을 누르세요.",
        path: ({ project }) => {
          const b = siteBucket(project);
          return b ? `/s3/buckets/${b.id}/edit-policy` : null;
        },
        target: '[data-tour="s3-policy-form"]',
        side: "left",
        isDone: ({ project }) => {
          const b = siteBucket(project);
          return !!b && websiteRequest(project, b.id, "/").status === 200;
        },
      },
      {
        id: "preview",
        title: "⑥ 웹 사이트 열어 보기",
        body: ["가상 브라우저로 웹 사이트 주소에 요청을 보내 봅니다. 200 OK와 함께 올린 HTML이 보이면 성공입니다. 없는 경로(/abc)도 요청해 보세요."],
        path: ({ project }) => {
          const b = siteBucket(project);
          return b ? `/s3/buckets/${b.id}?tab=properties` : null;
        },
        target: '[data-tour="s3-website-preview"]',
        side: "bottom",
      },
      {
        id: "done",
        title: "웹 사이트를 공개했습니다! 🎉",
        body: [
          "비공개가 기본인 S3를 '차단 해제 + 버킷 정책' 두 단계로 공개했습니다.",
          "다음 도전: S3 접근 테스트에서 익명 사용자로 PutObject를 시험해 보세요(거부됩니다). 또는 퍼블릭 액세스 차단을 다시 켜고 웹 사이트가 403이 되는 것을 확인해 보세요.",
        ],
      },
    ],
  },
  {
    id: "cloudwatch-alarm",
    title: "CloudWatch로 과부하 경보 받기",
    description: "서버에 가상 부하를 주고 CPU 그래프를 본 뒤, 기준을 넘으면 알려 주는 경보를 만듭니다.",
    minutes: 6,
    steps: [
      {
        id: "intro",
        title: "CloudWatch: 계기판과 경고등",
        body: [
          "CloudWatch는 서버 CPU·요청 수 같은 숫자(지표)를 모아 그래프로 보여 주고, 기준을 넘으면 경보를 울립니다.",
          "순서: ① 부하를 받을 서버 준비 → ② 가상 부하 주기 → ③ 그래프 보기 → ④ 경보 만들기 → ⑤ 경보 상태 확인",
          "이 시뮬레이터의 지표는 실제 수집값이 아니라 설정과 가상 부하로 계산한 값입니다.",
        ],
      },
      {
        id: "server",
        title: "① 부하를 받을 서버 준비",
        body: ["실행 중인 EC2 인스턴스나 로드 밸런서가 필요합니다. 없다면 '첫 웹 서버 만들기' 튜토리얼이나 샌드박스 목록의 예시 아키텍처로 준비하세요."],
        task: "실행 중인(Running) 인스턴스가 하나 이상 있으면 이 단계가 완료됩니다.",
        path: "/ec2/instances",
        isDone: ({ topo }) => !!loadTarget(topo),
      },
      {
        id: "load",
        title: "② 가상 부하 주기",
        body: ["'분당 N번 요청이 온다'고 가정합니다. 보안 그룹·라우팅을 통과하는 요청만 서버에 도착해 CPU를 올립니다."],
        task: "대상과 포트(보통 80)를 확인하고, 분당 요청 '많음', 시작 시점 '15분 전부터 진행 중'을 고른 뒤 '부하 시작'을 누르세요.",
        path: "/cloudwatch/load",
        target: "#tour-cw-load-form",
        side: "bottom",
        isDone: ({ project, topo }) => buildMetricModel(project, topo).loads.some((l) => l.reaches),
      },
      {
        id: "metrics",
        title: "③ CPU 그래프 보기",
        body: ["지표 화면에서 서버의 CPUUtilization을 고르면 부하가 시작된 시점부터 CPU가 오른 것이 보입니다. 그래프에 마우스를 올리면 시각별 값이 나옵니다."],
        path: ({ topo }) => {
          const ec2 = topo.ofType("ec2").find((e) => e.config.state === "running");
          return ec2 ? `/cloudwatch/metrics?ns=AWS/EC2&resource=${ec2.id}&metric=CPUUtilization` : "/cloudwatch/metrics";
        },
      },
      {
        id: "alarm",
        title: "④ 경보 만들기",
        body: ["경보는 '최근 N개 기간 중 M개가 기준을 넘으면 ALARM'처럼 정합니다. 미리 보기 그래프의 빨간 선이 임계값입니다."],
        task: "지표 CPUUtilization, 조건 '보다 큼', 임계값 70 → '다음' → 알림 켜기 → '다음' → 이름 high-cpu → '다음' → '경보 생성'을 누르세요.",
        path: ({ topo }) => {
          const ec2 = topo.ofType("ec2").find((e) => e.config.state === "running");
          return ec2 ? `/cloudwatch/alarms/create?ns=AWS/EC2&resource=${ec2.id}&metric=CPUUtilization` : "/cloudwatch/alarms/create";
        },
        target: '[data-tour="cw-alarm-form"]',
        side: "left",
        isDone: ({ project }) => project.services.cloudwatch.alarms.length > 0,
      },
      {
        id: "watch",
        title: "⑤ 경보 상태 확인",
        body: [
          "경보 상세 화면에서 현재 상태와 이유, 상태 변화 기록을 볼 수 있습니다. 부하가 진행 중이면 1분 안에 ALARM이 되고 오른쪽 아래에 알림이 뜹니다.",
          "부하가 끝나면 다시 OK로 돌아옵니다. 가상 부하 화면에서 '중지'를 눌러 보세요.",
        ],
        path: ({ project }) => {
          const alarm = project.services.cloudwatch.alarms[project.services.cloudwatch.alarms.length - 1];
          return alarm ? `/cloudwatch/alarms/${alarm.id}` : "/cloudwatch/alarms";
        },
      },
      {
        id: "done",
        title: "모니터링 기본을 익혔습니다! 🎉",
        body: [
          "지표 → 그래프 → 경보 → 알림의 흐름을 직접 해 봤습니다.",
          "다음 도전: 인스턴스 유형을 키우거나(t3.micro → t3.medium) 로드 밸런서 뒤에 서버를 늘리면 같은 부하에서 CPU가 얼마나 내려가는지 비교해 보세요. 대시보드에 그래프를 모아 둘 수도 있습니다.",
        ],
      },
    ],
  },
  {
    id: "nat-instance",
    title: "NAT 인스턴스로 비용 줄이기",
    description: "NAT 게이트웨이 대신 EC2 한 대로 프라이빗 서브넷의 외부 통신을 만듭니다. AWS 문서의 NAT 인스턴스 절차를 따라 하고 비용을 비교합니다.",
    minutes: 15,
    steps: [
      {
        id: "intro",
        title: "NAT 인스턴스란?",
        body: [
          "프라이빗 서브넷의 서버도 업데이트나 외부 API 호출을 위해 인터넷으로 나가야 할 때가 있습니다. 이때 출발지 주소를 바꿔 대신 내보내 주는 것이 NAT입니다.",
          "NAT 게이트웨이는 AWS가 관리해 편하지만 시간당 요금과 처리 데이터(GB)당 요금이 붙습니다. NAT 인스턴스는 퍼블릭 서브넷의 EC2가 같은 일을 하므로 인스턴스 요금만 듭니다. 대신 장애 대비·패치는 직접 해야 합니다. AWS는 운영 환경에 NAT 게이트웨이를 권장합니다.",
          "순서: ① 프라이빗 서브넷과 라우팅 테이블 → ② NAT용 보안 그룹 → ③ NAT 인스턴스 시작(NAT 설정 스크립트) → ④ 소스/대상 확인 중지 → ⑤ 경로 추가 → ⑥ 프라이빗 서버 → ⑦ 통신 분석 → ⑧ 비용 비교",
          "이 시뮬레이터는 운영체제나 iptables를 실제로 실행하지 않습니다. 사용자 데이터 스크립트에 NAT 설정이 있는지, 소스/대상 확인과 경로가 맞는지로 동작을 계산합니다.",
        ],
      },
      {
        id: "public",
        title: "준비: 퍼블릭 서브넷",
        body: ["NAT 인스턴스는 인터넷 게이트웨이 경로(0.0.0.0/0 → IGW)가 있는 퍼블릭 서브넷에 둡니다. NAT 인스턴스 자신도 그 길로 인터넷에 나가기 때문입니다."],
        task: "퍼블릭 서브넷이 없다면 '첫 웹 서버 만들기' 튜토리얼의 ①~④를 먼저 하세요. 이미 있으면 '다음'을 누르세요.",
        path: "/vpc/subnets",
        isDone: ({ topo }) => publicSubnets(topo).length > 0,
      },
      {
        id: "private-subnet",
        title: "①-1 프라이빗 서브넷 만들기",
        body: ["외부에 드러나지 않을 서버를 둘 구역입니다. 퍼블릭 서브넷과 같은 VPC에 만듭니다."],
        task: "퍼블릭 서브넷이 있는 VPC를 고르고 이름 private-a, CIDR 10.0.11.0/24(VPC 범위 안의 겹치지 않는 범위)로 '서브넷 생성'을 누르세요.",
        path: "/vpc/subnets/create",
        target: '[data-tour="subnet-form"]',
        side: "left",
        isDone: ({ topo }) => {
          const vpc = natLabVpc(topo);
          return !!vpc && topo.subnetsOfVpc(vpc).length >= 2;
        },
      },
      {
        id: "private-rt",
        title: "①-2 프라이빗 라우팅 테이블 연결",
        body: [
          "새 서브넷은 VPC의 기본(main) 라우팅 테이블을 씁니다. 기본 테이블에 IGW 경로가 있으면 새 서브넷도 퍼블릭이 되어 버립니다.",
          "그래서 IGW 경로가 없는 라우팅 테이블(private-rt)을 따로 만들어 프라이빗 서브넷에 연결합니다. 이미 프라이빗(IGW 경로 없음)으로 판정되면 이 단계는 완료입니다.",
        ],
        task: "라우팅 테이블 생성에서 이름 private-rt, VPC를 고르고 만드세요. 그다음 '서브넷 연결 편집'에서 private-a를 체크하고 저장하세요.",
        path: ({ topo }) => {
          const rt = privateRouteTable(topo);
          return rt ? `/vpc/route-tables/${rt.id}/edit-associations` : "/vpc/route-tables/create";
        },
        target: '[data-tour="rt-associations"], [data-tour="rt-form"]',
        side: "left",
        isDone: ({ topo }) => privateSubnetsOf(topo, natLabVpc(topo)).length > 0,
      },
      {
        id: "nat-sg",
        title: "② NAT 인스턴스용 보안 그룹",
        body: [
          "NAT 인스턴스는 프라이빗 서브넷에서 오는 요청을 받아야 합니다. AWS 문서는 프라이빗 서브넷 CIDR에서 오는 HTTP(80)·HTTPS(443)를 인바운드로 허용하도록 권장합니다.",
          "아웃바운드는 기본값(모든 트래픽 허용)이어도 동작합니다. AWS 문서의 권장은 인터넷으로 나가는 HTTP·HTTPS만 허용하는 것입니다.",
        ],
        task: "이름 nat-sg, 설명 'NAT instance'로 같은 VPC를 고르고, 인바운드 규칙 HTTP와 HTTPS를 추가해 소스를 '사용자 지정' 10.0.11.0/24(프라이빗 서브넷 CIDR)로 정한 뒤 '보안 그룹 생성'을 누르세요.",
        path: "/vpc/security-groups/create",
        target: '[data-tour="sg-form"]',
        side: "left",
        isDone: ({ topo }) => {
          const vpc = natLabVpc(topo);
          const samples = privateSubnetsOf(topo, vpc)
            .map((s) => parseIpv4(topo.suggestPrivateIp(s.id) ?? ""))
            .filter((ip): ip is number => ip !== null);
          return topo
            .ofType("security-group")
            .some(
              (g) =>
                !g.config.isDefault &&
                topo.vpcOf(g.id) === vpc &&
                samples.some((ip) => evaluateSecurityGroups([g], "inbound", { protocol: "tcp", port: 443, peerIp: ip, peerSecurityGroupIds: [] }).allowed),
            );
        },
      },
      {
        id: "nat-launch",
        title: "③ NAT 인스턴스 시작하기",
        body: [
          "NAT 인스턴스는 평범한 EC2입니다. 운영체제 안에서 IP 포워딩을 켜고 iptables MASQUERADE로 출발지 주소를 바꾸면 NAT가 됩니다.",
          "AWS 문서는 이 설정(iptables-services 설치, net.ipv4.ip_forward=1, MASQUERADE 규칙 저장)을 넣은 NAT AMI를 만들어 시작합니다. 이 시뮬레이터에는 AMI 만들기가 없어서, 사용자 데이터 템플릿 'NAT 인스턴스'로 같은 명령을 넣습니다. 실습에는 가장 작은 유형(t3.micro)이면 충분합니다.",
        ],
        task: "이름 nat-instance, Amazon Linux 2023, t3.micro, 퍼블릭 서브넷, 퍼블릭 IP 자동 할당 '활성화', 보안 그룹 nat-sg, 고급 세부 정보의 사용자 데이터 'NAT 인스턴스'를 고르고 '인스턴스 시작'을 누르세요.",
        path: "/ec2/instances/launch",
        target: '[data-tour="launch-form"]',
        side: "left",
        isDone: ({ topo }) => !!natCandidate(topo),
      },
      {
        id: "src-dst",
        title: "④ 소스/대상 확인 중지",
        body: [
          "EC2는 기본적으로 자기 주소가 출발지나 목적지가 아닌 트래픽을 버립니다(소스/대상 확인). NAT 인스턴스는 남의 트래픽을 전달하므로 이 기능을 꺼야 합니다.",
          "이 설정은 인스턴스를 시작한 뒤에 바꿉니다.",
        ],
        task: "NAT 인스턴스 화면에서 작업 → 네트워킹 → '소스/대상 확인 변경'을 열고 '중지'를 체크한 뒤 저장하세요.",
        path: ({ topo }) => {
          const nat = natCandidate(topo);
          return nat ? `/ec2/instances/${nat.id}` : "/ec2/instances";
        },
        target: '[data-tour="instance-actions"]',
        side: "bottom",
        isDone: ({ topo }) => natCandidate(topo)?.config.sourceDestCheck === false,
      },
      {
        id: "route",
        title: "⑤ 프라이빗 경로: 0.0.0.0/0 → NAT 인스턴스",
        body: ["프라이빗 서브넷에서 인터넷으로 가는 트래픽을 NAT 인스턴스로 보냅니다. 경로 대상(Target)으로 '인스턴스'를 고를 수 있습니다."],
        task: "'라우팅 추가'를 누르고 대상(Destination) 0.0.0.0/0, 대상(Target)에 인스턴스 · nat-instance를 고른 뒤 '변경 사항 저장'을 누르세요.",
        path: ({ topo }) => {
          const rt = privateRouteTable(topo);
          return rt ? `/vpc/route-tables/${rt.id}/edit-routes` : "/vpc/route-tables";
        },
        target: '[data-tour="routes-form"]',
        side: "left",
        isDone: ({ topo }) => natInstanceSubnets(topo).length > 0,
      },
      {
        id: "worker",
        title: "⑥ 프라이빗 서버 시작하기",
        body: ["이제 프라이빗 서브넷에 퍼블릭 IP가 없는 서버를 둡니다. 이 서버는 인터넷에서 직접 접속할 수 없지만, NAT 인스턴스를 거쳐 밖으로 나갈 수는 있습니다."],
        task: "이름 worker-1, 서브넷 private-a, 퍼블릭 IP 자동 할당 '비활성화'로 '인스턴스 시작'을 누르세요. (보안 그룹은 기본값이어도 됩니다)",
        path: "/ec2/instances/launch",
        target: '[data-tour="launch-form"]',
        side: "left",
        isDone: ({ topo }) => {
          const subnets = new Set(natInstanceSubnets(topo).map((s) => s.id));
          return topo.ofType("ec2").some((e) => e.config.state !== "terminated" && subnets.has(topo.subnetOf(e.id) ?? ""));
        },
      },
      {
        id: "analyze",
        title: "⑦ 프라이빗 서버 → 인터넷 분석하기",
        body: ["Reachability Analyzer로 프라이빗 서버의 요청이 NAT 인스턴스와 인터넷 게이트웨이를 거쳐 나가는지 확인합니다. 단계마다 소스/대상 확인, MASQUERADE 주소 변환, 보안 그룹 판정이 보입니다."],
        task: "소스 유형 '인스턴스'에 worker-1, 대상 유형 '인터넷', 프로토콜 TCP, 포트 443으로 '경로 생성 및 분석'을 누르세요. (worker-1이 Running이 된 뒤에 분석하세요)",
        path: "/vpc/reachability/create",
        target: '[data-tour="path-form"]',
        side: "left",
        isDone: ({ project, topo }) => {
          const subnets = new Set(natInstanceSubnets(topo).map((s) => s.id));
          return project.networkPaths.some(
            (p) =>
              p.request.source.kind === "resource" &&
              subnets.has(topo.subnetOf(p.request.source.resourceId) ?? "") &&
              p.request.destination.kind === "internet" &&
              simulateWithTopology(topo, p.request).outcome === "success",
          );
        },
      },
      {
        id: "cost",
        title: "⑧ 비용 비교하기",
        body: [
          "가상 비용 화면에서 같은 가정 단가로 NAT 게이트웨이와 NAT 인스턴스의 한 달 비용을 비교해 보세요. 사용량 가정(처리 데이터 GB)을 바꾸면 차이가 어떻게 달라지는지도 볼 수 있습니다.",
          "숫자는 교육용 가정값이며 실제 요금이 아닙니다.",
        ],
        path: "/billing",
        target: '[data-testid="nat-cost-comparison"]',
        side: "top",
      },
      {
        id: "done",
        title: "NAT 인스턴스를 직접 구성했습니다! 🎉",
        body: [
          "퍼블릭 서브넷의 EC2 + NAT 설정 스크립트 + 소스/대상 확인 중지 + 0.0.0.0/0 → 인스턴스 경로로, NAT 게이트웨이 없이 프라이빗 서버의 외부 통신을 만들었습니다.",
          "다음 도전: 소스/대상 확인을 다시 켜거나 NAT 인스턴스를 중지한 뒤 다시 분석해 보세요. 어느 단계에서 왜 막히는지 보입니다(중지하면 경로가 Blackhole이 됩니다). 운영 환경이라면 장애에 대비해 NAT 게이트웨이를 고려하세요.",
        ],
      },
    ],
  },
];

export function tutorialById(id: string | null | undefined): Tutorial | undefined {
  return TUTORIALS.find((t) => t.id === id);
}

/** 판정 단계 중 완료된 개수 */
export function tutorialProgress(t: Tutorial, ctx: TutorialContext): { done: number; total: number } {
  const checks = t.steps.filter((s) => s.isDone);
  return { done: checks.filter((s) => s.isDone!(ctx)).length, total: checks.length };
}

/** 이어서 할 단계: 아직 완료하지 않은 첫 판정 단계 (하나도 안 했거나 모두 끝냈으면 처음부터) */
export function resumeStepIndex(t: Tutorial, ctx: TutorialContext): number {
  const progress = tutorialProgress(t, ctx);
  if (progress.done === 0 || progress.done === progress.total) return 0;
  const index = t.steps.findIndex((s) => s.isDone && !s.isDone(ctx));
  return index < 0 ? 0 : index;
}

export function resolveStepPath(step: TutorialStep, ctx: TutorialContext): string | null {
  if (!step.path) return null;
  return typeof step.path === "function" ? step.path(ctx) : step.path;
}
