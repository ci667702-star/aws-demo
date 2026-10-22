/**
 * 시뮬레이션 단계별 실행 로그.
 * 엔진은 각 판단(라우팅, 보안 그룹, NACL 등)을 근거와 함께 단계로 기록한다.
 */

export type StepStatus = "pass" | "fail" | "info" | "warn";
export type StepPhase = "setup" | "request" | "service" | "response";
export type StepKind =
  | "endpoint"
  | "state"
  | "dns"
  | "route"
  | "security-group"
  | "network-acl"
  | "gateway"
  | "nat"
  | "listener"
  | "target"
  | "service";

export type FailureCategory =
  | "configuration"
  | "state"
  | "dns"
  | "routing"
  | "security-group"
  | "network-acl"
  | "gateway"
  | "listener"
  | "target"
  | "service";

export interface RuleRow {
  label: string;
  note: string;
  matched: boolean;
  /** 결정에 사용된 행인지 */
  decisive?: boolean;
}

export interface SimStep {
  index: number;
  phase: StepPhase;
  segment: string;
  kind: StepKind;
  status: StepStatus;
  title: string;
  detail: string;
  resourceIds: string[];
  /** 이 단계에서 사용된 연결(경로, 리스너 전달, 대상 등록) */
  connectionIds: string[];
  rules?: RuleRow[];
  concept?: string;
}

export interface FailureInfo {
  stepIndex: number;
  category: FailureCategory;
  reason: string;
  resourceIds: string[];
  fixes: string[];
  concept?: string;
}

export interface PathHop {
  resourceId: string | null;
  label: string;
  kind: "internet" | "resource";
}

/** 시뮬레이션을 중단시키는 "통신 실패". 엔진 내부 오류(버그)와 구분된다. */
export class SimulationHalt extends Error {
  constructor(public readonly failure: FailureInfo) {
    super(failure.reason);
    this.name = "SimulationHalt";
  }
}

export const MAX_STEPS = 400;

export interface StepInput {
  kind: StepKind;
  title: string;
  detail?: string;
  resourceIds?: (string | null | undefined)[];
  connectionIds?: (string | null | undefined)[];
  rules?: RuleRow[];
  concept?: string;
}

export interface FailInput extends StepInput {
  category: FailureCategory;
  reason?: string;
  fixes?: string[];
}

export class SimulationLog {
  readonly steps: SimStep[] = [];
  readonly path: PathHop[] = [];
  phase: StepPhase = "setup";
  segment = "";
  private truncated = false;

  private push(status: StepStatus, input: StepInput): SimStep {
    const step: SimStep = {
      index: this.steps.length,
      phase: this.phase,
      segment: this.segment,
      kind: input.kind,
      status,
      title: input.title,
      detail: input.detail ?? "",
      resourceIds: (input.resourceIds ?? []).filter((x): x is string => !!x),
      connectionIds: (input.connectionIds ?? []).filter((x): x is string => !!x),
      rules: input.rules,
      concept: input.concept,
    };
    if (this.steps.length < MAX_STEPS) this.steps.push(step);
    else this.truncated = true;
    return step;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  pass(input: StepInput): SimStep {
    return this.push("pass", input);
  }

  info(input: StepInput): SimStep {
    return this.push("info", input);
  }

  warn(input: StepInput): SimStep {
    return this.push("warn", input);
  }

  /** 실패 단계를 기록하고 시뮬레이션을 중단한다. */
  fail(input: FailInput): never {
    const step = this.push("fail", input);
    throw new SimulationHalt({
      stepIndex: step.index,
      category: input.category,
      reason: input.reason ?? input.title,
      resourceIds: step.resourceIds,
      fixes: input.fixes ?? [],
      concept: input.concept,
    });
  }

  hop(resourceId: string | null, label: string, kind: PathHop["kind"] = "resource"): void {
    const last = this.path[this.path.length - 1];
    if (last && last.resourceId === resourceId && last.label === label) return;
    if (last && kind === "internet" && last.kind === "internet") return;
    this.path.push({ resourceId, label, kind });
  }

  withSegment<T>(segment: string, phase: StepPhase, fn: () => T): T {
    const prevSegment = this.segment;
    const prevPhase = this.phase;
    this.segment = segment;
    this.phase = phase;
    try {
      return fn();
    } finally {
      this.segment = prevSegment;
      this.phase = prevPhase;
    }
  }
}
