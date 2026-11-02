"use client";

/**
 * 학교 역할 템플릿: 역할별 최소 권한 정책·그룹·예시 사용자를 한 번에 만들고,
 * 역할마다 할 수 있는 일을 표로 비교한 뒤 해당 사용자로 로그인해 직접 확인한다.
 */
import { Check, Minus, X } from "lucide-react";
import { cn } from "cn";
import { useState } from "react";
import { actingIdentity } from "@/lib/engine/iam-session";
import { CAPABILITIES, capabilityRow, ROLE_TEMPLATES, templateCapabilityRow, templatePolicyDocument, type CapabilityDecision } from "@/lib/engine/iam-templates";
import { applyRoleTemplates, signInAsUser } from "@/lib/project/iam-actions";
import { useProject, useRunAction } from "../../console-context";
import { href } from "../../router";
import { useSessionActions } from "../../shell/identity-menu";
import { Alert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { Checkbox } from "../../ui/form";
import { Container, ContainerHeader, ExpandableSection, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { Badge } from "../../ui/status";

function DecisionCell({ d }: { d: CapabilityDecision }) {
  if (d === "allowed") {
    return (
      <span className="inline-flex items-center gap-1 font-bold text-aws-success" title="허용">
        <Check className="size-4" aria-hidden />
        <span className="sr-only">허용</span>
      </span>
    );
  }
  if (d === "explicit-deny") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] font-bold text-aws-error" title="명시적 Deny">
        <X className="size-4" aria-hidden /> Deny
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-aws-text-3" title="허용하는 정책 없음 (암묵적 거부)">
      <Minus className="size-4" aria-hidden />
      <span className="sr-only">거부</span>
    </span>
  );
}

