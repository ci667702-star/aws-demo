"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface TextPromptValues {
  name: string;
  description: string;
}

/** 이름(필수)과 선택적 설명을 입력받는 대화 상자 */
export function TextPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initialName = "",
  initialDescription = "",
  withDescription = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  initialName?: string;
  initialDescription?: string;
  withDescription?: boolean;
  /** 오류 메시지를 반환하면 대화 상자를 닫지 않고 표시한다 */
  onSubmit: (values: TextPromptValues) => string | null | void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <PromptForm
            title={title}
            description={description}
            submitLabel={submitLabel}
            initialName={initialName}
            initialDescription={initialDescription}
            withDescription={withDescription}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  title,
  description,
  submitLabel,
  initialName,
  initialDescription,
  withDescription,
  onSubmit,
  onCancel,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  initialName: string;
  initialDescription: string;
  withDescription: boolean;
  onSubmit: (values: TextPromptValues) => string | null | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("이름을 입력하세요.");
      return;
    }
    if (trimmed.length > 100) {
      setError("이름은 100자 이하여야 합니다.");
      return;
    }
    const result = onSubmit({ name: trimmed, description: desc.trim() });
    if (typeof result === "string") setError(result);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="prompt-name">이름</Label>
        <Input
          id="prompt-name"
          autoFocus
          value={name}
          maxLength={100}
          aria-invalid={!!error}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      {withDescription && (
        <div className="space-y-1.5">
          <Label htmlFor="prompt-desc">설명 (선택)</Label>
          <Textarea id="prompt-desc" value={desc} maxLength={500} rows={3} onChange={(e) => setDesc(e.target.value)} />
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          취소
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}
