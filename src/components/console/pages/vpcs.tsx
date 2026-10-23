"use client";

import { withHint } from "../error-codes";
import { useState } from "react";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { createDefaultVpc, createVpc, deleteVpc, editVpcSettings } from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { ErrorAlert } from "../ui/alert";
import { PageGuide } from "../ui/page-guide";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { Checkbox, FormActions, FormField, RadioGroup, TextInput } from "../ui/form";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { Badge, CopyText, StatusIndicator } from "../ui/status";
import { NameCell, ResourceNotFound, sortName, SubnetKindLabel, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { EditNameModal } from "./shared-modals";

type Vpc = ResourceOfType<"vpc">;

export function VpcListPage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = vpcs.find((v) => v.id === selected[0]);

  return (
    <SpaceBetween>
      <PageGuide topic="vpc" />
      <ResourceTable<Vpc>
        ariaLabel="VPC 목록"
        items={vpcs}
        trackBy={(v) => v.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(v) => displayName(v)}
        header={
          <PageHeader
            title="VPC"
            counter={`(${vpcs.length})`}
            info={<InfoLink topic="vpc" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "settings", text: "VPC 설정 편집", disabled: !current },
                    { id: "delete", text: "VPC 삭제", disabled: !current, danger: true },
                    { id: "default", text: "기본 VPC 생성" },
                  ]}
                  onItemClick={(id) => {
                    if (id === "settings" && current) navigate(`${resourcePath("vpc", current.id)}/edit-settings`);
                    if (id === "delete") setDeleting(true);
                    if (id === "default") {
                      const r = run("CreateDefaultVpc", (p) => createDefaultVpc(p), { success: (res) => `기본 VPC ${res.createdId}을(를) 생성했습니다.`, flashError: true });
                      if (r.ok && r.createdId) setSelected([r.createdId]);
                    }
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/vpcs/create")}>
                  VPC 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={
          <EmptyState
            title="VPC 없음"
            description="이 샌드박스에는 아직 VPC가 없습니다. 직접 VPC를 만들어 네트워크를 구성하세요."
            action={<ButtonLink href={href("/vpc/vpcs/create")}>VPC 생성</ButtonLink>}
          />
        }
        columns={[
          { id: "name", header: "Name", cell: (v) => <NameCell r={v} />, sortValue: sortName, filterValue: (v) => v.name },
          { id: "id", header: "VPC ID", cell: (v) => <TypedResourceLink type="vpc" id={v.id} />, sortValue: (v) => v.id },
          { id: "state", optional: true, header: "상태", cell: () => <StatusIndicator type="success">Available</StatusIndicator> },
          { id: "cidr", header: "IPv4 CIDR", cell: (v) => v.config.cidr, sortValue: (v) => v.config.cidr },
          { id: "rt", optional: true, header: "기본 라우팅 테이블", cell: (v) => <ResourceLink id={topo.mainRouteTableOf(v.id)?.id} /> },
          {
            id: "nacl",
            optional: true,
            header: "기본 네트워크 ACL",
            cell: (v) => <ResourceLink id={topo.ofType("network-acl").find((n) => n.config.isDefault && topo.vpcOf(n.id) === v.id)?.id} />,
          },
          { id: "default", optional: true, header: "기본 VPC", cell: (v) => (v.config.isDefault ? "예" : "아니요") },
        ]}
      />
      <DeleteVpcModal vpc={deleting ? current : undefined} onClose={() => setDeleting(false)} onDeleted={() => setSelected([])} />
    </SpaceBetween>
  );
}

function DeleteVpcModal({ vpc, onClose, onDeleted }: { vpc: Vpc | undefined; onClose: () => void; onDeleted?: () => void }) {
  const run = useRunAction();
  const topo = useTopology();
  if (!vpc) return null;
  const children = topo.project.resources.filter((r) => r.id !== vpc.id && (topo.vpcOf(r.id) === vpc.id || topo.vpcsOf(r.id).includes(vpc.id)));
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="VPC 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = run("DeleteVpc", (p) => deleteVpc(p, vpc.id), { success: () => `VPC ${vpc.id}을(를) 삭제했습니다.` });
        if (!r.ok) return withHint(r);
        onDeleted?.();
        navigate("/vpc/vpcs");
        return null;
      }}
    >
      <p>
        VPC <strong>{displayName(vpc)}</strong>({vpc.config.cidr})을(를) 삭제하시겠습니까? 서브넷, 라우팅 테이블, 네트워크 ACL, 보안 그룹이 함께 삭제됩니다.
      </p>
      {children.length > 0 && (
        <p className="text-aws-text-2">
          이 VPC의 리소스 {children.length}개: {children.slice(0, 8).map((r) => r.id).join(", ")}
          {children.length > 8 ? " …" : ""}
        </p>
      )}
    </DeleteModal>
  );
}

