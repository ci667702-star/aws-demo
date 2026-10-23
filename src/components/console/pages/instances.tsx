"use client";

import { useState } from "react";
import type { ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import {
  AMI_INFO,
  changeInstanceSecurityGroups,
  changeInstanceState,
  editInstanceUserData,
  INSTANCE_TYPE_INFO,
  type InstanceAction,
} from "@/lib/project/console-actions";
import { useAnalysis } from "../analysis-context";
import { useRunAction } from "../console-context";
import { href, navigate, resourcePath } from "../router";
import { Alert } from "../ui/alert";
import { Button, ButtonDropdown, ButtonLink } from "../ui/button";
import { FormActions, FormField, MultiSelect } from "../ui/form";
import { Container, ContainerHeader, EmptyState, KeyValueGrid, PageHeader, SpaceBetween } from "../ui/layout";
import { InfoLink, ResourceLink, TypedResourceLink } from "../ui/links";
import { DeleteModal } from "../ui/overlay";
import { ResourceTable } from "../ui/table";
import { Tabs } from "../ui/tabs";
import { CopyText, StatusIndicator } from "../ui/status";
import { InstanceState, ipText, NameCell, ResourceNotFound, sortName, useQueryTab, useResource, useSelection, useTopology } from "./common";
import { SgRulesTable } from "./network-tables";
import { EditNameModal } from "./shared-modals";
import { UserDataFields, useUserDataDraft } from "./user-data";

type Instance = ResourceOfType<"ec2">;

const STATE_EVENT: Record<InstanceAction, string> = { start: "StartInstances", stop: "StopInstances", reboot: "RebootInstances", terminate: "TerminateInstances" };
const STATE_LABEL: Record<InstanceAction, string> = { start: "시작", stop: "중지", reboot: "재부팅", terminate: "종료" };

function StateChangeModal({ instances, action, onClose }: { instances: Instance[]; action: InstanceAction | null; onClose: () => void }) {
  const run = useRunAction();
  if (!action || !instances.length) return null;
  const confirm = () => {
    const failures: string[] = [];
    for (const i of instances) {
      const r = run(STATE_EVENT[action], (p) => changeInstanceState(p, i.id, action), {
        success: () => `인스턴스 ${i.id}을(를) ${STATE_LABEL[action]}${action === "terminate" ? "했습니다" : "하는 중입니다"}.`,
      });
      if (!r.ok) failures.push(r.error);
    }
    return failures.length ? failures.join(" ") : null;
  };
  return (
    <DeleteModal
      open
      onClose={onClose}
      title={action === "terminate" ? "인스턴스 종료(삭제)" : `인스턴스 ${STATE_LABEL[action]}`}
      actionLabel={action === "terminate" ? "종료(삭제)" : STATE_LABEL[action]}
      onConfirm={confirm}
    >
      <p>다음 인스턴스를 {STATE_LABEL[action]}하시겠습니까?</p>
      <ul className="list-disc pl-5">
        {instances.map((i) => (
          <li key={i.id}>
            {i.id} ({displayName(i)}) — 현재 {i.config.state}
          </li>
        ))}
      </ul>
      {action === "stop" && <p className="text-aws-text-2">자동 할당된 퍼블릭 IPv4 주소는 중지하면 해제됩니다. 탄력적 IP는 유지됩니다.</p>}
      {action === "terminate" && <p className="text-aws-text-2">종료한 인스턴스는 다시 시작할 수 없습니다. 대상 그룹에서 등록 해제되고 탄력적 IP 연결이 해제됩니다.</p>}
    </DeleteModal>
  );
}

function instanceActions(selected: Instance[]) {
  const one = selected.length === 1 ? selected[0] : undefined;
  const can = (pred: (i: Instance) => boolean) => selected.length > 0 && selected.every(pred);
  return {
    state: [
      { id: "stop", text: "인스턴스 중지", disabled: !can((i) => i.config.state === "running" || i.config.state === "pending") },
      { id: "start", text: "인스턴스 시작", disabled: !can((i) => i.config.state === "stopped") },
      { id: "reboot", text: "인스턴스 재부팅", disabled: !can((i) => i.config.state === "running") },
      { id: "terminate", text: "인스턴스 종료(삭제)", disabled: !can((i) => i.config.state !== "terminated"), danger: true },
    ],
    actions: [
      { id: "network", text: "네트워킹", items: [{ id: "eip", text: "탄력적 IP 주소 연결", disabled: !one || one.config.state === "terminated" }] },
      { id: "security", text: "보안", items: [{ id: "sgs", text: "보안 그룹 변경", disabled: !one || one.config.state === "terminated" }] },
      {
        id: "settings",
        text: "인스턴스 설정",
        items: [
          { id: "userdata", text: "사용자 데이터 편집", disabled: !one || one.config.state === "terminated", description: "인스턴스가 중지된 상태에서만 편집 가능" },
          { id: "tags", text: "태그 관리", disabled: !one },
        ],
      },
    ],
  };
}

export function InstanceListPage() {
  const topo = useTopology();
  const instances = topo.ofType("ec2");
  const [selected, setSelected] = useSelection();
  const [action, setAction] = useState<InstanceAction | null>(null);
  const [naming, setNaming] = useState(false);
  const chosen = instances.filter((i) => selected.includes(i.id));
  const items = instanceActions(chosen);
  const one = chosen.length === 1 ? chosen[0] : undefined;
  const onAction = (id: string) => {
    if (id === "eip") navigate("/ec2/eips");
    if (id === "sgs" && one) navigate(`${resourcePath("ec2", one.id)}/security-groups`);
    if (id === "userdata" && one) navigate(`${resourcePath("ec2", one.id)}/user-data`);
    if (id === "tags") setNaming(true);
  };
  return (
    <SpaceBetween>
      <ResourceTable<Instance>
        ariaLabel="인스턴스 목록"
        items={instances}
        trackBy={(i) => i.id}
        selectionType="multi"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(i) => displayName(i)}
        header={
          <PageHeader
            title="인스턴스"
            counter={`(${instances.length})`}
            info={<InfoLink topic="ec2-launch" />}
            actions={
              <>
                <ButtonDropdown label="인스턴스 상태" items={items.state} onItemClick={(id) => setAction(id as InstanceAction)} disabled={!chosen.length} />
                <ButtonDropdown label="작업" items={items.actions} onItemClick={onAction} />
                <ButtonLink variant="primary" href={href("/ec2/instances/launch")}>
                  인스턴스 시작
                </ButtonLink>
              </>
            }
          />
        }
        empty={<EmptyState title="인스턴스 없음" description="이 샌드박스에는 아직 인스턴스가 없습니다." action={<ButtonLink href={href("/ec2/instances/launch")}>인스턴스 시작</ButtonLink>} />}
        columns={[
          { id: "name", header: "Name", cell: (i) => <NameCell r={i} />, sortValue: sortName, filterValue: (i) => i.name },
          { id: "id", header: "인스턴스 ID", cell: (i) => <TypedResourceLink type="ec2" id={i.id} />, sortValue: (i) => i.id },
          { id: "state", header: "인스턴스 상태", cell: (i) => <InstanceState state={i.config.state} />, sortValue: (i) => i.config.state, filterValue: (i) => i.config.state },
          { id: "type", header: "인스턴스 유형", cell: (i) => i.config.instanceType, sortValue: (i) => i.config.instanceType },
          { id: "az", header: "가용 영역", cell: (i) => topo.getOfType(topo.subnetOf(i.id), "subnet")?.config.availabilityZone ?? "–" },
          { id: "public", header: "퍼블릭 IPv4 주소", cell: (i) => ipText(topo.enisOf(i.id)[0]?.publicIp), filterValue: (i) => ipText(topo.enisOf(i.id)[0]?.publicIp) },
          { id: "eip", header: "탄력적 IP", cell: (i) => topo.elasticIpOf(i.id)?.config.publicIp ?? "–" },
          { id: "private", header: "프라이빗 IPv4 주소", cell: (i) => i.config.privateIp, sortValue: (i) => i.config.privateIp },
          { id: "sg", header: "보안 그룹 이름", cell: (i) => topo.securityGroupsOf(i.id).map((g) => g.name).join(", ") || "–" },
        ]}
      />
      <StateChangeModal instances={chosen} action={action} onClose={() => setAction(null)} />
      <EditNameModal resource={one} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function InstanceDetailPage({ id }: { id: string }) {
  const inst = useResource(id, "ec2");
  const topo = useTopology();
  const { health } = useAnalysis();
  const [tab, setTab] = useQueryTab("details");
  const [action, setAction] = useState<InstanceAction | null>(null);
  const [naming, setNaming] = useState(false);
  if (!inst) return <ResourceNotFound type="ec2" id={id} />;
  const items = instanceActions([inst]);
  const eni = topo.enisOf(inst.id)[0];
  const subnetId = topo.subnetOf(inst.id);
  const subnet = topo.getOfType(subnetId, "subnet");
  const sgs = topo.securityGroupsOf(inst.id);
  const eip = topo.elasticIpOf(inst.id);
  const tgs = topo.ofType("target-group").filter((tg) => topo.targetGroupTargets(tg.id).some((t) => t.ec2.id === inst.id));
  const onAction = (a: string) => {
    if (a === "eip") navigate("/ec2/eips");
    if (a === "sgs") navigate(`${resourcePath("ec2", inst.id)}/security-groups`);
    if (a === "userdata") navigate(`${resourcePath("ec2", inst.id)}/user-data`);
    if (a === "tags") setNaming(true);
  };
  const publicMode = { "subnet-default": `서브넷 설정 사용 (${subnet?.config.mapPublicIpOnLaunch ? "활성화" : "비활성화"})`, enabled: "활성화", disabled: "비활성화" }[inst.config.publicIpMode];
  return (
    <SpaceBetween>
      <PageHeader
        title={`인스턴스 요약: ${inst.id}${inst.name ? ` (${inst.name})` : ""}`}
        actions={
          <>
            <ButtonDropdown label="인스턴스 상태" items={items.state} onItemClick={(a) => setAction(a as InstanceAction)} />
            <ButtonDropdown label="작업" items={items.actions} onItemClick={onAction} />
          </>
        }
      />
      {inst.config.state === "pending" && <Alert type="info">인스턴스를 시작하는 중입니다 (Pending). Running이 되면 통신할 수 있습니다.</Alert>}
      <Container header={<ContainerHeader title="요약" />}>
        <KeyValueGrid
          columns={3}
          items={[
            { label: "인스턴스 ID", value: <CopyText text={inst.id} /> },
            { label: "퍼블릭 IPv4 주소", value: eni?.publicIp != null ? <CopyText text={ipText(eni.publicIp)} /> : "–", info: <InfoLink topic="public-ip" /> },
            { label: "프라이빗 IPv4 주소", value: inst.config.privateIp },
            { label: "인스턴스 상태", value: <InstanceState state={inst.config.state} />, info: <InfoLink topic="lifecycle" /> },
            { label: "프라이빗 IP DNS 이름 (가상)", value: topo.dnsName(inst.id) ?? "–" },
            { label: "인스턴스 유형", value: `${inst.config.instanceType} (${INSTANCE_TYPE_INFO[inst.config.instanceType]})` },
            { label: "탄력적 IP 주소", value: eip ? <ResourceLink id={eip.id} /> : "–" },
            { label: "VPC ID", value: <ResourceLink id={topo.vpcOf(inst.id)} showName /> },
            { label: "서브넷 ID", value: <ResourceLink id={subnetId} showName /> },
          ]}
        />
      </Container>
      <Tabs
        ariaLabel="인스턴스 탭"
        activeId={tab}
        onChange={setTab}
        tabs={[
          {
            id: "details",
            label: "세부 정보",
            content: (
              <Container header={<ContainerHeader title="인스턴스 세부 정보" />}>
                <KeyValueGrid
                  columns={3}
                  items={[
                    { label: "AMI", value: AMI_INFO[inst.config.ami].label },
                    { label: "플랫폼", value: AMI_INFO[inst.config.ami].family === "windows" ? "Windows" : "Linux/UNIX" },
                    { label: "키 페어", value: "없음 (가상 환경)" },
                    { label: "가용 영역", value: subnet?.config.availabilityZone ?? "–" },
                    { label: "퍼블릭 IP 자동 할당", value: publicMode },
                    { label: "가상 서비스 포트", value: inst.config.listenPorts.join(", ") || "없음", info: <InfoLink topic="user-data" /> },
                  ]}
                />
              </Container>
            ),
          },
          {
            id: "security",
            label: "보안",
            content: (
              <Container header={<ContainerHeader title="보안 세부 정보" actions={<Button onClick={() => onAction("sgs")} disabled={inst.config.state === "terminated"}>보안 그룹 변경</Button>} />}>
                <SpaceBetween size="m">
                  <KeyValueGrid columns={2} items={[{ label: "보안 그룹", value: sgs.length ? sgs.map((g) => <div key={g.id}><ResourceLink id={g.id} /> ({g.name})</div>) : "없음" }]} />
                  {sgs.map((g) => (
                    <div key={g.id} className="space-y-2">
                      <h3 className="text-sm font-bold">
                        인바운드 규칙 — {g.id} ({g.name})
                      </h3>
                      <SgRulesTable rules={g.config.inboundRules} direction="inbound" topo={topo} />
                    </div>
                  ))}
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "networking",
            label: "네트워킹",
            content: (
              <Container header={<ContainerHeader title="네트워킹 세부 정보" />}>
                <KeyValueGrid
                  columns={3}
                  items={[
                    { label: "퍼블릭 IPv4 주소", value: ipText(eni?.publicIp) },
                    { label: "프라이빗 IPv4 주소", value: inst.config.privateIp },
                    { label: "VPC ID", value: <ResourceLink id={topo.vpcOf(inst.id)} /> },
                    { label: "서브넷 ID", value: <ResourceLink id={subnetId} /> },
                    { label: "가용 영역", value: subnet?.config.availabilityZone ?? "–" },
                    { label: "서브넷 라우팅", value: subnetId ? topo.classifySubnet(subnetId).reason : "–" },
                  ]}
                />
              </Container>
            ),
          },
          {
            id: "user-data",
            label: "사용자 데이터",
            content: (
              <Container header={<ContainerHeader title="사용자 데이터" info={<InfoLink topic="user-data" />} actions={<Button onClick={() => onAction("userdata")} disabled={inst.config.state === "terminated"}>사용자 데이터 편집</Button>} />}>
                <SpaceBetween size="m">
                  <KeyValueGrid
                    columns={2}
                    items={[
                      { label: "가상 서비스 포트", value: inst.config.listenPorts.join(", ") || "없음" },
                      { label: "가상 HTTP 응답 코드", value: inst.config.httpResponseCode },
                    ]}
                  />
                  <pre className="overflow-x-auto rounded-lg border border-aws-border bg-aws-surface-2 p-3 font-mono text-[13px] whitespace-pre-wrap text-aws-text">{inst.config.userData || "(사용자 데이터 없음)"}</pre>
                  <p className="text-xs text-aws-text-2">스크립트는 실행되지 않습니다. 위 가상 서비스 포트만 응답하는 것으로 시뮬레이션합니다.</p>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "target-groups",
            label: `대상 그룹 (${tgs.length})`,
            content: (
              <Container header={<ContainerHeader title="등록된 대상 그룹" />}>
                {tgs.length ? (
                  <ul className="space-y-2 text-sm">
                    {tgs.map((tg) => {
                      const h = health.get(tg.id)?.find((x) => x.targetId === inst.id);
                      return (
                        <li key={tg.id} className="flex flex-wrap items-center gap-3">
                          <ResourceLink id={tg.id} showName />
                          {h && <StatusIndicator type={h.state === "healthy" ? "success" : h.state === "unhealthy" ? "error" : "info"}>{h.state}{h.reason ? ` (${h.reason})` : ""}</StatusIndicator>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-aws-text-2">이 인스턴스는 대상 그룹에 등록되어 있지 않습니다.</p>
                )}
              </Container>
            ),
          },
        ]}
      />
      <StateChangeModal instances={[inst]} action={action} onClose={() => setAction(null)} />
      <EditNameModal resource={inst} open={naming} onClose={() => setNaming(false)} />
    </SpaceBetween>
  );
}

export function ChangeInstanceSgsPage({ id }: { id: string }) {
  const inst = useResource(id, "ec2");
  const topo = useTopology();
  const run = useRunAction();
  const [selected, setSelected] = useState<string[]>(() => (inst ? topo.securityGroupsOf(inst.id).map((g) => g.id) : []));
  const [error, setError] = useState<string | null>(null);
  if (!inst) return <ResourceNotFound type="ec2" id={id} />;
  const vpcId = topo.vpcOf(inst.id);
  const groups = topo.ofType("security-group").filter((g) => topo.vpcOf(g.id) === vpcId);
  const save = () => {
    const r = run("ModifyInstanceAttribute", (p) => changeInstanceSecurityGroups(p, inst.id, selected), { success: () => `인스턴스 ${inst.id}의 보안 그룹을 변경했습니다.` });
    if (r.ok) navigate(resourcePath("ec2", inst.id), { query: { tab: "security" } });
    else setError(r.error);
  };
  return (
    <SpaceBetween>
      <PageHeader title="보안 그룹 변경" info={<InfoLink topic="security-group" />} description={`${inst.id} (${displayName(inst)}) — 인스턴스와 같은 VPC(${vpcId})의 보안 그룹만 연결할 수 있습니다.`} />
      <Container header={<ContainerHeader title="연결된 보안 그룹" />}>
        <FormField label="보안 그룹" constraint="1~5개" error={error ?? undefined}>
          <MultiSelect selected={selected} onChange={setSelected} max={5} aria-label="보안 그룹" options={groups.map((g) => ({ value: g.id, label: `${g.id} (${g.name})`, description: g.config.description }))} />
        </FormField>
      </Container>
      <FormActions>
        <ButtonLink variant="link" href={href(resourcePath("ec2", inst.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}

export function EditUserDataPage({ id }: { id: string }) {
  const inst = useResource(id, "ec2");
  const run = useRunAction();
  const draft = useUserDataDraft(inst?.config.ami ?? "amazon-linux-2023", inst ? { listenPorts: inst.config.listenPorts, httpResponseCode: inst.config.httpResponseCode, userData: inst.config.userData } : undefined);
  const [error, setError] = useState<string | null>(null);
  if (!inst) return <ResourceNotFound type="ec2" id={id} />;
  const stopped = inst.config.state === "stopped";
  const save = () => {
    const value = draft.toValue();
    if (!value.ok) return setError(value.error);
    const r = run("ModifyInstanceAttribute", (p) => editInstanceUserData(p, inst.id, value.value), { success: () => `인스턴스 ${inst.id}의 사용자 데이터를 저장했습니다. 다시 시작하면 적용된 서비스가 응답합니다.` });
    if (r.ok) navigate(resourcePath("ec2", inst.id), { query: { tab: "user-data" } });
    else setError([r.error, r.hint].filter(Boolean).join(" "));
  };
  return (
    <SpaceBetween>
      <PageHeader title="사용자 데이터 편집" info={<InfoLink topic="user-data" />} description={`${inst.id} (${displayName(inst)})`} />
      {!stopped && (
        <Alert
          type="warning"
          header="인스턴스를 중지해야 합니다"
          action={
            inst.config.state !== "terminated" ? (
              <Button onClick={() => run("StopInstances", (p) => changeInstanceState(p, inst.id, "stop"), { success: () => `인스턴스 ${inst.id}을(를) 중지했습니다.`, flashError: true })}>인스턴스 중지</Button>
            ) : undefined
          }
        >
          AWS와 마찬가지로 사용자 데이터는 인스턴스가 중지된 상태에서만 편집할 수 있습니다. 현재 상태: {inst.config.state}
        </Alert>
      )}
      <Container header={<ContainerHeader title="사용자 데이터" />}>
        <UserDataFields ami={inst.config.ami} draft={draft} disabled={!stopped} />
      </Container>
      <FormActions error={error ? <Alert type="error">{error}</Alert> : undefined}>
        <ButtonLink variant="link" href={href(resourcePath("ec2", inst.id))}>
          취소
        </ButtonLink>
        <Button variant="primary" onClick={save} disabled={!stopped}>
          저장
        </Button>
      </FormActions>
    </SpaceBetween>
  );
}
