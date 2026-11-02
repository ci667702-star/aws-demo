/**
 * NAT 인스턴스: NAT 게이트웨이 대신 EC2 한 대가 프라이빗 서브넷의 아웃바운드 트래픽을 주소 변환해 내보낸다.
 * AWS 문서(VPC 사용 설명서 "Enable private resources to communicate outside the VPC")의 절차를 따른다.
 *   1) 퍼블릭 서브넷에 퍼블릭 IP(또는 탄력적 IP)를 가진 인스턴스를 둔다
 *   2) IP 포워딩을 켜고 iptables MASQUERADE를 설정한다 (문서는 NAT AMI를 만들어 시작하지만, 이 시뮬레이터는 같은 명령이 사용자 데이터에 있는지로 판단)
 *   3) 소스/대상 확인을 끈다
 *   4) 프라이빗 서브넷 라우팅 테이블에 0.0.0.0/0 → 인스턴스 경로를 넣는다
 *   5) 보안 그룹은 프라이빗 서브넷 CIDR에서 오는 HTTP·HTTPS를 허용하고, 밖으로 HTTP·HTTPS를 허용한다
 * 실제 운영체제와 iptables는 실행되지 않는다.
 */
import type { ConfigOf, ResourceOfType } from "./resource-models";
import type { Topology } from "./topology-engine";

/** AWS 문서의 Amazon Linux 2023 절차를 사용자 데이터 스크립트로 옮긴 것 (기본 인터페이스는 기본 경로에서 찾는다) */
const AL2023_NAT_SCRIPT = [
  "#!/bin/bash",
  "# NAT 인스턴스 설정 (AWS VPC 사용 설명서 'Create a NAT AMI' 절차)",
  "yum install -y iptables-services",
  "systemctl enable --now iptables",
  "# IP 포워딩을 켜고 재부팅 후에도 유지",
  'echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/custom-ip-forwarding.conf',
  "sysctl -p /etc/sysctl.d/custom-ip-forwarding.conf",
  "# 기본 네트워크 인터페이스(eth0, ens5, enX0 등)로 나가는 트래픽의 출발지 주소를 이 인스턴스 주소로 바꾼다",
  "IFACE=$(ip route show default | awk '{print $5}' | head -1)",
  "iptables -t nat -A POSTROUTING -o \"$IFACE\" -j MASQUERADE",
  "iptables -F FORWARD",
  "service iptables save",
].join("\n");

const UBUNTU_NAT_SCRIPT = [
  "#!/bin/bash",
  "# NAT 인스턴스 설정 (Ubuntu)",
  'echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/custom-ip-forwarding.conf',
  "sysctl -p /etc/sysctl.d/custom-ip-forwarding.conf",
  "IFACE=$(ip route show default | awk '{print $5}' | head -1)",
  "iptables -t nat -A POSTROUTING -o \"$IFACE\" -j MASQUERADE",
  "iptables -F FORWARD",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent",
  "netfilter-persistent save",
].join("\n");

/** NAT 설정 스크립트. Windows는 NAT 인스턴스로 쓰지 않으므로 null */
export function natInstanceScript(ami: ConfigOf<"ec2">["ami"]): string | null {
  if (ami === "windows-server-2022") return null;
  return ami === "ubuntu-24.04" ? UBUNTU_NAT_SCRIPT : AL2023_NAT_SCRIPT;
}

/** 사용자 데이터에 IP 포워딩과 MASQUERADE 설정이 모두 있으면 NAT 소프트웨어가 설정된 것으로 본다 */
export function hasNatSoftware(userData: string): boolean {
  return /MASQUERADE/.test(userData) && /ip_forward\s*=\s*1/.test(userData);
}

export interface NatInstanceCheck {
  ok: boolean;
  /** 사람이 읽는 문제 (없으면 빈 배열) */
  problems: { field: "state" | "sourceDestCheck" | "userData" | "publicIpMode" | "subnet"; text: string }[];
}

/** 인스턴스가 NAT 인스턴스로 동작할 수 있는지 (경로 대상일 때 확인한다) */
export function checkNatInstance(topo: Topology, ec2: ResourceOfType<"ec2">): NatInstanceCheck {
  const problems: NatInstanceCheck["problems"] = [];
  if (ec2.config.state !== "running") problems.push({ field: "state", text: `인스턴스가 ${ec2.config.state} 상태라 트래픽을 전달할 수 없습니다 (경로가 블랙홀이 됨).` });
  if (ec2.config.sourceDestCheck !== false) problems.push({ field: "sourceDestCheck", text: "소스/대상 확인이 켜져 있어 다른 리소스의 트래픽을 받으면 버립니다." });
  if (!hasNatSoftware(ec2.config.userData)) problems.push({ field: "userData", text: "인스턴스 안에 NAT 설정(IP 포워딩 + iptables MASQUERADE)이 없습니다." });
  const subnetId = topo.subnetOf(ec2.id);
  if (!subnetId || topo.classifySubnet(subnetId).kind !== "public") problems.push({ field: "subnet", text: "인스턴스가 인터넷 게이트웨이 경로가 있는 퍼블릭 서브넷에 있지 않습니다." });
  if (topo.enisOf(ec2.id)[0]?.publicIp == null && ec2.config.state === "running") problems.push({ field: "publicIpMode", text: "퍼블릭 IP(또는 탄력적 IP)가 없어 인터넷으로 나갈 주소가 없습니다." });
  return { ok: problems.length === 0, problems };
}

/** 이 인스턴스를 대상으로 하는 경로가 있는지 (NAT 인스턴스로 쓰이는지) */
export function isNatInstanceTarget(topo: Topology, ec2Id: string): boolean {
  return topo.incoming(ec2Id, "route-table-ec2").length > 0;
}

export interface NatInstanceUsage {
  ec2: ResourceOfType<"ec2">;
  /** 이 인스턴스를 경로 대상으로 쓰는 라우팅 테이블 */
  routeTableIds: string[];
  /** "private-rt의 0.0.0.0/0" 형태의 경로 설명 */
  routeLabels: string[];
  /** 그 라우팅 테이블을 쓰는 서브넷 (명시적 연결 + 기본 테이블) */
  subnetIds: string[];
}

/** 라우팅 테이블 경로의 대상이 된 인스턴스(= NAT 인스턴스로 쓰는 EC2)와 그 경로를 쓰는 서브넷 */
export function natInstanceUsages(topo: Topology): NatInstanceUsage[] {
  const byEc2 = new Map<string, NatInstanceUsage>();
  for (const c of topo.connections) {
    if (c.relationType !== "route-table-ec2") continue;
    const ec2 = topo.getOfType(c.targetResourceId, "ec2");
    if (!ec2) continue;
    const usage = byEc2.get(ec2.id) ?? { ec2, routeTableIds: [], routeLabels: [], subnetIds: [] };
    if (!usage.routeTableIds.includes(c.sourceResourceId)) usage.routeTableIds.push(c.sourceResourceId);
    usage.routeLabels.push(`${topo.name(c.sourceResourceId)}의 ${c.metadata.destinationCidr}`);
    byEc2.set(ec2.id, usage);
  }
  for (const usage of byEc2.values()) {
    for (const s of topo.ofType("subnet")) {
      const ref = topo.routeTableRefFor(s.id);
      if ((ref.kind === "explicit" || ref.kind === "main") && usage.routeTableIds.includes(ref.routeTableId)) usage.subnetIds.push(s.id);
    }
  }
  return [...byEc2.values()];
}