export function CreateVpcPage() {
  const run = useRunAction();
  const [name, setName] = useState("");
  const [cidr, setCidr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = run("CreateVpc", (p) => createVpc(p, { name, cidr }), { success: (r) => `VPC ${r.createdId}을(를) 생성했습니다.` });
    if (!result.ok) setError(withHint(result));
    else if (result.createdId) navigate(resourcePath("vpc", result.createdId));
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate data-tour="vpc-form">
      <PageHeader title="VPC 생성" info={<InfoLink topic="vpc" />} description="VPC는 리소스를 시작할 수 있는 격리된 가상 네트워크입니다. 서브넷, 인터넷 게이트웨이, 경로는 VPC를 만든 뒤 직접 추가합니다." />
      <PageGuide topic="vpc" />
      <Container header={<ContainerHeader title="VPC 설정" />}>
        <SpaceBetween size="m">
          <FormField label="생성할 리소스" description="이 시뮬레이터는 VPC만 생성합니다. 서브넷과 게이트웨이는 각 메뉴에서 직접 만드세요.">
            <RadioGroup value="vpc-only" onChange={() => undefined} items={[{ value: "vpc-only", label: "VPC만" }]} aria-label="생성할 리소스" />
          </FormField>
          <FormField label="이름 태그" optional description="키가 'Name'이고 값이 입력한 이름인 태그를 만듭니다." constraint="최대 128자">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-vpc-01" maxLength={128} />
          </FormField>
          <FormField label="IPv4 CIDR 블록" info={<InfoLink topic="cidr" />}>
            <RadioGroup value="manual" onChange={() => undefined} items={[{ value: "manual", label: "IPv4 CIDR 수동 입력" }]} aria-label="IPv4 CIDR 블록" />
          </FormField>
          <FormField label="IPv4 CIDR" constraint="CIDR 블록 크기는 /16에서 /28 사이여야 합니다." error={error && /CIDR/.test(error) ? error : undefined}>
            <TextInput value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.0.0/16" />
          </FormField>
          <FormField label="IPv6 CIDR 블록">
            <RadioGroup value="none" onChange={() => undefined} items={[{ value: "none", label: "IPv6 CIDR 블록 없음", description: "이 시뮬레이터는 IPv6를 지원하지 않습니다." }]} aria-label="IPv6 CIDR 블록" />
          </FormField>
          <FormField label="테넌시">
            <TextInput value="기본값" disabled readOnly />
          </FormField>
        </SpaceBetween>
      </Container>
      <FormActions error={error && !/CIDR/.test(error) ? <ErrorAlert message={error} header="VPC를 생성할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href("/vpc/vpcs")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          VPC 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function VpcDetailPage({ id }: { id: string }) {
  const vpc = useResource(id, "vpc");
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("map");
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  if (!vpc) return <ResourceNotFound type="vpc" id={id} />;
  const subnets = topo.subnetsOfVpc(vpc.id);
  const rts = topo.routeTablesOfVpc(vpc.id);
  const igw = topo.igwOfVpc(vpc.id);
  const nats = topo.ofType("nat-gateway").filter((n) => topo.vpcOf(n.id) === vpc.id);
  const defaultNacl = topo.ofType("network-acl").find((n) => n.config.isDefault && topo.vpcOf(n.id) === vpc.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${vpc.id}${vpc.name ? ` / ${vpc.name}` : ""}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "settings", text: "VPC 설정 편집" },
              { id: "tags", text: "태그 관리" },
              { id: "delete", text: "VPC 삭제", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "settings") navigate(`${resourcePath("vpc", vpc.id)}/edit-settings`);
              if (a === "tags") setNaming(true);
              if (a === "delete") setDeleting(true);
            }}
          />
        }
      />
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "VPC ID", value: <CopyText text={vpc.id} /> },
            { label: "상태", value: <StatusIndicator type="success">Available</StatusIndicator> },
            { label: "DNS 확인", value: vpc.config.enableDnsSupport ? "활성화됨" : "비활성화됨", info: <InfoLink topic="dns-settings" /> },
            { label: "DNS 호스트 이름", value: vpc.config.enableDnsHostnames ? "활성화됨" : "비활성화됨" },
            { label: "IPv4 CIDR", value: vpc.config.cidr },
            { label: "기본 라우팅 테이블", value: <ResourceLink id={topo.mainRouteTableOf(vpc.id)?.id} /> },
            { label: "기본 네트워크 ACL", value: <ResourceLink id={defaultNacl?.id} /> },
            { label: "기본 VPC", value: vpc.config.isDefault ? "예" : "아니요" },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="VPC 세부 정보 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "map",
            label: "리소스 맵",
            content: (
              <Container header={<ContainerHeader title="리소스 맵" description="이 VPC에 속한 서브넷, 라우팅 테이블, 네트워크 연결입니다." />}>
                <div className="grid gap-4 md:grid-cols-3">
                  <MapColumn title={`서브넷 (${subnets.length})`} empty="서브넷 없음 — 서브넷을 만들어 VPC 범위를 나누세요.">
                    {subnets.map((s) => (
                      <li key={s.id} className="space-y-0.5">
                        <ResourceLink id={s.id} showName />
                        <p className="text-xs text-aws-text-2">
                          {s.config.availabilityZone} · {s.config.cidr}
                        </p>
                        <SubnetKindLabel topo={topo} subnetId={s.id} />
                      </li>
                    ))}
                  </MapColumn>
                  <MapColumn title={`라우팅 테이블 (${rts.length})`} empty="라우팅 테이블 없음">
                    {rts.map((rt) => (
                      <li key={rt.id} className="space-y-0.5">
                        <ResourceLink id={rt.id} showName /> {rt.config.main && <Badge>기본</Badge>}
                        <p className="text-xs text-aws-text-2">
                          경로 {topo.routesOf(rt.id, vpc.id).length}개 · 명시적 서브넷 연결 {topo.outgoing(rt.id, "route-table-subnet").length}개
                        </p>
                      </li>
                    ))}
                  </MapColumn>
                  <MapColumn title={`네트워크 연결 (${(igw ? 1 : 0) + nats.length})`} empty="인터넷 게이트웨이나 NAT 게이트웨이가 없습니다. 이 VPC는 인터넷과 통신할 수 없습니다.">
                    {igw && (
                      <li>
                        <ResourceLink id={igw.id} showName /> <span className="text-xs text-aws-text-2">인터넷 게이트웨이</span>
                      </li>
                    )}
                    {nats.map((n) => (
                      <li key={n.id}>
                        <ResourceLink id={n.id} showName /> <span className="text-xs text-aws-text-2">NAT 게이트웨이 · {n.config.state}</span>
                      </li>
                    ))}
                  </MapColumn>
                </div>
              </Container>
            ),
          },
          {
            id: "cidrs",
            label: "CIDR",
            content: (
              <Container header={<ContainerHeader title="IPv4 CIDR" />}>
                <KeyValueGrid columns={2} items={[{ label: "CIDR", value: vpc.config.cidr }, { label: "상태", value: <StatusIndicator type="success">Associated</StatusIndicator> }]} />
              </Container>
            ),
          },
          {
            id: "tags",
            label: "태그",
            content: (
              <Container header={<ContainerHeader title="태그" actions={<Button onClick={() => setNaming(true)}>태그 관리</Button>} />}>
                <KeyValueGrid columns={2} items={[{ label: "Name", value: vpc.name || "–" }]} />
              </Container>
            ),
          },
        ]}
      />
      <DeleteVpcModal vpc={deleting ? vpc : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={vpc} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

function MapColumn({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div className="rounded-xl border border-aws-border p-3">
      <h3 className="mb-2 text-sm font-bold text-aws-text">{title}</h3>
      {items.length ? <ul className="space-y-3 text-sm">{children}</ul> : <p className="text-[13px] text-aws-text-2">{empty}</p>}
    </div>
  );
}

export function EditVpcSettingsPage({ id }: { id: string }) {
  const vpc = useResource(id, "vpc");
  const run = useRunAction();
  const [support, setSupport] = useState(vpc?.config.enableDnsSupport ?? true);
  const [hostnames, setHostnames] = useState(vpc?.config.enableDnsHostnames ?? false);
  const [error, setError] = useState<string | null>(null);
  if (!vpc) return <ResourceNotFound type="vpc" id={id} />;
  const save = () => {
    const r = run("ModifyVpcAttribute", (p) => editVpcSettings(p, vpc.id, { enableDnsSupport: support, enableDnsHostnames: hostnames }), {
      success: () => `VPC ${vpc.id}의 설정을 수정했습니다.`,
    });
    if (r.ok) navigate(resourcePath("vpc", vpc.id));
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="VPC 설정 편집" description={`${vpc.id} (${displayName(vpc)})`} />
      <Container header={<ContainerHeader title="DNS 설정" info={<InfoLink topic="dns-settings" />} />}>
        <SpaceBetween size="m">
          <Checkbox checked={support} onChange={setSupport} description="Amazon 제공 DNS 서버를 통한 DNS 확인을 사용합니다.">
            DNS 확인 활성화
          </Checkbox>
          <Checkbox checked={hostnames} onChange={setHostnames} description="퍼블릭 IP 주소가 있는 리소스에 퍼블릭 DNS 호스트 이름을 부여합니다.">
            DNS 호스트 이름 활성화
          </Checkbox>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} header="설정을 저장할 수 없습니다" /> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("vpc", vpc.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
