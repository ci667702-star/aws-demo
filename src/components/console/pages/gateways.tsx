"use client";

/** 인터넷 게이트웨이, 탄력적 IP, NAT 게이트웨이 */
import { useState } from "react";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import {
  allocateElasticIp,
  associateElasticIp,
  attachInternetGateway,
  createInternetGateway,
  createNatGateway,
  deleteInternetGateway,
  deleteNatGateway,
  detachInternetGateway,
  disassociateElasticIp,
  releaseElasticIp,
} from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { href, navigate, resourceHref, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { FormActions, FormField, RadioGroup, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { CopyText, StatusIndicator } from "../ui/status";
import { ipText, NameCell, NatState, ResourceNotFound, sortName, SubnetKindLabel, useResource, useSelection, useTopology } from "./common";
import { EditNameModal } from "./shared-modals";

// ================================================================ 인터넷 게이트웨이

type Igw = ResourceOfType<"internet-gateway">;

function IgwState({ attached }: { attached: boolean }) {
  return attached ? <StatusIndicator type="success">Attached</StatusIndicator> : <StatusIndicator type="warning">Detached</StatusIndicator>;
}

function useIgwActions() {
  const run = useRunAction();
  return {
    detach: (igw: Igw) =>
      run("DetachInternetGateway", (p) => detachInternetGateway(p, igw.id), { success: () => `인터넷 게이트웨이 ${igw.id}을(를) VPC에서 분리했습니다.` }),
    remove: (igw: Igw) => run("DeleteInternetGateway", (p) => deleteInternetGateway(p, igw.id), { success: () => `인터넷 게이트웨이 ${igw.id}을(를) 삭제했습니다.` }),
  };
}

function IgwModals({ igw, mode, onClose }: { igw: Igw | undefined; mode: "detach" | "delete" | null; onClose: () => void }) {
  const actions = useIgwActions();
  const topo = useTopology();
  if (!igw || !mode) return null;
  if (mode === "detach") {
    return (
      <DeleteModal
        open
        onClose={onClose}
        title="VPC에서 분리"
        actionLabel="인터넷 게이트웨이 분리"
        onConfirm={() => {
          const r = actions.detach(igw);
          return r.ok ? null : [r.error, r.hint].filter(Boolean).join(" ");
        }}
      >
        <p>
          인터넷 게이트웨이 <strong>{displayName(igw)}</strong>을(를) VPC {topo.vpcOfIgw(igw.id)}에서 분리하시겠습니까? 분리하면 이 VPC는 인터넷과 통신할 수 없습니다.
        </p>
      </DeleteModal>
    );
  }
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="인터넷 게이트웨이 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = actions.remove(igw);
        if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
        navigate("/vpc/igws");
        return null;
      }}
    >
      <p>
        인터넷 게이트웨이 <strong>{displayName(igw)}</strong>을(를) 삭제하시겠습니까?
      </p>
    </DeleteModal>
  );
}

