/**
 * 처음 쓰는 사람을 위한 "다음 할 일": 인터넷에서 접속되는 첫 웹 서버까지의 순서.
 * 단계의 완료 여부는 저장하지 않고 지금 샌드박스의 실제 설정으로 매번 판정한다 (심화 모드·쉬운 모드 공용).
 */
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import type { Topology } from "@/lib/engine/topology-engine";

export interface FirstStep {
  id: "vpc" | "subnet" | "igw" | "route" | "sg" | "ec2" | "verify";
  title: string;
  /** 왜 하는지 한 줄 */
  detail: string;
  done: boolean;
  /** 심화 모드(콘솔)에서 할 곳 */
  consolePath: string;
  /** 쉬운 모드에서 끌어다 놓을 리소스 (없으면 null) */
  paletteType: ResourceType | null;
  /** 쉬운 모드에서 하는 방법 */
  builderHint: string;
}

export function firstWebServerSteps(project: Project, topo: Topology): FirstStep[] {
  const vpcs = topo.ofType("vpc");
  return [
    {
      id: "vpc",
      title: "VPC 만들기",
      detail: "내 전용 네트워크의 주소 범위(예: 10.0.0.0/16)를 정합니다.",
      done: vpcs.length > 0,
      consolePath: "/vpc/vpcs/create",
      paletteType: "vpc",
      builderHint: "왼쪽 팔레트의 VPC를 캔버스로 끌어다 놓거나 눌러서 추가하세요.",
    },
    {
      id: "subnet",
      title: "서브넷 만들기",
      detail: "VPC를 구역으로 나눕니다. 서버는 서브넷 안에 놓입니다.",
      done: topo.ofType("subnet").length > 0,
      consolePath: "/vpc/subnets/create",
      paletteType: "subnet",
      builderHint: "서브넷을 VPC 영역 안에 놓으세요. VPC 안에 놓으면 자동으로 VPC에 속합니다.",
    },
    {
      id: "igw",
      title: "인터넷 게이트웨이 연결",
      detail: "VPC에 인터넷으로 나가는 문을 답니다.",
      done: vpcs.some((v) => !!topo.igwOfVpc(v.id)),
      consolePath: "/vpc/igws",
      paletteType: "internet-gateway",
      builderHint: "인터넷 게이트웨이를 놓고, 리소스의 연결점을 끌어 VPC와 선으로 이으세요.",
    },
    {
      id: "route",
      title: "라우팅 테이블에 인터넷 경로 추가",
      detail: "0.0.0.0/0 → 인터넷 게이트웨이 경로가 있어야 퍼블릭 서브넷이 됩니다.",
      done: topo.ofType("subnet").some((s) => topo.classifySubnet(s.id).kind === "public"),
      consolePath: "/vpc/route-tables",
      paletteType: "route-table",
      builderHint: "라우팅 테이블을 VPC 안에 놓고 서브넷, 인터넷 게이트웨이와 각각 선으로 이으세요. 인터넷 게이트웨이와 이으면 0.0.0.0/0 경로가 생깁니다.",
    },
    {
      id: "sg",
      title: "보안 그룹 만들기",
      detail: "서버에 들어올 수 있는 트래픽(예: HTTP 80)을 정합니다.",
      done: topo.ofType("security-group").some((g) => !g.config.isDefault),
      consolePath: "/vpc/security-groups/create",
      paletteType: "security-group",
      builderHint: "보안 그룹을 VPC 안에 놓고, 오른쪽 설정에서 HTTP(80) 인바운드 규칙을 추가하세요.",
    },
    {
      id: "ec2",
      title: "EC2 인스턴스 시작",
      detail: "서브넷·퍼블릭 IP·보안 그룹·웹 서버 설치를 고릅니다.",
      done: topo.ofType("ec2").length > 0,
      consolePath: "/ec2/instances/launch",
      paletteType: "ec2",
      builderHint: "EC2를 퍼블릭 서브넷 안에 놓고 보안 그룹과 선으로 이으세요. 오른쪽 설정에서 퍼블릭 IP도 켭니다.",
    },
    {
      id: "verify",
      title: "통신 경로 분석",
      detail: "인터넷에서 서버까지 실제로 도달하는지 단계별로 확인합니다.",
      done: project.networkPaths.some((p) => p.lastAnalysis),
      consolePath: "/vpc/reachability/create",
      paletteType: null,
      builderHint: "위쪽 '시뮬레이션' 버튼을 눌러 인터넷에서 EC2까지 통신을 실행해 보세요.",
    },
  ];
}

/** 순서대로 보아 아직 하지 않은 첫 단계 (모두 끝났으면 null) */
export function nextFirstStep(steps: FirstStep[]): FirstStep | null {
  return steps.find((s) => !s.done) ?? null;
}
