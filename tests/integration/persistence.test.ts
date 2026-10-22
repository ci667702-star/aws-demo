import { beforeEach, describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/connectivity-engine";
import { loadProjects, saveProjects, STORAGE_KEY, type StorageLike } from "@/lib/project/persistence";
import { createThreeTierSample } from "@/lib/project/samples";
import { exportProjectJson, parseProjectJson } from "@/lib/project/serialization";
import { idOf, internet, res, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("프로젝트 저장 및 복원", () => {
  it("저장한 프로젝트를 그대로 복원하고 같은 시뮬레이션 결과를 얻는다", () => {
    const storage = memoryStorage();
    const project = createThreeTierSample();
    expect(saveProjects(storage, [project])).toEqual({ ok: true });
    const loaded = loadProjects(storage);
    expect(loaded.errors).toEqual([]);
    expect(loaded.projects).toEqual([project]);
    const req = { source: internet(), destination: res(idOf(project, "web-alb")), protocol: "tcp" as const, port: 80 };
    expect(simulate(loaded.projects[0], req).outcome).toBe("success");
  });

  it("localStorage(jsdom)에서도 저장 후 복원된다", () => {
    const project = createThreeTierSample();
    saveProjects(window.localStorage, [project]);
    expect(loadProjects(window.localStorage).projects[0].id).toBe(project.id);
  });

  it("첫 방문은 firstRun으로 표시한다", () => {
    expect(loadProjects(memoryStorage())).toMatchObject({ firstRun: true, projects: [] });
  });

  it("손상된 데이터는 백업하고 오류를 보고한다", () => {
    const storage = memoryStorage({ [STORAGE_KEY]: "{not json" });
    const loaded = loadProjects(storage);
    expect(loaded.projects).toEqual([]);
    expect(loaded.errors[0]).toContain("손상");
    expect(Object.keys(storage.data).some((k) => k.includes(":backup:"))).toBe(true);
  });

  it("일부 프로젝트만 잘못되었으면 나머지는 복원한다", () => {
    const good = createThreeTierSample();
    const bad = { ...createThreeTierSample(), connections: [{ ...good.connections[0], targetResourceId: "ghost" }] };
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, projects: [good, bad] }) });
    const loaded = loadProjects(storage);
    expect(loaded.projects.map((p) => p.id)).toEqual([good.id]);
    expect(loaded.errors.join()).toContain("잘못된 리소스 참조");
  });

  it("저장 공간 오류를 사용자에게 알릴 수 있는 메시지로 반환한다", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    const r = saveProjects(storage, [createThreeTierSample()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("저장 공간");
  });
});

describe("JSON 내보내기와 가져오기", () => {
  it("내보낸 JSON을 다시 가져올 수 있다", () => {
    const project = createThreeTierSample();
    const r = parseProjectJson(exportProjectJson(project));
    expect(r.ok && r.project).toEqual(project);
  });

  it("JSON 문법 오류를 거부한다", () => {
    const r = parseProjectJson("{ broken");
    expect(!r.ok && r.errors[0]).toContain("JSON");
  });

  it("스키마에 맞지 않는 데이터를 거부한다", () => {
    const project = createThreeTierSample();
    const broken = JSON.parse(exportProjectJson(project));
    broken.project.resources[0].type = "lambda";
    const r = parseProjectJson(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("스키마");
  });

  it("존재하지 않는 리소스를 참조하는 프로젝트를 거부한다", () => {
    const project = createThreeTierSample();
    const broken = JSON.parse(exportProjectJson(project));
    broken.project.connections[0].targetResourceId = "subnet-ghost";
    const r = parseProjectJson(JSON.stringify(broken));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("subnet-ghost");
  });

  it("관계 방향이 잘못된 연결을 거부한다", () => {
    const project = createThreeTierSample();
    const broken = JSON.parse(exportProjectJson(project));
    const c = broken.project.connections.find((x: { relationType: string }) => x.relationType === "vpc-subnet");
    [c.sourceResourceId, c.targetResourceId] = [c.targetResourceId, c.sourceResourceId];
    const r = parseProjectJson(JSON.stringify(broken));
    expect(!r.ok && r.errors.join()).toContain("방향");
  });

  it("존재하지 않는 보안 그룹을 참조하는 규칙을 거부한다", () => {
    const project = createThreeTierSample();
    const broken = JSON.parse(exportProjectJson(project));
    const sg = broken.project.resources.find((r: { name: string }) => r.name === "app-sg");
    sg.config.inboundRules[0].peer.securityGroupId = "sg-ghost";
    const r = parseProjectJson(JSON.stringify(broken));
    expect(!r.ok && r.errors.join()).toContain("sg-ghost");
  });

  it("다른 형식의 파일을 거부한다", () => {
    expect(parseProjectJson(JSON.stringify({ format: "something-else", project: {} })).ok).toBe(false);
  });
});
