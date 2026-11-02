/**
 * 현재 구성 분석.
 * 선택한 리소스의 실제 연결 상태, 설정 요약, 검증 결과, 통신 시뮬레이션 결과를 모은다.
 * 일반 설명(resource-docs)과 달리 지금 샌드박스의 실제 데이터만 쓰며, 연결되지 않은 것을 연결되었다고 표시하지 않는다.
 */
import type { TargetHealth } from "@/lib/engine/alb-engine";
import { awsUsableHostCount, cidrContainsCidr, cidrSize, cidrsOverlap, formatIpv4, tryParseCidr } from "@/lib/engine/cidr-utils";
import { alarmHistory, buildMetricModel, metricDefinition, type AlarmState, type MetricModel } from "@/lib/engine/cloudwatch-engine";
import { DEFAULT_INTERNET_CLIENT_IP, DEFAULT_INTERNET_HOST_IP, simulateWithTopology, type SimulationRequest } from "@/lib/engine/connectivity-engine";
import { describeNaclRule } from "@/lib/engine/network-acl-engine";
import type { Project, Resource, ResourceOfType, ResourceType } from "@/lib/engine/resource-models";
import { describeSgRule } from "@/lib/engine/security-group-engine";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import { checkNatInstance, natInstanceUsages } from "@/lib/engine/nat-instance";
import type { ValidationFinding } from "@/lib/engine/validation-engine";
import type { ServiceDocKey } from "./types";

/** 분석에 필요한 입력 (콘솔·빌더의 ProjectAnalysis가 그대로 만족한다) */
export interface AnalysisInput {
  project: Project;
  topology: Topology;
  health: Map<string, TargetHealth[]>;
  findingsByResource: Map<string, ValidationFinding[]>;
}

export type AnalysisTone = "ok" | "warn" | "error" | "info";

export interface LinkedItem {
  /** 캔버스 리소스 */
  resourceId?: string;
  type?: ResourceType;
  /** VPC 밖 서비스 항목 (S3 버킷, IAM 역할, 경보 등) */
  service?: { key: ServiceDocKey; itemId: string | null; consolePath: string };
  name: string;
  detail?: string;
  tone?: AnalysisTone;
}

export interface RelationGroup {
  label: string;
  /** 이 관계가 왜 중요한가 */
  explanation: string;
  items: LinkedItem[];
  /** 필요한데 없을 때의 안내 (있으면 경고로 표시) */
  missing?: string;
  /** 비어 있을 때 표시할 문구 (문제는 아님) */
  empty?: string;
  field?: string;
}

export interface AnalysisCheck {
  tone: AnalysisTone;
  title: string;
  detail: string;
  field?: string;
  /** 시뮬레이션 콘솔에서 다시 실행할 수 있는 요청 */
  request?: SimulationRequest;
}

export interface Fact {
  label: string;
  value: string;
  field?: string;
}

export interface ResourceAnalysis {
  headline: { tone: AnalysisTone; text: string };
  facts: Fact[];
  relations: RelationGroup[];
  checks: AnalysisCheck[];
  findings: ValidationFinding[];
  recommendations: string[];
}

export interface AnalysisOptions {
  /** 경보 상태 평가 시각 (기본: 지금) */
  now?: number;
  metricModel?: MetricModel;
}

const INTERNET = { kind: "internet" as const, ip: DEFAULT_INTERNET_CLIENT_IP };
const INTERNET_HOST = { kind: "internet" as const, ip: DEFAULT_INTERNET_HOST_IP };

const item = (topo: Topology, r: Resource | undefined | null, detail?: string, tone?: AnalysisTone): LinkedItem[] =>
  r ? [{ resourceId: r.id, type: r.type, name: displayName(r), detail, tone }] : [];

function simCheck(topo: Topology, title: string, request: SimulationRequest, okDetail: string, field?: string): AnalysisCheck {
  const result = simulateWithTopology(topo, request);
  if (result.outcome === "success") return { tone: "ok", title, detail: okDetail, request, field };
  const fix = result.failure?.fixes[0];
  return {
    tone: result.outcome === "failure" ? "error" : "warn",
    title,
    detail: `${result.failure?.reason ?? result.summary}${fix ? ` → 해결: ${fix}` : ""}`,
    request,
    field,
  };
}

const SUBNET_KIND_TEXT = { public: "퍼블릭", "private-nat": "프라이빗 (NAT로 외부 통신)", "private-isolated": "프라이빗 (외부 경로 없음)", unattached: "VPC 없음" } as const;
const SUBNET_KIND_TONE = { public: "info", "private-nat": "info", "private-isolated": "info", unattached: "error" } as const;

function subnetItem(topo: Topology, subnetId: string | null): LinkedItem[] {
  const s = topo.getOfType(subnetId, "subnet");
  if (!s) return [];
  const cls = topo.classifySubnet(s.id);
  return [{ resourceId: s.id, type: "subnet", name: displayName(s), detail: `${SUBNET_KIND_TEXT[cls.kind]} · ${s.config.availabilityZone} · ${s.config.cidr}`, tone: SUBNET_KIND_TONE[cls.kind] }];
}

function defaultNaclOf(topo: Topology, vpcId: string | null) {
  return topo.ofType("network-acl").find((n) => n.config.isDefault && topo.vpcOf(n.id) === vpcId);
}

/** 서브넷에 실제로 적용되는 NACL (명시적 연결 → 기본 NACL) */
function effectiveNacl(topo: Topology, subnetId: string): { nacl: ResourceOfType<"network-acl"> | undefined; explicit: boolean } {
  const explicit = topo.naclOf(subnetId);
  if (explicit) return { nacl: explicit, explicit: true };
  return { nacl: defaultNaclOf(topo, topo.vpcOfSubnet(subnetId)), explicit: false };
}

function routeTableItems(topo: Topology, subnetId: string): LinkedItem[] {
  const ref = topo.routeTableRefFor(subnetId);
  if (ref.kind === "explicit" || ref.kind === "main") {
    const rt = topo.getOfType(ref.routeTableId, "route-table");
    const routes = topo.subnetRouting(subnetId).routes.map((r) => `${r.destinationCidr} → ${topo.routeTargetLabel(r)}`).join(", ");
    return item(topo, rt, `${ref.kind === "explicit" ? "명시적 연결" : "기본(main) 테이블"} · ${routes}`);
  }
  return [];
}

function alarmsFor(project: Project, resourceId: string, options: AnalysisOptions, input: AnalysisInput): LinkedItem[] {
  const alarms = project.services.cloudwatch.alarms.filter((a) => a.metric.resourceId === resourceId);
  if (!alarms.length) return [];
  const model = options.metricModel ?? buildMetricModel(project, input.topology, input.health);
  const now = options.now ?? Date.now();
  const toneOf: Record<AlarmState, AnalysisTone> = { OK: "ok", ALARM: "error", INSUFFICIENT_DATA: "info" };
  return alarms.map((a) => {
    const state = alarmHistory(model, a, now, 60).current.state;
    return {
      service: { key: "cloudwatch", itemId: a.id, consolePath: `/cloudwatch/alarms/${a.id}` },
      name: a.name,
      detail: `${metricDefinition(a.metric)?.label ?? a.metric.metricName} · 상태 ${state}`,
      tone: toneOf[state],
    };
  });
}

function alarmRelation(project: Project, resourceId: string, options: AnalysisOptions, input: AnalysisInput, what: string): RelationGroup {
  return {
    label: "CloudWatch 경보",
    explanation: `이 ${what}의 가상 지표를 감시하는 경보입니다.`,
    items: alarmsFor(project, resourceId, options, input),
    empty: "이 리소스를 감시하는 경보가 없습니다. 심화 모드의 CloudWatch에서 만들 수 있습니다.",
  };
}

// ---------------------------------------------------------------- 리소스별 분석

