"use client";

import { useState } from "react";
import { createId } from "@/lib/engine/ids";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { createRouteTable, deleteRouteTable, editRouteTableAssociations, editRoutes, makeMainRouteTable } from "@/lib/project/console-actions";
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
import { CopyText, StatusIndicator } from "../ui/status";
import { NameCell, ResourceNotFound, sortName, SubnetKindLabel, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { RoutesTable } from "./network-tables";
import { EditNameModal } from "./shared-modals";

type RouteTable = ResourceOfType<"route-table">;

function DeleteRtModal({ rt, onClose }: { rt: RouteTable | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!rt) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="라우팅 테이블 삭제"
      confirmText="delete"
      onConfirm={() => {
        const r = run("DeleteRouteTable", (p) => deleteRouteTable(p, rt.id), { success: () => `라우팅 테이블 ${rt.id}을(를) 삭제했습니다.` });
        if (!r.ok) return [r.error, r.hint].filter(Boolean).join(" ");
        navigate("/vpc/route-tables");
        return null;
      }}
    >
      <p>
        라우팅 테이블 <strong>{displayName(rt)}</strong>을(를) 삭제하시겠습니까?
      </p>
    </DeleteModal>
  );
}

function rtActionItems(rt: RouteTable | undefined) {
  return [
    { id: "main", text: "기본 라우팅 테이블로 설정", disabled: !rt || rt.config.main },
    { id: "associations", text: "서브넷 연결 편집", disabled: !rt },
    { id: "routes", text: "라우팅 편집", disabled: !rt },
    { id: "tags", text: "태그 관리", disabled: !rt },
    { id: "delete", text: "라우팅 테이블 삭제", disabled: !rt, danger: true },
  ];
}

function useRtActionHandler(rt: RouteTable | undefined, setDeleting: (v: boolean) => void, setNaming: (v: boolean) => void) {
  const run = useRunAction();
  return (id: string) => {
    if (!rt) return;
    if (id === "main") run("ReplaceRouteTableAssociation", (p) => makeMainRouteTable(p, rt.id), { success: () => `${rt.id}을(를) 기본 라우팅 테이블로 설정했습니다.`, flashError: true });
    if (id === "associations") navigate(`${resourcePath("route-table", rt.id)}/edit-associations`);
    if (id === "routes") navigate(`${resourcePath("route-table", rt.id)}/edit-routes`);
    if (id === "tags") setNaming(true);
    if (id === "delete") setDeleting(true);
  };
}

