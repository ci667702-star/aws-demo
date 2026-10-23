/**
 * 콘솔 튜토리얼 정의.
 * 판정(isDone)이 있는 단계는 실제 설정이 맞아야 다음으로 넘어간다. 판정이 없는 단계는 "다음" 버튼으로 넘어간다.
 */
import { parseIpv4 } from "@/lib/engine/cidr-utils";
import { buildMetricModel } from "@/lib/engine/cloudwatch-engine";
import { DEFAULT_INTERNET_CLIENT_IP, simulateWithTopology } from "@/lib/engine/connectivity-engine";
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
  /** 완료 판정 — 참이 되면 자동으로 다음 단계로 넘어간다 */
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
    description: "VPC부터 EC2까지 직접 만들고 인터넷에서 접속되는지 확인합니다. 단계마다 실제 설정이 맞아야 다음으로 넘어갑니다.",
    minutes: 10,
    steps: [
      {
        id: "intro",
        title: "무엇을 만들까요?",
        body: [
          "인터넷에서 접속할 수 있는 웹 서버 한 대를 만듭니다. 순서는 다음과 같습니다.",
          "① VPC(내 네트워크) → ② 서브넷(구역) → ③ 인터넷 게이트웨이(정문) → ④ 라우팅(길 안내) → ⑤ 보안 그룹(출입 규칙) → ⑥ EC2(서버) → ⑦ 통신 분석",
          "각 단계에서 안내 팝업이 해당 화면의 양식을 가리킵니다. 양식을 채우고 버튼을 누르면 자동으로 다음 단계로 넘어갑니다.",
        ],
      },
      {
        id: "vpc",
        title: "① VPC 만들기",
        body: ["VPC는 내 리소스만 들어가는 가상 네트워크입니다. 주소 범위(CIDR)를 정합니다."],
        task: "이름 태그에 my-vpc, IPv4 CIDR에 10.0.0.0/16을 입력하고 'VPC 생성'을 누르세요.",
        path: "/vpc/vpcs/create",
        target: '[data-tour="vpc-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("vpc").length > 0,
      },
      {
        id: "subnet",
        title: "② 서브넷 만들기",
        body: ["서브넷은 VPC를 나눈 구역입니다. 서버는 서브넷 안에 놓입니다. 서브넷 CIDR은 VPC 범위 안이어야 합니다."],
        task: "VPC를 고르고 서브넷 이름 public-a, 가용 영역 ap-northeast-2a, CIDR 10.0.1.0/24를 입력한 뒤 '서브넷 생성'을 누르세요.",
        path: "/vpc/subnets/create",
        target: '[data-tour="subnet-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("subnet").some((s) => !!topo.vpcOfSubnet(s.id)),
      },
      {
        id: "igw",
        title: "③-1 인터넷 게이트웨이 만들기",
        body: ["인터넷 게이트웨이는 VPC와 인터넷을 잇는 정문입니다. 만든 직후에는 어느 VPC에도 연결되어 있지 않습니다."],
        task: "'인터넷 게이트웨이 생성'을 누르세요. (이름은 비워도 됩니다)",
        path: "/vpc/igws/create",
        target: '[data-tour="igw-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("internet-gateway").length > 0,
      },
      {
        id: "igw-attach",
        title: "③-2 VPC에 연결하기",
        body: ["정문을 만들었으니 건물(VPC)에 달아야 합니다. VPC 하나에는 인터넷 게이트웨이를 하나만 연결할 수 있습니다."],
        task: "사용 가능한 VPC에서 만든 VPC를 고르고 '인터넷 게이트웨이 연결'을 누르세요.",
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
        task: "'라우팅 추가'를 누르고 대상(Destination)에 0.0.0.0/0, 대상(Target)에 인터넷 게이트웨이를 고른 뒤 '변경 사항 저장'을 누르세요.",
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
        task: "이름 web-sg, 설명 '웹 서버'를 입력하고 VPC를 고른 뒤, 인바운드 '규칙 추가' → 유형 HTTP, 소스 유형 Anywhere-IPv4 → '보안 그룹 생성'을 누르세요.",
        path: "/vpc/security-groups/create",
        target: '[data-tour="sg-form"]',
        side: "left",
        isDone: ({ topo }) => topo.ofType("security-group").some((g) => !g.config.isDefault && allowsHttpFromInternet([g])),
      },
      {
        id: "ec2",
        title: "⑥ 웹 서버(EC2) 시작하기",
        body: ["이제 서버를 퍼블릭 서브넷에 놓습니다. 인터넷에서 접속하려면 퍼블릭 IP와 웹 서버 프로그램(사용자 데이터)이 필요합니다.", "시작하면 Pending을 거쳐 몇 초 뒤 Running이 됩니다."],
        task: "서브넷 public-a, 퍼블릭 IP 자동 할당 '활성화', 방화벽 '기존 보안 그룹 선택' → web-sg, 고급 세부 정보의 사용자 데이터 '웹 서버 설치'를 고르고 '인스턴스 시작'을 누르세요.",
        path: "/ec2/instances/launch",
        target: '[data-tour="launch-form"]',
        side: "left",
        isDone: ({ topo }) => webServers(topo).length > 0,
      },
      {
        id: "analyze",
        title: "⑦ 인터넷에서 접속되는지 분석하기",
        body: ["Reachability Analyzer는 가상 패킷이 라우팅·네트워크 ACL·보안 그룹을 통과하는지 단계별로 보여 줍니다."],
        task: "소스 유형 '인터넷', 대상 유형 '인스턴스', 대상에 웹 서버, 프로토콜 TCP, 포트 80으로 '경로 생성 및 분석'을 누르세요.",
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
        task: "실행 중인(Running) 인스턴스가 하나 이상 있어야 다음으로 넘어갑니다.",
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
];

export function tutorialById(id: string | null | undefined): Tutorial | undefined {
  return TUTORIALS.find((t) => t.id === id);
}

/** 판정 단계 중 완료된 개수 */
export function tutorialProgress(t: Tutorial, ctx: TutorialContext): { done: number; total: number } {
  const checks = t.steps.filter((s) => s.isDone);
  return { done: checks.filter((s) => s.isDone!(ctx)).length, total: checks.length };
}

export function resolveStepPath(step: TutorialStep, ctx: TutorialContext): string | null {
  if (!step.path) return null;
  return typeof step.path === "function" ? step.path(ctx) : step.path;
}