function analyzeVpc(input: AnalysisInput, vpc: ResourceOfType<"vpc">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const cidr = tryParseCidr(vpc.config.cidr);
  const subnets = topo.subnetsOfVpc(vpc.id);
  const igw = topo.igwOfVpc(vpc.id);
  const main = topo.mainRouteTableOf(vpc.id);
  const publicCount = subnets.filter((s) => topo.classifySubnet(s.id).kind === "public").length;
  const checks: AnalysisCheck[] = [];
  if (!igw) checks.push({ tone: "warn", title: "인터넷 게이트웨이 없음", detail: "이 VPC의 리소스는 인터넷과 직접 통신할 수 없습니다. VPC를 만든 것만으로는 인터넷이 되지 않습니다.", field: "internetGateway" });
  else if (!publicCount) checks.push({ tone: "warn", title: "IGW는 연결됐지만 퍼블릭 서브넷이 없음", detail: "어떤 서브넷의 라우팅 테이블에도 0.0.0.0/0 → IGW 경로가 없습니다.", field: "internetGateway" });
  else checks.push({ tone: "ok", title: "인터넷 경로 있음", detail: `퍼블릭 서브넷 ${publicCount}개가 ${displayName(igw)}을(를) 통해 인터넷과 통신할 수 있습니다.` });
  if (!subnets.length) checks.push({ tone: "info", title: "서브넷 없음", detail: "리소스는 서브넷에 배치되므로 서브넷을 먼저 만드세요." });
  if (!vpc.config.enableDnsSupport) checks.push({ tone: "warn", title: "DNS 확인 꺼짐", detail: "VPC 안에서 ALB·RDS 이름 조회가 실패합니다.", field: "enableDnsSupport" });
  return {
    headline: igw ? { tone: "ok", text: `${vpc.config.cidr} · 서브넷 ${subnets.length}개 (퍼블릭 ${publicCount})` } : { tone: "warn", text: `${vpc.config.cidr} · 인터넷 게이트웨이 없음` },
    facts: [
      { label: "IPv4 CIDR", value: cidr ? `${vpc.config.cidr} (주소 ${cidrSize(cidr).toLocaleString("ko-KR")}개)` : vpc.config.cidr, field: "cidr" },
      { label: "DNS 확인", value: vpc.config.enableDnsSupport ? "켜짐" : "꺼짐", field: "enableDnsSupport" },
      { label: "DNS 호스트 이름", value: vpc.config.enableDnsHostnames ? "켜짐" : "꺼짐", field: "enableDnsHostnames" },
      { label: "기본 VPC", value: vpc.config.isDefault ? "예" : "아니요", field: "isDefault" },
    ],
    relations: [
      { label: "서브넷", explanation: "이 VPC의 주소 범위를 나눈 구역입니다. 퍼블릭/프라이빗은 라우팅으로 판정합니다.", items: subnets.flatMap((s) => subnetItem(topo, s.id)), missing: subnets.length ? undefined : "서브넷이 없어 리소스를 배치할 수 없습니다." },
      { label: "인터넷 게이트웨이", explanation: "VPC당 하나만 연결할 수 있는 인터넷 출입구입니다.", items: item(topo, igw, "연결됨 (Attached)", "ok"), missing: igw ? undefined : "연결된 인터넷 게이트웨이가 없어 인터넷과 통신할 수 없습니다.", field: "internetGateway" },
      { label: "기본(main) 라우팅 테이블", explanation: "명시적 연결이 없는 서브넷이 쓰는 테이블입니다.", items: item(topo, main), missing: main ? undefined : "기본 테이블이 없어 연결 안 된 서브넷은 local 경로만 있다고 가정합니다.", field: "mainRouteTable" },
      { label: "보안 그룹", explanation: "이 VPC에 속한 보안 그룹입니다.", items: topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpc.id).flatMap((g) => item(topo, g, g.config.isDefault ? "기본 보안 그룹" : undefined)), empty: "보안 그룹이 없습니다." },
    ],
    checks,
    recommendations: cidr && cidr.prefix > 20 ? ["VPC 범위가 작습니다. 서브넷을 여러 개 만들 계획이라면 /16 정도로 넉넉하게 잡는 것이 좋습니다."] : [],
  };
}

function analyzeSubnet(input: AnalysisInput, subnet: ResourceOfType<"subnet">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const vpcId = topo.vpcOfSubnet(subnet.id);
  const vpc = topo.getOfType(vpcId, "vpc");
  const cls = topo.classifySubnet(subnet.id);
  const cidr = tryParseCidr(subnet.config.cidr);
  const vpcCidr = topo.vpcCidr(vpcId);
  const nacl = effectiveNacl(topo, subnet.id);
  const checks: AnalysisCheck[] = [];
  if (cidr && vpcCidr) {
    checks.push(
      cidrContainsCidr(vpcCidr, cidr)
        ? { tone: "ok", title: "VPC 범위 안의 CIDR", detail: `${subnet.config.cidr}은(는) VPC ${vpc ? vpc.config.cidr : ""} 안에 있습니다.`, field: "cidr" }
        : { tone: "error", title: "VPC 범위를 벗어난 CIDR", detail: `${subnet.config.cidr}은(는) VPC ${vpc?.config.cidr ?? ""} 범위 밖입니다.`, field: "cidr" },
    );
    const overlaps = topo
      .subnetsOfVpc(vpcId!)
      .filter((o) => o.id !== subnet.id)
      .filter((o) => {
        const oc = tryParseCidr(o.config.cidr);
        return oc && cidrsOverlap(oc, cidr);
      });
    checks.push(
      overlaps.length
        ? { tone: "error", title: "다른 서브넷과 겹침", detail: `${overlaps.map((o) => `${displayName(o)}(${o.config.cidr})`).join(", ")}과(와) 주소가 겹칩니다.`, field: "cidr" }
        : { tone: "ok", title: "다른 서브넷과 겹치지 않음", detail: "같은 VPC의 다른 서브넷과 주소 범위가 겹치지 않습니다.", field: "cidr" },
    );
  }
  checks.push({
    tone: cls.kind === "unattached" ? "error" : "info",
    title: `${SUBNET_KIND_TEXT[cls.kind]} 서브넷으로 판정`,
    detail: `${cls.reason} (이름이 아니라 라우팅 테이블 경로로 판정합니다)`,
    field: "routeTable",
  });
  if (subnet.config.mapPublicIpOnLaunch && cls.kind !== "public") {
    checks.push({ tone: "warn", title: "퍼블릭 IP 자동 할당이 켜져 있지만 퍼블릭 서브넷이 아님", detail: "인터넷 게이트웨이 경로가 없어 퍼블릭 IP가 있어도 인터넷과 통신할 수 없습니다.", field: "mapPublicIpOnLaunch" });
  }
  const residents: LinkedItem[] = [
    ...topo.ofType("ec2").filter((e) => topo.subnetOf(e.id) === subnet.id).flatMap((e) => item(topo, e, e.config.state)),
    ...topo.ofType("nat-gateway").filter((n) => topo.subnetOf(n.id) === subnet.id).flatMap((n) => item(topo, n, n.config.state)),
    ...topo.ofType("alb").filter((a) => topo.albSubnets(a.id).some((s) => s.id === subnet.id)).flatMap((a) => item(topo, a, "ALB 노드")),
    ...topo.ofType("rds").filter((d) => {
      const p = topo.rdsPlacement(d.id);
      return p.primary?.id === subnet.id || p.standby?.id === subnet.id;
    }).flatMap((d) => item(topo, d, topo.rdsPlacement(d.id).primary?.id === subnet.id ? "기본 인스턴스" : "대기 인스턴스")),
  ];
  return {
    headline: { tone: cls.kind === "unattached" ? "error" : "info", text: `${SUBNET_KIND_TEXT[cls.kind]} · ${subnet.config.availabilityZone} · ${subnet.config.cidr}` },
    facts: [
      { label: "IPv4 CIDR", value: cidr ? `${subnet.config.cidr} (사용 가능 ${awsUsableHostCount(cidr).toLocaleString("ko-KR")}개, AWS 예약 5개 제외)` : subnet.config.cidr, field: "cidr" },
      { label: "가용 영역", value: subnet.config.availabilityZone, field: "availabilityZone" },
      { label: "퍼블릭 IPv4 자동 할당", value: subnet.config.mapPublicIpOnLaunch ? "켜짐" : "꺼짐", field: "mapPublicIpOnLaunch" },
      { label: "판정", value: SUBNET_KIND_TEXT[cls.kind], field: "routeTable" },
    ],
    relations: [
      { label: "소속 VPC", explanation: "서브넷 CIDR은 이 VPC 범위 안이어야 합니다.", items: item(topo, vpc), missing: vpc ? undefined : "VPC에 속하지 않아 이 서브넷의 리소스는 통신할 수 없습니다.", field: "vpc" },
      { label: "적용되는 라우팅 테이블", explanation: "이 테이블의 경로로 퍼블릭/프라이빗이 정해집니다.", items: routeTableItems(topo, subnet.id), missing: routeTableItems(topo, subnet.id).length ? undefined : "적용되는 라우팅 테이블이 없어 local 경로만 있다고 가정합니다.", field: "routeTable" },
      {
        label: "적용되는 네트워크 ACL",
        explanation: "서브넷 경계에서 요청과 응답을 각각 검사합니다.",
        items: item(topo, nacl.nacl, nacl.explicit ? "명시적 연결" : "기본 NACL (모두 허용)"),
        empty: "명시적으로 연결된 NACL이 없어 기본 NACL(모두 허용)을 쓴다고 가정합니다.",
        field: "networkAcl",
      },
      { label: "이 서브넷의 리소스", explanation: "이 서브넷에 배치된 리소스입니다.", items: residents, empty: "배치된 리소스가 없습니다." },
    ],
    checks,
    recommendations: [],
  };
}

