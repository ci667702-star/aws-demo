"use client";

/** 쉬운 모드(빌더)의 Lambda 함수 설정. 일정·규칙은 심화 모드(콘솔)의 EventBridge 화면에서 만든다 */
import Link from "next/link";
import { ToneBadge, type Tone } from "@/components/resource-visuals";
import { analyzeInvocation, LAMBDA_TEMPLATE_INFO, lambdaArn, ruleCanInvoke, scheduleCanInvoke, type InvokeOutcome } from "@/lib/engine/lambda-engine";
import { LAMBDA_ARCHITECTURES, LAMBDA_CODE_TEMPLATES, LAMBDA_RUNTIMES, type ResourceOfType } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { createExecutionRoleFor } from "@/lib/project/lambda-actions";
import { toggleRelation } from "@/lib/project/mutations";
import { Button } from "@/components/ui/button";
import { Callout, CheckList, InfoRow, NumberField, Section, SelectField, TextField } from "./fields";
import { vpcCompatibility, type FormContext } from "./form-shared";

const OUTCOME: Record<InvokeOutcome, { tone: Tone; label: string }> = {
  success: { tone: "ok", label: "성공" },
  error: { tone: "error", label: "오류" },
  timeout: { tone: "error", label: "시간 초과" },
  throttled: { tone: "warn", label: "제한됨" },
  invalid: { tone: "error", label: "실행할 수 없음" },
};

const RUNTIME_LABEL: Record<(typeof LAMBDA_RUNTIMES)[number], string> = { "nodejs22.x": "Node.js 22.x", "python3.13": "Python 3.13", java21: "Java 21" };