export function RoleTemplatesPage() {
  const project = useProject();
  const run = useRunAction();
  const act = useSessionActions();
  const [selected, setSelected] = useState<string[]>(ROLE_TEMPLATES.map((t) => t.id));
  const [createUsers, setCreateUsers] = useState(true);
  const identity = actingIdentity(project);
  const { users, groups } = project.services.iam;
  const created = (groupName: string) => groups.find((g) => g.name === groupName);

  const apply = () =>
    run("ApplyRoleTemplates", (p) => applyRoleTemplates(p, selected, { createUsers }), {
      success: () => "역할 템플릿을 적용했습니다.",
      flashError: true,
    });

  return (
    <SpaceBetween>
      <PageHeader
        title="학교 역할 템플릿 (최소 권한)"
        info={<InfoLink topic="iam-policy" />}
        description="여러 사람이 한 AWS 계정을 함께 쓸 때는 역할을 나누고, 역할마다 꼭 필요한 권한만 줍니다(최소 권한 원칙). 템플릿은 역할별 정책·그룹·예시 사용자를 만들고, 만든 사용자로 로그인하면 그 역할이 할 수 없는 작업이 실제로 거부됩니다. 모두 가상이며 실제 AWS 계정과 연결되지 않습니다."
        actions={
          <ButtonLink href={href("/iam/simulator")} variant="normal">
            정책 시뮬레이터
          </ButtonLink>
        }
      />
      <Alert type="info" header="이렇게 해 보세요">
        <ol className="list-decimal space-y-0.5 pl-5">
          <li>아래에서 역할을 고르고 &lsquo;선택한 템플릿 만들기&rsquo;를 누릅니다 (루트 또는 IAM 관리 권한이 필요).</li>
          <li>표의 &lsquo;로그인&rsquo; 버튼이나 상단 계정 메뉴로 예시 사용자(예: net-admin)로 로그인합니다.</li>
          <li>VPC 만들기, 인스턴스 시작처럼 여러 작업을 해 보며 무엇이 허용되고 무엇이 거부되는지 확인합니다.</li>
          <li>오류 메시지에 거부된 IAM 작업과 그 작업을 맡는 역할이 나옵니다. 정책을 고쳐 보며 차이를 비교하세요.</li>
        </ol>
      </Alert>

      <Container header={<ContainerHeader title="역할별 권한 표" description="각 칸은 템플릿 정책을 실제로 평가한 결과입니다. ✓ 허용 · − 허용하는 정책 없음(암묵적 거부) · Deny 명시적 거부" />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-[14px]" data-testid="capability-matrix">
            <thead>
              <tr className="border-b border-aws-divider text-left text-[13px] text-aws-text-2">
                <th className="py-2 pr-3 font-bold">역할</th>
                {CAPABILITIES.map((c) => (
                  <th key={c.id} className="px-1.5 py-2 text-center font-bold">
                    {c.label}
                  </th>
                ))}
                <th className="py-2 pl-3 font-bold">이 샌드박스</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_TEMPLATES.map((t) => {
                const row = templateCapabilityRow(project, t);
                const group = created(t.groupName);
                const user = users.find((u) => u.name === t.exampleUser && (!group || u.groupIds.includes(group.id)));
                const signedIn = identity.kind === "user" && identity.user.id === user?.id;
                return (
                  <tr key={t.id} className="border-b border-aws-divider" data-template={t.id}>
                    <th className="py-2 pr-3 text-left align-top font-normal">
                      <span className="block font-bold">{t.title}</span>
                      <span className="font-mono text-[12px] text-aws-text-2">{t.groupName}</span>
                    </th>
                    {CAPABILITIES.map((c) => (
                      <td key={c.id} className="px-1.5 py-2 text-center">
                        <DecisionCell d={row[c.id]} />
                      </td>
                    ))}
                    <td className="py-2 pl-3 align-top">
                      {group ? (
                        user?.consoleAccess ? (
                          signedIn ? (
                            <Badge color="green">로그인 중</Badge>
                          ) : (
                            <Button onClick={() => act("로그인", (p) => signInAsUser(p, user.id))} data-testid={`template-sign-in-${t.id}`}>
                              {t.exampleUser}(으)로 로그인
                            </Button>
                          )
                        ) : (
                          <Badge color="blue">그룹 있음</Badge>
                        )
                      ) : (
                        <span className="text-[13px] text-aws-text-3">아직 없음</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Container>

      <Container
        header={
          <ContainerHeader
            title="템플릿 고르기"
            description="정책 이름은 School-로 시작합니다. 이미 같은 이름이 있으면 새로 만들지 않고 연결만 맞춥니다."
            actions={
              <Button variant="primary" onClick={apply} disabled={!selected.length} data-testid="apply-role-templates">
                선택한 템플릿 만들기 ({selected.length})
              </Button>
            }
          />
        }
      >
        <SpaceBetween size="m">
          <Checkbox checked={createUsers} onChange={setCreateUsers} description="역할마다 콘솔 액세스가 켜진 예시 사용자를 만들어 바로 로그인해 볼 수 있게 합니다 (암호 없음, 가상).">
            예시 사용자도 만들기
          </Checkbox>
          <ul className="grid gap-4 lg:grid-cols-2">
            {ROLE_TEMPLATES.map((t) => {
              const checked = selected.includes(t.id);
              const doc = templatePolicyDocument(t);
              return (
                <li key={t.id} className={cn("space-y-2 rounded-xl border p-4", checked ? "border-aws-link" : "border-aws-border")}>
                  <Checkbox checked={checked} onChange={(v) => setSelected((s) => (v ? [...s, t.id] : s.filter((x) => x !== t.id)))}>
                    <span className="font-bold">{t.title}</span> <span className="font-mono text-[13px] text-aws-text-2">{t.groupName}</span>
                  </Checkbox>
                  <p className="text-[14px] text-aws-text">{t.summary}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-[13px] font-bold text-aws-success">할 수 있는 일</p>
                      <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
                        {t.can.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-[13px] font-bold text-aws-error">할 수 없는 일</p>
                      <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
                        {t.cannot.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <p className="rounded-lg bg-aws-surface-2 px-3 py-2 text-[13px] text-aws-text-2">
                    <span className="font-bold text-aws-text">왜 이렇게 나눌까? </span>
                    {t.why}
                  </p>
                  {doc ? (
                    <ExpandableSection header={`정책 문서 보기 (${t.policyName})`}>
                      <pre className="max-h-72 overflow-auto rounded-lg border border-aws-border bg-aws-surface-2 p-3 font-mono text-[12px] leading-relaxed">{doc}</pre>
                    </ExpandableSection>
                  ) : (
                    <p className="text-[13px] text-aws-text-2">
                      AWS 관리형 정책 <span className="font-mono">{t.managedPolicyId?.replace("aws:", "")}</span>을(를) 연결합니다.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </SpaceBetween>
      </Container>

      {users.length > 0 && (
        <Container header={<ContainerHeader title="이 샌드박스 사용자의 실제 권한" description="그룹과 직접 연결한 정책을 모두 합쳐 평가한 결과입니다." />}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-aws-divider text-left text-[13px] text-aws-text-2">
                  <th className="py-2 pr-3 font-bold">사용자</th>
                  {CAPABILITIES.map((c) => (
                    <th key={c.id} className="px-1.5 py-2 text-center font-bold">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const row = capabilityRow(project, { kind: "user", user: u });
                  return (
                    <tr key={u.id} className="border-b border-aws-divider">
                      <th className="py-2 pr-3 text-left font-normal">
                        <a className="font-bold text-aws-link hover:underline" href={href(`/iam/users/${u.id}`)}>
                          {u.name}
                        </a>
                      </th>
                      {CAPABILITIES.map((c) => (
                        <td key={c.id} className="px-1.5 py-2 text-center">
                          <DecisionCell d={row[c.id]} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Container>
      )}
    </SpaceBetween>
  );
}