function analyzeIgw(input: AnalysisInput, igw: ResourceOfType<"internet-gateway">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const vpcId = topo.vpcOfIgw(igw.id);
  const vpc = topo.getOfType(vpcId, "vpc");
  const routeTables = topo.incoming(igw.id, "route-table-internet-gateway").map((c) => topo.getOfType(c.sourceResourceId, "route-table")).filter((r): r is ResourceOfType<"route-table"> => !!r);
  const publicSubnets = topo.ofType("subnet").filter((s) => {
    const cls = topo.classifySubnet(s.id);
    return cls.kind === "public" && cls.route?.targetId === igw.id;
  });
  const checks: AnalysisCheck[] = [];
  if (!vpc) checks.push({ tone: "error", title: "VPC에 연결되지 않음 (Detached)", detail: "이 게이트웨이를 가리키는 경로가 있어도 트래픽을 전달하지 않습니다 (블랙홀).", field: "vpc" });
  else if (!routeTables.length) checks.push({ tone: "warn", title: "연결은 됐지만 경로가 없음", detail: "어떤 라우팅 테이블도 이 게이트웨이로 트래픽을 보내지 않아 퍼블릭 서브넷이 없습니다. 라우팅 테이블에 0.0.0.0/0 → 이 IGW를 추가하세요.", field: "attachmentState" });
  else checks.push({ tone: "ok", title: "인터넷 경로로 사용 중", detail: `퍼블릭 서브넷 ${publicSubnets.length}개가 이 게이트웨이를 통해 인터넷과 통신합니다. (리소스에는 퍼블릭 IP도 필요합니다)` });
  return {
    headline: vpc ? { tone: "ok", text: `Attached → ${displayName(vpc)}` } : { tone: "error", text: "Detached (연결 안 됨)" },
    facts: [{ label: "연결 상태", value: vpc ? `Attached (${displayName(vpc)})` : "Detached", field: "attachmentState" }],
    relations: [
      { label: "연결된 VPC", explanation: "VPC당 인터넷 게이트웨이는 하나입니다.", items: item(topo, vpc), missing: vpc ? undefined : "VPC에 연결하지 않으면 출입구 역할을 하지 못합니다.", field: "vpc" },
      { label: "이 IGW로 향하는 라우팅 테이블", explanation: "경로가 있어야 트래픽이 이 게이트웨이로 옵니다.", items: routeTables.flatMap((rt) => item(topo, rt)), empty: "이 게이트웨이를 대상으로 하는 경로가 없습니다." },
      { label: "이 IGW 덕분에 퍼블릭인 서브넷", explanation: "라우팅으로 판정한 퍼블릭 서브넷입니다.", items: publicSubnets.flatMap((s) => subnetItem(topo, s.id)), empty: "없습니다." },
    ],
    checks,
    recommendations: [],
  };
}

function analyzeEip(input: AnalysisInput, eip: ResourceOfType<"elastic-ip">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const target = topo.elasticIpTarget(eip.id);
  return {
    headline: target ? { tone: "ok", text: `${eip.config.publicIp} → ${displayName(target)}` } : { tone: "warn", text: `${eip.config.publicIp} · 연결 안 됨` },
    facts: [{ label: "퍼블릭 IPv4 (가상)", value: eip.config.publicIp, field: "publicIp" }],
    relations: [{ label: "연결 대상", explanation: "이 고정 주소를 쓰는 인스턴스나 NAT 게이트웨이입니다.", items: item(topo, target), missing: target ? undefined : "연결되지 않은 탄력적 IP는 아무 리소스에도 주소를 주지 않습니다.", field: "association" }],
    checks: target ? [{ tone: "ok", title: "연결됨", detail: `${displayName(target)}이(가) 이 주소를 사용합니다.` }] : [{ tone: "warn", title: "연결되지 않음", detail: "실제 AWS에서는 사용하지 않는 퍼블릭 IPv4 주소에도 요금이 부과됩니다.", field: "association" }],
    recommendations: [],
  };
}

function analyzeRouteTable(input: AnalysisInput, rt: ResourceOfType<"route-table">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const vpcId = topo.vpcOf(rt.id);
  const vpc = topo.getOfType(vpcId, "vpc");
  const routes = topo.routesOf(rt.id, vpcId);
  const explicit = topo.outgoing(rt.id, "route-table-subnet").map((c) => topo.getOfType(c.targetResourceId, "subnet")).filter((s): s is ResourceOfType<"subnet"> => !!s);
  const implicit = vpcId && rt.config.main ? topo.subnetsOfVpc(vpcId).filter((s) => topo.routeTableRefFor(s.id).kind === "main") : [];
  const checks: AnalysisCheck[] = [];
  for (const r of routes) {
    if (r.targetKind === "internet-gateway" && !topo.igwAttachedTo(r.targetId, vpcId)) {
      checks.push({ tone: "error", title: `블랙홀 경로: ${r.destinationCidr}`, detail: `${topo.label(r.targetId)}이(가) 이 VPC에 연결되어 있지 않아 이 경로의 트래픽은 버려집니다.`, field: "target" });
    }
    if (r.targetKind === "nat-gateway") {
      const nat = topo.getOfType(r.targetId, "nat-gateway");
      if (!nat) checks.push({ tone: "error", title: `블랙홀 경로: ${r.destinationCidr}`, detail: "대상 NAT 게이트웨이가 없습니다.", field: "target" });
      else if (nat.config.state !== "available") checks.push({ tone: "error", title: `NAT가 사용 불가: ${r.destinationCidr}`, detail: `${displayName(nat)} 상태가 ${nat.config.state}입니다.`, field: "target" });
      else if (topo.classifySubnet(topo.subnetOf(nat.id) ?? "").kind !== "public") checks.push({ tone: "error", title: `NAT가 프라이빗 서브넷에 있음: ${r.destinationCidr}`, detail: `${displayName(nat)}이(가) 인터넷으로 나갈 수 없습니다.`, field: "target" });
    }
    if (r.targetKind === "instance") {
      const ec2 = topo.getOfType(r.targetId, "ec2");
      if (!ec2) checks.push({ tone: "error", title: `블랙홀 경로: ${r.destinationCidr}`, detail: "대상 인스턴스가 없습니다.", field: "target" });
      else {
        const nat = checkNatInstance(topo, ec2);
        if (!nat.ok) {
          const blackhole = ec2.config.state !== "running";
          checks.push({
            tone: "error",
            title: `${blackhole ? "블랙홀 경로" : "NAT 인스턴스 준비 안 됨"}: ${r.destinationCidr}`,
            detail: `${displayName(ec2)} — ${nat.problems.map((p) => p.text).join(" ")}`,
            field: "target",
          });
        }
      }
    }
  }
  const hasDefault = routes.some((r) => r.destinationCidr === "0.0.0.0/0");
  if (!hasDefault) checks.push({ tone: "info", title: "외부로 나가는 기본 경로(0.0.0.0/0) 없음", detail: "이 테이블을 쓰는 서브넷은 VPC 밖과 통신할 수 없는 격리된 서브넷입니다. 의도한 것이 아니라면 IGW나 NAT 경로를 추가하세요.", field: "routes" });
  if (!checks.some((c) => c.tone === "error") && hasDefault) checks.push({ tone: "ok", title: "경로 대상이 모두 유효", detail: "모든 경로의 대상이 연결·사용 가능 상태입니다." });
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: `${rt.config.main ? "기본(main) · " : ""}경로 ${routes.length}개 · 서브넷 ${explicit.length + implicit.length}개` },
    facts: [
      { label: "기본(main) 테이블", value: rt.config.main ? "예" : "아니요", field: "main" },
      ...routes.map((r) => ({ label: r.destinationCidr, value: topo.routeTargetLabel(r), field: r.targetKind === "local" ? "routes" : "target" })),
    ],
    relations: [
      { label: "소속 VPC", explanation: "local 경로의 범위입니다.", items: item(topo, vpc), missing: vpc ? undefined : "VPC에 속하지 않은 테이블은 어떤 서브넷에도 적용할 수 없습니다.", field: "vpc" },
      { label: "명시적으로 연결된 서브넷", explanation: "이 테이블의 경로를 따르는 서브넷입니다.", items: explicit.flatMap((s) => subnetItem(topo, s.id)), empty: "명시적으로 연결된 서브넷이 없습니다.", field: "subnets" },
      ...(rt.config.main ? [{ label: "기본 테이블로 적용되는 서브넷", explanation: "명시적 연결이 없어 이 기본 테이블을 쓰는 서브넷입니다.", items: implicit.flatMap((s) => subnetItem(topo, s.id)), empty: "없습니다.", field: "main" }] : []),
      {
        label: "경로 대상",
        explanation: "이 테이블이 트래픽을 보내는 게이트웨이 또는 인스턴스(NAT 인스턴스)입니다.",
        items: routes.filter((r) => r.targetId).flatMap((r) => item(topo, topo.get(r.targetId), `${r.destinationCidr}`)),
        empty: "local 외의 경로가 없습니다.",
        field: "routes",
      },
    ],
    checks,
    recommendations: [],
  };
}

