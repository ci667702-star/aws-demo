import { beforeEach, describe, expect, it } from "vitest";
import { alarmHistory, buildMetricModel, evaluateAlarm, metricSeries, MINUTE } from "@/lib/engine/cloudwatch-engine";
import type { Alarm, Project } from "@/lib/engine/resource-models";
import * as cw from "@/lib/project/cloudwatch-actions";
import type { ActionResult } from "@/lib/project/console-actions";
import { SG } from "@/lib/project/factory";
import { idOf, publicWebProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

const NOW = Date.parse("2026-01-01T12:00:00Z");

function must(r: ActionResult): { project: Project; id: string } {
  if (!r.ok) throw new Error(r.error);
  return { project: r.project, id: r.createdId ?? "" };
}

/** t3.micro 웹 서버에 30분 전부터 20분 동안 용량만큼 부하를 준다 */
function loaded(options: { open?: boolean } = {}) {
  const p = publicWebProject({ sgInbound: options.open === false ? [] : [SG.tcp(80, "0.0.0.0/0")] });
  const web = idOf(p, "web");
  const running = { ...p, resources: p.resources.map((r) => (r.type === "ec2" ? { ...r, config: { ...r.config, state: "running" as const, listenPorts: [80] } } : r)) };
  const load = must(cw.createLoadTest(running, { name: "spike", targetId: web, port: 80, requestsPerMinute: 3000, durationMinutes: 20, startOffsetMinutes: -30 }, NOW));
  return { project: load.project, web, loadId: load.id };
}

function cpuAlarm(project: Project, web: string, overrides: Partial<cw.AlarmInput> = {}): { project: Project; alarm: Alarm } {
  const r = must(
    cw.createAlarm(project, {
      name: "high-cpu",
      description: "",
      metric: { namespace: "AWS/EC2", metricName: "CPUUtilization", resourceId: web, stat: "Average" },
      period: 60,
      comparison: "GreaterThanThreshold",
      threshold: 70,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: "missing",
      notify: true,
      ...overrides,
    }),
  );
  // 경보를 1시간 전에 만든 것으로 맞춰 기록을 결정적으로 만든다
  const alarm = { ...r.project.services.cloudwatch.alarms[0], createdAt: new Date(NOW - 60 * MINUTE).toISOString() };
  return { project: { ...r.project, services: { ...r.project.services, cloudwatch: { ...r.project.services.cloudwatch, alarms: [alarm] } } }, alarm };
}

describe("가상 지표", () => {
  it("부하가 있는 동안 CPU가 오르고, 끝나면 내려간다", () => {
    const s = loaded();
    const model = buildMetricModel(s.project);
    expect(model.loads[0].reaches).toBe(true);
    const series = metricSeries(model, { namespace: "AWS/EC2", metricName: "CPUUtilization", resourceId: s.web, stat: "Average" }, 60, NOW - 40 * MINUTE, NOW);
    const at = (minAgo: number) => series.find((d) => d.t === NOW - minAgo * MINUTE)?.value ?? null;
    expect(at(35)).toBeLessThan(10);
    expect(at(20)).toBeGreaterThan(70);
    expect(at(5)).toBeLessThan(10);
  });

  it("같은 입력이면 같은 값 (결정적)", () => {
    const s = loaded();
    const ref = { namespace: "AWS/EC2" as const, metricName: "NetworkIn", resourceId: s.web, stat: "Sum" as const };
    expect(metricSeries(buildMetricModel(s.project), ref, 300, NOW - 60 * MINUTE, NOW)).toEqual(metricSeries(buildMetricModel(s.project), ref, 300, NOW - 60 * MINUTE, NOW));
  });

  it("보안 그룹이 막으면 부하가 인스턴스에 도달하지 않는다", () => {
    const s = loaded({ open: false });
    const model = buildMetricModel(s.project);
    expect(model.loads[0].reaches).toBe(false);
    expect(model.loads[0].reason).toContain("보안 그룹");
  });
});

describe("경보", () => {
  it("임계값을 넘으면 ALARM, 부하가 끝나면 OK로 돌아오며 기록이 남는다", () => {
    const s = loaded();
    const { project, alarm } = cpuAlarm(s.project, s.web);
    const model = buildMetricModel(project);
    expect(evaluateAlarm(model, alarm, NOW - 15 * MINUTE).state).toBe("ALARM");
    const history = alarmHistory(model, alarm, NOW);
    expect(history.current.state).toBe("OK");
    expect(history.transitions.map((t) => t.to)).toEqual(["OK", "ALARM", "OK"]);
  });

  it("데이터가 없으면 INSUFFICIENT_DATA, notBreaching이면 OK", () => {
    const s = loaded();
    const stopped = { ...s.project, resources: s.project.resources.map((r) => (r.type === "ec2" ? { ...r, config: { ...r.config, state: "stopped" as const } } : r)) };
    const a = cpuAlarm(stopped, s.web);
    expect(evaluateAlarm(buildMetricModel(a.project), a.alarm, NOW).state).toBe("INSUFFICIENT_DATA");
    const b = cpuAlarm(stopped, s.web, { treatMissingData: "notBreaching" });
    expect(evaluateAlarm(buildMetricModel(b.project), b.alarm, NOW).state).toBe("OK");
  });

  it("M of N 조건을 검사한다", () => {
    const s = loaded();
    const r = cw.createAlarm(s.project, {
      name: "bad",
      description: "",
      metric: { namespace: "AWS/EC2", metricName: "CPUUtilization", resourceId: s.web, stat: "Average" },
      period: 60,
      comparison: "GreaterThanThreshold",
      threshold: 70,
      evaluationPeriods: 2,
      datapointsToAlarm: 3,
      treatMissingData: "missing",
      notify: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe("가상 부하 동작", () => {
  it("진행 중인 부하를 멈추면 지금까지만 기록된다", () => {
    const p = publicWebProject();
    const web = idOf(p, "web");
    const load = must(cw.createLoadTest(p, { name: "now", targetId: web, port: 80, requestsPerMinute: 100, durationMinutes: 60, startOffsetMinutes: -10 }, NOW));
    const stopped = must(cw.stopLoadTest(load.project, load.id, NOW)).project;
    expect(stopped.services.cloudwatch.loads[0].durationMinutes).toBe(10);
  });
});