export function IgwListPage() {
  const topo = useTopology();
  const igws = topo.ofType("internet-gateway");
  const [selected, setSelected] = useSelection();
  const [mode, setMode] = useState<"detach" | "delete" | null>(null);
  const [naming, setNaming] = useState(false);
  const current = igws.find((g) => g.id === selected[0]);
  const attached = current ? !!topo.vpcOfIgw(current.id) : false;
  return (
    <SpaceBetween>
      <ResourceTable<Igw>
        ariaLabel="인터넷 게이트웨이 목록"
        items={igws}
        trackBy={(g) => g.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(g) => displayName(g)}
        header={
          <PageHeader
            title="인터넷 게이트웨이"
            counter={`(${igws.length})`}
            info={<InfoLink topic="igw" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "attach", text: "VPC에 연결", disabled: !current || attached },
                    { id: "detach", text: "VPC에서 분리", disabled: !current || !attached },
                    { id: "tags", text: "태그 관리", disabled: !current },
                    { id: "delete", text: "인터넷 게이트웨이 삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (id === "attach" && current) navigate(`${resourcePath("internet-gateway", current.id)}/attach`);
                    if (id === "detach") setMode("detach");
                    if (id === "delete") setMode("delete");
                    if (id === "tags") setNaming(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/igws/create")}>
                  인터넷 게이트웨이 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="인터넷 게이트웨이 없음" description="VPC가 인터넷과 통신하려면 인터넷 게이트웨이를 만들어 VPC에 연결해야 합니다." action={<ButtonLink href={href("/vpc/igws/create")}>인터넷 게이트웨이 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "Name", cell: (g) => <NameCell r={g} />, sortValue: sortName, filterValue: (g) => g.name },
          { id: "id", header: "인터넷 게이트웨이 ID", cell: (g) => <TypedResourceLink type="internet-gateway" id={g.id} />, sortValue: (g) => g.id },
          { id: "state", header: "상태", cell: (g) => <IgwState attached={!!topo.vpcOfIgw(g.id)} /> },
          { id: "vpc", header: "VPC ID", cell: (g) => <ResourceLink id={topo.vpcOfIgw(g.id)} showName fallback="–" /> },
        ]}
      />
      <IgwModals igw={current} mode={mode} onClose={() => setMode(null)} />
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function CreateIgwPage() {
  const run = useRunAction();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = run("CreateInternetGateway", (p) => createInternetGateway(p, { name }), {
      success: (res) => `인터넷 게이트웨이 ${res.createdId}이(가) 생성되었습니다. VPC에 연결하면 인터넷과 통신할 수 있습니다.`,
      successAction: (res) => ({ label: "VPC에 연결", href: href(`${resourcePath("internet-gateway", res.createdId!)}/attach`) }),
    });
    if (r.ok && r.createdId) navigate(resourcePath("internet-gateway", r.createdId));
    else if (!r.ok) setError(r.error);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="인터넷 게이트웨이 생성" info={<InfoLink topic="igw" />} description="인터넷 게이트웨이는 VPC와 인터넷을 연결하는 가상 라우터입니다. 만든 뒤 VPC에 연결해야 합니다." />
      <Container header={<ContainerHeader title="인터넷 게이트웨이 설정" />}>
        <FormField label="이름 태그" optional constraint="최대 128자">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-internet-gateway-01" maxLength={128} />
        </FormField>
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href("/vpc/igws")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          인터넷 게이트웨이 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function AttachIgwPage({ id }: { id: string }) {
  const igw = useResource(id, "internet-gateway");
  const topo = useTopology();
  const run = useRunAction();
  const [vpcId, setVpcId] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!igw) return <ResourceNotFound type="internet-gateway" id={id} />;
  const vpcs = topo.ofType("vpc").filter((v) => !topo.igwOfVpc(v.id));
  const submit = () => {
    const r = run("AttachInternetGateway", (p) => attachInternetGateway(p, igw.id, vpcId), { success: () => `인터넷 게이트웨이 ${igw.id}을(를) VPC ${vpcId}에 연결했습니다.` });
    if (r.ok) navigate(resourcePath("internet-gateway", igw.id));
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="VPC에 연결" info={<InfoLink topic="igw" />} description={`${igw.id} (${displayName(igw)})`} />
      <Container header={<ContainerHeader title="VPC" description="인터넷 게이트웨이를 VPC에 연결해 VPC와 인터넷 간 통신을 활성화합니다." />}>
        <FormField label="사용 가능한 VPC" description="인터넷 게이트웨이가 연결되지 않은 VPC만 표시됩니다." error={error ?? undefined}>
          <SelectInput value={vpcId} onChange={setVpcId} placeholder="VPC 선택" options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})`, description: v.config.cidr }))} />
        </FormField>
        {!vpcs.length && (
          <Alert type="info" className="mt-3">
            연결할 수 있는 VPC가 없습니다. 모든 VPC에 이미 인터넷 게이트웨이가 있거나 VPC가 없습니다.
          </Alert>
        )}
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(resourcePath("internet-gateway", igw.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit} disabled={!vpcId}>
          인터넷 게이트웨이 연결
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function IgwDetailPage({ id }: { id: string }) {
  const igw = useResource(id, "internet-gateway");
  const topo = useTopology();
  const [mode, setMode] = useState<"detach" | "delete" | null>(null);
  const [naming, setNaming] = useState(false);
  if (!igw) return <ResourceNotFound type="internet-gateway" id={id} />;
  const vpcId = topo.vpcOfIgw(igw.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${igw.id}${igw.name ? ` / ${igw.name}` : ""}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "attach", text: "VPC에 연결", disabled: !!vpcId },
              { id: "detach", text: "VPC에서 분리", disabled: !vpcId },
              { id: "tags", text: "태그 관리" },
              { id: "delete", text: "인터넷 게이트웨이 삭제", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "attach") navigate(`${resourcePath("internet-gateway", igw.id)}/attach`);
              if (a === "detach") setMode("detach");
              if (a === "delete") setMode("delete");
              if (a === "tags") setNaming(true);
            }}
          />
        }
      />
      {!vpcId && (
        <Alert type="info" header="VPC에 연결되지 않음" action={<ButtonLink href={href(`${resourcePath("internet-gateway", igw.id)}/attach`)}>VPC에 연결</ButtonLink>}>
          이 인터넷 게이트웨이는 Detached 상태입니다. VPC에 연결해야 인터넷 통신에 사용할 수 있습니다.
        </Alert>
      )}
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "인터넷 게이트웨이 ID", value: <CopyText text={igw.id} /> },
            { label: "상태", value: <IgwState attached={!!vpcId} /> },
            { label: "VPC ID", value: <ResourceLink id={vpcId} showName fallback="–" /> },
            { label: "Name", value: igw.name || "–" },
          ]}
        />
      </Container>
      <IgwModals igw={igw} mode={mode} onClose={() => setMode(null)} />
      <EditNameModal resource={igw} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

// ================================================================ 탄력적 IP

type Eip = ResourceOfType<"elastic-ip">;

export function EipListPage({ base = "/vpc" }: { base?: "/vpc" | "/ec2" }) {
  const topo = useTopology();
  const run = useRunAction();
  const eips = topo.ofType("elastic-ip");
  const [selected, setSelected] = useSelection();
  const [releasing, setReleasing] = useState(false);
  const [naming, setNaming] = useState(false);
  const current = eips.find((e) => e.id === selected[0]);
  const target = current ? topo.elasticIpTarget(current.id) : undefined;
  return (
    <SpaceBetween>
      <ResourceTable<Eip>
        ariaLabel="탄력적 IP 목록"
        items={eips}
        trackBy={(e) => e.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(e) => e.config.publicIp}
        header={
          <PageHeader
            title="탄력적 IP 주소"
            counter={`(${eips.length})`}
            info={<InfoLink topic="eip" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "associate", text: "탄력적 IP 주소 연결", disabled: !current || !!target },
                    { id: "disassociate", text: "탄력적 IP 주소 연결 해제", disabled: !current || !target },
                    { id: "tags", text: "태그 관리", disabled: !current },
                    { id: "release", text: "탄력적 IP 주소 릴리스", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (!current) return;
                    if (id === "associate") navigate(`${resourcePath("elastic-ip", current.id)}/associate`);
                    if (id === "disassociate")
                      run("DisassociateAddress", (p) => disassociateElasticIp(p, current.id), { success: () => `탄력적 IP ${current.config.publicIp}의 연결을 해제했습니다.`, flashError: true });
                    if (id === "release") setReleasing(true);
                    if (id === "tags") setNaming(true);
                  }}
                />
                <ButtonLink variant="primary" href={href(`${base}/eips/allocate`)}>
                  탄력적 IP 주소 할당
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="탄력적 IP 주소 없음" description="고정 퍼블릭 IPv4 주소가 필요하면 탄력적 IP를 할당하세요. NAT 게이트웨이를 만들 때도 필요합니다." action={<ButtonLink href={href(`${base}/eips/allocate`)}>탄력적 IP 주소 할당</ButtonLink>} />}
        columns={[
          { id: "name", header: "Name", cell: (e) => <NameCell r={e} />, sortValue: sortName, filterValue: (e) => e.name },
          { id: "ip", header: "할당된 IPv4 주소", cell: (e) => <a href={resourceHref("elastic-ip", e.id)} className="font-mono text-[13px] text-aws-link hover:underline">{e.config.publicIp}</a>, sortValue: (e) => e.config.publicIp },
          { id: "type", header: "유형", cell: () => "Public IP" },
          { id: "alloc", header: "할당 ID", cell: (e) => <span className="font-mono text-[13px]">{e.id}</span>, sortValue: (e) => e.id },
          { id: "instance", header: "연결된 인스턴스 ID", cell: (e) => { const t = topo.elasticIpTarget(e.id); return t?.type === "ec2" ? <ResourceLink id={t.id} /> : "–"; } },
          { id: "nat", header: "NAT 게이트웨이 ID", cell: (e) => { const t = topo.elasticIpTarget(e.id); return t?.type === "nat-gateway" ? <ResourceLink id={t.id} /> : "–"; } },
          { id: "private", header: "프라이빗 IP 주소", cell: (e) => { const t = topo.elasticIpTarget(e.id); return t ? ipText(topo.enisOf(t.id)[0]?.privateIp) : "–"; } },
        ]}
      />
      {releasing && current && (
        <DeleteModal
          open
          onClose={() => setReleasing(false)}
          title="탄력적 IP 주소 릴리스"
          actionLabel="릴리스"
          onConfirm={() => {
            const r = run("ReleaseAddress", (p) => releaseElasticIp(p, current.id), { success: () => `탄력적 IP ${current.config.publicIp}을(를) 릴리스했습니다.` });
            return r.ok ? null : [r.error, r.hint].filter(Boolean).join(" ");
          }}
        >
          <p>
            탄력적 IP 주소 <strong className="font-mono">{current.config.publicIp}</strong>을(를) 릴리스하시겠습니까? 릴리스한 주소는 다시 받을 수 없을 수 있습니다.
          </p>
        </DeleteModal>
      )}
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function AllocateEipPage({ base = "/vpc" }: { base?: "/vpc" | "/ec2" }) {
  const run = useRunAction();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = run("AllocateAddress", (p) => allocateElasticIp(p, { name }), {
      success: (res) => `탄력적 IP 주소를 할당했습니다: ${res.createdId}`,
      successAction: (res) => ({ label: "이 탄력적 IP 주소 연결", href: href(`${resourcePath("elastic-ip", res.createdId!)}/associate`) }),
    });
    if (r.ok) navigate(`${base}/eips`);
    else setError(r.error);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="탄력적 IP 주소 할당" info={<InfoLink topic="eip" />} description="가상 퍼블릭 IPv4 주소 풀에서 탄력적 IP 주소를 할당합니다." />
      <Container header={<ContainerHeader title="탄력적 IP 주소 설정" />}>
        <SpaceBetween size="m">
          <FormField label="네트워크 경계 그룹">
            <TextInput value="ap-northeast-2 (가상)" disabled readOnly />
          </FormField>
          <FormField label="퍼블릭 IPv4 주소 풀">
            <RadioGroup
              value="amazon"
              onChange={() => undefined}
              aria-label="퍼블릭 IPv4 주소 풀"
              items={[{ value: "amazon", label: "가상 IPv4 주소 풀", description: "198.51.100.0/24(문서용 예약 대역)에서 주소를 할당합니다. 실제 공인 IP가 아닙니다." }]}
            />
          </FormField>
          <FormField label="Name 태그" optional>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="my-eip" />
          </FormField>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(`${base}/eips`)}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          할당
        </Button>
      </FormActions>
    </form>
  );
}

export function AssociateEipPage({ id }: { id: string }) {
  const eip = useResource(id, "elastic-ip");
  const topo = useTopology();
  const run = useRunAction();
  const [instanceId, setInstanceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!eip) return <ResourceNotFound type="elastic-ip" id={id} />;
  const instances = topo.ofType("ec2").filter((i) => i.config.state !== "terminated" && !topo.elasticIpOf(i.id));
  const chosen = instances.find((i) => i.id === instanceId);
  const submit = () => {
    const r = run("AssociateAddress", (p) => associateElasticIp(p, eip.id, instanceId), { success: () => `탄력적 IP ${eip.config.publicIp}을(를) ${instanceId}에 연결했습니다.` });
    if (r.ok) navigate(resourcePath("elastic-ip", eip.id));
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="탄력적 IP 주소 연결" info={<InfoLink topic="eip" />} description={`${eip.config.publicIp} (${eip.id})`} />
      <Container header={<ContainerHeader title="탄력적 IP 주소" />}>
        <SpaceBetween size="m">
          <FormField label="리소스 유형">
            <RadioGroup value="instance" onChange={() => undefined} aria-label="리소스 유형" items={[{ value: "instance", label: "인스턴스", description: "네트워크 인터페이스 직접 연결은 지원하지 않습니다." }]} />
          </FormField>
          <FormField label="인스턴스" description="탄력적 IP가 연결되지 않은, 종료되지 않은 인스턴스" error={error ?? undefined}>
            <SelectInput
              value={instanceId}
              onChange={setInstanceId}
              placeholder="인스턴스 선택"
              options={instances.map((i) => ({ value: i.id, label: `${i.id} (${displayName(i)})`, description: i.config.state }))}
            />
          </FormField>
          {chosen && (
            <FormField label="프라이빗 IP 주소">
              <TextInput value={chosen.config.privateIp} disabled readOnly />
            </FormField>
          )}
          {chosen && topo.vpcOf(chosen.id) && !topo.igwOfVpc(topo.vpcOf(chosen.id)!) && (
            <Alert type="warning">인스턴스의 VPC에 인터넷 게이트웨이가 없어 연결할 수 없습니다 ([Gateway.NotAttached]).</Alert>
          )}
        </SpaceBetween>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(resourcePath("elastic-ip", eip.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit} disabled={!instanceId}>
          연결
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EipDetailPage({ id }: { id: string }) {
  const eip = useResource(id, "elastic-ip");
  const topo = useTopology();
  const run = useRunAction();
  const [releasing, setReleasing] = useState(false);
  const [naming, setNaming] = useState(false);
  if (!eip) return <ResourceNotFound type="elastic-ip" id={id} />;
  const target = topo.elasticIpTarget(eip.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={eip.config.publicIp}
        description={eip.name ? `${eip.name} · ${eip.id}` : eip.id}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "associate", text: "탄력적 IP 주소 연결", disabled: !!target },
              { id: "disassociate", text: "탄력적 IP 주소 연결 해제", disabled: !target },
              { id: "tags", text: "태그 관리" },
              { id: "release", text: "탄력적 IP 주소 릴리스", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "associate") navigate(`${resourcePath("elastic-ip", eip.id)}/associate`);
              if (a === "disassociate") run("DisassociateAddress", (p) => disassociateElasticIp(p, eip.id), { success: () => `${eip.config.publicIp}의 연결을 해제했습니다.`, flashError: true });
              if (a === "release") setReleasing(true);
              if (a === "tags") setNaming(true);
            }}
          />
        }
      />
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "할당된 IPv4 주소", value: <CopyText text={eip.config.publicIp} /> },
            { label: "유형", value: "Public IP (가상)" },
            { label: "할당 ID", value: eip.id },
            { label: "연결된 리소스", value: target ? <ResourceLink id={target.id} showName /> : "–" },
            { label: "프라이빗 IP 주소", value: target ? ipText(topo.enisOf(target.id)[0]?.privateIp) : "–" },
            { label: "네트워크 경계 그룹", value: "ap-northeast-2 (가상)" },
          ]}
        />
      </Container>
      {releasing && (
        <DeleteModal
          open
          onClose={() => setReleasing(false)}
          title="탄력적 IP 주소 릴리스"
          actionLabel="릴리스"
          onConfirm={() => {
            const r = run("ReleaseAddress", (p) => releaseElasticIp(p, eip.id), { success: () => `탄력적 IP ${eip.config.publicIp}을(를) 릴리스했습니다.` });
            if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
            navigate("/vpc/eips");
            return null;
          }}
        >
          <p>
            <strong className="font-mono">{eip.config.publicIp}</strong>을(를) 릴리스하시겠습니까?
          </p>
        </DeleteModal>
      )}
      <EditNameModal resource={eip} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

// ================================================================ NAT 게이트웨이

type Nat = ResourceOfType<"nat-gateway">;

function DeleteNatModal({ nat, onClose }: { nat: Nat | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!nat) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="NAT 게이트웨이 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = run("DeleteNatGateway", (p) => deleteNatGateway(p, nat.id), { success: () => `NAT 게이트웨이 ${nat.id}을(를) 삭제했습니다.` });
        if (!r.ok) return r.error;
        navigate("/vpc/nat-gateways");
        return null;
      }}
    >
      <p>
        NAT 게이트웨이 <strong>{displayName(nat)}</strong>을(를) 삭제하시겠습니까? 연결된 탄력적 IP는 해제되며(릴리스되지 않음), 이 NAT를 가리키는 경로도 함께 삭제됩니다.
      </p>
    </DeleteModal>
  );
}

export function NatListPage() {
  const topo = useTopology();
  const nats = topo.ofType("nat-gateway");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  const current = nats.find((n) => n.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Nat>
        ariaLabel="NAT 게이트웨이 목록"
        items={nats}
        trackBy={(n) => n.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(n) => displayName(n)}
        header={
          <PageHeader
            title="NAT 게이트웨이"
            counter={`(${nats.length})`}
            info={<InfoLink topic="nat" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "tags", text: "태그 관리", disabled: !current },
                    { id: "delete", text: "NAT 게이트웨이 삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (id === "delete") setDeleting(true);
                    if (id === "tags") setNaming(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/nat-gateways/create")}>
                  NAT 게이트웨이 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="NAT 게이트웨이 없음" description="프라이빗 서브넷의 리소스가 인터넷으로 나가려면 퍼블릭 서브넷에 NAT 게이트웨이를 만들고 경로를 추가하세요." action={<ButtonLink href={href("/vpc/nat-gateways/create")}>NAT 게이트웨이 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "Name", cell: (n) => <NameCell r={n} />, sortValue: sortName, filterValue: (n) => n.name },
          { id: "id", header: "NAT 게이트웨이 ID", cell: (n) => <TypedResourceLink type="nat-gateway" id={n.id} />, sortValue: (n) => n.id },
          { id: "type", header: "연결 유형", cell: () => "Public" },
          { id: "state", header: "상태", cell: (n) => <NatState state={n.config.state} />, sortValue: (n) => n.config.state },
          { id: "public", header: "기본 퍼블릭 IPv4 주소", cell: (n) => ipText(topo.enisOf(n.id)[0]?.publicIp) },
          { id: "private", header: "기본 프라이빗 IPv4 주소", cell: (n) => ipText(topo.enisOf(n.id)[0]?.privateIp) },
          { id: "vpc", header: "VPC", cell: (n) => <ResourceLink id={topo.vpcOf(n.id)} /> },
          { id: "subnet", header: "서브넷", cell: (n) => <ResourceLink id={topo.subnetOf(n.id)} /> },
        ]}
      />
      <DeleteNatModal nat={deleting ? current : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function CreateNatPage() {
  const topo = useTopology();
  const run = useRunAction();
  const [name, setName] = useState("");
  const [subnetId, setSubnetId] = useState("");
  const [eipId, setEipId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const subnets = topo.ofType("subnet");
  const freeEips = topo.ofType("elastic-ip").filter((e) => !topo.elasticIpTarget(e.id));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subnetId) return setError("서브넷을 선택하세요.");
    const r = run("CreateNatGateway", (p) => createNatGateway(p, { name, subnetId, eipId }), { success: (res) => `NAT 게이트웨이 ${res.createdId}을(를) 생성했습니다.` });
    if (r.ok && r.createdId) navigate(resourcePath("nat-gateway", r.createdId));
    else if (!r.ok) setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  const allocate = () => {
    const r = run("AllocateAddress", (p) => allocateElasticIp(p, { name: "" }), { flashError: true });
    if (r.ok && r.createdId) setEipId(r.createdId);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="NAT 게이트웨이 생성" info={<InfoLink topic="nat" />} description="프라이빗 서브넷의 인스턴스가 VPC 외부 서비스에 연결할 수 있게 해 주는 가상 NAT 서비스입니다." />
      <Container header={<ContainerHeader title="NAT 게이트웨이 설정" />}>
        <SpaceBetween size="m">
          <FormField label="이름" optional constraint="최대 128자">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="my-nat-gateway-01" />
          </FormField>
          <FormField label="서브넷" description="NAT 게이트웨이를 만들 서브넷을 선택합니다. 퍼블릭 NAT는 퍼블릭 서브넷(IGW 경로가 있는 서브넷)에 두어야 합니다.">
            <SelectInput
              value={subnetId}
              onChange={setSubnetId}
              placeholder="서브넷 선택"
              options={subnets.map((s) => ({
                value: s.id,
                label: `${s.id} (${displayName(s)})`,
                description: `${s.config.cidr} · ${s.config.availabilityZone} · ${{ public: "퍼블릭", "private-nat": "프라이빗(NAT)", "private-isolated": "프라이빗", unattached: "VPC 없음" }[topo.classifySubnet(s.id).kind]}`,
              }))}
            />
          </FormField>
          {subnetId && <SubnetKindLabel topo={topo} subnetId={subnetId} />}
          <FormField label="연결 유형">
            <RadioGroup value="public" onChange={() => undefined} aria-label="연결 유형" items={[{ value: "public", label: "퍼블릭", description: "프라이빗 NAT 게이트웨이는 지원하지 않습니다." }]} />
          </FormField>
          <FormField label="탄력적 IP 할당 ID" info={<InfoLink topic="eip" />} description="NAT 게이트웨이에 연결할 탄력적 IP를 선택합니다.">
            <div className="flex flex-wrap gap-2">
              <SelectInput
                className="min-w-64 flex-1"
                value={eipId}
                onChange={setEipId}
                placeholder="탄력적 IP 선택"
                options={freeEips.map((e) => ({ value: e.id, label: `${e.id} (${e.config.publicIp})` }))}
              />
              <Button onClick={allocate}>탄력적 IP 할당</Button>
            </div>
          </FormField>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <Alert type="error" header="NAT 게이트웨이를 생성할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href("/vpc/nat-gateways")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          NAT 게이트웨이 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function NatDetailPage({ id }: { id: string }) {
  const nat = useResource(id, "nat-gateway");
  const topo = useTopology();
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  if (!nat) return <ResourceNotFound type="nat-gateway" id={id} />;
  const eni = topo.enisOf(nat.id)[0];
  const eip = topo.elasticIpOf(nat.id);
  const routes = topo.connections.filter((c) => c.relationType === "route-table-nat-gateway" && c.targetResourceId === nat.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${nat.id}${nat.name ? ` / ${nat.name}` : ""}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "tags", text: "태그 관리" },
              { id: "delete", text: "NAT 게이트웨이 삭제", danger: true },
            ]}
            onItemClick={(a) => (a === "delete" ? setDeleting(true) : setNaming(true))}
          />
        }
      />
      {nat.config.state === "pending" && <Alert type="info">NAT 게이트웨이를 준비하는 중입니다 (Pending). Available이 되면 트래픽을 처리합니다.</Alert>}
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "NAT 게이트웨이 ID", value: <CopyText text={nat.id} /> },
            { label: "연결 유형", value: "Public" },
            { label: "상태", value: <NatState state={nat.config.state} />, info: <InfoLink topic="lifecycle" /> },
            { label: "기본 퍼블릭 IPv4 주소", value: ipText(eni?.publicIp) },
            { label: "탄력적 IP 할당 ID", value: <ResourceLink id={eip?.id} fallback="없음 (이전 형식)" /> },
            { label: "기본 프라이빗 IPv4 주소", value: ipText(eni?.privateIp) },
            { label: "VPC", value: <ResourceLink id={topo.vpcOf(nat.id)} showName /> },
            { label: "서브넷", value: <ResourceLink id={topo.subnetOf(nat.id)} showName /> },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title={`이 NAT를 사용하는 경로 (${routes.length})`} />}>
        {routes.length ? (
          <ul className="space-y-1 text-sm">
            {routes.map((c) => (
              <li key={c.id}>
                <ResourceLink id={c.sourceResourceId} showName /> — <span className="font-mono">{"destinationCidr" in c.metadata ? c.metadata.destinationCidr : ""}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">아직 이 NAT 게이트웨이를 대상으로 하는 경로가 없습니다. 프라이빗 서브넷의 라우팅 테이블에 0.0.0.0/0 → {nat.id} 경로를 추가하세요.</p>
        )}
      </Container>
      <DeleteNatModal nat={deleting ? nat : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={nat} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}
