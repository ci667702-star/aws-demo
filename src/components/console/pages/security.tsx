"use client";

/** 보안 그룹, 네트워크 ACL */
import { useState } from "react";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import {
  createNetworkAcl,
  createSecurityGroup,
  deleteNetworkAcl,
  deleteSecurityGroup,
  editNetworkAclAssociations,
  editNetworkAclRules,
  editSecurityGroupRules,
} from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { Checkbox, FormActions, FormField, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { Badge, CopyText } from "../ui/status";
import { NameCell, ResourceNotFound, sortName, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { NaclRulesTable, SgRulesTable } from "./network-tables";
import {
  naclDraftsFromRules,
  NaclRuleEditor,
  naclRulesFromDrafts,
  newSgDraft,
  sgDraftsFromRules,
  SgRuleEditor,
  sgRulesFromDrafts,
  type NaclRuleDraft,
  type SgRuleDraft,
} from "./rule-editors";
import { EditNameModal } from "./shared-modals";

// ================================================================ 보안 그룹

type Sg = ResourceOfType<"security-group">;

function DeleteSgModal({ sg, onClose }: { sg: Sg | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!sg) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="보안 그룹 삭제"
      onConfirm={() => {
        const r = run("DeleteSecurityGroup", (p) => deleteSecurityGroup(p, sg.id), { success: () => `보안 그룹 ${sg.id}을(를) 삭제했습니다.` });
        if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
        navigate("/vpc/security-groups");
        return null;
      }}
    >
      <p>
        보안 그룹 <strong>{sg.id}</strong>({displayName(sg)})을(를) 삭제하시겠습니까?
      </p>
    </DeleteModal>
  );
}

export function SecurityGroupListPage({ base = "/vpc" }: { base?: "/vpc" | "/ec2" }) {
  const topo = useTopology();
  const sgs = topo.ofType("security-group");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = sgs.find((g) => g.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Sg>
        ariaLabel="보안 그룹 목록"
        items={sgs}
        trackBy={(g) => g.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(g) => displayName(g)}
        header={
          <PageHeader
            title="보안 그룹"
            counter={`(${sgs.length})`}
            info={<InfoLink topic="security-group" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "inbound", text: "인바운드 규칙 편집", disabled: !current },
                    { id: "outbound", text: "아웃바운드 규칙 편집", disabled: !current },
                    { id: "delete", text: "보안 그룹 삭제", disabled: !current || current.config.isDefault, disabledReason: "기본 보안 그룹은 삭제할 수 없습니다.", danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (!current) return;
                    if (id === "inbound") navigate(`${resourcePath("security-group", current.id)}/edit-inbound`);
                    if (id === "outbound") navigate(`${resourcePath("security-group", current.id)}/edit-outbound`);
                    if (id === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href(`${base}/security-groups/create`)}>
                  보안 그룹 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="보안 그룹 없음" description="VPC를 만들면 기본 보안 그룹이 함께 생성됩니다." />}
        columns={[
          { id: "id", header: "보안 그룹 ID", cell: (g) => <TypedResourceLink type="security-group" id={g.id} />, sortValue: (g) => g.id },
          { id: "name", header: "보안 그룹 이름", cell: (g) => <NameCell r={g} />, sortValue: sortName, filterValue: (g) => g.name },
          { id: "vpc", header: "VPC ID", cell: (g) => <ResourceLink id={topo.vpcOf(g.id)} />, filterValue: (g) => topo.vpcOf(g.id) ?? "" },
          { id: "desc", header: "설명", cell: (g) => <span className="text-aws-text-2">{g.config.description}</span>, filterValue: (g) => g.config.description },
          { id: "in", header: "인바운드 규칙 수", cell: (g) => `${g.config.inboundRules.length}개 권한 항목` },
          { id: "out", header: "아웃바운드 규칙 수", cell: (g) => `${g.config.outboundRules.length}개 권한 항목` },
          { id: "used", header: "사용 중인 리소스", cell: (g) => topo.resourcesUsingSecurityGroup(g.id).filter((r) => !(r.type === "ec2" && r.config.state === "terminated")).length },
        ]}
      />
      <DeleteSgModal sg={deleting ? current : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function CreateSecurityGroupPage({ base = "/vpc" }: { base?: "/vpc" | "/ec2" }) {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vpcId, setVpcId] = useState(vpcs.length === 1 ? vpcs[0].id : "");
  const [inbound, setInbound] = useState<SgRuleDraft[]>([]);
  const [outbound, setOutbound] = useState<SgRuleDraft[]>(() => [newSgDraft({ typeId: "all-traffic", peerMode: "anywhere" })]);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const inb = sgRulesFromDrafts(inbound);
    const out = sgRulesFromDrafts(outbound);
    const errors = { ...inb.errors, ...out.errors };
    setRowErrors(errors);
    if (Object.keys(errors).length) return setError("규칙의 입력값을 확인하세요.");
    const r = run("CreateSecurityGroup", (p) => createSecurityGroup(p, { name, description, vpcId, inboundRules: inb.rules, outboundRules: out.rules }), {
      success: (res) => `보안 그룹 ${res.createdId}(${name.trim()})을(를) 생성했습니다.`,
    });
    if (r.ok && r.createdId) navigate(resourcePath("security-group", r.createdId));
    else if (!r.ok) setError(r.error);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader
        title="보안 그룹 생성"
        info={<InfoLink topic="security-group" />}
        description="보안 그룹은 인스턴스·로드 밸런서·DB의 가상 방화벽 역할을 합니다. 허용 규칙만 지정할 수 있으며 일치하지 않는 트래픽은 거부됩니다."
      />
      <Container header={<ContainerHeader title="기본 세부 정보" />}>
        <SpaceBetween size="m">
          <FormField label="보안 그룹 이름" constraint="만든 후에는 이름을 편집할 수 없습니다. 'default'나 'sg-'로 시작하는 이름은 쓸 수 없습니다.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="예: web-sg" maxLength={255} />
          </FormField>
          <FormField label="설명">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="예: 웹 서버용 HTTP 허용" maxLength={255} />
          </FormField>
          <FormField label="VPC">
            <SelectInput value={vpcId} onChange={setVpcId} placeholder="VPC 선택" options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="인바운드 규칙" info={<InfoLink topic="security-group" />} description="이 보안 그룹이 연결된 리소스로 들어오는 트래픽 중 허용할 것을 지정합니다." />}>
        <SgRuleEditor direction="inbound" drafts={inbound} onChange={setInbound} errors={rowErrors} topo={topo} vpcId={vpcId || null} />
      </Container>
      <Container header={<ContainerHeader title="아웃바운드 규칙" description="콘솔에서 만든 보안 그룹에는 모든 아웃바운드 트래픽을 허용하는 규칙이 기본으로 들어 있습니다." />}>
        <SgRuleEditor direction="outbound" drafts={outbound} onChange={setOutbound} errors={rowErrors} topo={topo} vpcId={vpcId || null} />
      </Container>
      <FormActions error={error ? <Alert type="error" header="보안 그룹을 생성할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(`${base}/security-groups`)}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit">
          보안 그룹 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function SecurityGroupDetailPage({ id }: { id: string }) {
  const sg = useResource(id, "security-group");
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("inbound");
  const [deleting, setDeleting] = useState(false);
  if (!sg) return <ResourceNotFound type="security-group" id={id} />;
  const users = topo.resourcesUsingSecurityGroup(sg.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${sg.id} - ${sg.name}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "inbound", text: "인바운드 규칙 편집" },
              { id: "outbound", text: "아웃바운드 규칙 편집" },
              { id: "delete", text: "보안 그룹 삭제", disabled: sg.config.isDefault, disabledReason: "기본 보안 그룹은 삭제할 수 없습니다.", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "inbound") navigate(`${resourcePath("security-group", sg.id)}/edit-inbound`);
              if (a === "outbound") navigate(`${resourcePath("security-group", sg.id)}/edit-outbound`);
              if (a === "delete") setDeleting(true);
            }}
          />
        }
      />
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "보안 그룹 이름", value: sg.name },
            { label: "보안 그룹 ID", value: <CopyText text={sg.id} /> },
            { label: "설명", value: sg.config.description },
            { label: "VPC ID", value: <ResourceLink id={topo.vpcOf(sg.id)} showName /> },
            { label: "인바운드 규칙 수", value: `${sg.config.inboundRules.length}개 권한 항목` },
            { label: "아웃바운드 규칙 수", value: `${sg.config.outboundRules.length}개 권한 항목` },
            { label: "기본 보안 그룹", value: sg.config.isDefault ? <Badge color="blue">default</Badge> : "아니요", info: sg.config.isDefault ? <InfoLink topic="default-sg" /> : undefined },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="보안 그룹 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "inbound",
            label: "인바운드 규칙",
            content: (
              <Container header={<ContainerHeader title={`인바운드 규칙 (${sg.config.inboundRules.length})`} actions={<ButtonLink href={href(`${resourcePath("security-group", sg.id)}/edit-inbound`)}>인바운드 규칙 편집</ButtonLink>} />}>
                <SgRulesTable rules={sg.config.inboundRules} direction="inbound" topo={topo} />
              </Container>
            ),
          },
          {
            id: "outbound",
            label: "아웃바운드 규칙",
            content: (
              <Container header={<ContainerHeader title={`아웃바운드 규칙 (${sg.config.outboundRules.length})`} actions={<ButtonLink href={href(`${resourcePath("security-group", sg.id)}/edit-outbound`)}>아웃바운드 규칙 편집</ButtonLink>} />}>
                <SgRulesTable rules={sg.config.outboundRules} direction="outbound" topo={topo} />
              </Container>
            ),
          },
          {
            id: "usage",
            label: `연결된 리소스 (${users.length})`,
            content: (
              <Container header={<ContainerHeader title="이 보안 그룹을 사용하는 리소스" />}>
                {users.length ? (
                  <ul className="space-y-1 text-sm">
                    {users.map((r) => (
                      <li key={r.id}>
                        <ResourceLink id={r.id} showName /> {r.type === "ec2" && r.config.state === "terminated" && <span className="text-aws-text-2">(종료됨)</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-aws-text-2">이 보안 그룹을 사용하는 리소스가 없습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      <DeleteSgModal sg={deleting ? sg : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function EditSgRulesPage({ id, direction }: { id: string; direction: "inbound" | "outbound" }) {
  const sg = useResource(id, "security-group");
  const topo = useTopology();
  const run = useRunAction();
  const [drafts, setDrafts] = useState<SgRuleDraft[]>(() => (sg ? sgDraftsFromRules(direction === "inbound" ? sg.config.inboundRules : sg.config.outboundRules) : []));
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!sg) return <ResourceNotFound type="security-group" id={id} />;
  const label = direction === "inbound" ? "인바운드" : "아웃바운드";
  const save = () => {
    const { rules, errors } = sgRulesFromDrafts(drafts);
    setRowErrors(errors);
    if (Object.keys(errors).length) return setError("규칙의 입력값을 확인하세요.");
    const r = run(direction === "inbound" ? "AuthorizeSecurityGroupIngress" : "AuthorizeSecurityGroupEgress", (p) => editSecurityGroupRules(p, sg.id, direction, rules), {
      success: () => `보안 그룹 ${sg.id}의 ${label} 규칙을 저장했습니다.`,
    });
    if (r.ok) navigate(resourcePath("security-group", sg.id), { query: { tab: direction } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title={`${label} 규칙 편집`} info={<InfoLink topic="security-group" />} description={`${sg.id} - ${sg.name}. 보안 그룹은 상태 저장(stateful)이라 허용된 요청의 응답은 자동으로 허용됩니다.`} />
      <Container header={<ContainerHeader title={`${label} 규칙`} />}>
        <SgRuleEditor direction={direction} drafts={drafts} onChange={setDrafts} errors={rowErrors} topo={topo} vpcId={topo.vpcOf(sg.id)} selfId={sg.id} />
      </Container>
      <FormActions error={error ? <Alert type="error" header="규칙을 저장할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("security-group", sg.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          규칙 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

// ================================================================ 네트워크 ACL

type Nacl = ResourceOfType<"network-acl">;

function DeleteNaclModal({ nacl, onClose }: { nacl: Nacl | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!nacl) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="네트워크 ACL 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = run("DeleteNetworkAcl", (p) => deleteNetworkAcl(p, nacl.id), { success: () => `네트워크 ACL ${nacl.id}을(를) 삭제했습니다.` });
        if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
        navigate("/vpc/network-acls");
        return null;
      }}
    >
      <p>
        네트워크 ACL <strong>{displayName(nacl)}</strong>을(를) 삭제하시겠습니까?
      </p>
    </DeleteModal>
  );
}

export function NaclListPage() {
  const topo = useTopology();
  const nacls = topo.ofType("network-acl");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  const current = nacls.find((n) => n.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Nacl>
        ariaLabel="네트워크 ACL 목록"
        items={nacls}
        trackBy={(n) => n.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(n) => displayName(n)}
        header={
          <PageHeader
            title="네트워크 ACL"
            counter={`(${nacls.length})`}
            info={<InfoLink topic="nacl" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "inbound", text: "인바운드 규칙 편집", disabled: !current },
                    { id: "outbound", text: "아웃바운드 규칙 편집", disabled: !current },
                    { id: "assoc", text: "서브넷 연결 편집", disabled: !current },
                    { id: "tags", text: "태그 관리", disabled: !current },
                    { id: "delete", text: "네트워크 ACL 삭제", disabled: !current || current.config.isDefault, disabledReason: "기본 네트워크 ACL은 삭제할 수 없습니다.", danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (!current) return;
                    if (id === "inbound") navigate(`${resourcePath("network-acl", current.id)}/edit-inbound`);
                    if (id === "outbound") navigate(`${resourcePath("network-acl", current.id)}/edit-outbound`);
                    if (id === "assoc") navigate(`${resourcePath("network-acl", current.id)}/edit-associations`);
                    if (id === "tags") setNaming(true);
                    if (id === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/vpc/network-acls/create")}>
                  네트워크 ACL 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="네트워크 ACL 없음" description="VPC를 만들면 모든 트래픽을 허용하는 기본 네트워크 ACL이 함께 생성됩니다." />}
        columns={[
          { id: "name", header: "Name", cell: (n) => <NameCell r={n} />, sortValue: sortName, filterValue: (n) => n.name },
          { id: "id", header: "네트워크 ACL ID", cell: (n) => <TypedResourceLink type="network-acl" id={n.id} />, sortValue: (n) => n.id },
          { id: "assoc", header: "연결 대상", cell: (n) => { const c = topo.outgoing(n.id, "network-acl-subnet").length; return c ? `${c}개 서브넷` : "–"; } },
          { id: "default", header: "기본", cell: (n) => (n.config.isDefault ? "예" : "아니요") },
          { id: "vpc", header: "VPC ID", cell: (n) => <ResourceLink id={topo.vpcOf(n.id)} /> },
          { id: "in", header: "인바운드 규칙 수", cell: (n) => n.config.inboundRules.length + 1 },
          { id: "out", header: "아웃바운드 규칙 수", cell: (n) => n.config.outboundRules.length + 1 },
        ]}
      />
      <DeleteNaclModal nacl={deleting ? current : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function CreateNaclPage() {
  const topo = useTopology();
  const run = useRunAction();
  const [name, setName] = useState("");
  const [vpcId, setVpcId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = run("CreateNetworkAcl", (p) => createNetworkAcl(p, { name, vpcId }), { success: (res) => `네트워크 ACL ${res.createdId}을(를) 생성했습니다.` });
    if (r.ok && r.createdId) navigate(resourcePath("network-acl", r.createdId));
    else if (!r.ok) setError(r.error);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="네트워크 ACL 생성" info={<InfoLink topic="nacl" />} description="네트워크 ACL은 서브넷 단위의 상태 비저장 방화벽입니다." />
      <Container header={<ContainerHeader title="네트워크 ACL 설정" />}>
        <SpaceBetween size="m">
          <FormField label="이름" optional>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="my-network-acl-01" />
          </FormField>
          <FormField label="VPC" error={error ?? undefined}>
            <SelectInput value={vpcId} onChange={setVpcId} placeholder="VPC 선택" options={topo.ofType("vpc").map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))} />
          </FormField>
          <Alert type="info">새 네트워크 ACL에는 규칙이 없어 모든 인바운드·아웃바운드 트래픽을 거부합니다. 서브넷과 연결하기 전에 필요한 규칙을 추가하세요.</Alert>
        </SpaceBetween>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href("/vpc/network-acls")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit" disabled={!vpcId}>
          네트워크 ACL 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function NaclDetailPage({ id }: { id: string }) {
  const nacl = useResource(id, "network-acl");
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("inbound");
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  if (!nacl) return <ResourceNotFound type="network-acl" id={id} />;
  const subnets = topo.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId);
  const go = (s: string) => navigate(`${resourcePath("network-acl", nacl.id)}/${s}`);
  return (
    <SpaceBetween>
      <PageHeader
        title={`${nacl.id}${nacl.name ? ` / ${nacl.name}` : ""}`}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "inbound", text: "인바운드 규칙 편집" },
              { id: "outbound", text: "아웃바운드 규칙 편집" },
              { id: "assoc", text: "서브넷 연결 편집" },
              { id: "tags", text: "태그 관리" },
              { id: "delete", text: "네트워크 ACL 삭제", disabled: nacl.config.isDefault, danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "inbound") go("edit-inbound");
              if (a === "outbound") go("edit-outbound");
              if (a === "assoc") go("edit-associations");
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
            { label: "네트워크 ACL ID", value: <CopyText text={nacl.id} /> },
            { label: "기본", value: nacl.config.isDefault ? "예" : "아니요" },
            { label: "VPC ID", value: <ResourceLink id={topo.vpcOf(nacl.id)} showName /> },
            { label: "연결 대상", value: subnets.length ? `${subnets.length}개 서브넷` : "–" },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="네트워크 ACL 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "inbound",
            label: "인바운드 규칙",
            content: (
              <Container header={<ContainerHeader title={`인바운드 규칙 (${nacl.config.inboundRules.length + 1})`} info={<InfoLink topic="nacl" />} actions={<Button onClick={() => go("edit-inbound")}>인바운드 규칙 편집</Button>} />}>
                <NaclRulesTable rules={nacl.config.inboundRules} direction="inbound" />
              </Container>
            ),
          },
          {
            id: "outbound",
            label: "아웃바운드 규칙",
            content: (
              <Container header={<ContainerHeader title={`아웃바운드 규칙 (${nacl.config.outboundRules.length + 1})`} actions={<Button onClick={() => go("edit-outbound")}>아웃바운드 규칙 편집</Button>} />}>
                <NaclRulesTable rules={nacl.config.outboundRules} direction="outbound" />
              </Container>
            ),
          },
          {
            id: "associations",
            label: "서브넷 연결",
            content: (
              <Container header={<ContainerHeader title={`서브넷 연결 (${subnets.length})`} actions={<Button onClick={() => go("edit-associations")}>서브넷 연결 편집</Button>} />}>
                {subnets.length ? (
                  <ul className="space-y-1 text-sm">
                    {subnets.map((s) => (
                      <li key={s}>
                        <ResourceLink id={s} showName />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-aws-text-2">연결된 서브넷이 없습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      <DeleteNaclModal nacl={deleting ? nacl : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={nacl} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function EditNaclRulesPage({ id, direction }: { id: string; direction: "inbound" | "outbound" }) {
  const nacl = useResource(id, "network-acl");
  const run = useRunAction();
  const [drafts, setDrafts] = useState<NaclRuleDraft[]>(() => (nacl ? naclDraftsFromRules(direction === "inbound" ? nacl.config.inboundRules : nacl.config.outboundRules) : []));
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!nacl) return <ResourceNotFound type="network-acl" id={id} />;
  const label = direction === "inbound" ? "인바운드" : "아웃바운드";
  const save = () => {
    const { rules, errors } = naclRulesFromDrafts(drafts);
    setRowErrors(errors);
    if (Object.keys(errors).length) return setError("규칙의 입력값을 확인하세요.");
    const r = run("ReplaceNetworkAclEntries", (p) => editNetworkAclRules(p, nacl.id, direction, rules), { success: () => `네트워크 ACL ${nacl.id}의 ${label} 규칙을 저장했습니다.` });
    if (r.ok) navigate(resourcePath("network-acl", nacl.id), { query: { tab: direction } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader
        title={`${label} 규칙 편집`}
        info={<InfoLink topic="nacl" />}
        description={`${nacl.id} — 규칙 번호가 작은 것부터 평가해 처음 일치한 규칙을 적용합니다. 상태 비저장이므로 응답 트래픽(임시 포트 1024-65535)도 허용해야 합니다.`}
      />
      <Container header={<ContainerHeader title={`${label} 규칙`} />}>
        <NaclRuleEditor direction={direction} drafts={drafts} onChange={setDrafts} errors={rowErrors} />
      </Container>
      <FormActions error={error ? <Alert type="error" header="규칙을 저장할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("network-acl", nacl.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditNaclAssociationsPage({ id }: { id: string }) {
  const nacl = useResource(id, "network-acl");
  const topo = useTopology();
  const run = useRunAction();
  const [selected, setSelected] = useState<string[]>(() => (nacl ? topo.outgoing(nacl.id, "network-acl-subnet").map((c) => c.targetResourceId) : []));
  const [error, setError] = useState<string | null>(null);
  if (!nacl) return <ResourceNotFound type="network-acl" id={id} />;
  const vpcId = topo.vpcOf(nacl.id);
  const subnets = vpcId ? topo.subnetsOfVpc(vpcId) : [];
  const save = () => {
    const r = run("ReplaceNetworkAclAssociation", (p) => editNetworkAclAssociations(p, nacl.id, selected), { success: () => `네트워크 ACL ${nacl.id}의 서브넷 연결을 업데이트했습니다.` });
    if (r.ok) navigate(resourcePath("network-acl", nacl.id), { query: { tab: "associations" } });
    else setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  return (
    <SpaceBetween>
      <PageHeader title="서브넷 연결 편집" info={<InfoLink topic="nacl" />} description={`${nacl.id} — 선택을 해제한 서브넷은 VPC의 기본 네트워크 ACL로 돌아갑니다.`} />
      <Container header={<ContainerHeader title={`서브넷 (${subnets.length})`} />}>
        {subnets.length ? (
          <ul className="space-y-2">
            {subnets.map((s) => (
              <li key={s.id}>
                <Checkbox
                  checked={selected.includes(s.id)}
                  onChange={(v) => setSelected(v ? [...selected, s.id] : selected.filter((x) => x !== s.id))}
                  description={`${s.config.cidr} · 현재 네트워크 ACL: ${topo.naclOf(s.id)?.id ?? "없음"}`}
                >
                  {s.id}
                  {s.name ? ` / ${s.name}` : ""}
                </Checkbox>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-aws-text-2">이 VPC에 서브넷이 없습니다.</p>
        )}
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("network-acl", nacl.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
