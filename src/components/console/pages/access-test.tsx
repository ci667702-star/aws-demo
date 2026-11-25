"use client";

/**
 * "누가 어디서 이 값을 읽을 수 있나?" 접근 테스트 (Secrets Manager·Parameter Store 공용).
 * 호출자를 고르면 네트워크 → 자격 증명 → IAM 권한 → 대상 상태 순서로 근거를 보여 준다. 실제 요청은 보내지 않는다.
 */
import { useState } from "react";
import { apiCallerOptions, type AccessStep, type ApiAccessResult, type ApiCaller } from "@/lib/engine/service-access";
import { useProject } from "../console-context";
import { href } from "../router";
import { Button } from "../ui/button";
import { FormField, SelectInput } from "../ui/form";
import { Container, ContainerHeader, SpaceBetween } from "../ui/layout";
import { StatusIndicator, type StatusType } from "../ui/status";
import { useTopology } from "./common";

const STEP_TYPE: Record<AccessStep["status"], StatusType> = { pass: "success", fail: "error", info: "info", warn: "warning" };

/** 판정 근거 목록 (단계마다 통과·실패와 이유, 고칠 곳으로 가는 링크) */
export function AccessSteps({ steps }: { steps: AccessStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="rounded-xl border border-aws-border p-3">
          <StatusIndicator type={STEP_TYPE[s.status]}>
            <span className="font-bold">
              {i + 1}. {s.title}
            </span>
          </StatusIndicator>
          <p className="mt-1 pl-6 text-[15px] leading-relaxed break-words">{s.detail}</p>
          {s.link && (
            <a className="mt-1 inline-block pl-6 text-sm text-aws-link hover:underline" href={href(s.link.path)}>
              {s.link.label} →
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AccessTestPanel({
  title,
  description,
  action,
  evaluate,
  children,
  testId,
}: {
  title: string;
  description: string;
  /** 평가하는 IAM 작업 (표시용) */
  action: string;
  evaluate: (caller: ApiCaller) => ApiAccessResult;
  /** 호출자 아래에 둘 추가 선택 항목 */
  children?: React.ReactNode;
  testId: string;
}) {
  const project = useProject();
  const topo = useTopology();
  const callers = apiCallerOptions(project, topo);
  const [value, setValue] = useState(callers[0]?.value ?? "");
  const [tested, setTested] = useState<string | null>(null);
  const caller = callers.find((c) => c.value === (tested ?? ""));
  // 설정을 바꾸면 결과도 바로 다시 계산된다
  const result = caller ? evaluate(caller.caller) : null;
  return (
    <Container header={<ContainerHeader title={title} description={description} />}>
      <SpaceBetween size="m">
        {callers.length ? (
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="누가 읽나요? (호출자)" className="min-w-64 flex-1" constraint={`평가하는 작업: ${action}`}>
              <SelectInput value={value} onChange={setValue} options={callers.map((c) => ({ value: c.value, label: c.label }))} />
            </FormField>
            {children}
            <Button variant="primary" onClick={() => setTested(value)} data-testid={`${testId}-run`} className="mb-6">
              테스트 실행
            </Button>
          </div>
        ) : (
          <p className="text-[15px] text-aws-text-2">테스트할 호출자가 없습니다. Lambda 함수, EC2 인스턴스, IAM 역할·사용자 중 하나를 먼저 만드세요.</p>
        )}
        {result && (
          <div className="space-y-3" data-testid={`${testId}-result`} data-ok={result.ok}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusIndicator type={result.ok ? "success" : "error"}>
                <span className="font-bold">{result.summary}</span>
              </StatusIndicator>
              <span className={result.ok ? "font-mono text-sm font-bold text-aws-success" : "font-mono text-sm font-bold text-aws-error"}>{result.code}</span>
            </div>
            <AccessSteps steps={result.steps} />
            {result.decision && result.decision.matched.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-bold">일치한 정책 문장</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">
                  {result.decision.matched.map((m, i) => (
                    <li key={i}>
                      <span className={m.statement.effect === "Deny" ? "font-bold text-aws-error" : "font-bold text-aws-success"}>{m.statement.effect}</span> · {m.source}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[13px] text-aws-text-2">설정(정책·경로·보안 그룹)을 바꾸면 결과가 바로 다시 계산됩니다. 실제 요청은 보내지 않습니다.</p>
          </div>
        )}
      </SpaceBetween>
    </Container>
  );
}
