"use client";

import { withHint } from "../error-codes";
import { useMemo, useState } from "react";
import { awsUsableHostCount, tryParseCidr } from "@/lib/engine/cidr-utils";
import { createId } from "@/lib/engine/ids";
import { AVAILABILITY_ZONES, type Project, type ResourceOfType } from "@/lib/engine/resource-models";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import {
  createSubnet,
  deleteSubnet,
  editSubnetSettings,
  replaceSubnetNetworkAcl,
  replaceSubnetRouteTable,
  type ActionResult,
} from "@/lib/project/console-actions";
import { touch } from "@/lib/project/mutations";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert, ErrorAlert } from "../ui/alert";
import { PageGuide } from "../ui/page-guide";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { Checkbox, FormActions, FormField, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { CopyText, StatusIndicator } from "../ui/status";
import { ipText, NameCell, ResourceNotFound, sortName, SubnetKindLabel, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { NaclRulesTable, RoutesTable } from "./network-tables";
import { EditNameModal } from "./shared-modals";

type Subnet = ResourceOfType<"subnet">;

export function availableIps(topo: Topology, subnet: Subnet): number | null {
  const cidr = tryParseCidr(subnet.config.cidr);
  if (!cidr) return null;
  const used = topo.enis().filter((e) => e.subnetId === subnet.id && e.privateIp !== null).length;
  return Math.max(0, awsUsableHostCount(cidr) - used);
}

function naclIdOf(topo: Topology, subnetId: string) {
  return topo.naclOf(subnetId)?.id;
}

function routeTableIdOf(topo: Topology, subnetId: string) {
  const ref = topo.routeTableRefFor(subnetId);
  return ref.kind === "explicit" || ref.kind === "main" ? ref.routeTableId : null;
}

export function SubnetListPage() {
  const topo = useTopology();
  const subnets = topo.ofType("subnet");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  const current = subnets.find((s) => s.id === selected[0]);
  const go = (suffix: string) => current && navigate(`${resourcePath("subnet", current.id)}/${suffix}`);
  return (
    <SpaceBetween>
      <PageGuide topic="subnet" />
      <ResourceTable<Subnet>
        ariaLabel="서브넷 목록"
        items={subnets}
        trackBy={(s) => s.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(s) => displayName(s)}
        header={
          <PageHeader
            title="서브넷"
            counter={`(${subnets.length})`}
            info={<InfoLink topic="subnet" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "settings", text: "서브넷 설정 편집", disabled: !current },
                    { id: "rt", text: "라우팅 테이블 연결 편집", disabled: !current },
                    { id: "nacl", text: "네트워크 ACL 연결 편집", disabled: !current },
                    { id: "tags", text: "태그 관리", disabled: !current },
                    { id: "delete", text: "서브넷 삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (id === "settings") go("edit-settings");
                    if (id === "rt") go("edit-route-table");
                    if (id === "nacl") go("edit-network-acl");
                    if (id === "tags") setNaming(true);
                    if (id === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/subnets/create")}>
                  서브넷 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={
          <EmptyState
            title="서브넷 없음"
            description={topo.ofType("vpc").length ? "VPC의 IP 범위를 나눠 서브넷을 만드세요." : "먼저 VPC를 만든 뒤 서브넷을 만들 수 있습니다."}
            action={<ButtonLink href={href(topo.ofType("vpc").length ? "/vpc/subnets/create" : "/vpc/vpcs/create")}>{topo.ofType("vpc").length ? "서브넷 생성" : "VPC 생성"}</ButtonLink>}
          />
        }
        columns={[
          { id: "name", header: "Name", cell: (s) => <NameCell r={s} />, sortValue: sortName, filterValue: (s) => s.name },
          { id: "id", header: "서브넷 ID", cell: (s) => <TypedResourceLink type="subnet" id={s.id} />, sortValue: (s) => s.id },
          { id: "state", optional: true, header: "상태", cell: () => <StatusIndicator type="success">Available</StatusIndicator> },
          { id: "vpc", header: "VPC", cell: (s) => <ResourceLink id={topo.vpcOfSubnet(s.id)} showName />, filterValue: (s) => topo.vpcOfSubnet(s.id) ?? "" },
          { id: "cidr", header: "IPv4 CIDR", cell: (s) => s.config.cidr, sortValue: (s) => s.config.cidr },
          { id: "ips", optional: true, header: "사용 가능한 IPv4 주소", cell: (s) => availableIps(topo, s) ?? "–", sortValue: (s) => availableIps(topo, s) ?? 0 },
          { id: "az", header: "가용 영역", cell: (s) => s.config.availabilityZone, sortValue: (s) => s.config.availabilityZone },
          { id: "rt", optional: true, header: "라우팅 테이블", cell: (s) => <ResourceLink id={routeTableIdOf(topo, s.id)} /> },
          { id: "nacl", optional: true, header: "네트워크 ACL", cell: (s) => <ResourceLink id={naclIdOf(topo, s.id)} /> },
          { id: "kind", header: "라우팅 기준 분류", cell: (s) => <SubnetKindLabel topo={topo} subnetId={s.id} /> },
          { id: "auto", optional: true, header: "퍼블릭 IPv4 주소 자동 할당", cell: (s) => (s.config.mapPublicIpOnLaunch ? "예" : "아니요") },
        ]}
      />
      <DeleteSubnetModal subnet={deleting ? current : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

function DeleteSubnetModal({ subnet, onClose }: { subnet: Subnet | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!subnet) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="서브넷 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = run("DeleteSubnet", (p) => deleteSubnet(p, subnet.id), { success: () => `서브넷 ${subnet.id}을(를) 삭제했습니다.` });
        if (!r.ok) return withHint(r);
        navigate("/vpc/subnets");
        return null;
      }}
    >
      <p>
        서브넷 <strong>{displayName(subnet)}</strong>({subnet.config.cidr})을(를) 삭제하시겠습니까?
      </p>
    </DeleteModal>
  );
}

interface SubnetDraft {
  key: string;
  name: string;
  az: string;
  cidr: string;
}

export function CreateSubnetPage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [vpcId, setVpcId] = useState("");
  const [drafts, setDrafts] = useState<SubnetDraft[]>([{ key: createId("draft"), name: "", az: "", cidr: "" }]);
  const [error, setError] = useState<{ index: number | null; message: string } | null>(null);
  const vpc = vpcs.find((v) => v.id === vpcId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!vpc) {
      setError({ index: null, message: "VPC를 선택하세요." });
      return;
    }
    let failedIndex: number | null = null;
    const created: string[] = [];
    const result = run(
      "CreateSubnet",
      (p): ActionResult => {
        let next: Project = p;
        const notes: string[] = [];
        for (const [i, d] of drafts.entries()) {
          const r = createSubnet(next, { vpcId: vpc.id, name: d.name, availabilityZone: d.az || null, cidr: d.cidr });
          if (!r.ok) {
            failedIndex = i;
            return r;
          }
          next = r.project;
          created.push(r.createdId!);
          if (i === 0) notes.push(...r.notes.slice(1));
        }
        return { ok: true, project: touch(next), notes, createdId: created[0] };
      },
      { success: () => `서브넷 ${created.length}개를 생성했습니다: ${created.join(", ")}` },
    );
    if (!result.ok) setError({ index: failedIndex, message: result.error });
    else navigate(created.length === 1 ? resourcePath("subnet", created[0]) : "/vpc/subnets");
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate data-tour="subnet-form">
      <PageHeader title="서브넷 생성" info={<InfoLink topic="subnet" />} description="VPC의 IPv4 CIDR 범위 안에서 서브넷을 만듭니다. 서브넷마다 하나의 가용 영역을 사용합니다." />
      <PageGuide topic="subnet" />
      <Container header={<ContainerHeader title="VPC" />}>
        <FormField label="VPC ID" description="이 VPC에 서브넷을 만듭니다." error={error?.index === null ? error.message : undefined}>
          <SelectInput
            value={vpcId}
            onChange={(v) => {
              setVpcId(v);
              setError(null);
            }}
            placeholder="VPC 선택"
            options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})`, description: v.config.cidr }))}
          />
        </FormField>
        {vpc && (
          <p className="mt-3 text-sm text-aws-text-2">
            연결된 VPC CIDR: <span className="font-mono text-aws-text">{vpc.config.cidr}</span> · 기존 서브넷:{" "}
            {topo.subnetsOfVpc(vpc.id).map((s) => s.config.cidr).join(", ") || "없음"}
          </p>
        )}
        {!vpcs.length && (
          <Alert type="info" className="mt-3">
            VPC가 없습니다. <a href={href("/vpc/vpcs/create")}>VPC를 먼저 생성</a>하세요.
          </Alert>
        )}
      </Container>
      {vpc && (
        <Container header={<ContainerHeader title="서브넷 설정" description="서브넷의 CIDR 블록과 가용 영역을 지정합니다." />}>
          <SpaceBetween>
            {drafts.map((d, i) => (
              <fieldset key={d.key} className="space-y-4 rounded-xl border border-aws-border p-4" data-testid="subnet-draft">
                <legend className="px-1 text-sm font-bold">
                  서브넷 {i + 1}/{drafts.length}
                </legend>
                <FormField label="서브넷 이름" optional constraint="이름은 최대 128자까지 입력할 수 있습니다.">
                  <TextInput value={d.name} placeholder="my-subnet-01" maxLength={128} onChange={(e) => setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, name: e.target.value } : x)))} />
                </FormField>
                <FormField label="가용 영역" info={<InfoLink topic="availability-zone" />} description="선택하지 않으면 서브넷이 가장 적은 가용 영역을 사용합니다.">
                  <SelectInput
                    value={d.az}
                    placeholder="기본 설정 없음"
                    options={AVAILABILITY_ZONES.map((z) => ({ value: z, label: `아시아 태평양(서울) / ${z}` }))}
                    onChange={(v) => setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, az: v } : x)))}
                  />
                </FormField>
                <FormField label="IPv4 서브넷 CIDR 블록" info={<InfoLink topic="cidr" />} constraint={`VPC 범위(${vpc.config.cidr}) 안의 /16 ~ /28 블록`} error={error?.index === i ? error.message : undefined}>
                  <TextInput value={d.cidr} placeholder="10.0.1.0/24" onChange={(e) => setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, cidr: e.target.value } : x)))} />
                </FormField>
                {drafts.length > 1 && (
                  <div className="flex justify-end">
                    <Button onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))}>제거</Button>
                  </div>
                )}
              </fieldset>
            ))}
            <div>
              <Button onClick={() => setDrafts([...drafts, { key: createId("draft"), name: "", az: "", cidr: "" }])}>새 서브넷 추가</Button>
            </div>
          </SpaceBetween>
        </Container>
      )}
      <FormActions error={error && error.index === null && vpc ? <ErrorAlert message={error.message} /> : undefined}>
        <ButtonLink variant="link" href={href("/vpc/subnets")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit" disabled={!vpcs.length}>
          서브넷 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function SubnetDetailPage({ id }: { id: string }) {
  const subnet = useResource(id, "subnet");
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("route-table");
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  if (!subnet) return <ResourceNotFound type="subnet" id={id} />;
  const routing = topo.subnetRouting(subnet.id);
  const rtId = routeTableIdOf(topo, subnet.id);
  const nacl = topo.naclOf(subnet.id);
  const members = topo.enis().filter((e) => e.subnetId === subnet.id);
  const go = (suffix: string) => navigate(`${resourcePath("subnet", subnet.id)}/${suffix}`);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${subnet.id}${subnet.name ? ` / ${subnet.name}` : ""}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "settings", text: "서브넷 설정 편집" },
              { id: "rt", text: "라우팅 테이블 연결 편집" },
              { id: "nacl", text: "네트워크 ACL 연결 편집" },
              { id: "tags", text: "태그 관리" },
              { id: "delete", text: "서브넷 삭제", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "settings") go("edit-settings");
              if (a === "rt") go("edit-route-table");
              if (a === "nacl") go("edit-network-acl");
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
            { label: "서브넷 ID", value: <CopyText text={subnet.id} /> },
            { label: "상태", value: <StatusIndicator type="success">Available</StatusIndicator> },
            { label: "VPC", value: <ResourceLink id={topo.vpcOfSubnet(subnet.id)} showName /> },
            { label: "IPv4 CIDR", value: subnet.config.cidr },
            { label: "사용 가능한 IPv4 주소", value: availableIps(topo, subnet) ?? "–" },
            { label: "가용 영역", value: subnet.config.availabilityZone },
            { label: "라우팅 테이블", value: <ResourceLink id={rtId} fallback="없음" /> },
            { label: "네트워크 ACL", value: <ResourceLink id={nacl?.id} fallback="없음" /> },
            { label: "퍼블릭 IPv4 주소 자동 할당", value: subnet.config.mapPublicIpOnLaunch ? "예" : "아니요", info: <InfoLink topic="public-ip" /> },
            { label: "라우팅 기준 분류", value: <SubnetKindLabel topo={topo} subnetId={subnet.id} />, info: <InfoLink topic="subnet" /> },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="서브넷 세부 정보 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "route-table",
            label: "라우팅 테이블",
            content: (
              <Container
                header={
                  <ContainerHeader
                    title={rtId ? `라우팅 테이블: ${rtId}` : "라우팅 테이블"}
                    description={topo.routeTableLabel(routing.table)}
                    actions={<Button onClick={() => go("edit-route-table")}>라우팅 테이블 연결 편집</Button>}
                  />
                }
              >
                <RoutesTable topo={topo} routes={routing.routes} />
              </Container>
            ),
          },
          {
            id: "network-acl",
            label: "네트워크 ACL",
            content: (
              <Container header={<ContainerHeader title={nacl ? `네트워크 ACL: ${nacl.id}` : "네트워크 ACL"} actions={<Button onClick={() => go("edit-network-acl")}>네트워크 ACL 연결 편집</Button>} />}>
                {nacl ? (
                  <div className="grid gap-6 xl:grid-cols-2">
                    <NaclRulesTable title="인바운드 규칙" rules={nacl.config.inboundRules} direction="inbound" />
                    <NaclRulesTable title="아웃바운드 규칙" rules={nacl.config.outboundRules} direction="outbound" />
                  </div>
                ) : (
                  <p className="text-sm text-aws-text-2">연결된 네트워크 ACL이 없습니다.</p>
                )}
              </Container>
            ),
          },
          {
            id: "resources",
            label: `리소스 (${members.length})`,
            content: (
              <Container header={<ContainerHeader title="이 서브넷의 네트워크 인터페이스" description="인스턴스, NAT 게이트웨이, 로드 밸런서 노드, DB 인스턴스" />}>
                {members.length ? (
                  <ul className="divide-y divide-aws-divider text-sm">
                    {members.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          <ResourceLink id={e.ownerId} showName /> <span className="text-aws-text-2">({e.label})</span>
                        </span>
                        <span className="font-mono text-[13px] text-aws-text-2">
                          {ipText(e.privateIp)}
                          {e.publicIp !== null ? ` · 퍼블릭 ${ipText(e.publicIp)}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-aws-text-2">이 서브넷에는 아직 리소스가 없습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      <DeleteSubnetModal subnet={deleting ? subnet : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={subnet} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function EditSubnetSettingsPage({ id }: { id: string }) {
  const subnet = useResource(id, "subnet");
  const run = useRunAction();
  const [auto, setAuto] = useState(subnet?.config.mapPublicIpOnLaunch ?? false);
  if (!subnet) return <ResourceNotFound type="subnet" id={id} />;
  const save = () => {
    const r = run("ModifySubnetAttribute", (p) => editSubnetSettings(p, subnet.id, { mapPublicIpOnLaunch: auto }), { success: () => `서브넷 ${subnet.id}의 설정을 수정했습니다.`, flashError: true });
    if (r.ok) navigate(resourcePath("subnet", subnet.id));
  };
  return (
    <SpaceBetween>
      <PageHeader title="서브넷 설정 편집" description={`${subnet.id} (${displayName(subnet)})`} />
      <Container header={<ContainerHeader title="IP 주소 자동 할당 설정" info={<InfoLink topic="public-ip" />} />}>
        <Checkbox checked={auto} onChange={setAuto} description="이 서브넷에서 시작하는 인스턴스에 퍼블릭 IPv4 주소를 자동으로 할당합니다. 인스턴스 시작 시 개별적으로 바꿀 수 있습니다.">
          퍼블릭 IPv4 주소 자동 할당 활성화
        </Checkbox>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(resourcePath("subnet", subnet.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditSubnetRouteTablePage({ id }: { id: string }) {
  const subnet = useResource(id, "subnet");
  const topo = useTopology();
  const run = useRunAction();
  const initial = subnet ? topo.routeTableRefFor(subnet.id) : null;
  const [rtId, setRtId] = useState(initial?.kind === "explicit" || initial?.kind === "main" ? initial.routeTableId : "");
  const [error, setError] = useState<string | null>(null);
  const vpcId = subnet ? topo.vpcOfSubnet(subnet.id) : null;
  const tables = useMemo(() => (vpcId ? topo.routeTablesOfVpc(vpcId) : []), [topo, vpcId]);
  if (!subnet) return <ResourceNotFound type="subnet" id={id} />;
  const chosen = tables.find((t) => t.id === rtId);
  const save = () => {
    const target = chosen && !chosen.config.main ? chosen.id : null;
    const r = run("ReplaceRouteTableAssociation", (p) => replaceSubnetRouteTable(p, subnet.id, target), { success: () => `서브넷 ${subnet.id}의 라우팅 테이블 연결을 변경했습니다.` });
    if (r.ok) navigate(resourcePath("subnet", subnet.id), { query: { tab: "route-table" } });
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="라우팅 테이블 연결 편집" info={<InfoLink topic="route-table" />} description={`${subnet.id} (${displayName(subnet)})`} />
      <Container header={<ContainerHeader title="라우팅 테이블 ID" />}>
        <SpaceBetween size="m">
          <FormField label="라우팅 테이블" description="기본(main) 라우팅 테이블을 고르면 명시적 연결이 제거되고 VPC 기본 테이블을 사용합니다.">
            <SelectInput
              value={rtId}
              onChange={setRtId}
              placeholder="라우팅 테이블 선택"
              options={tables.map((t) => ({ value: t.id, label: `${t.id}${t.name ? ` (${t.name})` : ""}${t.config.main ? " · 기본" : ""}` }))}
            />
          </FormField>
          {chosen && vpcId && <RoutesTable topo={topo} routes={topo.routesOf(chosen.id, vpcId)} />}
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("subnet", subnet.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save} disabled={!chosen}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditSubnetNaclPage({ id }: { id: string }) {
  const subnet = useResource(id, "subnet");
  const topo = useTopology();
  const run = useRunAction();
  const [naclId, setNaclId] = useState(subnet ? (topo.naclOf(subnet.id)?.id ?? "") : "");
  const [error, setError] = useState<string | null>(null);
  if (!subnet) return <ResourceNotFound type="subnet" id={id} />;
  const vpcId = topo.vpcOfSubnet(subnet.id);
  const nacls = topo.ofType("network-acl").filter((n) => topo.vpcOf(n.id) === vpcId);
  const chosen = nacls.find((n) => n.id === naclId);
  const save = () => {
    const r = run("ReplaceNetworkAclAssociation", (p) => replaceSubnetNetworkAcl(p, subnet.id, naclId), { success: () => `서브넷 ${subnet.id}의 네트워크 ACL 연결을 변경했습니다.` });
    if (r.ok) navigate(resourcePath("subnet", subnet.id), { query: { tab: "network-acl" } });
    else setError(withHint(r));
  };
  return (
    <SpaceBetween>
      <PageHeader title="네트워크 ACL 연결 편집" info={<InfoLink topic="nacl" />} description={`${subnet.id} (${displayName(subnet)})`} />
      <Container header={<ContainerHeader title="네트워크 ACL" />}>
        <SpaceBetween size="m">
          <FormField label="네트워크 ACL ID" description="서브넷은 항상 하나의 네트워크 ACL과 연결됩니다.">
            <SelectInput value={naclId} onChange={setNaclId} placeholder="네트워크 ACL 선택" options={nacls.map((n) => ({ value: n.id, label: `${n.id}${n.name ? ` (${n.name})` : ""}${n.config.isDefault ? " · 기본" : ""}` }))} />
          </FormField>
          {chosen && (
            <div className="grid gap-6 xl:grid-cols-2">
              <NaclRulesTable title="인바운드 규칙" rules={chosen.config.inboundRules} direction="inbound" />
              <NaclRulesTable title="아웃바운드 규칙" rules={chosen.config.outboundRules} direction="outbound" />
            </div>
          )}
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <ErrorAlert message={error} /> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("subnet", subnet.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save} disabled={!chosen}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
