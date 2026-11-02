import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Builder } from "@/components/builder/builder";
import { getResourceDoc } from "@/lib/docs";
import { RULE_FIELDS } from "@/lib/docs/rule-fields";
import { sequentialIdGenerator, setIdGenerator } from "@/lib/engine/ids";
import { RESOURCE_TYPES, type Project, type ResourceType } from "@/lib/engine/resource-models";
import { ProjectBuilder } from "@/lib/project/builder";
import { NACL, SG } from "@/lib/project/factory";
import { createThreeTierSample } from "@/lib/project/samples";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { idOf, publicWebProject } from "../helpers";
import { goTo, renderConsole, renderWithProviders, seedStore } from "./ui-helpers";

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
});

function setup(p: Project) {
  seedStore([p]);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<Builder projectId={p.id} />);
  return { user, id: p.id };
}

function select(resourceIds: string[]) {
  act(() => useEditorStore.getState().setSelection(resourceIds, []));
}

/** 13개 리소스 유형이 모두 들어 있는 프로젝트 */
function allTypesProject(): Project {
  const b = new ProjectBuilder("all-types");
  const vpc = b.vpc("vpc", "10.0.0.0/16");
  const pubA = b.subnet("public-a", vpc, "10.0.1.0/24", "ap-northeast-2a");
  const pubC = b.subnet("public-c", vpc, "10.0.2.0/24", "ap-northeast-2c");
  const dbA = b.subnet("db-a", vpc, "10.0.21.0/24", "ap-northeast-2a");
  const dbC = b.subnet("db-c", vpc, "10.0.22.0/24", "ap-northeast-2c");
  const igw = b.igw("igw", vpc);
  b.routeTable("public-rt", vpc, { subnets: [pubA, pubC], routes: [{ destination: "0.0.0.0/0", igw }] });
  b.nat("nat", pubA);
  const albSg = b.securityGroup("alb-sg", vpc, { inbound: [SG.tcp(80, "0.0.0.0/0")] });
  const webSg = b.securityGroup("web-sg", vpc, { inbound: [SG.tcp(80, { sg: albSg })] });
  const dbSg = b.securityGroup("db-sg", vpc, { inbound: [SG.tcp(3306, { sg: webSg })] });
  b.networkAcl("db-nacl", vpc, { subnets: [dbA, dbC], inbound: [NACL.allow(100, "all", [0, 65535], "10.0.0.0/16")], outbound: [NACL.allow(100, "all", [0, 65535], "10.0.0.0/16")] });
  const web = b.ec2("web", pubA, { ip: "10.0.1.10", publicIp: "enabled", sgs: [webSg], listenPorts: [80] });
  b.associateElasticIp(b.elasticIp("web-eip"), web);
  const tg = b.targetGroup("web-tg", { vpc, targets: [web] });
  b.alb("web-alb", { subnets: [pubA, pubC], sgs: [albSg], listeners: [{ port: 80, targetGroup: tg }] });
  const group = b.dbSubnetGroup("db-group", [dbA, dbC], "private db");
  b.rds("db", { subnetGroup: group, sgs: [dbSg] });
  return b.build();
}

const inspector = () => screen.getByTestId("inspector");

