"use client";

import type { S3Bucket } from "@/lib/engine/resource-models";
import { bucketAccess } from "@/lib/engine/s3-engine";
import { useProject } from "../../console-context";
import { href } from "../../router";
import { Alert } from "../../ui/alert";
import { ButtonLink } from "../../ui/button";
import { Checkbox } from "../../ui/form";
import { Container, EmptyState } from "../../ui/layout";
import { Badge } from "../../ui/status";

export function useBucket(id: string): S3Bucket | undefined {
  return useProject().services.s3.buckets.find((b) => b.id === id);
}

export function BucketNotFound() {
  return (
    <Container>
      <EmptyState title="버킷을 찾을 수 없습니다" description="삭제되었거나 주소가 올바르지 않습니다." action={<ButtonLink href={href("/s3")}>버킷 목록</ButtonLink>} />
    </Container>
  );
}

export function AccessBadge({ bucket }: { bucket: S3Bucket }) {
  const a = bucketAccess(bucket);
  const color = a.kind === "public" ? "red" : a.kind === "can-be-public" ? "orange" : "grey";
  return (
    <Badge color={color} title={a.detail}>
      {a.kind === "public" ? "⚠ " : ""}
      {a.label}
    </Badge>
  );
}

export type Bpa = S3Bucket["blockPublicAccess"];

export const BPA_ITEMS: { key: keyof Bpa; label: string; description: string }[] = [
  {
    key: "blockPublicAcls",
    label: "새 ACL(액세스 제어 목록)을 통해 부여된 퍼블릭 액세스 차단",
    description: "앞으로 객체·버킷에 퍼블릭 ACL을 붙이지 못하게 막습니다. (이 시뮬레이터는 ACL을 다루지 않아 표시만 바뀝니다)",
  },
  {
    key: "ignorePublicAcls",
    label: "임의의 ACL을 통해 부여된 퍼블릭 액세스 차단",
    description: "이미 붙어 있는 퍼블릭 ACL도 무시합니다. (ACL은 표시만)",
  },
  {
    key: "blockPublicPolicy",
    label: "새 퍼블릭 버킷 정책을 통해 부여된 퍼블릭 액세스 차단",
    description: "Principal \"*\"(누구나)에게 허용하는 버킷 정책을 저장하지 못하게 막습니다.",
  },
  {
    key: "restrictPublicBuckets",
    label: "임의의 퍼블릭 버킷 정책을 통해 부여된 퍼블릭 액세스 차단",
    description: "이미 퍼블릭 정책이 있어도 익명 사용자의 접근을 막습니다. 같은 계정의 IAM 사용자·역할은 영향을 받지 않습니다.",
  },
];

export const allOn = (b: Bpa) => Object.values(b).every(Boolean);

/** 퍼블릭 액세스 차단 설정 4개 + '모두 차단' */
export function BpaFields({ value, onChange }: { value: Bpa; onChange: (v: Bpa) => void }) {
  const all = allOn(value);
  return (
    <div className="space-y-3">
      <Checkbox
        checked={all}
        onChange={(v) => onChange({ blockPublicAcls: v, ignorePublicAcls: v, blockPublicPolicy: v, restrictPublicBuckets: v })}
        description="이 설정을 켜면 아래 4가지 설정을 모두 켠 것과 같습니다. 웹 사이트처럼 꼭 공개해야 하는 경우가 아니면 켜 두세요."
      >
        <span className="font-bold">모든 퍼블릭 액세스 차단</span>
      </Checkbox>
      <div className="space-y-2 border-l-2 border-aws-divider pl-5">
        {BPA_ITEMS.map((item) => (
          <Checkbox key={item.key} checked={value[item.key]} onChange={(v) => onChange({ ...value, [item.key]: v })} description={item.description}>
            {item.label}
          </Checkbox>
        ))}
      </div>
    </div>
  );
}

export function PublicWarning({ acknowledged, onAcknowledge }: { acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  return (
    <Alert type="warning" header="모든 퍼블릭 액세스 차단을 끄면 버킷과 객체가 공개될 수 있습니다">
      <p>정적 웹 사이트 호스팅처럼 공개가 꼭 필요한 경우가 아니면 모두 차단을 켜 두는 것이 좋습니다.</p>
      <div className="mt-2">
        <Checkbox checked={acknowledged} onChange={onAcknowledge}>
          현재 설정으로 인해 이 버킷과 그 안의 객체가 퍼블릭 상태가 될 수 있음을 알고 있습니다.
        </Checkbox>
      </div>
    </Alert>
  );
}
