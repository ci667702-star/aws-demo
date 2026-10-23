"use client";

import { useState } from "react";
import { AVAILABILITY_ZONES, RDS_DEFAULT_PORT, RDS_INSTANCE_CLASSES, type ConfigOf, type ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import {
  changeDatabaseState,
  createDatabase,
  createDbSubnetGroup,
  deleteDatabase,
  deleteDbSubnetGroup,
  editDbSubnetGroup,
  modifyDatabase,
} from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { FormActions, FormField, MultiSelect, RadioGroup, SelectInput, TextInput, Tiles } from "../ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { CopyText, StatusIndicator } from "../ui/status";
import { DbState, ipText, ResourceNotFound, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { SgRulesTable } from "./network-tables";

type Db = ResourceOfType<"rds">;
type Dbsg = ResourceOfType<"db-subnet-group">;
type InstanceClass = ConfigOf<"rds">["instanceClass"];

const CLASS_INFO: Record<InstanceClass, string> = {
  "db.t3.micro": "vCPU 2개 · 메모리 1GiB",
  "db.t3.small": "vCPU 2개 · 메모리 2GiB",
  "db.t3.medium": "vCPU 2개 · 메모리 4GiB",
  "db.m5.large": "vCPU 2개 · 메모리 8GiB",
};

// ================================================================ DB 서브넷 그룹

function DbSubnetGroupFields({
  vpcId,
  setVpcId,
  azs,
  setAzs,
  subnetIds,
  setSubnetIds,
  lockVpc,
}: {
  vpcId: string;
  setVpcId: (v: string) => void;
  azs: string[];
  setAzs: (v: string[]) => void;
  subnetIds: string[];
  setSubnetIds: (v: string[]) => void;
  lockVpc?: boolean;
}) {
  const topo = useTopology();
  const subnets = vpcId ? topo.subnetsOfVpc(vpcId) : [];
  const zoneOptions = AVAILABILITY_ZONES.filter((z) => subnets.some((s) => s.config.availabilityZone === z)).map((z) => ({ value: z, label: z }));
  const subnetOptions = subnets
    .filter((s) => azs.includes(s.config.availabilityZone))
    .map((s) => ({ value: s.id, label: `${s.id} (${displayName(s)})`, description: `${s.config.availabilityZone} · ${s.config.cidr} · ${{ public: "퍼블릭", "private-nat": "프라이빗(NAT)", "private-isolated": "프라이빗", unattached: "-" }[topo.classifySubnet(s.id).kind]}` }));
  return (
    <SpaceBetween size="m">
      <FormField label="VPC" description={lockVpc ? "만든 뒤에는 VPC를 바꿀 수 없습니다." : "DB 서브넷 그룹을 만들 VPC"}>
        <SelectInput
          value={vpcId}
          disabled={lockVpc}
          onChange={(v) => {
            setVpcId(v);
            setAzs([]);
            setSubnetIds([]);
          }}
          placeholder="VPC 선택"
          options={topo.ofType("vpc").map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))}
        />
      </FormField>
      <FormField label="가용 영역" info={<InfoLink topic="availability-zone" />} constraint="최소 2개 가용 영역">
        <MultiSelect aria-label="가용 영역" selected={azs} onChange={(v) => { setAzs(v); setSubnetIds(subnetIds.filter((id) => v.includes(topo.getOfType(id, "subnet")?.config.availabilityZone ?? ""))); }} options={zoneOptions} empty={vpcId ? "이 VPC에 서브넷이 없습니다." : "먼저 VPC를 선택하세요."} />
      </FormField>
      <FormField label="서브넷" description="DB 인스턴스는 보통 인터넷 경로가 없는 프라이빗 서브넷에 둡니다.">
        <MultiSelect aria-label="서브넷" selected={subnetIds} onChange={setSubnetIds} options={subnetOptions} empty="가용 영역을 먼저 선택하세요." />
      </FormField>
    </SpaceBetween>
  );
}