describe("리소스 상세 설명 패널 (쉬운 모드)", () => {
  it("아무것도 선택하지 않으면 안내 문구를 보여 준다", async () => {
    setup(createThreeTierSample());
    expect(await screen.findByTestId("inspector-empty-hint")).toHaveTextContent("리소스를 선택하면 상세 설명과 설정 가이드를 확인할 수 있습니다.");
  });

  it("다른 리소스를 선택하면 이전 리소스의 설명이 남지 않는다", async () => {
    const p = createThreeTierSample();
    setup(p);
    select([idOf(p, "web-alb")]);
    const header = await screen.findByTestId("doc-header");
    expect(header).toHaveAttribute("data-doc-key", "alb");
    expect(within(inspector()).getByTestId("doc-summary")).toHaveTextContent(getResourceDoc("alb").summary);

    select([idOf(p, "orders-db")]);
    await waitFor(() => expect(screen.getByTestId("doc-header")).toHaveAttribute("data-doc-key", "rds"));
    const panel = inspector();
    expect(within(panel).getByTestId("doc-summary")).toHaveTextContent(getResourceDoc("rds").summary);
    expect(panel).not.toHaveTextContent(getResourceDoc("alb").summary);
    expect(within(panel).getByTestId("resource-name")).toHaveValue("orders-db");
  });

  it("13개 리소스 유형 모두 설정 도움말이 빠짐없이 연결되고, 검증 규칙이 가리키는 설정 항목이 폼에 있다", async () => {
    const p = allTypesProject();
    setup(p);
    const covered = new Set<ResourceType>();
    for (const r of p.resources) {
      if (covered.has(r.type)) continue;
      covered.add(r.type);
      select([r.id]);
      await waitFor(() => expect(screen.getByTestId("doc-header")).toHaveAttribute("data-doc-key", r.type));
      const panel = inspector();
      expect(document.querySelectorAll("[data-help-missing]"), `${r.type} 도움말 누락`).toHaveLength(0);
      expect(within(panel).getAllByTestId(/^field-help-/).length).toBeGreaterThan(2);
      const fields = new Set([...panel.querySelectorAll<HTMLElement>("[data-field]")].map((el) => el.dataset.field));
      for (const [ruleId, map] of Object.entries(RULE_FIELDS)) {
        const field = map[r.type];
        if (field) expect(fields.has(field), `${ruleId} → ${r.type}.${field}`).toBe(true);
      }
    }
    expect([...covered].sort()).toEqual([...RESOURCE_TYPES].sort());
  });

  it("설정 옆 도움말 아이콘을 누르면 실제 AWS와 시뮬레이터 동작을 나눠 설명한다", async () => {
    const p = createThreeTierSample();
    const { user } = setup(p);
    select([idOf(p, "app-1")]);
    // 설정 폼(C)의 아이콘 — 같은 설정의 아이콘이 분석(E)에도 있다
    const settings = await screen.findByTestId("doc-section-settings");
    await user.click(within(settings).getByRole("button", { name: /인스턴스 유형.*도움말/ }));
    const popover = await screen.findByTestId("field-help-popover");
    const help = getResourceDoc("ec2").fields.instanceType;
    expect(popover).toHaveTextContent(help.meaning);
    expect(within(popover).getByText("실제 AWS에서는")).toBeInTheDocument();
    expect(within(popover).getByText("이 시뮬레이터에서는")).toBeInTheDocument();
    expect(popover).toHaveTextContent(help.simulator);
  });

  it("관련 리소스를 누르면 그 리소스의 설명으로 이동한다", async () => {
    const p = createThreeTierSample();
    const { user } = setup(p);
    select([idOf(p, "app-1")]);
    const relations = await screen.findByTestId("current-relations");
    await user.click(within(relations).getAllByRole("button", { name: /app-a/ })[0]);
    await waitFor(() => expect(screen.getByTestId("doc-header")).toHaveAttribute("data-doc-key", "subnet"));
    expect(useEditorStore.getState().selectedResourceIds).toEqual([idOf(p, "app-a")]);
  });

  it("설정을 바꾸면 현재 구성 분석이 바로 바뀐다", async () => {
    const p = publicWebProject();
    const { id } = setup(p);
    select([idOf(p, "web")]);
    const internetCheck = () => within(screen.getByTestId("analysis-checks")).getByText(/인터넷 → 이 인스턴스/).closest("li")!;
    await waitFor(() => expect(internetCheck()).toHaveAttribute("data-tone", "ok"));
    const sgId = idOf(p, "web-sg");
    act(() => {
      useProjectStore.getState().apply(id, "규칙 삭제", (cur) => ({
        ok: true,
        project: { ...cur, resources: cur.resources.map((r) => (r.id === sgId && r.type === "security-group" ? { ...r, config: { ...r.config, inboundRules: [] } } : r)) },
        notes: [],
      }));
    });
    await waitFor(() => expect(internetCheck()).toHaveAttribute("data-tone", "error"));
  });

  it("검증 센터의 '설정으로 이동'은 해당 리소스의 설정 항목을 펼치고 강조한다", async () => {
    const b = new ProjectBuilder("outside");
    const vpc = b.vpc("vpc", "10.0.0.0/16");
    const subnet = b.subnet("outside", vpc, "10.9.1.0/24", "ap-northeast-2a");
    const { user } = setup(b.build());
    const center = await screen.findByTestId("validation-center");
    const finding = within(center).getAllByTestId("finding").find((f) => f.dataset.rule === "NET-004")!;
    await user.click(within(finding).getAllByRole("button")[0]);
    const related = within(finding).getByTestId("finding-related-settings");
    expect(within(finding).getByTestId("finding-project-analysis")).toHaveTextContent("현재 프로젝트 분석");
    const row = within(related).getByText("outside").parentElement!;
    await user.click(within(row).getByRole("button", { name: "설정으로 이동" }));
    await waitFor(() => expect(useEditorStore.getState().selectedResourceIds).toEqual([subnet]));
    await waitFor(() => expect(inspector().querySelector('[data-field="cidr"]')).toHaveAttribute("data-field-flash"));
  });

  it("시뮬레이션이 실패하면 차단한 설정 항목으로 바로 갈 수 있다", async () => {
    const p = publicWebProject({ sgInbound: [] });
    const { user } = setup(p);
    select([idOf(p, "web")]);
    const check = (await within(await screen.findByTestId("analysis-checks")).findByText(/인터넷 → 이 인스턴스/)).closest("li")!;
    expect(check).toHaveAttribute("data-tone", "error");
    await user.click(within(check).getByRole("button", { name: /시뮬레이션 다시 실행/ }));
    const result = await screen.findByTestId("simulation-result", {}, { timeout: 3000 });
    expect(result.dataset.outcome).toBe("failure");
    // 실패한 단계(자동으로 펼쳐짐)에도 그 단계를 결정한 설정으로 가는 버튼이 있다
    expect(within(result).getAllByTestId("step-open-field").length).toBeGreaterThan(0);
    const open = within(result).getAllByTestId("failure-open-field");
    await user.click(open.find((b) => /인바운드 규칙/.test(b.textContent ?? "")) ?? open[0]);
    await waitFor(() => expect(useEditorStore.getState().selectedResourceIds).toEqual([idOf(p, "web-sg")]));
    await waitFor(() => expect(inspector().querySelector('[data-field="inboundRules"]')).toHaveAttribute("data-field-flash"));
  });

  it("팔레트의 설명 버튼은 리소스 유형 설명을, 서비스 항목은 S3·IAM·CloudWatch 설명을 연다", async () => {
    const p = createThreeTierSample();
    const { user, id } = setup(p);
    await user.click(screen.getByTestId("palette-info-ec2"));
    const typePanel = await screen.findByTestId("type-doc-panel");
    expect(typePanel).toHaveAttribute("data-doc-key", "ec2");
    expect(within(typePanel).getByTestId("type-doc-existing")).toHaveTextContent("현재 프로젝트의 EC2");
    expect(p.resources.filter((r) => r.type === "ec2")).toHaveLength(2);
    expect(within(typePanel).getByTestId("type-doc-existing")).toHaveTextContent("2개");

    await user.click(screen.getByTestId("palette-service-s3"));
    const svc = await screen.findByTestId("service-doc-panel");
    expect(svc).toHaveAttribute("data-doc-key", "s3");
    expect(within(svc).getByTestId("service-doc-console")).toHaveAttribute("href", `/console/${id}#/s3`);
    // 버킷이 없으면 퍼블릭으로 열린 버킷이 있다고 말하지 않는다
    expect(within(svc).getByTestId("analysis-headline")).toBeInTheDocument();

    // 캔버스의 리소스를 고르면 서비스 설명이 닫히고 리소스 설명으로 바뀐다
    select([idOf(p, "web-tg")]);
    await waitFor(() => expect(screen.getByTestId("doc-header")).toHaveAttribute("data-doc-key", "target-group"));
    expect(screen.queryByTestId("service-doc-panel")).not.toBeInTheDocument();
  });
});

describe("리소스 설명 탭 (심화 모드)", () => {
  it("화면의 리소스를 따라 설명이 바뀌고, 콘솔 폼에도 설정 도움말이 있다", async () => {
    const p = createThreeTierSample();
    seedStore([p]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const app1 = idOf(p, "app-1");
    renderConsole(p.id, `#/ec2/instances/${app1}`);
    await user.click(await screen.findByTestId("open-resource-doc"));
    const doc = await screen.findByTestId("console-resource-doc");
    expect(doc).toHaveAttribute("data-doc-key", "ec2");
    expect(within(doc).getByTestId("doc-header")).toHaveTextContent("app-1");
    expect(within(doc).getByTestId("analysis-headline")).toBeInTheDocument();

    await goTo("#/s3");
    expect(await screen.findByTestId("console-service-doc")).toHaveAttribute("data-doc-key", "s3");

    await goTo("#/vpc/subnets");
    expect(await screen.findByTestId("console-type-doc")).toHaveAttribute("data-doc-key", "subnet");

    await goTo("#/ec2/instances/launch");
    const main = document.getElementById("console-main")!;
    expect(await within(main).findByTestId("field-help-instanceType")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-help-missing]")).toHaveLength(0);
  });
});
