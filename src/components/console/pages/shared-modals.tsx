"use client";

import { useState } from "react";
import { RESOURCE_TYPE_INFO, type Resource } from "@/lib/engine/resource-models";
import { editNameTag } from "@/lib/project/console-actions";
import { useRunAction } from "../console-context";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { FormField, TextInput } from "../ui/form";
import { Modal } from "../ui/overlay";

/** 이름(Name 태그) 편집 — AWS의 "태그 관리"를 단순화 */
export function EditNameModal({ resource, open, onClose }: { resource: Resource | undefined; open: boolean; onClose: () => void }) {
  if (!resource || !open) return null;
  return <EditNameDialog key={resource.id} resource={resource} onClose={onClose} />;
}

function EditNameDialog({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const run = useRunAction();
  const [name, setName] = useState(resource.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const result = run("CreateTags", (p) => editNameTag(p, resource.id, name), { success: () => `${resource.id}의 Name 태그를 업데이트했습니다.` });
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`태그 관리: ${resource.id}`}
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={submit}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-aws-text-2">{RESOURCE_TYPE_INFO[resource.type].label}의 Name 태그 값입니다. 비워 두면 콘솔에는 리소스 ID가 표시됩니다.</p>
        <FormField label="Name" constraint="최대 128자">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="값 입력" />
        </FormField>
        {error && <Alert type="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