function analyzeNat(input: AnalysisInput, nat: ResourceOfType<"nat-gateway">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const subnetId = topo.subnetOf(nat.id);
  const cls = subnetId ? topo.classifySubnet(subnetId) : null;
  const eip = topo.elasticIpOf(nat.id);
  const routeTables = topo.incoming(nat.id, "route-table-nat-gateway").map((c) => topo.getOfType(c.sourceResourceId, "route-table")).filter((r): r is ResourceOfType<"route-table"> => !!r);
  const served = topo.ofType("subnet").filter((s) => {
    const c = topo.classifySubnet(s.id);
    return c.kind === "private-nat" && c.route?.targetId === nat.id;
  });
  const checks: AnalysisCheck[] = [];
  if (!subnetId) checks.push({ tone: "error", title: "서브넷에 배치되지 않음", detail: "NAT 게이트웨이는 퍼블릭 서브넷에 있어야 합니다.", field: "subnet" });
  else if (cls?.kind !== "public") checks.push({ tone: "error", title: "프라이빗 서브넷에 배치됨", detail: "NAT 자신이 인터넷 게이트웨이로 나갈 수 없어 이 NAT를 쓰는 통신이 실패합니다.", field: "subnet" });
  else checks.push({ tone: "ok", title: "퍼블릭 서브넷에 배치됨", detail: cls.reason, field: "subnet" });
  if (nat.config.state !== "available") checks.push({ tone: "error", title: `상태: ${nat.config.state}`, detail: "available 상태에서만 트래픽을 처리합니다.", field: "state" });
  if (!eip) checks.push({ tone: "warn", title: "탄력적 IP 없음", detail: "퍼블릭 NAT 게이트웨이에는 탄력적 IP가 필요합니다.", field: "elasticIp" });
  if (!routeTables.length) checks.push({ tone: "warn", title: "NAT로 향하는 경로 없음", detail: "프라이빗 서브넷 라우팅 테이블에 0.0.0.0/0 → 이 NAT를 넣어야 프라이빗 서버가 나갈 수 있습니다." });
  const client = topo.ofType("ec2").find((e) => e.config.state === "running" && served.some((s) => s.id === topo.subnetOf(e.id)));
  if (client) {
    checks.push(simCheck(topo, `${displayName(client)} → 인터넷 (HTTPS 443, NAT 경유)`, { source: { kind: "resource", resourceId: client.id }, destination: INTERNET_HOST, protocol: "tcp", port: 443 }, "프라이빗 서버가 이 NAT를 통해 인터넷으로 나갈 수 있습니다."));
  }
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: `${nat.config.state} · ${cls ? SUBNET_KIND_TEXT[cls.kind] : "서브넷 없음"} 서브넷` },
    facts: [
      { label: "상태", value: nat.config.state, field: "state" },
      { label: "탄력적 IP", value: eip?.config.publicIp ?? "없음", field: "elasticIp" },
    ],
    relations: [
      { label: "배치된 서브넷", explanation: "퍼블릭 서브넷이어야 합니다.", items: subnetItem(topo, subnetId), missing: subnetId ? undefined : "서브넷이 없습니다.", field: "subnet" },
      { label: "탄력적 IP", explanation: "바깥으로 나갈 때 출발지 주소입니다.", items: item(topo, eip, eip?.config.publicIp), missing: eip ? undefined : "탄력적 IP가 연결되지 않았습니다.", field: "elasticIp" },
      { label: "이 NAT로 향하는 라우팅 테이블", explanation: "이 테이블을 쓰는 서브넷의 외부 트래픽이 NAT로 옵니다.", items: routeTables.flatMap((rt) => item(topo, rt)), empty: "없습니다." },
      { label: "이 NAT를 쓰는 프라이빗 서브넷", explanation: "라우팅으로 판정했습니다.", items: served.flatMap((s) => subnetItem(topo, s.id)), empty: "없습니다." },
    ],
    checks,
    recommendations: [],
  };
}

function riskyRules(sg: ResourceOfType<"security-group">): string[] {
  const out: string[] = [];
  for (const r of sg.config.inboundRules) {
    if (r.peer.kind !== "cidr" || r.peer.cidr !== "0.0.0.0/0") continue;
    if (r.protocol === "all") out.push("모든 트래픽을 0.0.0.0/0에 허용");
    else if (r.protocol === "tcp" && r.fromPort <= 22 && r.toPort >= 22) out.push("SSH(22)를 0.0.0.0/0에 공개");
    else if (r.protocol === "tcp" && r.fromPort <= 3389 && r.toPort >= 3389) out.push("RDP(3389)를 0.0.0.0/0에 공개");
    else if (r.protocol === "tcp" && [3306, 5432, 1433, 1521].some((p) => r.fromPort <= p && r.toPort >= p)) out.push("데이터베이스 포트를 0.0.0.0/0에 공개");
  }
  return [...new Set(out)];
}

