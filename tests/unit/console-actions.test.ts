import { beforeEach, describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/connectivity-engine";
import type { Project, ResourceType } from "@/lib/engine/resource-models";
import { validateProject } from "@/lib/engine/validation-engine";
import * as aws from "@/lib/project/console-actions";
import { createEmptyProject, DEFAULT_HEALTH_CHECK, NACL, SG } from "@/lib/project/factory";
import { advanceLifecycle, pendingTransitions, settleLifecycle } from "@/lib/project/lifecycle";
import { internet, res, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

/** 성공한 결과에서 프로젝트와 생성된 ID를 꺼낸다 */
function must(result: aws.ActionResult): { project: Project; id: string } {
  if (!result.ok) throw new Error(`동작 실패: ${result.error}`);
  return { project: result.project, id: result.createdId ?? "" };
}

function errorOf(result: aws.ActionResult): string {
  if (result.ok) throw new Error("실패해야 하는 동작이 성공했습니다.");
  return result.error;
}

function count(project: Project, type: ResourceType) {
  return project.resources.filter((r) => r.type === type).length;
}

const empty = () => createEmptyProject("콘솔 테스트");

/** 콘솔 동작만으로 VPC + 퍼블릭 서브넷 + IGW + 퍼블릭 라우팅 테이블을 만든다 */
function publicNetwork() {
  const vpc = must(aws.createVpc(empty(), { name: "lab-vpc", cidr: "10.0.0.0/16" }));
  const vpcId = vpc.id;
  let p = vpc.project;
  const subnetA = must(aws.createSubnet(p, { vpcId, name: "public-a", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" }));
  p = subnetA.project;
  const subnetC = must(aws.createSubnet(p, { vpcId, name: "public-c", availabilityZone: "ap-northeast-2c", cidr: "10.0.2.0/24" }));
  p = subnetC.project;
  const igw = must(aws.createInternetGateway(p, { name: "lab-igw" }));
  p = must(aws.attachInternetGateway(igw.project, igw.id, vpcId)).project;
  const rt = must(aws.createRouteTable(p, { vpcId, name: "public-rt" }));
  p = must(aws.editRoutes(rt.project, rt.id, [{ destination: "0.0.0.0/0", targetId: igw.id }])).project;
  p = must(aws.editRouteTableAssociations(p, rt.id, [subnetA.id, subnetC.id])).project;
  return { project: p, vpcId, subnetA: subnetA.id, subnetC: subnetC.id, igwId: igw.id, rtId: rt.id };
}

function webSg(p: Project, vpcId: string, name = "web-sg") {
  return must(
    aws.createSecurityGroup(p, {
      name,
      description: "web server",
      vpcId,
      inboundRules: [SG.tcp(80, "0.0.0.0/0", "HTTP")],
      outboundRules: [SG.all("0.0.0.0/0")],
    }),
  );
}

function launch(p: Project, subnetId: string, sgIds: string[], extra: Partial<aws.LaunchInstancesInput> = {}) {
  const userData = aws.userDataFor("amazon-linux-2023", "web-server");
  return aws.launchInstances(p, {
    name: "web",
    ami: "amazon-linux-2023",
    instanceType: "t3.micro",
    subnetId,
    publicIpMode: "enabled",
    securityGroupIds: sgIds,
    listenPorts: userData.listenPorts,
    httpResponseCode: 200,
    userData: userData.script,
    count: 1,
    ...extra,
  });
}

describe("VPC 생성", () => {
  it("AWS처럼 기본 라우팅 테이블·네트워크 ACL·보안 그룹을 함께 만든다 (그 외 설정은 하지 않는다)", () => {
    const { project, id } = must(aws.createVpc(empty(), { name: "my-vpc", cidr: "10.0.0.0/16" }));
    expect(id).toMatch(/^vpc-/);
    expect(count(project, "vpc")).toBe(1);
    expect(count(project, "route-table")).toBe(1);
    expect(count(project, "network-acl")).toBe(1);
    expect(count(project, "security-group")).toBe(1);
    expect(count(project, "subnet")).toBe(0);
    expect(count(project, "internet-gateway")).toBe(0);
    const rt = project.resources.find((r) => r.type === "route-table");
    expect(rt?.type === "route-table" && rt.config.main).toBe(true);
    const sg = project.resources.find((r) => r.type === "security-group");
    expect(sg?.type === "security-group" && sg.config.isDefault).toBe(true);
    expect(sg?.name).toBe("default");
    const vpc = project.resources.find((r) => r.type === "vpc");
    expect(vpc?.type === "vpc" && vpc.config).toMatchObject({ cidr: "10.0.0.0/16", enableDnsSupport: true, enableDnsHostnames: false });
  });

  it("잘못된 CIDR이나 허용 범위를 벗어난 크기는 거부한다", () => {
    expect(errorOf(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/33" }))).toContain("[InvalidParameterValue]");
    expect(errorOf(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/8" }))).toContain("[InvalidVpc.Range]");
    expect(errorOf(aws.createVpc(empty(), { name: "", cidr: "" }))).toContain("[InvalidParameterValue]");
  });

  it("기본 VPC 생성은 사용자가 선택할 때만, 리전당 하나만 만들어지며 바로 퍼블릭 인스턴스를 띄울 수 있다", () => {
    const { project, id } = must(aws.createDefaultVpc(empty()));
    const vpc = project.resources.find((r) => r.id === id);
    expect(vpc?.type === "vpc" && vpc.config).toMatchObject({ cidr: "172.31.0.0/16", isDefault: true, enableDnsHostnames: true });
    const subnets = project.resources.filter((r) => r.type === "subnet");
    expect(subnets.map((s) => (s.type === "subnet" ? s.config.cidr : ""))).toEqual(["172.31.0.0/20", "172.31.16.0/20", "172.31.32.0/20", "172.31.48.0/20"]);
    expect(subnets.every((s) => s.type === "subnet" && s.config.mapPublicIpOnLaunch)).toBe(true);
    expect(errorOf(aws.createDefaultVpc(project))).toContain("[DefaultVpcAlreadyExists]");
    const defaultSg = project.resources.find((r) => r.type === "security-group")!;
    const web = must(aws.editSecurityGroupRules(project, defaultSg.id, "inbound", [SG.tcp(80, "0.0.0.0/0")])).project;
    const launched = must(launch(web, subnets[0].id, [defaultSg.id], { publicIpMode: "subnet-default" }));
    const result = simulate(settleLifecycle(launched.project), { source: internet(), destination: res(launched.id), protocol: "tcp", port: 80 });
    expect(result.outcome).toBe("success");
  });

  it("DNS 호스트 이름은 DNS 확인 없이 켤 수 없다", () => {
    const { project, id } = must(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/16" }));
    expect(errorOf(aws.editVpcSettings(project, id, { enableDnsSupport: false, enableDnsHostnames: true }))).toContain("InvalidParameterCombination");
    const next = must(aws.editVpcSettings(project, id, { enableDnsSupport: true, enableDnsHostnames: true })).project;
    const vpc = next.resources.find((r) => r.id === id);
    expect(vpc?.type === "vpc" && vpc.config.enableDnsHostnames).toBe(true);
  });
});

describe("서브넷", () => {
  it("VPC 범위 밖, 겹치는 CIDR, 없는 가용 영역을 거부한다", () => {
    const { project, id: vpcId } = must(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/16" }));
    expect(errorOf(aws.createSubnet(project, { vpcId, name: "", availabilityZone: null, cidr: "10.1.0.0/24" }))).toContain("[InvalidSubnet.Range]");
    expect(errorOf(aws.createSubnet(project, { vpcId, name: "", availabilityZone: null, cidr: "10.0.0.0/29" }))).toContain("[InvalidSubnet.Range]");
    const first = must(aws.createSubnet(project, { vpcId, name: "a", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" })).project;
    expect(errorOf(aws.createSubnet(first, { vpcId, name: "b", availabilityZone: null, cidr: "10.0.1.128/25" }))).toContain("[InvalidSubnet.Conflict]");
    expect(errorOf(aws.createSubnet(first, { vpcId, name: "b", availabilityZone: "us-east-1a", cidr: "10.0.2.0/24" }))).toContain("InvalidParameterValue");
  });

  it("가용 영역을 지정하지 않으면 서브넷이 가장 적은 영역을 고르고 기본 NACL과 연결한다", () => {
    const vpc = must(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/16" }));
    const vpcId = vpc.id;
    const p = must(aws.createSubnet(vpc.project, { vpcId, name: "a", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" })).project;
    const { project, id } = must(aws.createSubnet(p, { vpcId, name: "b", availabilityZone: null, cidr: "10.0.2.0/24" }));
    const subnet = project.resources.find((r) => r.id === id);
    expect(subnet?.type === "subnet" && subnet.config.availabilityZone).not.toBe("ap-northeast-2a");
    expect(subnet?.type === "subnet" && subnet.config.mapPublicIpOnLaunch).toBe(false);
    const nacl = project.resources.find((r) => r.type === "network-acl")!;
    expect(project.connections.some((c) => c.relationType === "network-acl-subnet" && c.sourceResourceId === nacl.id && c.targetResourceId === id)).toBe(true);
  });

  it("인스턴스가 있는 서브넷은 삭제할 수 없다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    expect(errorOf(aws.deleteSubnet(launched.project, net.subnetA))).toContain("[DependencyViolation]");
    const terminated = must(aws.changeInstanceState(launched.project, launched.id, "terminate")).project;
    expect(aws.deleteSubnet(terminated, net.subnetA).ok).toBe(true);
  });
});

describe("인터넷 게이트웨이와 라우팅", () => {
  it("IGW는 VPC당 하나만 연결되고, 연결된 IGW는 삭제할 수 없다", () => {
    const net = publicNetwork();
    expect(errorOf(aws.attachInternetGateway(net.project, net.igwId, net.vpcId))).toContain("[Resource.AlreadyAssociated]");
    const second = must(aws.createInternetGateway(net.project, { name: "igw-2" }));
    expect(errorOf(aws.attachInternetGateway(second.project, second.id, net.vpcId))).toContain("[Resource.AlreadyAssociated]");
    expect(errorOf(aws.deleteInternetGateway(net.project, net.igwId))).toContain("[DependencyViolation]");
  });

  it("퍼블릭 주소가 매핑되어 있으면 IGW를 분리할 수 없다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = settleLifecycle(must(launch(sg.project, net.subnetA, [sg.id])).project);
    expect(errorOf(aws.detachInternetGateway(launched, net.igwId))).toContain("[DependencyViolation]");
    const detached = must(aws.detachInternetGateway(net.project, net.igwId)).project;
    expect(aws.deleteInternetGateway(detached, net.igwId).ok).toBe(true);
  });

  it("경로 편집은 대상, 중복, local 범위를 검사한다", () => {
    const net = publicNetwork();
    const other = must(aws.createInternetGateway(net.project, { name: "detached" }));
    expect(errorOf(aws.editRoutes(other.project, net.rtId, [{ destination: "0.0.0.0/0", targetId: other.id }]))).toContain("연결되어 있지 않습니다");
    expect(
      errorOf(
        aws.editRoutes(net.project, net.rtId, [
          { destination: "0.0.0.0/0", targetId: net.igwId },
          { destination: "0.0.0.0/0", targetId: net.igwId },
        ]),
      ),
    ).toContain("[RouteAlreadyExists]");
    expect(errorOf(aws.editRoutes(net.project, net.rtId, [{ destination: "10.0.0.0/16", targetId: net.igwId }]))).toContain("local");
    expect(errorOf(aws.editRoutes(net.project, net.rtId, [{ destination: "0.0.0.0/0", targetId: "" }]))).toContain("대상 리소스를 선택");
    expect(errorOf(aws.editRoutes(net.project, net.rtId, [{ destination: "abc", targetId: net.igwId }]))).toContain("[InvalidParameterValue]");
    const cleared = must(aws.editRoutes(net.project, net.rtId, [])).project;
    expect(cleared.connections.some((c) => c.relationType === "route-table-internet-gateway")).toBe(false);
  });

  it("기본 라우팅 테이블과 서브넷이 연결된 테이블은 삭제할 수 없다", () => {
    const net = publicNetwork();
    const main = net.project.resources.find((r) => r.type === "route-table" && r.config.main)!;
    expect(errorOf(aws.deleteRouteTable(net.project, main.id))).toContain("[DependencyViolation]");
    expect(errorOf(aws.deleteRouteTable(net.project, net.rtId))).toContain("[DependencyViolation]");
    const released = must(aws.editRouteTableAssociations(net.project, net.rtId, [])).project;
    expect(aws.deleteRouteTable(released, net.rtId).ok).toBe(true);
  });

  it("서브넷 연결을 다른 테이블로 옮기면 기존 연결이 바뀐다", () => {
    const net = publicNetwork();
    const rt2 = must(aws.createRouteTable(net.project, { vpcId: net.vpcId, name: "rt-2" }));
    const moved = must(aws.replaceSubnetRouteTable(rt2.project, net.subnetA, rt2.id)).project;
    const assoc = moved.connections.filter((c) => c.relationType === "route-table-subnet" && c.targetResourceId === net.subnetA);
    expect(assoc).toHaveLength(1);
    expect(assoc[0].sourceResourceId).toBe(rt2.id);
    const toMain = must(aws.replaceSubnetRouteTable(moved, net.subnetA, null)).project;
    expect(toMain.connections.some((c) => c.relationType === "route-table-subnet" && c.targetResourceId === net.subnetA)).toBe(false);
  });
});

describe("탄력적 IP와 NAT 게이트웨이", () => {
  it("가상 주소를 할당하고, 연결된 주소는 릴리스할 수 없다", () => {
    const net = publicNetwork();
    const eip = must(aws.allocateElasticIp(net.project, { name: "web-eip" }));
    const r = eip.project.resources.find((x) => x.id === eip.id);
    expect(r?.type === "elastic-ip" && r.config.publicIp).toMatch(/^198\.51\.100\./);
    const sg = webSg(eip.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id], { publicIpMode: "disabled" }));
    const associated = must(aws.associateElasticIp(launched.project, eip.id, launched.id)).project;
    expect(errorOf(aws.associateElasticIp(associated, eip.id, launched.id))).toContain("[Resource.AlreadyAssociated]");
    expect(errorOf(aws.releaseElasticIp(associated, eip.id))).toContain("[InvalidIPAddress.InUse]");
    const result = simulate(settleLifecycle(associated), { source: internet(), destination: res(launched.id), protocol: "tcp", port: 80 });
    expect(result.outcome).toBe("success");
    const freed = must(aws.disassociateElasticIp(associated, eip.id)).project;
    expect(aws.releaseElasticIp(freed, eip.id).ok).toBe(true);
  });

  it("NAT 게이트웨이는 IGW와 연결되지 않은 탄력적 IP가 필요하고 Pending 상태로 시작한다", () => {
    const vpc = must(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/16" }));
    const vpcId = vpc.id;
    let p = vpc.project;
    const subnet = must(aws.createSubnet(p, { vpcId, name: "", availabilityZone: "ap-northeast-2a", cidr: "10.0.1.0/24" }));
    const eip = must(aws.allocateElasticIp(subnet.project, { name: "" }));
    p = eip.project;
    expect(errorOf(aws.createNatGateway(p, { name: "nat", subnetId: subnet.id, eipId: eip.id }))).toContain("[Gateway.NotAttached]");
    expect(errorOf(aws.createNatGateway(p, { name: "nat", subnetId: subnet.id, eipId: "" }))).toContain("[MissingParameter]");
    const igw = must(aws.createInternetGateway(p, { name: "" }));
    p = must(aws.attachInternetGateway(igw.project, igw.id, vpcId)).project;
    const nat = must(aws.createNatGateway(p, { name: "nat", subnetId: subnet.id, eipId: eip.id }));
    const r = nat.project.resources.find((x) => x.id === nat.id);
    expect(r?.type === "nat-gateway" && r.config.state).toBe("pending");
    expect(errorOf(aws.createNatGateway(nat.project, { name: "nat-2", subnetId: subnet.id, eipId: eip.id }))).toContain("[Resource.AlreadyAssociated]");
    expect(errorOf(aws.disassociateElasticIp(nat.project, eip.id))).toContain("[InvalidIPAddress.InUse]");
    const deleted = must(aws.deleteNatGateway(nat.project, nat.id)).project;
    expect(aws.releaseElasticIp(deleted, eip.id).ok).toBe(true);
  });
});

describe("보안 그룹", () => {
  it("이름·설명·중복 규칙을 AWS처럼 검사한다", () => {
    const { project, id: vpcId } = must(aws.createVpc(empty(), { name: "", cidr: "10.0.0.0/16" }));
    const base = { description: "d", vpcId, inboundRules: [], outboundRules: [] };
    expect(errorOf(aws.createSecurityGroup(project, { ...base, name: "" }))).toContain("[MissingParameter]");
    expect(errorOf(aws.createSecurityGroup(project, { ...base, name: "default" }))).toContain("[InvalidParameterValue]");
    expect(errorOf(aws.createSecurityGroup(project, { ...base, name: "sg-web" }))).toContain("[InvalidParameterValue]");
    expect(errorOf(aws.createSecurityGroup(project, { ...base, name: "web", description: " " }))).toContain("[MissingParameter]");
    expect(
      errorOf(aws.createSecurityGroup(project, { ...base, name: "web", inboundRules: [SG.tcp(80, "0.0.0.0/0"), SG.tcp(80, "0.0.0.0/0", "again")] })),
    ).toContain("[InvalidPermission.Duplicate]");
    const created = must(aws.createSecurityGroup(project, { ...base, name: "web" }));
    expect(errorOf(aws.createSecurityGroup(created.project, { ...base, name: "web" }))).toContain("[InvalidGroup.Duplicate]");
  });

  it("다른 보안 그룹을 참조하는 규칙은 같은 VPC의 그룹만 허용한다", () => {
    const a = must(aws.createVpc(empty(), { name: "a", cidr: "10.0.0.0/16" }));
    const vpcA = a.id;
    let p = a.project;
    const b = must(aws.createVpc(p, { name: "b", cidr: "10.1.0.0/16" }));
    const sgB = must(aws.createSecurityGroup(b.project, { name: "b-sg", description: "d", vpcId: b.id, inboundRules: [], outboundRules: [] }));
    p = sgB.project;
    expect(
      errorOf(aws.createSecurityGroup(p, { name: "a-sg", description: "d", vpcId: vpcA, inboundRules: [SG.tcp(80, { sg: sgB.id })], outboundRules: [] })),
    ).toContain("다른 VPC");
  });

  it("기본 보안 그룹, 사용 중이거나 참조되는 보안 그룹은 삭제할 수 없다", () => {
    const net = publicNetwork();
    const defaultSg = net.project.resources.find((r) => r.type === "security-group" && r.config.isDefault)!;
    expect(errorOf(aws.deleteSecurityGroup(net.project, defaultSg.id))).toContain("[CannotDelete]");
    const web = webSg(net.project, net.vpcId);
    const db = must(
      aws.createSecurityGroup(web.project, { name: "db", description: "db", vpcId: net.vpcId, inboundRules: [SG.tcp(3306, { sg: web.id })], outboundRules: [] }),
    );
    expect(errorOf(aws.deleteSecurityGroup(db.project, web.id))).toContain("참조");
    const launched = must(launch(db.project, net.subnetA, [db.id]));
    expect(errorOf(aws.deleteSecurityGroup(launched.project, db.id))).toContain("[DependencyViolation]");
    expect(aws.editSecurityGroupRules(launched.project, db.id, "inbound", []).ok).toBe(true);
  });
});

describe("네트워크 ACL", () => {
  it("새 NACL은 규칙이 없고, 연결을 옮기거나 해제하면 기본 NACL로 돌아간다", () => {
    const net = publicNetwork();
    const nacl = must(aws.createNetworkAcl(net.project, { name: "strict", vpcId: net.vpcId }));
    const created = nacl.project.resources.find((r) => r.id === nacl.id);
    expect(created?.type === "network-acl" && created.config.inboundRules).toEqual([]);
    const moved = must(aws.editNetworkAclAssociations(nacl.project, nacl.id, [net.subnetA])).project;
    const owner = (p: Project, subnetId: string) =>
      p.connections.filter((c) => c.relationType === "network-acl-subnet" && c.targetResourceId === subnetId).map((c) => c.sourceResourceId);
    expect(owner(moved, net.subnetA)).toEqual([nacl.id]);
    expect(errorOf(aws.deleteNetworkAcl(moved, nacl.id))).toContain("[DependencyViolation]");
    const back = must(aws.editNetworkAclAssociations(moved, nacl.id, [])).project;
    const defaultNacl = back.resources.find((r) => r.type === "network-acl" && r.config.isDefault)!;
    expect(owner(back, net.subnetA)).toEqual([defaultNacl.id]);
    expect(aws.deleteNetworkAcl(back, nacl.id).ok).toBe(true);
    expect(errorOf(aws.deleteNetworkAcl(back, defaultNacl.id))).toContain("기본 네트워크 ACL");
  });

  it("규칙 번호 중복과 범위를 검사한다", () => {
    const net = publicNetwork();
    const nacl = must(aws.createNetworkAcl(net.project, { name: "", vpcId: net.vpcId }));
    expect(
      errorOf(aws.editNetworkAclRules(nacl.project, nacl.id, "inbound", [NACL.allow(100, "tcp", [80, 80], "0.0.0.0/0"), NACL.deny(100, "all", null, "0.0.0.0/0")])),
    ).toContain("[NetworkAclEntryAlreadyExists]");
    expect(errorOf(aws.editNetworkAclRules(nacl.project, nacl.id, "inbound", [NACL.allow(40000, "all", null, "0.0.0.0/0")]))).toContain("1~32766");
  });
});

describe("EC2 인스턴스", () => {
  it("보안 그룹이 없거나 다른 VPC의 보안 그룹이면 시작할 수 없다", () => {
    const net = publicNetwork();
    expect(errorOf(launch(net.project, net.subnetA, []))).toContain("[MissingParameter]");
    const other = must(aws.createVpc(net.project, { name: "other", cidr: "10.9.0.0/16" }));
    const foreign = must(aws.createSecurityGroup(other.project, { name: "x", description: "x", vpcId: other.id, inboundRules: [], outboundRules: [] }));
    expect(errorOf(launch(foreign.project, net.subnetA, [foreign.id]))).toContain("[InvalidParameter]");
  });

  it("기본 IP는 서브넷 범위·AWS 예약 주소·사용 중 여부를 검사하고, 비우면 자동 할당한다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    expect(errorOf(launch(sg.project, net.subnetA, [sg.id], { privateIp: "10.0.9.10" }))).toContain("범위");
    expect(errorOf(launch(sg.project, net.subnetA, [sg.id], { privateIp: "10.0.1.1" }))).toContain("예약");
    expect(errorOf(launch(sg.project, net.subnetA, [sg.id], { privateIp: "10.0.1.255" }))).toContain("예약");
    const first = must(launch(sg.project, net.subnetA, [sg.id], { privateIp: "10.0.1.20" }));
    expect(errorOf(launch(first.project, net.subnetA, [sg.id], { privateIp: "10.0.1.20" }))).toContain("[InvalidIPAddress.InUse]");
    const auto = must(launch(first.project, net.subnetA, [sg.id], { count: 2 }));
    const ips = auto.project.resources.filter((r) => r.type === "ec2").map((r) => (r.type === "ec2" ? r.config.privateIp : ""));
    expect(new Set(ips).size).toBe(3);
    expect(ips.every((ip) => ip.startsWith("10.0.1."))).toBe(true);
    expect(errorOf(launch(sg.project, net.subnetA, [sg.id], { privateIp: "10.0.1.30", count: 2 }))).toContain("[InvalidParameterCombination]");
  });

  it("Pending 상태에서는 통신이 실패하고, Running이 되면 인터넷에서 웹 서버에 접속된다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    const request = { source: internet(), destination: res(launched.id), protocol: "tcp" as const, port: 80 };
    expect(simulate(launched.project, request).outcome).not.toBe("success");
    expect(pendingTransitions(launched.project)).toEqual([expect.objectContaining({ resourceId: launched.id, from: "pending", to: "running" })]);
    const running = settleLifecycle(launched.project);
    expect(simulate(running, request).outcome).toBe("success");
    expect(validateProject(running).findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("사용자 데이터 없이 시작한 인스턴스는 80 포트에 응답하지 않는다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const plain = aws.userDataFor("amazon-linux-2023", "none");
    const launched = must(launch(sg.project, net.subnetA, [sg.id], { listenPorts: plain.listenPorts, userData: "" }));
    const result = simulate(settleLifecycle(launched.project), { source: internet(), destination: res(launched.id), protocol: "tcp", port: 80 });
    expect(result.outcome).toBe("failure");
  });

  it("상태 전환 규칙과 사용자 데이터 편집 조건을 지킨다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    let p = settleLifecycle(launched.project);
    expect(errorOf(aws.changeInstanceState(p, launched.id, "start"))).toContain("[IncorrectInstanceState]");
    expect(errorOf(aws.editInstanceUserData(p, launched.id, { listenPorts: [22, 8080], httpResponseCode: 200, userData: "" }))).toContain("[IncorrectInstanceState]");
    p = must(aws.changeInstanceState(p, launched.id, "stop")).project;
    p = must(aws.editInstanceUserData(p, launched.id, { listenPorts: [8080, 22, 8080], httpResponseCode: 200, userData: "#!/bin/bash" })).project;
    const ec2 = p.resources.find((r) => r.id === launched.id);
    expect(ec2?.type === "ec2" && ec2.config.listenPorts).toEqual([22, 8080]);
    p = must(aws.changeInstanceState(p, launched.id, "start")).project;
    expect(pendingTransitions(p)).toHaveLength(1);
    p = must(aws.changeInstanceState(p, launched.id, "terminate")).project;
    expect(errorOf(aws.changeInstanceState(p, launched.id, "start"))).toContain("[IncorrectInstanceState]");
  });

  it("종료하면 대상 그룹에서 등록 해제되고 탄력적 IP 연결이 풀린다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    const eip = must(aws.allocateElasticIp(launched.project, { name: "" }));
    let p = must(aws.associateElasticIp(eip.project, eip.id, launched.id)).project;
    const tg = must(aws.createTargetGroup(p, { name: "web-tg", protocol: "HTTP", port: 80, vpcId: net.vpcId, healthCheck: defaultHealthCheck(), targetIds: [launched.id] }));
    p = must(aws.changeInstanceState(tg.project, launched.id, "terminate")).project;
    expect(p.connections.some((c) => c.relationType === "target-group-ec2" || c.relationType === "elastic-ip-ec2")).toBe(false);
    expect(p.resources.some((r) => r.id === eip.id)).toBe(true);
  });
});

function defaultHealthCheck() {
  return { ...DEFAULT_HEALTH_CHECK };
}

describe("로드 밸런서와 대상 그룹", () => {
  function albSetup() {
    const net = publicNetwork();
    const albSg = webSg(net.project, net.vpcId, "alb-sg");
    const appSg = must(
      aws.createSecurityGroup(albSg.project, { name: "app-sg", description: "app", vpcId: net.vpcId, inboundRules: [SG.tcp(80, { sg: albSg.id })], outboundRules: [SG.all("0.0.0.0/0")] }),
    );
    const a = must(launch(appSg.project, net.subnetA, [appSg.id], { publicIpMode: "disabled" }));
    const c = must(launch(a.project, net.subnetC, [appSg.id], { publicIpMode: "disabled" }));
    return { ...net, project: c.project, albSg: albSg.id, appSg: appSg.id, instances: [a.id, c.id] };
  }

  it("대상 그룹 이름 규칙과 대상 VPC를 검사한다", () => {
    const s = albSetup();
    const input = { protocol: "HTTP" as const, port: 80, vpcId: s.vpcId, healthCheck: defaultHealthCheck(), targetIds: s.instances };
    expect(errorOf(aws.createTargetGroup(s.project, { ...input, name: "-bad" }))).toContain("[ValidationError]");
    expect(errorOf(aws.createTargetGroup(s.project, { ...input, name: "web_tg" }))).toContain("[ValidationError]");
    const tg = must(aws.createTargetGroup(s.project, { ...input, name: "web-tg" }));
    expect(errorOf(aws.createTargetGroup(tg.project, { ...input, name: "web-tg" }))).toContain("[DuplicateTargetGroupName]");
    expect(tg.project.connections.filter((c) => c.relationType === "target-group-ec2")).toHaveLength(2);
    const dereg = must(aws.deregisterTargets(tg.project, tg.id, [s.instances[0]])).project;
    expect(dereg.connections.filter((c) => c.relationType === "target-group-ec2")).toHaveLength(1);
  });

  it("ALB는 서로 다른 AZ 2개 이상, IGW(internet-facing), 리스너가 필요하다", () => {
    const s = albSetup();
    const tg = must(aws.createTargetGroup(s.project, { name: "web-tg", protocol: "HTTP", port: 80, vpcId: s.vpcId, healthCheck: defaultHealthCheck(), targetIds: s.instances }));
    const input: aws.CreateLoadBalancerInput = {
      name: "web-alb",
      scheme: "internet-facing",
      vpcId: s.vpcId,
      subnetIds: [s.subnetA, s.subnetC],
      securityGroupIds: [s.albSg],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    };
    expect(errorOf(aws.createLoadBalancer(tg.project, { ...input, subnetIds: [s.subnetA] }))).toContain("2개 이상");
    expect(errorOf(aws.createLoadBalancer(tg.project, { ...input, securityGroupIds: [] }))).toContain("보안 그룹");
    expect(errorOf(aws.createLoadBalancer(tg.project, { ...input, listeners: [] }))).toContain("리스너");
    expect(errorOf(aws.createLoadBalancer(tg.project, { ...input, name: "internal-web" }))).toContain("[ValidationError]");
    const alb = must(aws.createLoadBalancer(tg.project, input));
    expect(errorOf(aws.createLoadBalancer(alb.project, { ...input, name: "web-alb-2" }))).toContain("[TargetGroupAssociationLimit]");
    expect(errorOf(aws.deleteTargetGroup(alb.project, tg.id))).toContain("[ResourceInUse]");

    const request = { source: internet(), destination: res(alb.id), protocol: "tcp" as const, port: 80, requestCount: 2 };
    expect(simulate(settleLifecycle(s.project), request).outcome).not.toBe("success");
    const provisioning = alb.project.resources.find((r) => r.id === alb.id);
    expect(provisioning?.type === "alb" && provisioning.config.state).toBe("provisioning");
    expect(simulate(alb.project, request).outcome).not.toBe("success");
    const active = settleLifecycle(alb.project);
    expect(simulate(active, request).outcome).toBe("success");
  });

  it("IGW가 없는 VPC에는 internet-facing ALB를 만들 수 없다", () => {
    const s = albSetup();
    const tg = must(aws.createTargetGroup(s.project, { name: "tg", protocol: "HTTP", port: 80, vpcId: s.vpcId, healthCheck: defaultHealthCheck(), targetIds: [] }));
    let p = must(aws.editRoutes(tg.project, s.rtId, [])).project;
    p = must(aws.detachInternetGateway(p, s.igwId)).project;
    const input: aws.CreateLoadBalancerInput = {
      name: "alb",
      scheme: "internet-facing",
      vpcId: s.vpcId,
      subnetIds: [s.subnetA, s.subnetC],
      securityGroupIds: [s.albSg],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    };
    expect(errorOf(aws.createLoadBalancer(p, input))).toContain("[InvalidSubnet]");
    expect(aws.createLoadBalancer(p, { ...input, scheme: "internal" }).ok).toBe(true);
  });

  it("리스너를 추가·변경·삭제할 수 있다", () => {
    const s = albSetup();
    const tg1 = must(aws.createTargetGroup(s.project, { name: "tg-1", protocol: "HTTP", port: 80, vpcId: s.vpcId, healthCheck: defaultHealthCheck(), targetIds: [] }));
    const tg2 = must(aws.createTargetGroup(tg1.project, { name: "tg-2", protocol: "HTTP", port: 8080, vpcId: s.vpcId, healthCheck: defaultHealthCheck(), targetIds: [] }));
    const alb = must(
      aws.createLoadBalancer(tg2.project, {
        name: "alb",
        scheme: "internal",
        vpcId: s.vpcId,
        subnetIds: [s.subnetA, s.subnetC],
        securityGroupIds: [s.albSg],
        listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg1.id }],
      }),
    );
    expect(errorOf(aws.addListener(alb.project, alb.id, { protocol: "HTTP", port: 80, targetGroupId: tg2.id }))).toContain("[DuplicateListener]");
    const added = must(aws.addListener(alb.project, alb.id, { protocol: "HTTP", port: 8080, targetGroupId: tg2.id }));
    const listenerId = added.id;
    const changed = must(aws.editListenerDefaultAction(added.project, alb.id, listenerId, tg1.id)).project;
    expect(changed.connections.filter((c) => c.relationType === "alb-target-group" && c.targetResourceId === tg1.id)).toHaveLength(2);
    const removed = must(aws.deleteListener(changed, alb.id, listenerId)).project;
    const lb = removed.resources.find((r) => r.id === alb.id);
    expect(lb?.type === "alb" && lb.config.listeners).toHaveLength(1);
  });
});

describe("RDS", () => {
  function dbSetup() {
    const net = publicNetwork();
    const dbSg = must(aws.createSecurityGroup(net.project, { name: "db-sg", description: "db", vpcId: net.vpcId, inboundRules: [], outboundRules: [] }));
    return { ...net, project: dbSg.project, dbSg: dbSg.id };
  }

  it("DB 서브넷 그룹은 2개 이상의 가용 영역이 필요하다", () => {
    const s = dbSetup();
    const input = { name: "db-subnets", description: "db", vpcId: s.vpcId, subnetIds: [s.subnetA] };
    expect(errorOf(aws.createDbSubnetGroup(s.project, input))).toContain("[DBSubnetGroupDoesNotCoverEnoughAZs]");
    expect(errorOf(aws.createDbSubnetGroup(s.project, { ...input, name: "default", subnetIds: [s.subnetA, s.subnetC] }))).toContain("[InvalidParameterValue]");
    expect(aws.createDbSubnetGroup(s.project, { ...input, subnetIds: [s.subnetA, s.subnetC] }).ok).toBe(true);
  });

  it("퍼블릭 액세스 DB는 VPC의 DNS 확인과 DNS 호스트 이름이 모두 켜져 있어야 한다", () => {
    const s = dbSetup();
    const group = must(aws.createDbSubnetGroup(s.project, { name: "db-subnets", description: "db", vpcId: s.vpcId, subnetIds: [s.subnetA, s.subnetC] }));
    const input: aws.CreateDatabaseInput = {
      identifier: "orders-db",
      engine: "mysql",
      instanceClass: "db.t3.micro",
      allocatedStorageGb: 20,
      multiAz: false,
      dbSubnetGroupId: group.id,
      publiclyAccessible: true,
      securityGroupIds: [s.dbSg],
      port: 3306,
    };
    expect(errorOf(aws.createDatabase(group.project, input))).toContain("[InvalidVPCNetworkStateFault]");
    expect(errorOf(aws.createDatabase(group.project, { ...input, identifier: "Orders_DB" }))).toContain("[InvalidParameterValue]");
    expect(errorOf(aws.createDatabase(group.project, { ...input, allocatedStorageGb: 10 }))).toContain("20~65536");
    const dns = must(aws.editVpcSettings(group.project, s.vpcId, { enableDnsSupport: true, enableDnsHostnames: true })).project;
    const db = must(aws.createDatabase(dns, input));
    const r = db.project.resources.find((x) => x.id === db.id);
    expect(r?.type === "rds" && r.config.state).toBe("creating");
    expect(errorOf(aws.editVpcSettings(db.project, s.vpcId, { enableDnsSupport: true, enableDnsHostnames: false }))).toContain("퍼블릭 액세스");
    expect(errorOf(aws.modifyDatabase(db.project, db.id, { ...input, allocatedStorageGb: 30 }))).toContain("[InvalidDBInstanceState]");
    const available = settleLifecycle(db.project);
    expect(errorOf(aws.modifyDatabase(available, db.id, { ...input, allocatedStorageGb: 10 }))).toContain("줄일 수 없습니다");
    expect(errorOf(aws.deleteDbSubnetGroup(available, group.id))).toContain("[InvalidDBSubnetGroupStateFault]");
    const stopped = must(aws.changeDatabaseState(available, db.id, "stop")).project;
    expect(errorOf(aws.changeDatabaseState(stopped, db.id, "stop"))).toContain("[InvalidDBInstanceState]");
  });
});

describe("VPC 삭제와 이름 태그", () => {
  it("실행 중인 리소스가 있으면 거부하고, 비어 있으면 하위 네트워크 리소스를 함께 삭제한다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    expect(errorOf(aws.deleteVpc(launched.project, net.vpcId))).toContain("[DependencyViolation]");
    const deleted = must(aws.deleteVpc(sg.project, net.vpcId)).project;
    expect(deleted.resources.map((r) => r.type)).toEqual(["internet-gateway"]);
    expect(deleted.connections).toEqual([]);
  });

  it("보안 그룹·로드 밸런서·DB 이름은 바꿀 수 없고 VPC 이름 태그는 바꿀 수 있다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    expect(errorOf(aws.editNameTag(sg.project, sg.id, "renamed"))).toContain("변경할 수 없습니다");
    const renamed = must(aws.editNameTag(sg.project, net.vpcId, "prod-vpc")).project;
    expect(renamed.resources.find((r) => r.id === net.vpcId)?.name).toBe("prod-vpc");
  });

  it("deleteResourceAws는 유형별 규칙을 따른다 (인스턴스는 종료)", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    const terminated = must(aws.deleteResourceAws(launched.project, launched.id)).project;
    const ec2 = terminated.resources.find((r) => r.id === launched.id);
    expect(ec2?.type === "ec2" && ec2.config.state).toBe("terminated");
    const removed = must(aws.deleteResourceAws(terminated, launched.id)).project;
    expect(removed.resources.some((r) => r.id === launched.id)).toBe(false);
  });
});

describe("Reachability Analyzer 경로", () => {
  it("요청 형식을 검사해 저장하고 분석 결과를 기록한다", () => {
    const net = publicNetwork();
    expect(errorOf(aws.createNetworkPath(net.project, { name: "bad", request: { protocol: "tcp" } }))).toContain("[InvalidParameterValue]");
    const request = { source: internet(), destination: res(net.subnetA), protocol: "tcp", port: 80 };
    const path = must(aws.createNetworkPath(net.project, { name: "internet-to-subnet", request }));
    expect(path.project.networkPaths).toHaveLength(1);
    const recorded = aws.recordPathAnalysis(path.project, path.id, { outcome: "failure", summary: "도달 불가" });
    expect(recorded.networkPaths[0].lastAnalysis).toMatchObject({ outcome: "failure", summary: "도달 불가" });
    expect(must(aws.deleteNetworkPaths(recorded, [path.id])).project.networkPaths).toEqual([]);
  });
});

describe("수명 주기", () => {
  it("상태가 이미 바뀐 리소스는 전이하지 않는다", () => {
    const net = publicNetwork();
    const sg = webSg(net.project, net.vpcId);
    const launched = must(launch(sg.project, net.subnetA, [sg.id]));
    const stopped = must(aws.changeInstanceState(launched.project, launched.id, "stop")).project;
    expect(advanceLifecycle(stopped, launched.id, "pending", "running")).toBeNull();
    expect(pendingTransitions(stopped)).toEqual([]);
  });
});
