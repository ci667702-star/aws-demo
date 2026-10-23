import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as aws from "@/lib/project/console-actions";
import { createEmptyProject, SG } from "@/lib/project/factory";
import { resetProjectStore, useProjectStore } from "@/lib/store/project-store";
import { useDeterministicIds } from "../helpers";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

beforeEach(() => {
  useDeterministicIds();
  vi.useFakeTimers();
  resetProjectStore();
});

afterEach(() => {
  resetProjectStore();
  vi.useRealTimers();
});

describe("프로젝트 스토어", () => {
  it("첫 방문에도 예시 프로젝트를 만들지 않는다", () => {
    const storage = memoryStorage();
    useProjectStore.getState().hydrate(storage);
    vi.runAllTimers();
    expect(useProjectStore.getState().projects).toEqual({});
    expect(storage.data.size).toBe(0);
  });

  it("Pending 인스턴스는 시간이 지나면 Running이 되며, 이 전이는 실행 취소 기록에 남지 않는다", () => {
    const storage = memoryStorage();
    useProjectStore.getState().hydrate(storage);
    const projectId = useProjectStore.getState().createProject("lifecycle");
    const apply = (label: string, fn: Parameters<ReturnType<typeof useProjectStore.getState>["apply"]>[2]) => {
      const r = useProjectStore.getState().apply(projectId, label, fn);
      if (!r.ok) throw new Error(r.error);
      return r.createdId!;
    };
    const vpcId = apply("CreateVpc", (p) => aws.createVpc(p, { name: "", cidr: "10.0.0.0/16" }));
    const subnetId = apply("CreateSubnet", (p) => aws.createSubnet(p, { vpcId, name: "", availabilityZone: null, cidr: "10.0.1.0/24" }));
    const sgId = apply("CreateSecurityGroup", (p) => aws.createSecurityGroup(p, { name: "web", description: "web", vpcId, inboundRules: [], outboundRules: [SG.all("0.0.0.0/0")] }));
    const ec2 = apply("RunInstances", (p) =>
      aws.launchInstances(p, {
        name: "web",
        ami: "amazon-linux-2023",
        instanceType: "t3.micro",
        subnetId,
        publicIpMode: "disabled",
        securityGroupIds: [sgId],
        listenPorts: [22],
        httpResponseCode: 200,
        userData: "",
        count: 1,
      }),
    );
    const state = () => {
      const r = useProjectStore.getState().projects[projectId].resources.find((x) => x.id === ec2);
      return r?.type === "ec2" ? r.config.state : null;
    };
    expect(state()).toBe("pending");
    vi.advanceTimersByTime(1000);
    expect(state()).toBe("pending");
    vi.advanceTimersByTime(600);
    expect(state()).toBe("running");
    expect(useProjectStore.getState().activity.some((a) => a.kind === "system" && a.message.includes(ec2))).toBe(true);

    // 상태 전이는 기록되지 않으므로, 실행 취소하면 인스턴스를 시작하기 전으로 돌아간다
    useProjectStore.getState().undo(projectId);
    expect(state()).toBeNull();
    // 다시 실행하면 실행 취소 직전 상태(running)로 돌아온다
    useProjectStore.getState().redo(projectId);
    expect(state()).toBe("running");

    vi.runOnlyPendingTimers();
    const saved = JSON.parse(storage.data.get("aws-playground:projects:v1")!);
    expect(saved.projects[0].resources.find((r: { id: string }) => r.id === ec2).config.state).toBe("running");
  });

  it("스토어에 없는 프로젝트의 타이머는 아무것도 바꾸지 않는다", () => {
    useProjectStore.getState().hydrate(memoryStorage());
    const p = createEmptyProject("x");
    useProjectStore.setState({ projects: { [p.id]: p } });
    vi.runAllTimers();
    expect(useProjectStore.getState().projects[p.id]).toBe(p);
  });
});