function analyzeSecurityGroup(input: AnalysisInput, sg: ResourceOfType<"security-group">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const vpc = topo.getOfType(topo.vpcOf(sg.id), "vpc");
  const users = topo.resourcesUsingSecurityGroup(sg.id);
  const referencedBy = topo.ofType("security-group").filter((g) => g.id !== sg.id && [...g.config.inboundRules, ...g.config.outboundRules].some((r) => r.peer.kind === "security-group" && r.peer.securityGroupId === sg.id));
  const risks = riskyRules(sg);
  const name = (id: string) => topo.name(id);
  const checks: AnalysisCheck[] = risks.map((r) => ({ tone: "warn" as const, title: "보안 경고", detail: r, field: "inboundRules" }));
  if (!sg.config.inboundRules.length) checks.push({ tone: "info", title: "인바운드 규칙 없음", detail: "이 보안 그룹만 붙은 리소스는 먼저 들어오는 연결을 하나도 받지 않습니다 (응답은 자동 허용).", field: "inboundRules" });
  if (!sg.config.outboundRules.length) checks.push({ tone: "warn", title: "아웃바운드 규칙 없음", detail: "이 리소스가 먼저 시작하는 연결(DB 접속, 헬스 체크 전송 등)이 모두 차단됩니다.", field: "outboundRules" });
  if (!users.length) checks.push({ tone: "info", title: "사용되지 않는 보안 그룹", detail: "어떤 리소스에도 연결되지 않아 효과가 없습니다.", field: "attachedTo" });
  if (!risks.length && users.length) checks.push({ tone: "ok", title: "전체 공개 위험 규칙 없음", detail: "0.0.0.0/0에 관리 포트·DB 포트·모든 트래픽을 여는 규칙이 없습니다." });
  return {
    headline: { tone: risks.length ? "warn" : "ok", text: `인바운드 ${sg.config.inboundRules.length}개 · 아웃바운드 ${sg.config.outboundRules.length}개 · 사용 ${users.length}곳` },
    facts: [
      ...sg.config.inboundRules.slice(0, 8).map((r) => ({ label: "인바운드", value: describeSgRule(r, name), field: "inboundRules" })),
      ...sg.config.outboundRules.slice(0, 4).map((r) => ({ label: "아웃바운드", value: describeSgRule(r, name), field: "outboundRules" })),
    ],
    relations: [
      { label: "소속 VPC", explanation: "같은 VPC의 리소스에만 연결됩니다.", items: item(topo, vpc), missing: vpc ? undefined : "VPC에 속하지 않습니다.", field: "vpc" },
      { label: "이 보안 그룹을 쓰는 리소스", explanation: "규칙을 바꾸면 이 리소스들에 즉시 적용됩니다.", items: users.flatMap((r) => item(topo, r)), empty: "연결된 리소스가 없습니다.", field: "attachedTo" },
      { label: "이 보안 그룹을 규칙에서 참조하는 보안 그룹", explanation: "이 그룹이 붙은 리소스를 소스·대상으로 허용합니다.", items: referencedBy.flatMap((g) => item(topo, g)), empty: "없습니다.", field: "peer" },
    ],
    checks,
    recommendations: risks.length ? ["0.0.0.0/0 대신 필요한 IP(/32)나 다른 보안 그룹을 소스로 지정하세요."] : [],
  };
}

function analyzeNacl(input: AnalysisInput, nacl: ResourceOfType<"network-acl">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const vpcId = topo.vpcOf(nacl.id);
  const vpc = topo.getOfType(vpcId, "vpc");
  const explicit = topo.outgoing(nacl.id, "network-acl-subnet").map((c) => topo.getOfType(c.targetResourceId, "subnet")).filter((s): s is ResourceOfType<"subnet"> => !!s);
  const implicit = nacl.config.isDefault && vpcId ? topo.subnetsOfVpc(vpcId).filter((s) => !topo.naclOf(s.id)) : [];
  const checks: AnalysisCheck[] = [];
  if (!explicit.length && !implicit.length) checks.push({ tone: "info", title: "적용된 서브넷 없음", detail: "서브넷에 연결해야 효과가 있습니다.", field: "subnets" });
  const allowsEphemeralIn = nacl.config.isDefault || nacl.config.inboundRules.some((r) => r.action === "allow" && (r.protocol === "all" || (r.protocol === "tcp" && r.fromPort <= 1024 && r.toPort >= 65535)));
  const allowsEphemeralOut = nacl.config.isDefault || nacl.config.outboundRules.some((r) => r.action === "allow" && (r.protocol === "all" || (r.protocol === "tcp" && r.fromPort <= 1024 && r.toPort >= 65535)));
  if (!allowsEphemeralIn || !allowsEphemeralOut) {
    checks.push({
      tone: "warn",
      title: "응답용 임시 포트(1024-65535) 허용 확인",
      detail: `${!allowsEphemeralIn ? "인바운드" : ""}${!allowsEphemeralIn && !allowsEphemeralOut ? "·" : ""}${!allowsEphemeralOut ? "아웃바운드" : ""}에 1024-65535 전체를 허용하는 규칙이 없습니다. 상태 비저장이라 응답이 막힐 수 있습니다 (자세한 판정은 검증 결과 SEC-010 참고).`,
      field: !allowsEphemeralOut ? "outboundRules" : "inboundRules",
    });
  } else checks.push({ tone: "ok", title: "응답용 임시 포트 허용", detail: "양방향 모두 1024-65535 응답 트래픽을 허용합니다." });
  return {
    headline: { tone: "info", text: `${nacl.config.isDefault ? "기본 NACL · " : ""}인바운드 ${nacl.config.inboundRules.length}개 · 아웃바운드 ${nacl.config.outboundRules.length}개` },
    facts: [
      ...[...nacl.config.inboundRules].sort((a, b) => a.ruleNumber - b.ruleNumber).slice(0, 8).map((r) => ({ label: `인바운드 ${r.ruleNumber}`, value: describeNaclRule(r), field: "inboundRules" })),
      ...[...nacl.config.outboundRules].sort((a, b) => a.ruleNumber - b.ruleNumber).slice(0, 8).map((r) => ({ label: `아웃바운드 ${r.ruleNumber}`, value: describeNaclRule(r), field: "outboundRules" })),
    ],
    relations: [
      { label: "소속 VPC", explanation: "같은 VPC의 서브넷에만 연결됩니다.", items: item(topo, vpc), missing: vpc ? undefined : "VPC에 속하지 않습니다.", field: "vpc" },
      { label: "명시적으로 연결된 서브넷", explanation: "이 규칙이 경계에 적용되는 서브넷입니다.", items: explicit.flatMap((s) => subnetItem(topo, s.id)), empty: "없습니다.", field: "subnets" },
      ...(nacl.config.isDefault ? [{ label: "기본 NACL로 적용되는 서브넷", explanation: "명시적 NACL이 없는 서브넷입니다.", items: implicit.flatMap((s) => subnetItem(topo, s.id)), empty: "없습니다.", field: "isDefault" }] : []),
    ],
    checks,
    recommendations: [],
  };
}

function preferredPort(ports: number[]): number | null {
  for (const p of [80, 443, 8080]) if (ports.includes(p)) return p;
  return ports[0] ?? null;
}

