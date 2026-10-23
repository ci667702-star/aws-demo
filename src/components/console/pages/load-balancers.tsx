"use client";

import { useState } from "react";
import { createId } from "@/lib/engine/ids";
import { AVAILABILITY_ZONES, type ResourceOfType } from "@/lib/engine/resource-models";
import { displayName, type Topology } from "@/lib/engine/topology-engine";
import {
  addListener,
  createLoadBalancer,
  deleteListener,
  deleteLoadBalancer,
  editListenerDefaultAction,
  editLoadBalancerSecurityGroups,
  editLoadBalancerSubnets,
} from "@/lib/project/console-actions";
import { useAnalysis } from "../analysis-context";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { Checkbox, FormActions, FormField, MultiSelect, RadioGroup, SelectInput, TextInput } from "../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal, Modal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { Badge, CopyText } from "../ui/status";
import { LbState, ResourceNotFound, SubnetKindLabel, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { HealthStatus } from "./target-groups";

type Alb = ResourceOfType<"alb">;

function DeleteAlbModal({ alb, onClose }: { alb: Alb | undefined; onClose: () => void }) {
  const run = useRunAction();
  if (!alb) return null;
  return (
    <DeleteModal
      open
      onClose={onClose}
      title="로드 밸런서 삭제"
      confirmText="confirm"
      onConfirm={() => {
        const r = run("DeleteLoadBalancer", (p) => deleteLoadBalancer(p, alb.id), { success: () => `로드 밸런서 ${alb.name}을(를) 삭제했습니다.` });
        if (!r.ok) return r.error;
        navigate("/ec2/load-balancers");
        return null;
      }}
    >
      <p>
        로드 밸런서 <strong>{alb.name}</strong>과(와) 리스너를 삭제하시겠습니까? 대상 그룹과 대상 인스턴스는 삭제되지 않습니다.
      </p>
    </DeleteModal>
  );
}

export function LoadBalancerListPage() {
  const topo = useTopology();
  const albs = topo.ofType("alb");
  const [selected, setSelected] = useSelection();
  const [deleting, setDeleting] = useState(false);
  const current = albs.find((a) => a.id === selected[0]);
  return (
    <SpaceBetween>
      <ResourceTable<Alb>
        ariaLabel="로드 밸런서 목록"
        items={albs}
        trackBy={(a) => a.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(a) => a.name}
        header={
          <PageHeader
            title="로드 밸런서"
            counter={`(${albs.length})`}
            info={<InfoLink topic="alb" />}
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  items={[
                    { id: "subnets", text: "서브넷 편집", disabled: !current },
                    { id: "sgs", text: "보안 그룹 편집", disabled: !current },
                    { id: "delete", text: "로드 밸런서 삭제", disabled: !current, danger: true },
                  ]}
                  onItemClick={(id) => {
                    if (!current) return;
                    if (id === "subnets") navigate(`${resourcePath("alb", current.id)}/edit-subnets`);
                    if (id === "sgs") navigate(`${resourcePath("alb", current.id)}/edit-security-groups`);
                    if (id === "delete") setDeleting(true);
                  }}
                />
                <ButtonLink variant="primary" href={href("/ec2/load-balancers/select-type")}>
                  로드 밸런서 생성
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="로드 밸런서 없음" description="여러 인스턴스로 요청을 분산하려면 Application Load Balancer를 만드세요." action={<ButtonLink href={href("/ec2/load-balancers/select-type")}>로드 밸런서 생성</ButtonLink>} />}
        columns={[
          { id: "name", header: "이름", cell: (a) => <TypedResourceLink type="alb" id={a.id}>{a.name}</TypedResourceLink>, sortValue: (a) => a.name },
          { id: "dns", header: "DNS 이름 (가상)", cell: (a) => <span className="font-mono text-[12px] break-all text-aws-text-2">{topo.dnsName(a.id)}</span> },
          { id: "state", header: "상태", cell: (a) => <LbState state={a.config.state} /> },
          { id: "vpc", header: "VPC ID", cell: (a) => <ResourceLink id={topo.vpcOf(a.id)} /> },
          { id: "azs", header: "가용 영역", cell: (a) => `${new Set(topo.albSubnets(a.id).map((s) => s.config.availabilityZone)).size}개 가용 영역` },
          { id: "type", header: "유형", cell: () => "application" },
          { id: "scheme", header: "체계", cell: (a) => a.config.scheme },
        ]}
      />
      <DeleteAlbModal alb={deleting ? current : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function SelectLbTypePage() {
  const cards = [
    { id: "alb", title: "Application Load Balancer", description: "HTTP/HTTPS 트래픽을 위한 레이어 7 로드 밸런서. 리스너가 받은 요청을 대상 그룹의 정상 인스턴스에 분산합니다.", supported: true },
    { id: "nlb", title: "Network Load Balancer", description: "TCP/UDP 트래픽을 위한 레이어 4 로드 밸런서", supported: false },
    { id: "gwlb", title: "Gateway Load Balancer", description: "타사 가상 어플라이언스용", supported: false },
  ];
  return (
    <SpaceBetween>
      <PageHeader title="로드 밸런서 유형 비교 및 선택" info={<InfoLink topic="alb" />} />
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((c) => (
          <Container key={c.id} header={<ContainerHeader title={c.title} />}>
            <SpaceBetween size="m">
              <p className="text-sm text-aws-text-2">{c.description}</p>
              {c.supported ? (
                <ButtonLink variant="primary" href={href("/ec2/load-balancers/create")}>
                  생성
                </ButtonLink>
              ) : (
                <Badge>이 시뮬레이터에서 지원하지 않음</Badge>
              )}
            </SpaceBetween>
          </Container>
        ))}
      </div>
    </SpaceBetween>
  );
}

interface ListenerDraft {
  key: string;
  protocol: "HTTP" | "HTTPS";
  port: string;
  targetGroupId: string;
}

function availableTargetGroups(topo: Topology, vpcId: string, albId?: string) {
  return topo.ofType("target-group").filter((tg) => topo.vpcOf(tg.id) === vpcId && topo.targetGroupAlbs(tg.id).every((a) => a.id === albId));
}

/** 가용 영역별 서브넷 선택 (ALB 네트워크 매핑) */
function SubnetMapping({ topo, vpcId, mapping, onChange }: { topo: Topology; vpcId: string; mapping: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const subnets = topo.subnetsOfVpc(vpcId);
  const zones = AVAILABILITY_ZONES.filter((z) => subnets.some((s) => s.config.availabilityZone === z));
  if (!zones.length) return <p className="text-sm text-aws-text-2">이 VPC에 서브넷이 없습니다. 서로 다른 가용 영역에 서브넷을 2개 이상 만드세요.</p>;
  return (
    <ul className="space-y-3">
      {zones.map((z) => {
        const inZone = subnets.filter((s) => s.config.availabilityZone === z);
        const on = z in mapping;
        return (
          <li key={z} className="space-y-2 rounded-xl border border-aws-border p-3">
            <Checkbox
              checked={on}
              onChange={(v) => {
                const next = { ...mapping };
                if (v) next[z] = inZone[0].id;
                else delete next[z];
                onChange(next);
              }}
            >
              {z}
            </Checkbox>
            {on && (
              <div className="space-y-1 pl-6">
                <SelectInput aria-label={`${z} 서브넷`} value={mapping[z]} onChange={(v) => onChange({ ...mapping, [z]: v })} options={inZone.map((s) => ({ value: s.id, label: `${s.id} (${displayName(s)})`, description: s.config.cidr }))} />
                <SubnetKindLabel topo={topo} subnetId={mapping[z]} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CreateLoadBalancerPage() {
  const topo = useTopology();
  const run = useRunAction();
  const vpcs = topo.ofType("vpc");
  const [name, setName] = useState("");
  const [scheme, setScheme] = useState<"internet-facing" | "internal">("internet-facing");
  const [vpcId, setVpcId] = useState(vpcs.length === 1 ? vpcs[0].id : "");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sgIds, setSgIds] = useState<string[]>([]);
  const [listeners, setListeners] = useState<ListenerDraft[]>([{ key: createId("draft"), protocol: "HTTP", port: "80", targetGroupId: "" }]);
  const [error, setError] = useState<string | null>(null);
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  const tgs = vpcId ? availableTargetGroups(topo, vpcId) : [];
  const updateListener = (key: string, patch: Partial<ListenerDraft>) => setListeners(listeners.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const submit = () => {
    setError(null);
    const parsed = listeners.map((l) => ({ protocol: l.protocol, port: Number(l.port), targetGroupId: l.targetGroupId }));
    if (listeners.some((l) => !/^\d+$/.test(l.port))) return setError("[ValidationError] 리스너 포트는 숫자여야 합니다.");
    const r = run("CreateLoadBalancer", (p) => createLoadBalancer(p, { name, scheme, vpcId, subnetIds: Object.values(mapping), securityGroupIds: sgIds, listeners: parsed }), {
      success: () => `로드 밸런서 ${name.trim()}을(를) 생성했습니다.`,
    });
    if (r.ok && r.createdId) navigate(resourcePath("alb", r.createdId));
    else if (!r.ok) setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  return (
    <SpaceBetween>
      <PageHeader title="Application Load Balancer 생성" info={<InfoLink topic="alb" />} description="Application Load Balancer는 리스너로 받은 HTTP/HTTPS 요청을 대상 그룹의 정상 대상에게 분산합니다." />
      <Container header={<ContainerHeader title="기본 구성" />}>
        <SpaceBetween size="m">
          <FormField label="로드 밸런서 이름" constraint="1~32자의 영문자, 숫자, 하이픈. 하이픈으로 시작·끝나거나 'internal-'로 시작할 수 없습니다. 만든 뒤에는 바꿀 수 없습니다.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-alb" maxLength={32} />
          </FormField>
          <FormField label="체계" description="만든 뒤에는 체계를 바꿀 수 없습니다.">
            <RadioGroup
              aria-label="체계"
              value={scheme}
              onChange={(v) => setScheme(v as typeof scheme)}
              items={[
                { value: "internet-facing", label: "인터넷 경계", description: "퍼블릭 서브넷에 두고 인터넷 클라이언트의 요청을 받습니다. VPC에 인터넷 게이트웨이가 있어야 합니다." },
                { value: "internal", label: "내부", description: "VPC 내부 클라이언트의 요청만 받습니다." },
              ]}
            />
          </FormField>
          <FormField label="IP 주소 유형">
            <TextInput value="IPv4" disabled readOnly className="max-w-40" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="네트워크 매핑" info={<InfoLink topic="availability-zone" />} description="로드 밸런서가 트래픽을 보낼 VPC와 가용 영역(최소 2개)을 선택합니다." />}>
        <SpaceBetween size="m">
          <FormField label="VPC">
            <SelectInput
              value={vpcId}
              onChange={(v) => {
                setVpcId(v);
                setMapping({});
                setSgIds([]);
                setListeners(listeners.map((l) => ({ ...l, targetGroupId: "" })));
              }}
              placeholder="VPC 선택"
              options={vpcs.map((v) => ({ value: v.id, label: `${v.id} (${displayName(v)})`, description: v.config.cidr }))}
            />
          </FormField>
          {vpcId && (
            <FormField label="가용 영역 및 서브넷" constraint="가용 영역마다 서브넷 하나, 최소 2개 가용 영역">
              <SubnetMapping topo={topo} vpcId={vpcId} mapping={mapping} onChange={setMapping} />
            </FormField>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="보안 그룹" info={<InfoLink topic="security-group" />} description="리스너 포트로 들어오는 클라이언트 트래픽을 허용하는 보안 그룹을 선택하세요." />}>
        <SpaceBetween size="s">
          <MultiSelect aria-label="보안 그룹" selected={sgIds} onChange={setSgIds} max={5} empty={vpcId ? "이 VPC에 보안 그룹이 없습니다." : "먼저 VPC를 선택하세요."} options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.id})`, description: g.config.description }))} />
          <a href={href("/ec2/security-groups/create")} className="text-sm text-aws-link hover:underline">
            새 보안 그룹 생성
          </a>
        </SpaceBetween>
      </Container>
      <Container header={<ContainerHeader title="리스너 및 라우팅" info={<InfoLink topic="target-group" />} description="리스너는 지정한 프로토콜과 포트로 연결 요청을 확인하고, 기본 작업에 따라 대상 그룹으로 전달합니다." />}>
        <SpaceBetween size="m">
          {listeners.map((l, i) => (
            <fieldset key={l.key} className="grid gap-3 rounded-xl border border-aws-border p-3 sm:grid-cols-[120px_120px_minmax(0,1fr)_auto]" data-testid="listener-draft">
              <legend className="px-1 text-sm font-bold">리스너 {i + 1}</legend>
              <FormField label="프로토콜">
                <SelectInput value={l.protocol} onChange={(v) => updateListener(l.key, { protocol: v as "HTTP" | "HTTPS" })} options={[{ value: "HTTP", label: "HTTP" }, { value: "HTTPS", label: "HTTPS" }]} />
              </FormField>
              <FormField label="포트">
                <TextInput value={l.port} onChange={(e) => updateListener(l.key, { port: e.target.value })} inputMode="numeric" />
              </FormField>
              <FormField label="기본 작업: 전달 대상">
                <SelectInput value={l.targetGroupId} onChange={(v) => updateListener(l.key, { targetGroupId: v })} placeholder={tgs.length ? "대상 그룹 선택" : "사용 가능한 대상 그룹 없음"} options={tgs.map((t) => ({ value: t.id, label: `${t.name} (${t.config.protocol}:${t.config.port})` }))} />
              </FormField>
              <div className="self-end">{listeners.length > 1 && <Button onClick={() => setListeners(listeners.filter((x) => x.key !== l.key))}>제거</Button>}</div>
            </fieldset>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setListeners([...listeners, { key: createId("draft"), protocol: "HTTP", port: "", targetGroupId: "" }])}>리스너 추가</Button>
            <a href={href("/ec2/target-groups/create")} className="text-sm text-aws-link hover:underline">
              대상 그룹 생성
            </a>
          </div>
        </SpaceBetween>
      </Container>
      <FormActions error={error ? <Alert type="error" header="로드 밸런서를 생성할 수 없습니다">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href("/ec2/load-balancers")}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={submit}>
          로드 밸런서 생성
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

function ListenerModal({ alb, listenerId, open, onClose }: { alb: Alb; listenerId: string | null; open: boolean; onClose: () => void }) {
  const topo = useTopology();
  const run = useRunAction();
  const vpcId = topo.vpcOf(alb.id) ?? "";
  const binding = listenerId ? topo.listenersOf(alb.id).find((b) => b.listener.id === listenerId) : undefined;
  const [protocol, setProtocol] = useState<"HTTP" | "HTTPS">(binding?.listener.protocol ?? "HTTP");
  const [port, setPort] = useState(binding ? String(binding.listener.port) : "");
  const [tgId, setTgId] = useState(binding?.targetGroupId ?? "");
  const [error, setError] = useState<string | null>(null);
  const tgs = availableTargetGroups(topo, vpcId, alb.id);
  const save = () => {
    const r = binding
      ? run("ModifyListener", (p) => editListenerDefaultAction(p, alb.id, binding.listener.id, tgId), { success: () => `리스너 ${binding.listener.protocol}:${binding.listener.port}의 기본 작업을 변경했습니다.` })
      : run("CreateListener", (p) => addListener(p, alb.id, { protocol, port: Number(port), targetGroupId: tgId }), { success: () => `리스너 ${protocol}:${port}을(를) 추가했습니다.` });
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={binding ? `리스너 편집: ${binding.listener.protocol}:${binding.listener.port}` : "리스너 추가"}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save} disabled={!tgId || (!binding && !port)}>
            {binding ? "변경 사항 저장" : "추가"}
          </Button>
        </>
      }
    >
      <SpaceBetween size="m">
        {!binding && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="프로토콜">
              <SelectInput value={protocol} onChange={(v) => setProtocol(v as "HTTP" | "HTTPS")} options={[{ value: "HTTP", label: "HTTP" }, { value: "HTTPS", label: "HTTPS" }]} />
            </FormField>
            <FormField label="포트">
              <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </FormField>
          </div>
        )}
        <FormField label="기본 작업: 전달 대상" description="같은 VPC에 있고 다른 로드 밸런서가 쓰지 않는 대상 그룹">
          <SelectInput value={tgId} onChange={setTgId} placeholder="대상 그룹 선택" options={tgs.map((t) => ({ value: t.id, label: `${t.name} (${t.config.protocol}:${t.config.port})` }))} />
        </FormField>
        {error && <Alert type="error">{error}</Alert>}
      </SpaceBetween>
    </Modal>
  );
}

export function LoadBalancerDetailPage({ id }: { id: string }) {
  const alb = useResource(id, "alb");
  const topo = useTopology();
  const { health } = useAnalysis();
  const run = useRunAction();
  const [tab, setTab] = useQueryTab("listeners");
  const [deleting, setDeleting] = useState(false);
  const [listenerModal, setListenerModal] = useState<{ id: string | null } | null>(null);
  if (!alb) return <ResourceNotFound type="alb" id={id} />;
  const subnets = topo.albSubnets(alb.id);
  const sgs = topo.securityGroupsOf(alb.id);
  const bindings = topo.listenersOf(alb.id);
  return (
    <SpaceBetween>
      <PageHeader
        title={alb.name}
        description={alb.id}
        actions={
          <ButtonDropdown
            label="작업"
            items={[
              { id: "subnets", text: "서브넷 편집" },
              { id: "sgs", text: "보안 그룹 편집" },
              { id: "delete", text: "로드 밸런서 삭제", danger: true },
            ]}
            onItemClick={(a) => {
              if (a === "subnets") navigate(`${resourcePath("alb", alb.id)}/edit-subnets`);
              if (a === "sgs") navigate(`${resourcePath("alb", alb.id)}/edit-security-groups`);
              if (a === "delete") setDeleting(true);
            }}
          />
        }
      />
      {alb.config.state === "provisioning" && <Alert type="info">로드 밸런서를 프로비저닝하는 중입니다. Active가 되면 요청을 받을 수 있습니다.</Alert>}
      <Container header={<ContainerHeader title="세부 정보" />}>
        <KeyValueGrid
          columns={4}
          items={[
            { label: "로드 밸런서 유형", value: "Application" },
            { label: "상태", value: <LbState state={alb.config.state} />, info: <InfoLink topic="lifecycle" /> },
            { label: "VPC", value: <ResourceLink id={topo.vpcOf(alb.id)} /> },
            { label: "체계", value: alb.config.scheme },
            { label: "DNS 이름 (가상)", value: <CopyText text={topo.dnsName(alb.id) ?? ""} /> },
            { label: "가용 영역", value: subnets.map((s) => <div key={s.id}>{s.config.availabilityZone} ({s.id})</div>) },
            { label: "IP 주소 유형", value: "IPv4" },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="로드 밸런서 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "listeners",
            label: "리스너 및 규칙",
            content: (
              <Container header={<ContainerHeader title={`리스너 및 규칙 (${bindings.length})`} actions={<Button onClick={() => setListenerModal({ id: null })}>리스너 추가</Button>} />}>
                {bindings.length ? (
                  <ul className="space-y-3">
                    {bindings.map((b) => {
                      const tg = topo.getOfType(b.targetGroupId, "target-group");
                      const hs = tg ? (health.get(tg.id) ?? []) : [];
                      return (
                        <li key={b.listener.id} className="space-y-2 rounded-xl border border-aws-border p-3" data-testid="listener">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-bold">
                              {b.listener.protocol}:{b.listener.port}
                            </p>
                            <div className="flex gap-2">
                              <Button onClick={() => setListenerModal({ id: b.listener.id })}>편집</Button>
                              <Button
                                onClick={() => run("DeleteListener", (p) => deleteListener(p, alb.id, b.listener.id), { success: () => `리스너 ${b.listener.protocol}:${b.listener.port}을(를) 삭제했습니다.`, flashError: true })}
                              >
                                삭제
                              </Button>
                            </div>
                          </div>
                          <p className="text-sm">
                            기본 작업: 전달 대상 → {tg ? <ResourceLink id={tg.id} showName /> : <span className="text-aws-error">대상 그룹 없음</span>}
                          </p>
                          {tg && (
                            <ul className="space-y-1 pl-4 text-sm">
                              {hs.length ? (
                                hs.map((h) => (
                                  <li key={h.targetId} className="flex flex-wrap items-center gap-3">
                                    <ResourceLink id={h.targetId} showName /> <HealthStatus h={h} />
                                  </li>
                                ))
                              ) : (
                                <li className="text-aws-text-2">등록된 대상 없음</li>
                              )}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-aws-text-2">리스너가 없어 이 로드 밸런서는 요청을 받지 않습니다.</p>
                )}
              </Container>
            ),
          },
          {
            id: "network",
            label: "네트워크 매핑",
            content: (
              <Container header={<ContainerHeader title="네트워크 매핑" actions={<ButtonLink href={href(`${resourcePath("alb", alb.id)}/edit-subnets`)}>서브넷 편집</ButtonLink>} />}>
                <ul className="space-y-2 text-sm">
                  {subnets.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-3">
                      <span className="font-bold">{s.config.availabilityZone}</span>
                      <ResourceLink id={s.id} showName />
                      <SubnetKindLabel topo={topo} subnetId={s.id} />
                    </li>
                  ))}
                </ul>
              </Container>
            ),
          },
          {
            id: "security",
            label: "보안",
            content: (
              <Container header={<ContainerHeader title={`보안 그룹 (${sgs.length})`} actions={<ButtonLink href={href(`${resourcePath("alb", alb.id)}/edit-security-groups`)}>편집</ButtonLink>} />}>
                <ul className="space-y-1 text-sm">
                  {sgs.map((g) => (
                    <li key={g.id}>
                      <ResourceLink id={g.id} /> {g.name} <span className="text-aws-text-2">— {g.config.description}</span>
                    </li>
                  ))}
                </ul>
              </Container>
            ),
          },
        ]}
      />
      {listenerModal && <ListenerModal key={listenerModal.id ?? "new"} alb={alb} listenerId={listenerModal.id} open onClose={() => setListenerModal(null)} />}
      <DeleteAlbModal alb={deleting ? alb : undefined} onClose={() => setDeleting(false)} />
    </SpaceBetween>
  );
}

export function EditLbSubnetsPage({ id }: { id: string }) {
  const alb = useResource(id, "alb");
  const topo = useTopology();
  const run = useRunAction();
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries((alb ? topo.albSubnets(alb.id) : []).map((s) => [s.config.availabilityZone, s.id])));
  const [error, setError] = useState<string | null>(null);
  if (!alb) return <ResourceNotFound type="alb" id={id} />;
  const vpcId = topo.vpcOf(alb.id) ?? "";
  const save = () => {
    const r = run("SetSubnets", (p) => editLoadBalancerSubnets(p, alb.id, Object.values(mapping)), { success: () => `로드 밸런서 ${alb.name}의 서브넷을 변경했습니다.` });
    if (r.ok) navigate(resourcePath("alb", alb.id), { query: { tab: "network" } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="서브넷 편집" description={alb.name} />
      <Container header={<ContainerHeader title="네트워크 매핑" description="최소 2개 가용 영역" />}>
        <SubnetMapping topo={topo} vpcId={vpcId} mapping={mapping} onChange={setMapping} />
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("alb", alb.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditLbSecurityGroupsPage({ id }: { id: string }) {
  const alb = useResource(id, "alb");
  const topo = useTopology();
  const run = useRunAction();
  const [selected, setSelected] = useState<string[]>(() => (alb ? topo.securityGroupsOf(alb.id).map((g) => g.id) : []));
  const [error, setError] = useState<string | null>(null);
  if (!alb) return <ResourceNotFound type="alb" id={id} />;
  const vpcId = topo.vpcOf(alb.id);
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  const save = () => {
    const r = run("SetSecurityGroups", (p) => editLoadBalancerSecurityGroups(p, alb.id, selected), { success: () => `로드 밸런서 ${alb.name}의 보안 그룹을 변경했습니다.` });
    if (r.ok) navigate(resourcePath("alb", alb.id), { query: { tab: "security" } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="보안 그룹 편집" description={alb.name} />
      <Container header={<ContainerHeader title="보안 그룹" />}>
        <FormField label="보안 그룹" constraint="1~5개" error={error ?? undefined}>
          <MultiSelect aria-label="보안 그룹" selected={selected} onChange={setSelected} max={5} options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.id})`, description: g.config.description }))} />
        </FormField>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(resourcePath("alb", alb.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          변경 사항 저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
