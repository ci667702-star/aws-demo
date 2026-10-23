"use client";

/** EC2 인스턴스 시작 마법사 (AWS 콘솔의 단일 페이지 구성) */
import { useMemo, useState } from "react";
import { EC2_INSTANCE_TYPES, type ConfigOf, type Project, type SgRule } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { AMI_INFO, createSecurityGroup, INSTANCE_TYPE_INFO, launchInstances, type ActionResult } from "@/lib/project/console-actions";
import { SG } from "@/lib/project/factory";
import { touch } from "@/lib/project/mutations";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonLink } from "../ui/button";
import { Checkbox, FormField, MultiSelect, RadioGroup, SelectInput, TextInput, Tiles } from "../ui/form";
import { Container, ContainerHeader, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink } from "../ui/links";
import { useTopology } from "./common";
import { UserDataFields, useUserDataDraft } from "./user-data";

type Ami = ConfigOf<"ec2">["ami"];

export function LaunchInstancePage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [name, setName] = useState("");
  const [ami, setAmi] = useState<Ami>("amazon-linux-2023");
  const [instanceType, setInstanceType] = useState<ConfigOf<"ec2">["instanceType"]>("t3.micro");
  const [vpcId, setVpcId] = useState(vpcs.length === 1 ? vpcs[0].id : "");
  const [subnetId, setSubnetId] = useState("");
  const [publicIpMode, setPublicIpMode] = useState<ConfigOf<"ec2">["publicIpMode"]>("subnet-default");
  const [sgMode, setSgMode] = useState<"create" | "existing">("create");
  const [existingSgs, setExistingSgs] = useState<string[]>([]);
  const nextWizardNumber = useMemo(() => topo.ofType("security-group").filter((g) => g.name.startsWith("launch-wizard-")).length + 1, [topo]);
  const [newSgName, setNewSgName] = useState(`launch-wizard-${nextWizardNumber}`);
  const [allowSsh, setAllowSsh] = useState(false);
  const [sshFrom, setSshFrom] = useState("0.0.0.0/0");
  const [allowHttp, setAllowHttp] = useState(false);
  const [allowHttps, setAllowHttps] = useState(false);
  const [privateIp, setPrivateIp] = useState("");
  const [count, setCount] = useState("1");
  const userData = useUserDataDraft(ami);
  const [error, setError] = useState<string | null>(null);

  const subnets = vpcId ? topo.subnetsOfVpc(vpcId) : [];
  const subnet = subnets.find((s) => s.id === subnetId);
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  const windows = AMI_INFO[ami].family === "windows";
  const willHavePublicIp = publicIpMode === "enabled" || (publicIpMode === "subnet-default" && !!subnet?.config.mapPublicIpOnLaunch);

  const launch = () => {
    setError(null);
    const ud = userData.toValue(ami);
    if (!ud.ok) return setError(ud.error);
    if (!vpcId) return setError("[MissingParameter] VPC를 선택하세요.");
    if (!subnetId) return setError("[MissingParameter] 서브넷을 선택하세요.");
    const n = Number(count);
    const ids: string[] = [];
    const result = run(
      "RunInstances",
      (p): ActionResult => {
        let next: Project = p;
        let sgIds = existingSgs;
        const notes: string[] = [];
        if (sgMode === "create") {
          const inbound: SgRule[] = [];
          if (allowSsh) inbound.push(windows ? SG.tcp(3389, sshFrom.trim(), "RDP") : SG.tcp(22, sshFrom.trim(), "SSH"));
          if (allowHttps) inbound.push(SG.tcp(443, "0.0.0.0/0", "HTTPS"));
          if (allowHttp) inbound.push(SG.tcp(80, "0.0.0.0/0", "HTTP"));
          const created = createSecurityGroup(next, {
            name: newSgName,
            description: `${newSgName} created by launch wizard`,
            vpcId,
            inboundRules: inbound,
            outboundRules: [SG.all("0.0.0.0/0")],
          });
          if (!created.ok) return created;
          next = created.project;
          sgIds = [created.createdId!];
          notes.push(`보안 그룹 ${created.createdId}(${newSgName.trim()})을(를) 생성했습니다.`);
        }
        const launched = launchInstances(next, {
          name,
          ami,
          instanceType,
          subnetId,
          publicIpMode,
          securityGroupIds: sgIds,
          privateIp: privateIp.trim() || undefined,
          listenPorts: ud.value.listenPorts,
          httpResponseCode: ud.value.httpResponseCode,
          userData: ud.value.userData,
          count: Number.isInteger(n) ? n : NaN,
        });
        if (!launched.ok) return launched;
        ids.push(...launched.project.resources.filter((r) => r.type === "ec2" && !p.resources.some((x) => x.id === r.id)).map((r) => r.id));
        return { ok: true, project: touch(launched.project), notes: [...notes, ...launched.notes], createdId: launched.createdId };
      },
      { success: () => `인스턴스를 시작했습니다: ${ids.join(", ")}` },
    );
    if (!result.ok) setError([result.error, result.hint].filter(Boolean).join(" "));
    else navigate(ids.length === 1 ? resourcePath("ec2", ids[0]) : "/ec2/instances");
  };

  return (
    <div className="space-y-6">
      <PageHeader title="인스턴스 시작" info={<InfoLink topic="ec2-launch" />} description="아래 단계에 따라 가상 EC2 인스턴스를 구성합니다. 실제 서버는 실행되지 않으며, 네트워크 동작만 시뮬레이션합니다." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SpaceBetween>
          <Container header={<ContainerHeader title="이름 및 태그" />}>
            <FormField label="이름">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: My Web Server" maxLength={128} />
            </FormField>
          </Container>

          <Container header={<ContainerHeader title="애플리케이션 및 OS 이미지(Amazon Machine Image)" description="빠른 시작 이미지 (가상)" />}>
            <Tiles
              aria-label="AMI"
              value={ami}
              onChange={(v) => {
                setAmi(v as Ami);
                if (userData.template !== "custom") userData.setTemplate(userData.template, v as Ami);
              }}
              items={(Object.keys(AMI_INFO) as Ami[]).map((id) => ({ value: id, label: AMI_INFO[id].label, description: AMI_INFO[id].description }))}
            />
          </Container>

          <Container header={<ContainerHeader title="인스턴스 유형" />}>
            <FormField label="인스턴스 유형" description="성능은 시뮬레이션하지 않으며 가상 비용 추정에만 사용됩니다.">
              <SelectInput
                value={instanceType}
                onChange={(v) => setInstanceType(v as typeof instanceType)}
                options={EC2_INSTANCE_TYPES.map((t) => ({ value: t, label: t, description: INSTANCE_TYPE_INFO[t] }))}
              />
            </FormField>
          </Container>

          <Container header={<ContainerHeader title="키 페어(로그인)" />}>
            <FormField label="키 페어 이름" description="이 시뮬레이터는 SSH/RDP 원격 접속을 지원하지 않으므로 키 페어를 사용하지 않습니다.">
              <TextInput value="키 페어 없이 계속 진행 (가상 환경)" disabled readOnly />
            </FormField>
          </Container>

          <Container header={<ContainerHeader title="네트워크 설정" info={<InfoLink topic="subnet" />} />}>
            <SpaceBetween size="m">
              <FormField label="VPC">
                <SelectInput
                  value={vpcId}
                  onChange={(v) => {
                    setVpcId(v);
                    setSubnetId("");
                    setExistingSgs([]);
                  }}
                  placeholder="VPC 선택"
                  options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})`, description: v.config.cidr }))}
                />
              </FormField>
              {!vpcs.length && (
                <Alert type="warning">
                  VPC가 없습니다. 먼저 <a href={href("/vpc/vpcs/create")}>VPC</a>와 <a href={href("/vpc/subnets/create")}>서브넷</a>을 만드세요.
                </Alert>
              )}
              <FormField label="서브넷">
                <SelectInput
                  value={subnetId}
                  onChange={setSubnetId}
                  disabled={!vpcId}
                  placeholder={vpcId ? (subnets.length ? "서브넷 선택" : "이 VPC에 서브넷이 없습니다") : "먼저 VPC를 선택하세요"}
                  options={subnets.map((s) => ({
                    value: s.id,
                    label: `${s.id} (${displayName(s)})`,
                    description: `${s.config.availabilityZone} · ${s.config.cidr} · ${{ public: "퍼블릭", "private-nat": "프라이빗(NAT)", "private-isolated": "프라이빗", unattached: "-" }[topo.classifySubnet(s.id).kind]}`,
                  }))}
                />
              </FormField>
              <FormField label="퍼블릭 IP 자동 할당" info={<InfoLink topic="public-ip" />}>
                <SelectInput
                  value={publicIpMode}
                  onChange={(v) => setPublicIpMode(v as typeof publicIpMode)}
                  options={[
                    { value: "subnet-default", label: `서브넷 설정 사용 (${subnet ? (subnet.config.mapPublicIpOnLaunch ? "활성화" : "비활성화") : "서브넷 선택 필요"})` },
                    { value: "enabled", label: "활성화" },
                    { value: "disabled", label: "비활성화" },
                  ]}
                />
              </FormField>
              <FormField label="방화벽(보안 그룹)" info={<InfoLink topic="security-group" />} description="보안 그룹은 인스턴스에 대한 트래픽을 제어하는 방화벽 규칙 집합입니다.">
                <RadioGroup
                  aria-label="방화벽"
                  value={sgMode}
                  onChange={(v) => setSgMode(v as "create" | "existing")}
                  items={[
                    { value: "create", label: "보안 그룹 생성" },
                    { value: "existing", label: "기존 보안 그룹 선택" },
                  ]}
                />
              </FormField>
              {sgMode === "create" ? (
                <div className="space-y-3 rounded-xl border border-aws-border p-4">
                  <FormField label="보안 그룹 이름">
                    <TextInput value={newSgName} onChange={(e) => setNewSgName(e.target.value)} maxLength={255} />
                  </FormField>
                  <p className="text-[13px] text-aws-text-2">다음 규칙으로 새 보안 그룹을 만듭니다. 아무것도 선택하지 않으면 인바운드 트래픽이 모두 거부됩니다.</p>
                  <Checkbox checked={allowSsh} onChange={setAllowSsh} description={windows ? "원격 데스크톱(RDP, 3389)" : "인스턴스 연결용 (SSH, 22)"}>
                    {windows ? "RDP" : "SSH"} 트래픽 허용
                  </Checkbox>
                  {allowSsh && (
                    <FormField label="소스 CIDR" constraint="0.0.0.0/0은 모든 IP에서 접근을 허용합니다. 보통 관리자 네트워크로 제한합니다.">
                      <TextInput value={sshFrom} onChange={(e) => setSshFrom(e.target.value)} className="max-w-64" />
                    </FormField>
                  )}
                  <Checkbox checked={allowHttps} onChange={setAllowHttps} description="0.0.0.0/0에서 HTTPS(443) 허용">
                    인터넷에서 HTTPS 트래픽 허용
                  </Checkbox>
                  <Checkbox checked={allowHttp} onChange={setAllowHttp} description="0.0.0.0/0에서 HTTP(80) 허용">
                    인터넷에서 HTTP 트래픽 허용
                  </Checkbox>
                </div>
              ) : (
                <FormField label="공통 보안 그룹" constraint="선택한 VPC의 보안 그룹, 1~5개">
                  <MultiSelect
                    aria-label="보안 그룹 선택"
                    selected={existingSgs}
                    onChange={setExistingSgs}
                    max={5}
                    empty={vpcId ? "이 VPC에 보안 그룹이 없습니다." : "먼저 VPC를 선택하세요."}
                    options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.id})`, description: g.config.description }))}
                  />
                </FormField>
              )}
              <ExpandableSection header="고급 네트워크 구성">
                <FormField label="기본 IP" optional description="비워 두면 서브넷에서 사용 가능한 주소가 자동으로 할당됩니다." constraint={subnet ? `${subnet.config.cidr} 범위 · 처음 4개와 마지막 주소는 AWS 예약` : undefined}>
                  <TextInput value={privateIp} onChange={(e) => setPrivateIp(e.target.value)} placeholder="자동 할당" className="max-w-64" />
                </FormField>
              </ExpandableSection>
            </SpaceBetween>
          </Container>

          <ExpandableSection variant="container" header="고급 세부 정보" defaultExpanded>
            <UserDataFields ami={ami} draft={userData} />
          </ExpandableSection>
        </SpaceBetween>

        <aside className="xl:sticky xl:top-16 xl:self-start">
          <Container header={<ContainerHeader title="요약" />}>
            <SpaceBetween size="m">
              <FormField label="인스턴스 개수" constraint="1~5">
                <TextInput value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" className="max-w-24" />
              </FormField>
              <KeyValueGrid
                columns={1}
                items={[
                  { label: "소프트웨어 이미지(AMI)", value: AMI_INFO[ami].label },
                  { label: "가상 서버 유형(인스턴스 유형)", value: instanceType },
                  { label: "방화벽(보안 그룹)", value: sgMode === "create" ? `새 보안 그룹 (${newSgName})` : existingSgs.join(", ") || "선택 안 됨" },
                  { label: "서브넷", value: subnet ? `${subnet.id} · ${subnet.config.availabilityZone}` : "선택 안 됨" },
                  { label: "퍼블릭 IPv4", value: subnet ? (willHavePublicIp ? "할당됨" : "할당 안 됨") : "–" },
                  { label: "가상 서비스 포트", value: (() => { const v = userData.toValue(ami); return v.ok ? v.value.listenPorts.join(", ") : "입력 확인 필요"; })() },
                ]}
              />
              {error && (
                <Alert type="error" header="인스턴스를 시작할 수 없습니다">
                  {error}
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <ButtonLink variant="link" href={href("/ec2/instances")}>
                  취소
                </ButtonLink>
                <Button variant="primary" onClick={launch}>
                  인스턴스 시작
                </Button>
              </div>
            </SpaceBetween>
          </Container>
        </aside>
      </div>
    </div>
  );
}
