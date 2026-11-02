"use client";

import { useState } from "react";
import { bucketArn, evaluateIam, KNOWN_SERVICES, objectArn, principalLabel, SERVICE_ACTIONS, type IamDecision, type IamPrincipal } from "@/lib/engine/iam-engine";
import { s3ResourcePolicyFor } from "@/lib/engine/s3-engine";
import type { Project } from "@/lib/engine/resource-models";
import { useProject } from "../../console-context";
import { Button } from "../../ui/button";
import { Checkbox, FormField, SelectInput, TextInput } from "../../ui/form";
import { Container, ContainerHeader, PageHeader, SpaceBetween } from "../../ui/layout";
import { InfoLink } from "../../ui/links";
import { PageGuide } from "../../ui/page-guide";
import { Badge } from "../../ui/status";

const SERVICES = [...new Set(SERVICE_ACTIONS.map((a) => a.service))];

interface SimRequest {
  principalKey: string;
  service: string;
  actions: string[];
  resource: string;
  includeResourcePolicy: boolean;
}

function principalFrom(project: Project, key: string): IamPrincipal | null {
  if (key === "anonymous") return { kind: "anonymous" };
  const [kind, id] = key.split(":");
  if (kind === "user") {
    const user = project.services.iam.users.find((u) => u.id === id);
    return user ? { kind: "user", user } : null;
  }
  const role = project.services.iam.roles.find((r) => r.id === id);
  return role ? { kind: "role", role } : null;
}

function DecisionBadge({ decision }: { decision: IamDecision["decision"] }) {
  if (decision === "allowed") return <Badge color="green">허용됨</Badge>;
  if (decision === "explicit-deny") return <Badge color="red">거부됨 (명시적 Deny)</Badge>;
  return <Badge color="orange">거부됨 (암묵적)</Badge>;
}