function analyzeEc2(input: AnalysisInput, ec2: ResourceOfType<"ec2">, options: AnalysisOptions): Omit<ResourceAnalysis, "findings"> {
  const { topology: topo, project } = input;
  const subnetId = topo.subnetOf(ec2.id);
  const vpc = topo.getOfType(topo.vpcOf(ec2.id), "vpc");
  const eni = topo.enisOf(ec2.id)[0];
  const sgs = topo.securityGroupsOf(ec2.id);
  const eip = topo.elasticIpOf(ec2.id);
  const tgs = topo.ofType("target-group").filter((tg) => topo.targetGroupTargets(tg.id).some((t) => t.ec2.id === ec2.id));
  const role = project.services.iam.roles.find((r) => r.id === ec2.config.iamRoleId);
  const running = ec2.config.state === "running";
  const checks: AnalysisCheck[] = [];
  if (!running) checks.push({ tone: "error", title: `상태: ${ec2.config.state}`, detail: "Running 상태가 아니라 요청을 처리하지 않습니다 (가상 상태).", field: "state" });
  const port = preferredPort(ec2.config.listenPorts);
  if (eni?.publicIp != null && port != null) {
    checks.push(simCheck(topo, `인터넷 → 이 인스턴스 (TCP ${port})`, { source: INTERNET, destination: { kind: "resource", resourceId: ec2.id, addressing: "public" }, protocol: "tcp", port }, `인터넷에서 퍼블릭 IP ${formatIpv4(eni.publicIp)}의 ${port} 포트로 접속할 수 있습니다.`, "securityGroups"));
  } else if (port != null) {
    checks.push({ tone: "info", title: "인터넷에서 직접 접근 불가", detail: "퍼블릭 IP가 없어 인터넷에서 직접 접속할 수 없습니다. ALB를 통하거나 같은 VPC 안에서만 접근합니다.", field: "publicIpMode" });
  } else {
    checks.push({ tone: "info", title: "가상 서비스 포트 없음", detail: "대기 중인 포트가 없어 어떤 요청에도 응답하지 않습니다.", field: "listenPorts" });
  }
  if (subnetId) {
    checks.push(simCheck(topo, "이 인스턴스 → 인터넷 (HTTPS 443)", { source: { kind: "resource", resourceId: ec2.id }, destination: INTERNET_HOST, protocol: "tcp", port: 443 }, "패키지 설치·외부 API 호출처럼 바깥으로 나가는 통신이 가능합니다.", "subnet"));
  }
  for (const db of topo.ofType("rds").filter((d) => topo.vpcOf(d.id) === topo.vpcOf(ec2.id)).slice(0, 2)) {
    checks.push(simCheck(topo, `이 인스턴스 → ${displayName(db)} (TCP ${db.config.port})`, { source: { kind: "resource", resourceId: ec2.id }, destination: { kind: "resource", resourceId: db.id }, protocol: "tcp", port: db.config.port }, "DB 포트까지 가상 네트워크 경로가 열려 있습니다 (SQL은 실행하지 않음).", "securityGroups"));
  }
  // NAT 인스턴스: 라우팅 테이블 경로의 대상이면 NAT로 동작할 조건을 확인한다
  const natUsage = natInstanceUsages(topo).find((u) => u.ec2.id === ec2.id);
  const NAT_FIELD = { state: "state", sourceDestCheck: "sourceDestCheck", userData: "userData", subnet: "subnet", publicIpMode: "publicIpMode" } as const;
  if (natUsage) {
    const nat = checkNatInstance(topo, ec2);
    if (nat.ok) {
      checks.push({
        tone: "ok",
        title: "NAT 인스턴스로 동작",
        detail: `프라이빗 서브넷 ${natUsage.subnetIds.length}개(${natUsage.subnetIds.map((id) => topo.name(id)).join(", ") || "없음"})가 이 인스턴스를 거쳐 인터넷으로 나갑니다.`,
        field: "sourceDestCheck",
      });
    } else {
      for (const p of nat.problems) checks.push({ tone: "error", title: "NAT 인스턴스로 동작하지 않음", detail: p.text, field: NAT_FIELD[p.field] });
    }
  } else if (ec2.config.sourceDestCheck === false) {
    checks.push({ tone: "info", title: "소스/대상 확인이 꺼져 있음", detail: "이 인스턴스를 가리키는 경로가 없습니다. NAT 인스턴스로 쓰지 않는다면 다시 켜 두는 것이 안전합니다.", field: "sourceDestCheck" });
  }
  const healthOf = (tgId: string) => input.health.get(tgId)?.find((h) => h.targetId === ec2.id);
  const toneOfHealth = (s?: string): AnalysisTone => (s === "healthy" ? "ok" : s === "unhealthy" ? "error" : "info");
  return {
    headline: { tone: running ? "ok" : "error", text: `${ec2.config.state} · ${ec2.config.instanceType} · ${subnetId ? SUBNET_KIND_TEXT[topo.classifySubnet(subnetId).kind] : "서브넷 없음"}${natUsage ? " · NAT 인스턴스" : ""}` },
    facts: [
      { label: "상태 (가상)", value: ec2.config.state, field: "state" },
      { label: "인스턴스 유형", value: ec2.config.instanceType, field: "instanceType" },
      { label: "사설 IPv4", value: ec2.config.privateIp, field: "privateIp" },
      { label: "퍼블릭 IPv4 (가상)", value: eni?.publicIp != null ? `${formatIpv4(eni.publicIp)}${eip ? " (탄력적 IP)" : ""}` : "없음", field: "publicIpMode" },
      { label: "가상 서비스 포트", value: ec2.config.listenPorts.join(", ") || "없음", field: "listenPorts" },
      { label: "가상 HTTP 응답 코드", value: String(ec2.config.httpResponseCode), field: "httpResponseCode" },
      { label: "소스/대상 확인", value: ec2.config.sourceDestCheck === false ? "중지됨" : "켜짐 (기본값)", field: "sourceDestCheck" },
    ],
    relations: [
      { label: "소속 VPC", explanation: "서브넷을 통해 정해집니다.", items: item(topo, vpc), missing: vpc ? undefined : "서브넷에 배치되지 않아 VPC가 없습니다.", field: "subnet" },
      { label: "배치된 서브넷", explanation: "퍼블릭/프라이빗 여부가 인터넷 접근 가능성을 정합니다.", items: subnetItem(topo, subnetId), missing: subnetId ? undefined : "서브넷이 없어 통신할 수 없습니다 (EC2-001).", field: "subnet" },
      { label: "적용되는 라우팅 테이블", explanation: "서브넷에 적용된 경로입니다.", items: subnetId ? routeTableItems(topo, subnetId) : [], empty: "적용되는 라우팅 테이블이 없습니다." },
      { label: "연결된 보안 그룹", explanation: "인바운드·아웃바운드 규칙의 합집합이 적용됩니다.", items: sgs.flatMap((g) => item(topo, g, `인바운드 ${g.config.inboundRules.length}개`)), missing: sgs.length ? undefined : "보안 그룹이 없습니다 (SEC-006).", field: "securityGroups" },
      { label: "대상 그룹 등록", explanation: "ALB가 이 인스턴스로 요청을 보내려면 등록되고 healthy여야 합니다.", items: tgs.flatMap((tg) => item(topo, tg, healthOf(tg.id) ? `상태 ${healthOf(tg.id)!.state} — ${healthOf(tg.id)!.reason}` : undefined, toneOfHealth(healthOf(tg.id)?.state))), empty: "어떤 대상 그룹에도 등록되지 않았습니다.", field: "targetGroups" },
      {
        label: "IAM 역할",
        explanation: "서버 안 프로그램이 액세스 키 없이 AWS를 호출할 때 쓰는 권한입니다.",
        items: role ? [{ service: { key: "iam", itemId: role.id, consolePath: `/iam/roles/${role.id}` }, name: role.name, detail: `권한 정책 ${role.policyIds.length}개` }] : [],
        empty: "연결된 IAM 역할이 없습니다 (심화 모드의 'IAM 역할 수정'에서 연결).",
        field: "iamRoleId",
      },
      alarmRelation(project, ec2.id, options, input, "인스턴스"),
      ...(natUsage
        ? [
            {
              label: "이 인스턴스로 향하는 경로 (NAT 인스턴스)",
              explanation: "이 라우팅 테이블을 쓰는 서브넷의 트래픽이 이 인스턴스로 옵니다.",
              items: natUsage.routeTableIds.flatMap((id) => item(topo, topo.get(id))),
              field: "sourceDestCheck",
            },
          ]
        : []),
    ],
    checks,
    recommendations: [
      ...(tgs.length && eni?.publicIp != null ? ["ALB 뒤의 인스턴스라면 퍼블릭 IP를 끄고 ALB를 통해서만 접근하게 하는 것이 안전합니다."] : []),
      ...(natUsage ? ["NAT 인스턴스 한 대가 멈추면 외부 통신이 모두 끊깁니다. 운영 환경이라면 NAT 게이트웨이(AWS 권장)를 고려하세요."] : []),
    ],
  };
}