export function LambdaForm({ fn, ctx }: { fn: ResourceOfType<"lambda">; ctx: FormContext }) {
  const t = ctx.analysis.topology;
  const c = fn.config;
  const run = analyzeInvocation(ctx.project, t, fn);
  const subnets = new Set(t.lambdaSubnets(fn.id).map((s) => s.id));
  const sgIds = new Set(t.securityGroupsOf(fn.id).map((g) => g.id));
  const roles = ctx.project.services.iam.roles;
  const { schedules, rules } = ctx.project.services.eventbridge;
  const mySchedules = schedules.filter((s) => s.targetLambdaId === fn.id);
  const myRules = rules.filter((r) => r.targetLambdaIds.includes(fn.id));
  const fail = run.checks.find((x) => x.status === "fail");
  const consoleBase = `/console/${ctx.projectId}#/lambda/functions/${encodeURIComponent(fn.id)}`;
  const upd = (patch: Partial<typeof c>, label: string) => ctx.actions.updateConfig<"lambda">(fn, patch, label);
  return (
    <>
      <Section title="호출하면 (가상)">
        <div className="flex items-center justify-between gap-2">
          <ToneBadge tone={OUTCOME[run.outcome].tone} className="h-6 px-2 text-xs">
            {OUTCOME[run.outcome].label}
          </ToneBadge>
          <Link href={`${consoleBase}?tab=test`} className="text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
            콘솔에서 테스트
          </Link>
        </div>
        {fail ? <Callout tone="error">{fail.detail}</Callout> : <p className="text-[11px] text-muted-foreground">코드는 실행하지 않고, 실행 역할·네트워크·코드 템플릿으로 결과를 계산합니다.</p>}
      </Section>
      <Section title="함수">
        <SelectField label="런타임" help="runtime" value={c.runtime} options={LAMBDA_RUNTIMES.map((r) => ({ value: r, label: RUNTIME_LABEL[r] }))} onChange={(v) => upd({ runtime: v as typeof c.runtime }, "런타임 변경")} />
        <SelectField label="아키텍처" help="architecture" value={c.architecture} options={LAMBDA_ARCHITECTURES.map((a) => ({ value: a, label: a }))} onChange={(v) => upd({ architecture: v as typeof c.architecture }, "아키텍처 변경")} />
        <TextField label="핸들러" help="handler" value={c.handler} mono validate={(v) => (v.trim() && v.trim().length <= 128 ? null : "1~128자로 입력하세요.")} onCommit={(v) => upd({ handler: v.trim() }, "핸들러 변경")} />
        <NumberField label="메모리 (MB)" help="memoryMb" value={c.memoryMb} min={128} max={10240} onCommit={(v) => upd({ memoryMb: v }, "메모리 변경")} />
        <NumberField label="제한 시간 (초)" help="timeoutSeconds" value={c.timeoutSeconds} min={1} max={900} onCommit={(v) => upd({ timeoutSeconds: v }, "제한 시간 변경")} hint="기본 3초, 최대 900초" />
        <InfoRow label="함수 ARN (가상)" mono>
          {lambdaArn(fn.name || fn.id)}
        </InfoRow>
      </Section>
      <Section title="실행 역할">
        <SelectField
          label="실행 역할 (IAM)"
          help="roleId"
          value={c.roleId ?? ""}
          options={[
            { value: "", label: "없음 (실행할 수 없음)" },
            ...roles.map((r) => ({ value: r.id, label: `${r.name}${r.trustedEntity === "lambda.amazonaws.com" ? "" : ` — ${r.trustedEntity} 신뢰 (Lambda 사용 불가)`}` })),
          ]}
          onChange={(v) => upd({ roleId: v || null }, "실행 역할 변경")}
          hint="lambda.amazonaws.com을 신뢰하는 역할이어야 합니다."
        />
        <Button size="xs" variant="outline" onClick={() => ctx.actions.run("Lambda 기본 실행 역할 만들기", (p) => createExecutionRoleFor(p, fn.id))} data-testid="lambda-create-role">
          기본 실행 역할 만들기
        </Button>
        <p className="text-[11px] text-muted-foreground">로그 쓰기 권한만 있는 역할을 만들어 연결합니다 (VPC에 연결되어 있으면 네트워크 인터페이스 권한도 추가). S3 같은 권한은 심화 모드의 IAM에서 더합니다.</p>
      </Section>
      <Section title="코드 (가상 템플릿)">
        <SelectField
          label="코드 템플릿"
          help="codeTemplate"
          value={c.codeTemplate}
          options={LAMBDA_CODE_TEMPLATES.map((x) => ({ value: x, label: LAMBDA_TEMPLATE_INFO[x].label }))}
          onChange={(v) => upd({ codeTemplate: v as typeof c.codeTemplate, templateTarget: "" }, "코드 템플릿 변경")}
          hint={LAMBDA_TEMPLATE_INFO[c.codeTemplate].needs}
        />
        {c.codeTemplate === "s3-list" && (
          <SelectField
            label="버킷"
            help="templateTarget"
            value={c.templateTarget}
            options={[{ value: "", label: "선택 안 함" }, ...ctx.project.services.s3.buckets.map((b) => ({ value: b.name, label: b.name }))]}
            onChange={(v) => upd({ templateTarget: v }, "템플릿 대상 변경")}
          />
        )}
        {c.codeTemplate === "rds-query" && (
          <SelectField
            label="DB 인스턴스"
            help="templateTarget"
            value={c.templateTarget}
            options={[{ value: "", label: "선택 안 함" }, ...t.ofType("rds").map((d) => ({ value: d.id, label: displayName(d) }))]}
            onChange={(v) => upd({ templateTarget: v }, "템플릿 대상 변경")}
          />
        )}
        {c.codeTemplate === "secret-get" && (
          <SelectField
            label="보안 암호"
            help="templateTarget"
            value={c.templateTarget}
            options={[{ value: "", label: "선택 안 함" }, ...ctx.project.services.secretsmanager.secrets.map((s) => ({ value: s.name, label: s.deletion ? `${s.name} — 삭제 예약됨` : s.name }))]}
            onChange={(v) => upd({ templateTarget: v }, "템플릿 대상 변경")}
            hint="보안 암호는 심화 모드의 Secrets Manager에서 만듭니다."
          />
        )}
        {c.codeTemplate === "ssm-get" && (
          <SelectField
            label="파라미터"
            help="templateTarget"
            value={c.templateTarget}
            options={[{ value: "", label: "선택 안 함" }, ...ctx.project.services.ssm.parameters.map((p) => ({ value: p.name, label: `${p.name} (${p.type})` }))]}
            onChange={(v) => upd({ templateTarget: v }, "템플릿 대상 변경")}
            hint="파라미터는 심화 모드의 Systems Manager에서 만듭니다."
          />
        )}
        {c.codeTemplate === "http-get" && (
          <TextField label="URL" help="templateTarget" value={c.templateTarget} mono validate={(v) => (v.length <= 512 ? null : "512자 이하로 입력하세요.")} onCommit={(v) => upd({ templateTarget: v.trim() }, "템플릿 대상 변경")} hint="실제로 요청하지 않습니다." />
        )}
        <NumberField label="가상 실행 시간 (ms)" help="virtualDurationMs" value={c.virtualDurationMs} min={1} max={900000} onCommit={(v) => upd({ virtualDurationMs: v }, "가상 실행 시간 변경")} />
        <NumberField label="가상 오류 비율 (%)" help="errorRatePercent" value={c.errorRatePercent} min={0} max={100} onCommit={(v) => upd({ errorRatePercent: v }, "가상 오류 비율 변경")} />
      </Section>
      <Section title={`VPC 연결 (서브넷 ${subnets.size})`}>
        <CheckList
          label="서브넷 (비우면 VPC 밖에서 실행)"
          help="subnets"
          empty="서브넷이 없습니다."
          items={t.ofType("subnet").map((s) => {
            const compat = vpcCompatibility(ctx, fn.id, s.id);
            const kind = t.classifySubnet(s.id).kind;
            return {
              id: s.id,
              label: `${displayName(s)} (${s.config.availabilityZone})`,
              description: kind === "public" ? "퍼블릭 서브넷 — Lambda는 퍼블릭 IP가 없어 인터넷에 나갈 수 없습니다" : kind === "private-nat" ? "프라이빗 (NAT 경로 있음)" : kind === "private-isolated" ? "프라이빗 (외부 경로 없음)" : "VPC 없음",
              checked: subnets.has(s.id),
              disabled: !subnets.has(s.id) && !compat.ok,
              disabledReason: compat.reason,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "Lambda 서브넷 연결" : "Lambda 서브넷 연결 해제", (p) => toggleRelation(p, fn.id, id, checked))}
        />
        <CheckList
          label="보안 그룹 (최대 5개)"
          help="securityGroups"
          empty="보안 그룹이 없습니다."
          items={t.ofType("security-group").map((g) => {
            const compat = vpcCompatibility(ctx, fn.id, g.id);
            return {
              id: g.id,
              label: displayName(g),
              description: `아웃바운드 ${g.config.outboundRules.length}개`,
              checked: sgIds.has(g.id),
              disabled: !sgIds.has(g.id) && (!compat.ok || sgIds.size >= 5),
              disabledReason: !compat.ok ? compat.reason : sgIds.size >= 5 ? "최대 5개까지 연결할 수 있습니다." : undefined,
            };
          })}
          onToggle={(id, checked) => ctx.actions.run(checked ? "Lambda 보안 그룹 연결" : "Lambda 보안 그룹 연결 해제", (p) => toggleRelation(p, fn.id, id, checked))}
        />
      </Section>
      <Section title="동시성">
        <SelectField
          label="예약 동시성"
          help="reservedConcurrency"
          value={c.reservedConcurrency === null ? "" : c.reservedConcurrency === 0 ? "0" : "custom"}
          options={[
            { value: "", label: "없음 (계정 공용 풀)" },
            { value: "0", label: "0 (모든 호출 제한)" },
            ...(c.reservedConcurrency ? [{ value: "custom", label: `${c.reservedConcurrency} (콘솔에서 설정)` }] : []),
          ]}
          onChange={(v) => v !== "custom" && upd({ reservedConcurrency: v === "" ? null : 0 }, "예약 동시성 변경")}
        />
      </Section>
      <Section title="리소스 기반 정책">
        <InfoRow label="호출 허용 (lambda:AddPermission)" help="permissions">
          {c.permissions.length ? c.permissions.map((p) => `${p.principal}${p.sourceArn ? "" : " (모든 소스)"}`).join(", ") : "없음"}
        </InfoRow>
        <p className="text-[11px] text-muted-foreground">EventBridge 규칙의 대상으로 이 함수를 추가하면 콘솔이 자동으로 넣습니다. 직접 추가·삭제는 심화 모드의 함수 구성 → 권한에서 합니다.</p>
      </Section>
      <Section title={`트리거 (${mySchedules.length + myRules.length})`} help="triggers">
        {mySchedules.length || myRules.length ? (
          <ul className="space-y-1 text-sm">
            {mySchedules.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  일정 {s.name} <span className="font-mono text-[11px] text-muted-foreground">{s.expression}</span>
                </span>
                <ToneBadge tone={s.state === "DISABLED" ? "muted" : scheduleCanInvoke(ctx.project, s, fn).ok ? "ok" : "error"}>{s.state === "DISABLED" ? "비활성" : scheduleCanInvoke(ctx.project, s, fn).ok ? "호출 가능" : "호출 실패"}</ToneBadge>
              </li>
            ))}
            {myRules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">규칙 {r.name}</span>
                <ToneBadge tone={r.state === "DISABLED" ? "muted" : ruleCanInvoke(r, fn).ok ? "ok" : "error"}>{r.state === "DISABLED" ? "비활성" : ruleCanInvoke(r, fn).ok ? "호출 가능" : "호출 실패"}</ToneBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">이 함수를 호출하는 일정·규칙이 없습니다.</p>
        )}
        <Link href={`/console/${ctx.projectId}#/eventbridge/schedules/create?target=${encodeURIComponent(fn.id)}`} className="text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
          심화 모드에서 일정 추가
        </Link>
      </Section>
    </>
  );
}