export function RouteTableListPage() {
  const topo = useTopology();
  const rts = topo.ofType("route-table");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  const current = rts.find((r) => r.id === selected[0]);
  const onAction = useRtActionHandler(current, setDeleting, setNaming);
  return (
    <SpaceBetween>
      <ResourceTable<RouteTable>
        ariaLabel="라우팅 테이블 목록"
        items={rts}
        trackBy={(r) => r.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => displayName(r)}
        header={
          <PageHeader
            title="라우팅 테이블"
            counter={`(${rts.length})`}
            info={<InfoLink topic="route-table" />}
            actions={
              <>
                <ButtonDropdown label="작업" items={rtActionItems(current)} onItemClick={onAction} />
                <ButtonLink variant="primary" href={href("/vpc/route-tables/create")}>
                  라우팅 테이블 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="라우팅 테이블 없음" description="VPC를 만들면 기본 라우팅 테이블이 함께 생성됩니다." />}
        columns={[
          { id: "name", header: "Name", cell: (r) => <NameCell r={r} />, sortValue: sortName, filterValue: (r) => r.name },
          { id: "id", header: "라우팅 테이블 ID", cell: (r) => <TypedResourceLink type="route-table" id={r.id} />, sortValue: (r) => r.id },
          {
            id: "assoc",
            header: "명시적 서브넷 연결",
            cell: (r) => {
              const ids = topo.outgoing(r.id, "route-table-subnet").map((c) => c.targetResourceId);
              return ids.length ? ids.join(", ") : "–";
            },
          },
          { id: "main", header: "기본", cell: (r) => (r.config.main ? "예" : "아니요"), sortValue: (r) => (r.config.main ? 0 : 1) },
          { id: "routes", header: "경로 수", cell: (r) => topo.routesOf(r.id, topo.vpcOf(r.id)).length },
          { id: "vpc", header: "VPC", cell: (r) => <ResourceLink id={topo.vpcOf(r.id)} showName />, filterValue: (r) => topo.vpcOf(r.id) ?? "" },
        ]}
      />
      <DeleteRtModal rt={deleting ? current : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={current} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function CreateRouteTablePage() {
  const topo = useTopology();
  const run = useRunAction();
  const [name, setName] = useState("");
  const [vpcId, setVpcId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = run("CreateRouteTable", (p) => createRouteTable(p, { vpcId, name }), {
      success: (res) => `라우팅 테이블 ${res.createdId}을(를) 생성했습니다.`,
      successAction: (res) => ({ label: "라우팅 편집", href: href(`${resourcePath("route-table", res.createdId!)}/edit-routes`) }),
    });
    if (r.ok && r.createdId) navigate(resourcePath("route-table", r.createdId));
    else if (!r.ok) setError(r.error);
  };
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="라우팅 테이블 생성" info={<InfoLink topic="route-table" />} description="라우팅 테이블은 서브넷 또는 게이트웨이의 네트워크 트래픽이 전송되는 위치를 지정합니다." />
      <Container header={<ContainerHeader title="라우팅 테이블 설정" />}>
        <SpaceBetween size="m">
          <FormField label="이름" optional>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="my-route-table-01" />
          </FormField>
          <FormField label="VPC" description="이 라우팅 테이블에 사용할 VPC" error={error ?? undefined}>
            <SelectInput value={vpcId} onChange={setVpcId} placeholder="VPC 선택" options={topo.ofType("vpc").map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})`, description: v.config.cidr }))} />
          </FormField>
        </SpaceBetween>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href("/vpc/route-tables")}>
          취소
        </ButtonLink>
        <Button variant="primary" type="submit" disabled={!vpcId}>
          라우팅 테이블 생성
        </Button>
      </FormActions>
    </form>
  );
}

export function RouteTableDetailPage({ id }: { id: string }) {
  const rt = useResource(id, "route-table");
  const topo = useTopology();
  const [tab, setTab] = useQueryTab("routes");
  const [deleting, setDeleting] = useState(false);
  const [naming, setNaming] = useState(false);
  const onAction = useRtActionHandler(rt, setDeleting, setNaming);
  if (!rt) return <ResourceNotFound type="route-table" id={id} />;
  const vpcId = topo.vpcOf(rt.id);
  const explicit = topo.outgoing(rt.id, "route-table-subnet").map((c) => topo.getOfType(c.targetResourceId, "subnet")).filter((s) => !!s);
  const implicit = rt.config.main && vpcId ? topo.subnetsOfVpc(vpcId).filter((s) => topo.routeTableRefFor(s.id).kind === "main") : [];
  return (
    <SpaceBetween>
      <PageHeader title={`${rt.id}${rt.name ? ` / ${rt.name}` : ""}`} actions={<ButtonDropdown label="작업" items={rtActionItems(rt)} onItemClick={onAction} />} />
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "라우팅 테이블 ID", value: <CopyText text={rt.id} /> },
            { label: "기본", value: rt.config.main ? "예" : "아니요" },
            { label: "명시적 서브넷 연결", value: explicit.length ? `${explicit.length}개 서브넷` : "–" },
            { label: "VPC", value: <ResourceLink id={vpcId} showName /> },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="라우팅 테이블 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "routes",
            label: "라우팅",
            content: (
              <Container
                header={
                  <ContainerHeader
                    title={`라우팅 (${topo.routesOf(rt.id, vpcId).length})`}
                    info={<InfoLink topic="route-table" />}
                    actions={<ButtonLink href={href(`${resourcePath("route-table", rt.id)}/edit-routes`)}>라우팅 편집</ButtonLink>}
                  />
                }
              >
                <RoutesTable topo={topo} routes={topo.routesOf(rt.id, vpcId)} />
              </Container>
            ),
          },
          {
            id: "associations",
            label: "서브넷 연결",
            content: (
              <SpaceBetween>
                <Container
                  header={
                    <ContainerHeader
                      title={`명시적 서브넷 연결 (${explicit.length})`}
                      actions={<ButtonLink href={href(`${resourcePath("route-table", rt.id)}/edit-associations`)}>서브넷 연결 편집</ButtonLink>}
                    />
                  }
                >
                  {explicit.length ? (
                    <ul className="space-y-2 text-sm">
                      {explicit.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center gap-3">
                          <ResourceLink id={s.id} showName />
                          <span className="text-aws-text-2">{s.config.cidr}</span>
                          <SubnetKindLabel topo={topo} subnetId={s.id} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-aws-text-2">이 라우팅 테이블과 명시적으로 연결된 서브넷이 없습니다.</p>
                  )}
                </Container>
                {rt.config.main && (
                  <Container header={<ContainerHeader title={`명시적 연결이 없는 서브넷 (${implicit.length})`} description="다음 서브넷은 명시적으로 연결된 라우팅 테이블이 없어 이 기본 라우팅 테이블을 사용합니다." />}>
                    {implicit.length ? (
                      <ul className="space-y-1 text-sm">
                        {implicit.map((s) => (
                          <li key={s.id}>
                            <ResourceLink id={s.id} showName /> <span className="text-aws-text-2">{s.config.cidr}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-aws-text-2">없음</p>
                    )}
                  </Container>
                )}
              </SpaceBetween>
            ),
          },
        ]}
      />
      <DeleteRtModal rt={deleting ? rt : undefined} onClose={() => setDeleting(false)} />
      <EditNameModal resource={rt} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

interface RouteDraft {
  key: string;
  destination: string;
  targetId: string;
}

export function EditRoutesPage({ id }: { id: string }) {
  const rt = useResource(id, "route-table");
  const topo = useTopology();
  const run = useRunAction();
  const vpcId = rt ? topo.vpcOf(rt.id) : null;
  const [drafts, setDrafts] = useState<RouteDraft[]>(() =>
    rt
      ? topo
          .routesOf(rt.id, vpcId)
          .filter((r) => r.targetKind !== "local")
          .map((r) => ({ key: r.key, destination: r.destinationCidr, targetId: r.targetId ?? "" }))
      : [],
  );
  const [error, setError] = useState<string | null>(null);
  if (!rt) return <ResourceNotFound type="route-table" id={id} />;
  const vpc = topo.getOfType(vpcId, "vpc");
  const igws = topo.ofType("internet-gateway");
  const nats = topo.ofType("nat-gateway").filter((n) => topo.vpcOf(n.id) === vpcId);
  const targetOptions = [
    ...igws.map((g) => ({ value: g.id, label: `인터넷 게이트웨이 · ${g.id}${g.name ? ` (${g.name})` : ""}`, description: topo.vpcOfIgw(g.id) === vpcId ? undefined : "이 VPC에 연결되지 않음" })),
    ...nats.map((n) => ({ value: n.id, label: `NAT 게이트웨이 · ${n.id}${n.name ? ` (${n.name})` : ""}`, description: n.config.state })),
  ];
  const save = () => {
    const r = run("ReplaceRoutes", (p) => editRoutes(p, rt.id, drafts.map((d) => ({ destination: d.destination, targetId: d.targetId }))), { success: () => `라우팅 테이블 ${rt.id}의 경로를 업데이트했습니다.` });
    if (r.ok) navigate(resourcePath("route-table", rt.id), { query: { tab: "routes" } });
    else setError(r.error);
  };
  const update = (key: string, patch: Partial<RouteDraft>) => setDrafts(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <SpaceBetween>
      <PageHeader title="라우팅 편집" info={<InfoLink topic="route-table" />} description={`${rt.id} (${displayName(rt)}) · VPC ${vpcId ?? "없음"}`} />
      <Container header={<ContainerHeader title="라우팅" description="목적지 CIDR과 트래픽을 보낼 대상을 지정합니다. 가장 구체적인 경로가 우선합니다." />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm" aria-label="경로 편집">
            <thead>
              <tr className="text-left text-aws-text-2">
                <th className="px-1 pb-1 font-bold">대상 (Destination)</th>
                <th className="px-1 pb-1 font-bold">대상 (Target)</th>
                <th className="w-28 px-1 pb-1 font-bold">상태</th>
                <th className="w-24 px-1 pb-1" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-1 py-1">
                  <TextInput aria-label="local 경로 대상" value={vpc?.config.cidr ?? ""} disabled readOnly />
                </td>
                <td className="px-1 py-1">
                  <TextInput aria-label="local 경로 대상" value="local" disabled readOnly />
                </td>
                <td className="px-1 py-1">
                  <StatusIndicator type="success">Active</StatusIndicator>
                </td>
                <td />
              </tr>
              {drafts.map((d, i) => (
                <tr key={d.key} data-testid="route-row">
                  <td className="px-1 py-1">
                    <TextInput aria-label={`경로 ${i + 1} 대상 CIDR`} value={d.destination} placeholder="0.0.0.0/0" onChange={(e) => update(d.key, { destination: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <SelectInput aria-label={`경로 ${i + 1} 대상 리소스`} value={d.targetId} placeholder="대상 선택" options={targetOptions} onChange={(v) => update(d.key, { targetId: v })} />
                  </td>
                  <td className="px-1 py-1 text-aws-text-2">–</td>
                  <td className="px-1 py-1 text-right">
                    <Button onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))} aria-label={`경로 ${i + 1} 제거`}>
                      제거
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3">
          <Button onClick={() => setDrafts([...drafts, { key: createId("draft"), destination: "", targetId: "" }])}>라우팅 추가</Button>
        </div>
        {!targetOptions.length && (
          <Alert type="info" className="mt-3">
            경로 대상으로 쓸 인터넷 게이트웨이나 NAT 게이트웨이가 없습니다. 먼저 <a href={href("/vpc/igws/create")}>인터넷 게이트웨이</a>를 만들어 VPC에 연결하세요.
          </Alert>
        )}
      </Container>
      <FormActions error={error ? <Alert type="error" header="경로를 저장할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("route-table", rt.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditRouteTableAssociationsPage({ id }: { id: string }) {
  const rt = useResource(id, "route-table");
  const topo = useTopology();
  const run = useRunAction();
  const [selected, setSelected] = useState<string[]>(() => (rt ? topo.outgoing(rt.id, "route-table-subnet").map((c) => c.targetResourceId) : []));
  const [error, setError] = useState<string | null>(null);
  if (!rt) return <ResourceNotFound type="route-table" id={id} />;
  const vpcId = topo.vpcOf(rt.id);
  const subnets = vpcId ? topo.subnetsOfVpc(vpcId) : [];
  const save = () => {
    const r = run("AssociateRouteTable", (p) => editRouteTableAssociations(p, rt.id, selected), { success: () => `라우팅 테이블 ${rt.id}의 서브넷 연결을 업데이트했습니다.` });
    if (r.ok) navigate(resourcePath("route-table", rt.id), { query: { tab: "associations" } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="서브넷 연결 편집" info={<InfoLink topic="route-table" />} description={`${rt.id} (${displayName(rt)}) — 다른 테이블에 연결된 서브넷을 선택하면 이 테이블로 연결이 옮겨집니다.`} />
      <Container header={<ContainerHeader title={`사용 가능한 서브넷 (${subnets.length})`} />}>
        {subnets.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" aria-label="서브넷 선택">
              <thead>
                <tr className="border-b border-aws-border text-left text-aws-text-2">
                  <th className="w-10 px-3 py-2" />
                  <th className="px-3 py-2 font-bold">서브넷</th>
                  <th className="px-3 py-2 font-bold">IPv4 CIDR</th>
                  <th className="px-3 py-2 font-bold">현재 라우팅 테이블</th>
                </tr>
              </thead>
              <tbody>
                {subnets.map((s) => {
                  const ref = topo.routeTableRefFor(s.id);
                  return (
                    <tr key={s.id} className="border-b border-aws-divider">
                      <td className="px-3 py-2">
                        <Checkbox aria-label={`${displayName(s)} 선택`} checked={selected.includes(s.id)} onChange={(v) => setSelected(v ? [...selected, s.id] : selected.filter((x) => x !== s.id))} />
                      </td>
                      <td className="px-3 py-2">
                        {s.id} {s.name && <span className="text-aws-text-2">/ {s.name}</span>}
                      </td>
                      <td className="px-3 py-2">{s.config.cidr}</td>
                      <td className="px-3 py-2 text-aws-text-2">
                        {ref.kind === "explicit" ? ref.routeTableId : ref.kind === "main" ? `기본 (${ref.routeTableId})` : "–"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-aws-text-2">이 VPC에 서브넷이 없습니다.</p>
        )}
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("route-table", rt.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          연결 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