export function DbSubnetGroupListPage() {
  const topo = useTopology();
  const groups = topo.ofType("db-subnet-group");
  const run = useRunAction();
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = groups.find((g) => g.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Dbsg>
        ariaLabel="DB 서브넷 그룹 목록"
        items={groups}
        trackBy={(g) => g.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(g) => g.name}
        header={
          <PageHeader
            title="서브넷 그룹"
            counter={`(${groups.length})`}
            info={<InfoLink topic="db-subnet-group" />}
            actions={
              <>
                <Button disabled={!current} onClick={() => current && navigate(`${resourcePath("db-subnet-group", current.id)}/edit`)}>
                  편집
                </Button>
                <Button disabled={!current} onClick={() => setDeleting(true)}>
                  삭제
                </Button>
                <ButtonLink variant="primary" href={href("/rds/subnet-groups/create")}>
                  DB 서브넷 그룹 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="DB 서브넷 그룹 없음" description="DB 인스턴스를 만들려면 서로 다른 가용 영역의 서브넷 2개 이상으로 DB 서브넷 그룹을 만드세요." action={<ButtonLink href={href("/rds/subnet-groups/create")}>DB 서브넷 그룹 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (g) => <TypedResourceLink type="db-subnet-group" id={g.id}>{g.name}</TypedResourceLink>, sortValue: (g) => g.name },
          { id: "desc", header: "설명", cell: (g) => <span className="text-aws-text-2">{g.config.description}</span> },
          { id: "state", header: "상태", cell: () => <StatusIndicator type="success">완료</StatusIndicator> },
          { id: "vpc", header: "VPC", cell: (g) => <ResourceLink id={topo.vpcsOf(g.id)[0]} /> },
          { id: "subnets", header: "서브넷", cell: (g) => `${topo.dbSubnetGroupSubnets(g.id).length}개` },
        ]}
      />
      {deleting && current && (
        <DeleteModal
          open
          onClose={() => setDeleting(false)}
          title="DB 서브넷 그룹 삭제"
          onConfirm={() => {
            const r = run("DeleteDBSubnetGroup", (p) => deleteDbSubnetGroup(p, current.id), { success: () => `DB 서브넷 그룹 ${current.name}을(를) 삭제했습니다.` });
            return r.ok ? null : r.error;
          }}
        >
          <p>
            DB 서브넷 그룹 <strong>{current.name}</strong>을(를) 삭제하시겠습니까?
          </p>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

export function CreateDbSubnetGroupPage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vpcId, setVpcId] = useState(vpcs.length === 1 ? vpcs[0].id : "");
  const [azs, setAzs] = useState<string[]>([]);
  const [subnetIds, setSubnetIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const r = run("CreateDBSubnetGroup", (p) => createDbSubnetGroup(p, { name, description, vpcId, subnetIds }), { success: () => `DB 서브넷 그룹 ${name.trim().toLowerCase()}을(를) 생성했습니다.` });
    if (r.ok) navigate("/rds/subnet-groups");
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="DB 서브넷 그룹 생성" info={<InfoLink topic="db-subnet-group" />} description="DB 인스턴스를 배치할 서브넷 묶음을 만듭니다." />
      <Container header={<ContainerHeader title="서브넷 그룹 세부 정보" />}>
        <SpaceBetween size="m">
          <FormField label="이름" constraint="영문 소문자, 숫자, 공백, 마침표, 밑줄, 하이픈. 'default'는 쓸 수 없습니다.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-db-subnets" maxLength={255} />
          </FormField>
          <FormField label="설명">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="DB용 프라이빗 서브넷" maxLength={255} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="서브넷 추가" />}>
        <DbSubnetGroupFields vpcId={vpcId} setVpcId={setVpcId} azs={azs} setAzs={setAzs} subnetIds={subnetIds} setSubnetIds={setSubnetIds} />
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href("/rds/subnet-groups")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function DbSubnetGroupDetailPage({ id }: { id: string }) {
  const group = useResource(id, "db-subnet-group");
  const topo = useTopology();
  if (!group) return <ResourceNotFound type="db-subnet-group" id={id} />;
  const subnets = topo.dbSubnetGroupSubnets(group.id);
  const users = topo.ofType("rds").filter((r) => topo.dbSubnetGroupOf(r.id)?.id === group.id);
  return (
    <SpaceBetween>
      <PageHeader title={group.name} actions={<ButtonLink href={href(`${resourcePath("db-subnet-group", group.id)}/edit`)}>편집</ButtonLink>} />
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "이름", value: group.name },
            { label: "설명", value: group.config.description },
            { label: "VPC", value: <ResourceLink id={topo.vpcsOf(group.id)[0]} showName /> },
            { label: "가용 영역", value: [...new Set(subnets.map((s) => s.config.availabilityZone))].join(", ") },
            { label: "사용 중인 DB 인스턴스", value: users.length ? users.map((u) => <div key={u.id}><ResourceLink id={u.id} showName /></div>) : "–" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title={`서브넷 (${subnets.length})`} />}>
        <ul className="space-y-1 text-sm">
          {subnets.map((s) => (
            <li key={s.id}>
              <ResourceLink id={s.id} showName /> <span className="text-aws-text-2">{s.config.availabilityZone} · {s.config.cidr}</span>
            </li>
          ))}
        </ul>
      </Container>
    </SpaceBetween>
  );
}

export function EditDbSubnetGroupPage({ id }: { id: string }) {
  const group = useResource(id, "db-subnet-group");
  const topo = useTopology();
  const run = useRunAction();
  const initialSubnets = group ? topo.dbSubnetGroupSubnets(group.id) : [];
  const [description, setDescription] = useState(group?.config.description ?? "");
  const [vpcId, setVpcId] = useState(group ? (topo.vpcsOf(group.id)[0] ?? "") : "");
  const [azs, setAzs] = useState<string[]>(() => [...new Set(initialSubnets.map((s) => s.config.availabilityZone))]);
  const [subnetIds, setSubnetIds] = useState<string[]>(() => initialSubnets.map((s) => s.id));
  const [error, setError] = useState<string | null>(null);
  if (!group) return <ResourceNotFound type="db-subnet-group" id={id} />;
  const save = () => {
    const r = run("ModifyDBSubnetGroup", (p) => editDbSubnetGroup(p, group.id, { description, subnetIds }), { success: () => `DB 서브넷 그룹 ${group.name}을(를) 수정했습니다.` });
    if (r.ok) navigate(resourcePath("db-subnet-group", group.id));
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="DB 서브넷 그룹 편집" description={group.name} />
      <Container header={<ContainerHeader title="서브넷 그룹 세부 정보" />}>
        <FormField label="설명">
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} />
        </FormField>
      </Container>
      <Container header={<ContainerHeader title="서브넷" />}>
        <DbSubnetGroupFields vpcId={vpcId} setVpcId={setVpcId} azs={azs} setAzs={setAzs} subnetIds={subnetIds} setSubnetIds={setSubnetIds} lockVpc />
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("db-subnet-group", group.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

// ================================================================ 데이터베이스

function DbDeleteModal({ db, onClose }: { db: Db | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!db) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={`${db.name} 인스턴스를 삭제하시겠습니까?`}
      confirmText="delete me"
      onConfirm={() => {
        const r = run("DeleteDBInstance", (p) => deleteDatabase(p, db.id), { success: () => `DB 인스턴스 ${db.name}을(를) 삭제했습니다.` });
        if (!r.ok) return r.error;
        navigate("/rds/databases");
        return null;
      }}
    >
      <p>가상 DB 인스턴스를 삭제합니다. (실제 데이터와 스냅샷은 존재하지 않습니다.)</p>
    </DeleteModal>
  );
}

export function DatabaseListPage() {
  const topo = useTopology();
  const dbs = topo.ofType("rds");
  const run = useRunAction();
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = dbs.find((d) => d.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Db>
        ariaLabel="데이터베이스 목록"
        items={dbs}
        trackBy={(d) => d.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(d) => d.name}
        header={
          <PageHeader
            title="데이터베이스"
            counter={`(${dbs.length})`}
            info={<InfoLink topic="rds" />}
            actions={
              <>
                <Button disabled={!current} onClick={() => current && navigate(`${resourcePath("rds", current.id)}/modify`)}>
                  수정
                </Button>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "stop", text: "일시적으로 중지", disabled: current?.config.state !== "available" },
                    { id: "start", text: "시작", disabled: current?.config.state !== "stopped" },
                    { id: "delete", text: "삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(a) => {
                    if (!current) return;
                    if (a === "stop" || a === "start") run(a === "stop" ? "StopDBInstance" : "StartDBInstance", (p) => changeDatabaseState(p, current.id, a), { success: () => `DB 인스턴스 ${current.name}을(를) ${a === "stop" ? "중지했습니다" : "시작하는 중입니다"}.`, flashError: true });
                    if (a === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/rds/databases/create")}>
                  데이터베이스 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="데이터베이스 없음" description="DB 서브넷 그룹과 보안 그룹을 준비한 뒤 데이터베이스를 만드세요." action={<ButtonLink href={href("/rds/databases/create")}>데이터베이스 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "DB 식별자", cell: (d) => <TypedResourceLink type="rds" id={d.id}>{d.name}</TypedResourceLink>, sortValue: (d) => d.name },
          { id: "state", header: "상태", cell: (d) => <DbState state={d.config.state} /> },
          { id: "role", header: "역할", cell: () => "인스턴스" },
          { id: "engine", header: "엔진", cell: (d) => (d.config.engine === "mysql" ? "MySQL Community" : "PostgreSQL") },
          { id: "az", header: "리전 및 AZ", cell: (d) => topo.rdsPlacement(d.id).primary?.config.availabilityZone ?? "–" },
          { id: "size", header: "크기", cell: (d) => d.config.instanceClass },
          { id: "vpc", header: "VPC", cell: (d) => <ResourceLink id={topo.vpcOf(d.id)} /> },
          { id: "maz", header: "다중 AZ", cell: (d) => (d.config.multiAz ? "예" : "아니요") },
        ]}
      />
      <DbDeleteModal db={deleting ? current : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

interface DbNetworkDraft {
  instanceClass: InstanceClass;
  storage: string;
  multiAz: boolean;
  publiclyAccessible: boolean;
  sgIds: string[];
  port: string;
}

function DbInstanceFields({ draft, set, vpcId }: { draft: DbNetworkDraft; set: (p: Partial<DbNetworkDraft>) => void; vpcId: string | null }) {
  const topo = useTopology();
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  return (
    <>
      <Container header={<ContainerHeader title="인스턴스 구성" />}>
        <FormField label="DB 인스턴스 클래스" description="성능은 시뮬레이션하지 않으며 가상 비용 추정에만 사용됩니다.">
          <SelectInput value={draft.instanceClass} onChange={(v) => set({ instanceClass: v as InstanceClass })} options={RDS_INSTANCE_CLASSES.map((c) => ({ value: c, label: c, description: CLASS_INFO[c] }))} />
        </FormField>
      </Container>
      <Container header={<ContainerHeader title="스토리지" />}>
        <FormField label="할당된 스토리지 (GiB)" constraint="20~65536 GiB">
          <TextInput value={draft.storage} onChange={(e) => set({ storage: e.target.value })} inputMode="numeric" className="max-w-40" />
        </FormField>
      </Container>
      <Container header={<ContainerHeader title="가용성 및 내구성" />}>
        <RadioGroup
          aria-label="배포 옵션"
          value={draft.multiAz ? "multi" : "single"}
          onChange={(v) => set({ multiAz: v === "multi" })}
          items={[
            { value: "single", label: "단일 DB 인스턴스", description: "대기 DB 인스턴스 없이 단일 가용 영역에 배치" },
            { value: "multi", label: "다중 AZ DB 인스턴스", description: "다른 가용 영역에 대기 인스턴스를 둡니다 (가상)" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="연결" info={<InfoLink topic="rds-public" />} />}>
        <SpaceBetween size="m">
          <FormField label="퍼블릭 액세스" info={<InfoLink topic="rds-public" />}>
            <RadioGroup
              aria-label="퍼블릭 액세스"
              value={draft.publiclyAccessible ? "yes" : "no"}
              onChange={(v) => set({ publiclyAccessible: v === "yes" })}
              items={[
                { value: "yes", label: "예", description: "VPC 외부에서 DB에 연결할 수 있도록 퍼블릭 IP를 할당합니다. VPC의 DNS 확인과 DNS 호스트 이름이 켜져 있어야 합니다." },
                { value: "no", label: "아니요", description: "VPC 안의 리소스만 DB에 연결할 수 있습니다." },
              ]}
            />
          </FormField>
          <FormField label="VPC 보안 그룹(방화벽)" constraint="DB 포트를 필요한 소스(예: 앱 서버 보안 그룹)에만 허용하세요.">
            <MultiSelect aria-label="VPC 보안 그룹" selected={draft.sgIds} onChange={(v) => set({ sgIds: v })} max={5} empty={vpcId ? "이 VPC에 보안 그룹이 없습니다." : "먼저 DB 서브넷 그룹을 선택하세요."} options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.id})`, description: g.config.description }))} />
          </FormField>
          <ExpandableSection header="추가 구성">
            <FormField label="데이터베이스 포트" constraint="1150~65535">
              <TextInput value={draft.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" className="max-w-32" />
            </FormField>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    </>
  );
}

export function CreateDatabasePage() {
  const topo = useTopology();
  const run = useRunAction();
  const [engine, setEngine] = useState<"mysql" | "postgres">("mysql");
  const [template, setTemplate] = useState<"production" | "devtest" | "free">("devtest");
  const [identifier, setIdentifier] = useState("database-1");
  const [vpcId, setVpcId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [draft, setDraft] = useState<DbNetworkDraft>({ instanceClass: "db.t3.micro", storage: "20", multiAz: false, publiclyAccessible: false, sgIds: [], port: String(RDS_DEFAULT_PORT.mysql) });
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<DbNetworkDraft>) => setDraft({ ...draft, ...p });
  const groups = topo.ofType("db-subnet-group").filter((g) => !vpcId || topo.vpcsOf(g.id).includes(vpcId));
  const applyTemplate = (t: typeof template) => {
    setTemplate(t);
    if (t === "production") set({ instanceClass: "db.m5.large", multiAz: true, storage: "100" });
    else set({ instanceClass: "db.t3.micro", multiAz: false, storage: "20" });
  };
  const submit = () => {
    setError(null);
    if (!/^\d+$/.test(draft.storage) || !/^\d+$/.test(draft.port)) return setError("[InvalidParameterValue] 스토리지와 포트는 숫자여야 합니다.");
    const r = run(
      "CreateDBInstance",
      (p) =>
        createDatabase(p, {
          identifier,
          engine,
          instanceClass: draft.instanceClass,
          allocatedStorageGb: Number(draft.storage),
          multiAz: draft.multiAz,
          dbSubnetGroupId: groupId,
          publiclyAccessible: draft.publiclyAccessible,
          securityGroupIds: draft.sgIds,
          port: Number(draft.port),
        }),
      { success: () => `데이터베이스 ${identifier.trim()}을(를) 생성하는 중입니다.` },
    );
    if (r.ok && r.createdId) navigate(resourcePath("rds", r.createdId));
    else if (!r.ok) setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  return (
    <SpaceBetween>
      <PageHeader title="데이터베이스 생성" info={<InfoLink topic="rds" />} description="표준 생성 — 가상 DB 인스턴스를 만듭니다. 실제 데이터베이스 엔진은 실행되지 않으며 네트워크 연결만 시뮬레이션합니다." />
      <Container header={<ContainerHeader title="엔진 옵션" />}>
        <Tiles
          aria-label="엔진 유형"
          value={engine}
          columns={2}
          onChange={(v) => {
            setEngine(v as typeof engine);
            set({ port: String(RDS_DEFAULT_PORT[v as typeof engine]) });
          }}
          items={[
            { value: "mysql", label: "MySQL", description: "기본 포트 3306" },
            { value: "postgres", label: "PostgreSQL", description: "기본 포트 5432" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="템플릿" description="템플릿은 아래 설정의 기본값만 채웁니다. 모든 값은 직접 바꿀 수 있습니다." />}>
        <Tiles
          aria-label="템플릿"
          value={template}
          onChange={(v) => applyTemplate(v as typeof template)}
          items={[
            { value: "production", label: "프로덕션", description: "다중 AZ, db.m5.large, 100GiB" },
            { value: "devtest", label: "개발/테스트", description: "단일 AZ, db.t3.micro, 20GiB" },
            { value: "free", label: "프리 티어 (가상)", description: "단일 AZ, db.t3.micro, 20GiB" },
          ]}
        />
      </Container>
      <Container header={<ContainerHeader title="설정" />}>
        <SpaceBetween size="m">
          <FormField label="DB 인스턴스 식별자" constraint="영문 소문자로 시작, 1~63자의 영문 소문자·숫자·하이픈. 하이픈으로 끝나거나 연속 하이픈을 쓸 수 없습니다.">
            <TextInput value={identifier} onChange={(e) => setIdentifier(e.target.value)} maxLength={63} />
          </FormField>
          <Alert type="info" header="자격 증명 설정 없음">
            이 시뮬레이터는 실제 데이터베이스를 만들지 않으므로 마스터 사용자 이름과 암호를 입력받지 않습니다. 실제 서비스의 암호를 이곳에 입력하지 마세요.
          </Alert>
        </SpaceBetween>
      </Container>
      <DbInstanceFields draft={draft} set={set} vpcId={vpcId || (groupId ? (topo.vpcsOf(groupId)[0] ?? null) : null)} />
      <Container header={<ContainerHeader title="네트워크 배치" info={<InfoLink topic="db-subnet-group" />} />}>
        <SpaceBetween size="m">
          <FormField label="Virtual Private Cloud(VPC)" description="만든 뒤에는 VPC를 바꿀 수 없습니다.">
            <SelectInput
              value={vpcId}
              onChange={(v) => {
                setVpcId(v);
                setGroupId("");
                set({ sgIds: [] });
              }}
              placeholder="VPC 선택"
              options={topo.ofType("vpc").map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})` }))}
            />
          </FormField>
          <FormField label="DB 서브넷 그룹" description="DB 인스턴스가 사용할 서브넷과 IP 범위">
            <SelectInput value={groupId} onChange={setGroupId} placeholder={groups.length ? "DB 서브넷 그룹 선택" : "사용 가능한 DB 서브넷 그룹 없음"} options={groups.map((g) => ({ value: g.id, label: g.name, description: g.config.description }))} />
          </FormField>
          {!groups.length && (
            <Alert type="info">
              이 VPC에 DB 서브넷 그룹이 없습니다. <a href={href("/rds/subnet-groups/create")}>DB 서브넷 그룹을 먼저 생성</a>하세요.
            </Alert>
          )}
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <Alert type="error" header="데이터베이스를 생성할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href("/rds/databases")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          데이터베이스 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function DatabaseDetailPage({ id }: { id: string }) {
  const db = useResource(id, "rds");
  const topo = useTopology();
  const run = useRunAction();
  const [tab, setTab] = useQueryTab("connectivity");
  const [deleting, setDeleting] = useState(false);
  if (!db) return <ResourceNotFound type="rds" id={id} />;
  const eni = topo.enisOf(db.id)[0];
  const group = topo.dbSubnetGroupOf(db.id);
  const placement = topo.rdsPlacement(db.id);
  const sgs = topo.securityGroupsOf(db.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={db.name}
        actions={
          <>
            <Button onClick={() => navigate(`${resourcePath("rds", db.id)}/modify`)} disabled={db.config.state !== "available"}>
              수정
            </Button>
            <ButtonDropdown
              label="작업"
              items={[
                { id: "stop", text: "일시적으로 중지", disabled: db.config.state !== "available" },
                { id: "start", text: "시작", disabled: db.config.state !== "stopped" },
                { id: "delete", text: "삭제", danger: true },
              ]}
              onItemClick={(a) => {
                if (a === "stop" || a === "start") run(a === "stop" ? "StopDBInstance" : "StartDBInstance", (p) => changeDatabaseState(p, db.id, a), { success: () => `DB 인스턴스 ${db.name}을(를) ${a === "stop" ? "중지했습니다" : "시작하는 중입니다"}.`, flashError: true });
                if (a === "delete") setDeleting(true);
              }}
            />
          </>
        }
      />
      {db.config.state === "creating" && <Alert type="info">데이터베이스를 생성하는 중입니다. ‘사용 가능’ 상태가 되면 연결할 수 있습니다.</Alert>}
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "DB 식별자", value: db.name },
            { label: "상태", value: <DbState state={db.config.state} />, info: <InfoLink topic="lifecycle" /> },
            { label: "역할", value: "인스턴스" },
            { label: "엔진", value: db.config.engine === "mysql" ? "MySQL Community" : "PostgreSQL" },
            { label: "클래스", value: db.config.instanceClass },
            { label: "리전 및 AZ", value: placement.primary?.config.availabilityZone ?? "–" },
            { label: "다중 AZ", value: db.config.multiAz ? `예 (대기: ${placement.standby?.config.availabilityZone ?? "없음"})` : "아니요" },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="데이터베이스 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "connectivity",
            label: "연결 및 보안",
            content: (
              <SpaceBetween>
                <Container header={<ContainerHeader title="연결 및 보안" />}>
                  <KeyValueGrid
                    columns={3}
                    items={[
                      { label: "엔드포인트 (가상)", value: <CopyText text={topo.dnsName(db.id) ?? ""} /> },
                      { label: "포트", value: db.config.port },
                      { label: "프라이빗 IP (가상)", value: ipText(eni?.privateIp) },
                      { label: "VPC", value: <ResourceLink id={topo.vpcOf(db.id)} showName /> },
                      { label: "서브넷 그룹", value: <ResourceLink id={group?.id} showName /> },
                      { label: "서브넷", value: <ResourceLink id={placement.primary?.id} /> },
                      { label: "퍼블릭 액세스 가능", value: db.config.publiclyAccessible ? `예 (${ipText(eni?.publicIp)})` : "아니요", info: <InfoLink topic="rds-public" /> },
                      { label: "VPC 보안 그룹", value: sgs.map((g) => <div key={g.id}><ResourceLink id={g.id} /> ({g.name})</div>) },
                    ]}
                  />
                </Container>
                {sgs.map((g) => (
                  <Container key={g.id} header={<ContainerHeader title={`보안 그룹 규칙: ${g.name}`} />}>
                    <SgRulesTable rules={g.config.inboundRules} direction="inbound" topo={topo} />
                  </Container>
                ))}
              </SpaceBetween>
            ),
          },
          {
            id: "configuration",
            label: "구성",
            content: (
              <Container header={<ContainerHeader title="인스턴스" />}>
                <KeyValueGrid
                  columns={3}
                  items={[
                    { label: "DB 인스턴스 ID", value: <CopyText text={db.id} /> },
                    { label: "엔진", value: db.config.engine },
                    { label: "인스턴스 클래스", value: db.config.instanceClass },
                    { label: "할당된 스토리지", value: `${db.config.allocatedStorageGb} GiB` },
                    { label: "다중 AZ", value: db.config.multiAz ? "예" : "아니요" },
                    { label: "마스터 자격 증명", value: "없음 (가상 환경)" },
                  ]}
                />
              </Container>
            ),
          },
        ]}
      />
      <DbDeleteModal db={deleting ? db : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function ModifyDatabasePage({ id }: { id: string }) {
  const db = useResource(id, "rds");
  const topo = useTopology();
  const run = useRunAction();
  const [draft, setDraft] = useState<DbNetworkDraft>(() => ({
    instanceClass: db?.config.instanceClass ?? "db.t3.micro",
    storage: String(db?.config.allocatedStorageGb ?? 20),
    multiAz: db?.config.multiAz ?? false,
    publiclyAccessible: db?.config.publiclyAccessible ?? false,
    sgIds: db ? topo.securityGroupsOf(db.id).map((g) => g.id) : [],
    port: String(db?.config.port ?? 3306),
  }));
  const [error, setError] = useState<string | null>(null);
  if (!db) return <ResourceNotFound type="rds" id={id} />;
  const set = (p: Partial<DbNetworkDraft>) => setDraft({ ...draft, ...p });
  const save = () => {
    if (!/^\d+$/.test(draft.storage) || !/^\d+$/.test(draft.port)) return setError("[InvalidParameterValue] 스토리지와 포트는 숫자여야 합니다.");
    const r = run(
      "ModifyDBInstance",
      (p) => modifyDatabase(p, db.id, { instanceClass: draft.instanceClass, allocatedStorageGb: Number(draft.storage), multiAz: draft.multiAz, publiclyAccessible: draft.publiclyAccessible, securityGroupIds: draft.sgIds, port: Number(draft.port) }),
      { success: () => `DB 인스턴스 ${db.name}을(를) 수정했습니다. (변경 사항 즉시 적용)` },
    );
    if (r.ok) navigate(resourcePath("rds", db.id));
    else setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  return (
    <SpaceBetween>
      <PageHeader title={`DB 인스턴스 수정: ${db.name}`} info={<InfoLink topic="rds" />} />
      {db.config.state !== "available" && <Alert type="warning">DB 인스턴스가 ‘사용 가능’ 상태일 때만 수정할 수 있습니다. 현재 상태: {db.config.state}</Alert>}
      <DbInstanceFields draft={draft} set={set} vpcId={topo.vpcOf(db.id)} />
      <FormActions error={error ? <Alert type="error" header="수정할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("rds", db.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          계속 (즉시 적용)
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