function analyzeAlb(input: AnalysisInput, alb: ResourceOfType<"alb">, options: AnalysisOptions): Omit<ResourceAnalysis, "findings"> {
  const { topology: topo, project } = input;
  const subnets = topo.albSubnets(alb.id);
  const azs = new Set(subnets.map((s) => s.config.availabilityZone));
  const sgs = topo.securityGroupsOf(alb.id);
  const bindings = topo.listenersOf(alb.id);
  const checks: AnalysisCheck[] = [];
  if (alb.config.state !== "active") checks.push({ tone: "error", title: `상태: ${alb.config.state}`, detail: "active가 되어야 요청을 받습니다.", field: "state" });
  if (!bindings.length) checks.push({ tone: "error", title: "리스너 없음", detail: "리스너가 없어 어떤 요청도 받지 않습니다. ALB가 있다는 것만으로 요청이 성공하지 않습니다.", field: "listeners" });
  if (azs.size < 2) checks.push({ tone: "error", title: `가용 영역 ${azs.size}개`, detail: "ALB는 2개 이상 AZ의 서브넷이 필요합니다.", field: "subnets" });
  const tgIds = new Set<string>();
  for (const b of bindings) {
    if (b.targetGroupId) tgIds.add(b.targetGroupId);
    for (const r of b.listener.rules ?? []) if (r.action.type === "forward") tgIds.add(r.action.targetGroupId);
  }
  for (const tgId of tgIds) {
    const hs = input.health.get(tgId) ?? [];
    const healthy = hs.filter((h) => h.state === "healthy").length;
    const tg = topo.getOfType(tgId, "target-group");
    if (!tg) continue;
    checks.push(
      !hs.length
        ? { tone: "error", title: `${displayName(tg)}: 등록된 대상 없음`, detail: "이 대상 그룹으로 가는 요청은 503이 됩니다.", field: "defaultTargetGroup" }
        : healthy === 0
          ? { tone: "error", title: `${displayName(tg)}: 정상 대상 없음`, detail: `대상 ${hs.length}개가 모두 정상이 아닙니다: ${hs.map((h) => `${h.targetName}(${h.reason})`).join("; ")}`, field: "defaultTargetGroup" }
          : { tone: "ok", title: `${displayName(tg)}: 정상 대상 ${healthy}/${hs.length}`, detail: "정상 대상에 라운드 로빈으로 요청을 나눕니다." },
    );
  }
  const first = bindings[0];
  if (first && alb.config.scheme === "internet-facing") {
    checks.push(simCheck(topo, `인터넷 → 이 ALB (${first.listener.protocol}:${first.listener.port})`, { source: INTERNET, destination: { kind: "resource", resourceId: alb.id }, protocol: "tcp", port: first.listener.port, requestCount: 1 }, "요청이 리스너 → 대상 그룹 → 정상 대상까지 전달됩니다.", "listeners"));
  } else if (alb.config.scheme === "internal") {
    checks.push({ tone: "info", title: "internal ALB", detail: "VPC 안에서만 접근할 수 있어 인터넷 요청 시뮬레이션은 하지 않습니다.", field: "scheme" });
  }
  const listenerItems: LinkedItem[] = bindings.map((b) => {
    const tg = topo.getOfType(b.targetGroupId, "target-group");
    const rules = (b.listener.rules ?? []).length;
    return { resourceId: tg?.id, type: tg ? "target-group" : undefined, name: `${b.listener.protocol}:${b.listener.port}`, detail: `기본 → ${tg ? displayName(tg) : "대상 그룹 없음"}${rules ? ` · 규칙 ${rules}개` : ""}`, tone: tg ? "ok" : "error" };
  });
  const targets = [...tgIds].flatMap((tgId) => (input.health.get(tgId) ?? []).map((h) => ({ resourceId: h.targetId, type: "ec2" as const, name: h.targetName, detail: `${topo.name(tgId)} · ${h.state} — ${h.reason}`, tone: (h.state === "healthy" ? "ok" : h.state === "unhealthy" ? "error" : "info") as AnalysisTone })));
  return {
    headline: { tone: checks.some((c) => c.tone === "error") ? "error" : "ok", text: `${alb.config.scheme} · ${alb.config.state} · 리스너 ${bindings.length}개 · AZ ${azs.size}개` },
    facts: [
      { label: "체계", value: alb.config.scheme, field: "scheme" },
      { label: "상태", value: alb.config.state, field: "state" },
      { label: "가상 DNS 이름", value: topo.dnsName(alb.id) ?? "–" },
      ...bindings.map((b) => ({ label: `리스너 ${b.listener.protocol}:${b.listener.port}`, value: `기본 → ${b.targetGroupId ? topo.name(b.targetGroupId) : "없음"}${(b.listener.rules ?? []).length ? `, 규칙 ${(b.listener.rules ?? []).length}개` : ""}`, field: "listeners" })),
    ],
    relations: [
      { label: "리스너와 기본 작업", explanation: "요청 포트와 일치하는 리스너가 대상 그룹으로 전달합니다.", items: listenerItems, missing: bindings.length ? undefined : "리스너가 없습니다 (ELB-001).", field: "listeners" },
      { label: "ALB 노드 서브넷", explanation: "internet-facing이면 퍼블릭 서브넷, 2개 이상 AZ가 필요합니다.", items: subnets.flatMap((s) => subnetItem(topo, s.id)), missing: subnets.length ? undefined : "서브넷이 없습니다.", field: "subnets" },
      { label: "ALB 보안 그룹", explanation: "리스너 포트를 인바운드로 허용해야 합니다.", items: sgs.flatMap((g) => item(topo, g)), missing: sgs.length ? undefined : "보안 그룹이 없습니다.", field: "securityGroups" },
      { label: "대상 (등록된 EC2와 헬스 상태)", explanation: "정상(healthy) 대상에만 요청이 갑니다.", items: targets, empty: "등록된 대상이 없습니다.", field: "defaultTargetGroup" },
      alarmRelation(project, alb.id, options, input, "로드 밸런서"),
    ],
    checks,
    recommendations: [],
  };
}

function analyzeTargetGroup(input: AnalysisInput, tg: ResourceOfType<"target-group">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const hs = input.health.get(tg.id) ?? [];
  const albs = topo.targetGroupAlbs(tg.id);
  const vpc = topo.getOfType(topo.vpcOf(tg.id), "vpc");
  const healthy = hs.filter((h) => h.state === "healthy").length;
  const hc = tg.config.healthCheck;
  const checks: AnalysisCheck[] = [];
  if (!albs.length) checks.push({ tone: "warn", title: "ALB에 연결되지 않음", detail: "리스너 기본 작업이나 규칙이 이 대상 그룹을 가리키지 않아 헬스 체크도 하지 않습니다 (대상 상태 unused).", field: "targets" });
  if (!hs.length) checks.push({ tone: "error", title: "등록된 대상 없음", detail: "ALB가 이 대상 그룹으로 보내는 요청은 503이 됩니다.", field: "targets" });
  for (const h of hs.filter((x) => x.state !== "healthy")) checks.push({ tone: h.state === "unhealthy" ? "error" : "info", title: `${h.targetName}: ${h.state}`, detail: `${h.reasonCode ? `${h.reasonCode} — ` : ""}${h.reason}`, field: h.reasonCode.includes("ResponseCodeMismatch") ? "matcher" : "targets" });
  if (hs.length && healthy === hs.length) checks.push({ tone: "ok", title: `모든 대상 정상 (${healthy}/${hs.length})`, detail: "헬스 체크를 통과해 요청을 받을 수 있습니다." });
  return {
    headline: { tone: !hs.length || !healthy ? "error" : healthy < hs.length ? "warn" : "ok", text: `${tg.config.protocol}:${tg.config.port} · 정상 ${healthy}/${hs.length}` },
    facts: [
      { label: "프로토콜:포트", value: `${tg.config.protocol}:${tg.config.port}`, field: "port" },
      { label: "헬스 체크", value: `${hc.protocol} ${hc.port === "traffic-port" ? tg.config.port : hc.port} ${hc.path} → ${hc.matcher}`, field: "healthCheckPath" },
      { label: "임계값 / 간격", value: `정상 ${hc.healthyThreshold} · 비정상 ${hc.unhealthyThreshold} · ${hc.intervalSeconds}초 (제한 ${hc.timeoutSeconds}초)`, field: "intervalSeconds" },
    ],
    relations: [
      { label: "이 대상 그룹을 쓰는 ALB", explanation: "리스너 기본 작업 또는 리스너 규칙이 가리킵니다.", items: albs.flatMap((a) => item(topo, a)), missing: albs.length ? undefined : "어떤 ALB도 이 대상 그룹으로 요청을 보내지 않습니다 (ELB-013).", field: "targets" },
      { label: "등록된 대상", explanation: "상태와 그 이유입니다.", items: hs.map((h) => ({ resourceId: h.targetId, type: "ec2" as const, name: h.targetName, detail: `${h.state} — ${h.reason}`, tone: (h.state === "healthy" ? "ok" : h.state === "unhealthy" ? "error" : "info") as AnalysisTone })), missing: hs.length ? undefined : "등록된 대상이 없습니다 (ELB-003).", field: "targets" },
      { label: "VPC", explanation: "같은 VPC의 인스턴스만 등록할 수 있습니다.", items: item(topo, vpc), empty: "VPC가 정해지지 않았습니다.", field: "vpc" },
    ],
    checks,
    recommendations: [],
  };
}

