/**
 * VPC 밖 서비스(IAM·S3·CloudWatch·EventBridge·Secrets Manager·Parameter Store) 항목의 ID를 사람이 읽는 이름으로 바꾼다.
 * CloudFront 배포는 AWS 콘솔처럼 배포 ID(E…)를 그대로 보여 준다.
 * 이동 경로와 브라우저 탭 제목에 ID 대신 이름을 보여 줄 때 쓴다.
 */
import { managedPolicy } from "@/lib/engine/iam-engine";
import type { Project } from "@/lib/engine/resource-models";

export function serviceItemName(project: Project, id: string): string | null {
  if (id.startsWith("aws:")) return managedPolicy(id)?.name ?? null;
  // Lambda 함수는 AWS 콘솔처럼 ID 대신 함수 이름으로 보여 준다
  const fn = project.resources.find((r) => r.id === id && r.type === "lambda");
  if (fn?.name) return fn.name;
  const { iam, s3, cloudwatch, eventbridge, secretsmanager, ssm } = project.services;
  const lists: { id: string; name: string }[][] = [
    iam.users,
    iam.groups,
    iam.roles,
    iam.policies,
    s3.buckets,
    cloudwatch.alarms,
    cloudwatch.dashboards,
    cloudwatch.loads,
    eventbridge.schedules,
    eventbridge.rules,
    secretsmanager.secrets,
    ssm.parameters,
  ];
  for (const list of lists) {
    const hit = list.find((x) => x.id === id);
    if (hit) return hit.name;
  }
  return null;
}