export function PolicySimulatorPage() {
  const project = useProject();
  const { users, roles } = project.services.iam;
  const buckets = project.services.s3.buckets;
  const [principalKey, setPrincipalKey] = useState(users[0] ? `user:${users[0].id}` : roles[0] ? `role:${roles[0].id}` : "anonymous");
  const [service, setService] = useState("s3");
  const [action, setAction] = useState("GetObject");
  const [bucketName, setBucketName] = useState(buckets[0]?.name ?? "");
  const [key, setKey] = useState("index.html");
  const [customResource, setCustomResource] = useState("*");
  const [includeResourcePolicy, setIncludeResourcePolicy] = useState(true);
  const [request, setRequest] = useState<SimRequest | null>(null);

  const actionInfo = SERVICE_ACTIONS.find((a) => a.service === service && a.action === action);
  const resource =
    service === "s3" && actionInfo?.resource === "object" && bucketName ? objectArn(bucketName, key.trim() || "*") : service === "s3" && actionInfo?.resource === "bucket" && bucketName ? bucketArn(bucketName) : customResource.trim() || "*";

  const run = (all: boolean) =>
    setRequest({
      principalKey,
      service,
      actions: all ? SERVICE_ACTIONS.filter((a) => a.service === service).map((a) => a.action) : [action],
      resource,
      includeResourcePolicy,
    });

  const principal = request ? principalFrom(project, request.principalKey) : null;
  const results =
    request && principal
      ? request.actions.map((a) => {
          const info = SERVICE_ACTIONS.find((x) => x.service === request.service && x.action === a);
          // 모든 작업 평가 시 작업 종류(버킷/객체)에 맞게 리소스를 바꾼다
          let res = request.resource;
          if (request.service === "s3" && request.actions.length > 1 && bucketName) {
            res = info?.resource === "object" ? objectArn(bucketName, key.trim() || "*") : info?.resource === "bucket" ? bucketArn(bucketName) : "*";
          }
          const rp = request.includeResourcePolicy ? s3ResourcePolicyFor(project, res) : null;
          const decision = evaluateIam(project, principal, `${request.service}:${a}`, res, rp ? { resourcePolicy: rp.resourcePolicy, restrictPublic: rp.restrictPublic } : {});
          return { action: `${request.service}:${a}`, description: info?.description ?? "", resource: res, decision, resourcePolicy: !!rp?.resourcePolicy.statements.length };
        })
      : [];

  return (
    <SpaceBetween tour="iam-simulator">
      <PageHeader
        title="정책 시뮬레이터"
        info={<InfoLink topic="iam-policy" />}
        description="실제로 요청하지 않고, 지금 정책대로라면 이 주체가 이 작업을 할 수 있는지 계산합니다. AWS의 IAM Policy Simulator를 단순화한 기능입니다."
      />
      <PageGuide topic="iam-policy" />
      <Container header={<ContainerHeader title="1. 주체 선택" description="정책을 평가할 사용자나 역할을 고릅니다." />}>
        <FormField label="주체">
          <SelectInput
            value={principalKey}
            onChange={setPrincipalKey}
            options={[
              ...users.map((u) => ({ value: `user:${u.id}`, label: `사용자 ${u.name}` })),
              ...roles.map((r) => ({ value: `role:${r.id}`, label: `역할 ${r.name}` })),
              { value: "anonymous", label: "익명 사용자 (인터넷의 누구나)" },
            ]}
            className="max-w-md"
          />
        </FormField>
      </Container>
      <Container header={<ContainerHeader title="2. 작업과 리소스" />}>
        <SpaceBetween size="m">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="서비스">
              <SelectInput
                value={service}
                onChange={(v) => {
                  setService(v);
                  setAction(SERVICE_ACTIONS.find((a) => a.service === v)?.action ?? "");
                }}
                options={SERVICES.map((s) => ({ value: s, label: `${KNOWN_SERVICES[s] ?? s} (${s})` }))}
              />
            </FormField>
            <FormField label="작업">
              <SelectInput value={action} onChange={setAction} options={SERVICE_ACTIONS.filter((a) => a.service === service).map((a) => ({ value: a.action, label: `${a.action} — ${a.description}` }))} />
            </FormField>
          </div>
          {service === "s3" && actionInfo?.resource !== "any" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="버킷" description={buckets.length ? undefined : "버킷이 없어 이름을 직접 입력합니다."}>
                {buckets.length ? (
                  <SelectInput value={bucketName} onChange={setBucketName} options={buckets.map((b) => ({ value: b.name, label: b.name }))} />
                ) : (
                  <TextInput value={bucketName} onChange={(e) => setBucketName(e.target.value)} placeholder="my-bucket" />
                )}
              </FormField>
              {actionInfo?.resource === "object" && (
                <FormField label="객체 키">
                  <TextInput value={key} onChange={(e) => setKey(e.target.value)} />
                </FormField>
              )}
            </div>
          ) : (
            <FormField label="리소스 ARN" constraint='"*"는 모든 리소스'>
              <TextInput value={customResource} onChange={(e) => setCustomResource(e.target.value)} className="max-w-xl" />
            </FormField>
          )}
          <p className="text-sm text-aws-text-2">
            평가할 리소스: <span className="font-mono break-all">{resource}</span>
          </p>
          {service === "s3" && (
            <Checkbox checked={includeResourcePolicy} onChange={setIncludeResourcePolicy} description="버킷 정책과 퍼블릭 액세스 차단(퍼블릭 버킷 제한)도 함께 평가합니다.">
              리소스 기반 정책 포함
            </Checkbox>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => run(true)}>이 서비스의 모든 작업 평가</Button>
            <Button variant="primary" onClick={() => run(false)}>
              시뮬레이션 실행
            </Button>
          </div>
        </SpaceBetween>
      </Container>
      {request && principal && (
        <Container header={<ContainerHeader title="3. 결과" description={`${principalLabel(principal)} 기준 · 설정을 바꾸면 결과도 바로 다시 계산됩니다.`} />}>
          {results.length === 1 ? (
            <SpaceBetween size="m">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[15px] font-bold">{results[0].action}</span>
                <DecisionBadge decision={results[0].decision.decision} />
              </div>
              <ul className="list-disc space-y-1 pl-5 text-[15px]">
                {results[0].decision.explanation.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              {results[0].decision.matched.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm" aria-label="일치한 정책 문장">
                    <thead>
                      <tr className="border-b border-aws-border text-left text-aws-text-2">
                        <th className="px-3 py-2">효과</th>
                        <th className="px-3 py-2">출처</th>
                        <th className="px-3 py-2">작업</th>
                        <th className="px-3 py-2">리소스</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results[0].decision.matched.map((m, i) => (
                        <tr key={i} className="border-b border-aws-divider align-top">
                          <td className="px-3 py-2">{m.statement.effect === "Allow" ? <Badge color="green">Allow</Badge> : <Badge color="red">Deny</Badge>}</td>
                          <td className="px-3 py-2">{m.source}</td>
                          <td className="px-3 py-2 font-mono text-[13px] break-all">{m.statement.actions.join(", ")}</td>
                          <td className="px-3 py-2 font-mono text-[13px] break-all">{m.statement.resources.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SpaceBetween>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" aria-label="작업별 평가 결과">
                <thead>
                  <tr className="border-b border-aws-border text-left text-aws-text-2">
                    <th className="px-3 py-2">작업</th>
                    <th className="px-3 py-2">설명</th>
                    <th className="px-3 py-2">리소스</th>
                    <th className="px-3 py-2">결과</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.action} className="border-b border-aws-divider align-top">
                      <td className="px-3 py-2 font-mono text-[13px]">{r.action}</td>
                      <td className="px-3 py-2">{r.description}</td>
                      <td className="px-3 py-2 font-mono text-[13px] break-all">{r.resource}</td>
                      <td className="px-3 py-2">
                        <DecisionBadge decision={r.decision.decision} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Container>
      )}
    </SpaceBetween>
  );
}
