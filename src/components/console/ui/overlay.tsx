"use client";

import { X } from "lucide-react";
import { cn } from "cn";
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ErrorAlert } from "./alert";
import { Button } from "./button";
import { FormField, TextInput } from "./form";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "medium",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "small" | "medium" | "large";
}) {
  const width = { small: "sm:max-w-md", medium: "sm:max-w-xl", large: "sm:max-w-3xl" }[size];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0f141a]/60" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-aws-border bg-aws-surface text-aws-text shadow-2xl outline-none",
            width,
          )}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-aws-divider px-5 py-4">
            <DialogPrimitive.Title className="text-lg leading-6 font-bold break-words">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded p-0.5 text-aws-text-2 hover:text-aws-text" aria-label="닫기">
              <X className="size-5" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-aws-divider px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * 삭제 확인 대화 상자. confirmText를 주면 AWS처럼 해당 문구를 입력해야 삭제 버튼이 활성화된다.
 * onConfirm이 오류 문자열을 돌려주면 대화 상자 안에 표시한다.
 */
export function DeleteModal({
  open,
  onClose,
  title,
  children,
  confirmText,
  actionLabel = "삭제",
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  confirmText?: string;
  actionLabel?: string;
  onConfirm: () => string | null;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = !confirmText || typed === confirmText;
  const close = () => {
    setTyped("");
    setError(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="link" onClick={close}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              const err = onConfirm();
              if (err) setError(err);
              else close();
            }}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">{children}</div>
        {confirmText && (
          <FormField label={<>확인하려면 필드에 <span className="font-mono">{confirmText}</span>을(를) 입력하세요.</>}>
            <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmText} />
          </FormField>
        )}
        {error && <ErrorAlert message={error} header="작업을 완료할 수 없습니다" />}
      </div>
    </Modal>
  );
}