function analyzeDbSubnetGroup(input: AnalysisInput, group: ResourceOfType<"db-subnet-group">): Omit<ResourceAnalysis, "findings"> {
  const topo = input.topology;
  const subnets = topo.dbSubnetGroupSubnets(group.id);
  const azs = new Set(subnets.map((s) => s.config.availabilityZone));
  const publicOnes = subnets.filter((s) => topo.classifySubnet(s.id).kind === "public");
  const users = topo.ofType("rds").filter((d) => topo.dbSubnetGroupOf(d.id)?.id === group.id);
  const checks: AnalysisCheck[] = [
    azs.size >= 2 ? { tone: "ok", title: `가용 영역 ${azs.size}개`, detail: "RDS를 만들 수 있고 Multi-AZ 대기 인스턴스를 둘 수 있습니다.", field: "subnets" } : { tone: "error", title: `가용 영역 ${azs.size}개`, detail: "2개 이상 AZ의 서브넷이 필요합니다.", field: "subnets" },
  ];
  if (publicOnes.length) checks.push({ tone: "warn", title: "퍼블릭 서브넷 포함", detail: `${publicOnes.map((s) => displayName(s)).join(", ")}은(는) 인터넷 경로가 있습니다. DB는 프라이빗 서브넷에 두는 것이 안전합니다.`, field: "subnets" });
  return {
    headline: { tone: azs.size >= 2 ? "ok" : "error", text: `서브넷 ${subnets.length}개 · AZ ${azs.size}개` },
    facts: [{ label: "설명", value: group.config.description || "–", field: "description" }],
    relations: [
      { label: "포함된 서브넷", explanation: "RDS가 배치될 수 있는 서브넷입니다.", items: subnets.flatMap((s) => subnetItem(topo, s.id)), missing: subnets.length ? undefined : "서브넷이 없습니다.", field: "subnets" },
      { label: "이 그룹을 쓰는 RDS", explanation: "DB 인스턴스의 배치 위치가 이 그룹에서 정해집니다.", items: users.flatMap((d) => item(topo, d, d.config.state)), empty: "사용하는 RDS가 없습니다." },
    ],
    checks,
    recommendations: [],
  };
}

function analyzeRds(input: AnalysisInput, rds: ResourceOfType<"rds">, options: AnalysisOptions): Omit<ResourceAnalysis, "findings"> {
  const { topology: topo, project } = input;
  const group = topo.dbSubnetGroupOf(rds.id);
  const placement = topo.rdsPlacement(rds.id);
  const sgs = topo.securityGroupsOf(rds.id);
  const vpcId = topo.vpcOf(rds.id);
  const apps = topo.ofType("ec2").filter((e) => e.config.state === "running" && topo.vpcOf(e.id) === vpcId);
  const checks: AnalysisCheck[] = [];
  if (rds.config.state !== "available") checks.push({ tone: "error", title: `상태: ${rds.config.state}`, detail: "available 상태에서만 연결을 받습니다.", field: "state" });
  for (const app of apps.slice(0, 3)) {
    checks.push(simCheck(topo, `${displayName(app)} → 이 DB (TCP ${rds.config.port})`, { source: { kind: "resource", resourceId: app.id }, destination: { kind: "resource", resourceId: rds.id }, protocol: "tcp", port: rds.config.port }, "애플리케이션에서 DB 포트까지 가상 네트워크 경로가 열려 있습니다 (SQL은 실행하지 않음).", "securityGroups"));
  }
  if (!apps.length) checks.push({ tone: "info", title: "같은 VPC에 실행 중인 애플리케이션 서버 없음", detail: "EC2를 만들면 DB 연결 가능 여부를 함께 분석합니다." });
  if (rds.config.publiclyAccessible) {
    const exposure = simulateWithTopology(topo, { source: INTERNET, destination: { kind: "resource", resourceId: rds.id, addressing: "public" }, protocol: "tcp", port: rds.config.port });
    checks.push(
      exposure.outcome === "success"
        ? { tone: "error", title: "인터넷에서 DB 포트에 접근 가능", detail: "Publicly Accessible이고 경로·보안 그룹이 열려 있어 인터넷에 노출됩니다.", field: "publiclyAccessible", request: exposure.request }
        : { tone: "warn", title: "Publicly Accessible이지만 인터넷에서 접근 불가", detail: exposure.failure?.reason ?? exposure.summary, field: "publiclyAccessible", request: exposure.request },
    );
  } else checks.push({ tone: "ok", title: "퍼블릭 액세스 꺼짐", detail: "인터넷에 DB 엔드포인트가 노출되지 않습니다." });
  return {
    headline: { tone: rds.config.state === "available" ? "ok" : "error", text: `${rds.config.engine} · ${rds.config.state} · ${rds.config.publiclyAccessible ? "퍼블릭" : "프라이빗"}${rds.config.multiAz ? " · Multi-AZ" : ""}` },
    facts: [
      { label: "엔진 / 포트", value: `${rds.config.engine} / ${rds.config.port}`, field: "engine" },
      { label: "인스턴스 클래스", value: rds.config.instanceClass, field: "instanceClass" },
      { label: "스토리지", value: `${rds.config.allocatedStorageGb} GB`, field: "allocatedStorageGb" },
      { label: "Publicly Accessible", value: rds.config.publiclyAccessible ? "예" : "아니요", field: "publiclyAccessible" },
      { label: "Multi-AZ", value: rds.config.multiAz ? "켜짐" : "꺼짐", field: "multiAz" },
      { label: "가상 엔드포인트", value: topo.dnsName(rds.id) ?? "–" },
    ],
    relations: [
      { label: "DB 서브넷 그룹", explanation: "DB를 놓을 서브넷 묶음입니다.", items: item(topo, group), missing: group ? undefined : "DB 서브넷 그룹이 없습니다 (RDS-001).", field: "dbSubnetGroup" },
      { label: "배치 서브넷", explanation: "기본 인스턴스와 Multi-AZ 대기 인스턴스가 놓인 서브넷입니다.", items: [...subnetItem(topo, placement.primary?.id ?? null).map((i) => ({ ...i, detail: `기본 · ${i.detail}` })), ...subnetItem(topo, placement.standby?.id ?? null).map((i) => ({ ...i, detail: `대기 · ${i.detail}` }))], empty: "배치된 서브넷이 없습니다." },
      { label: "DB 보안 그룹", explanation: "DB 포트에 누가 접근할 수 있는지 정합니다.", items: sgs.flatMap((g) => item(topo, g)), missing: sgs.length ? undefined : "보안 그룹이 없습니다.", field: "securityGroups" },
      { label: "같은 VPC의 애플리케이션 서버", explanation: "DB에 접속할 가능성이 있는 실행 중인 EC2입니다.", items: apps.flatMap((e) => item(topo, e)), empty: "없습니다." },
      alarmRelation(project, rds.id, options, input, "DB 인스턴스"),
    ],
    checks,
    recommendations: rds.config.multiAz ? [] : ["운영 DB라면 Multi-AZ로 다른 AZ에 대기 인스턴스를 두는 것을 고려하세요."],
  };
}

/** 리소스 하나의 현재 구성 분석. 리소스가 없으면 null */
export function analyzeResource(input: AnalysisInput, resourceId: string, options: AnalysisOptions = {}): ResourceAnalysis | null {
  const r = input.topology.get(resourceId);
  if (!r) return null;
  let base: Omit<ResourceAnalysis, "findings">;
  switch (r.type) {
    case "vpc":
      base = analyzeVpc(input, r);
      break;
    case "subnet":
      base = analyzeSubnet(input, r);
      break;
    case "internet-gateway":
      base = analyzeIgw(input, r);
      break;
    case "elastic-ip":
      base = analyzeEip(input, r);
      break;
    case "route-table":
      base = analyzeRouteTable(input, r);
      break;
    case "nat-gateway":
      base = analyzeNat(input, r);
      break;
    case "security-group":
      base = analyzeSecurityGroup(input, r);
      break;
    case "network-acl":
      base = analyzeNacl(input, r);
      break;
    case "ec2":
      base = analyzeEc2(input, r, options);
      break;
    case "alb":
      base = analyzeAlb(input, r, options);
      break;
    case "target-group":
      base = analyzeTargetGroup(input, r);
      break;
    case "db-subnet-group":
      base = analyzeDbSubnetGroup(input, r);
      break;
    case "rds":
      base = analyzeRds(input, r, options);
      break;
  }
  return { ...base, findings: input.findingsByResource.get(r.id) ?? [] };
}
