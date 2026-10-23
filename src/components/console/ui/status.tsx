"use client";

import { CircleCheck, CircleMinus, CircleX, Clock3, Copy, Info, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { useState } from "react";

export type StatusType = "success" | "error" | "warning" | "info" | "pending" | "stopped" | "in-progress";

const STATUS_STYLE: Record<StatusType, { icon: React.ElementType; color: string }> = {
  success: { icon: CircleCheck, color: "text-aws-success" },
  error: { icon: CircleX, color: "text-aws-error" },
  warning: { icon: TriangleAlert, color: "text-aws-warning" },
  info: { icon: Info, color: "text-aws-info" },
  pending: { icon: Clock3, color: "text-aws-pending" },
  stopped: { icon: CircleMinus, color: "text-aws-pending" },
  "in-progress": { icon: Loader2, color: "text-aws-info" },
};

export function StatusIndicator({ type, children, className }: { type: StatusType; children: React.ReactNode; className?: string }) {
  const { icon: Icon, color } = STATUS_STYLE[type];
  return (
    <span className={cn("inline-flex items-center gap-1.5 align-middle", color, className)} data-status={type}>
      <Icon className={cn("size-4 shrink-0", type === "in-progress" && "animate-spin")} aria-hidden />
      <span className="text-sm">{children}</span>
    </span>
  );
}

export type BadgeColor = "grey" | "blue" | "green" | "red" | "orange";

const BADGE: Record<BadgeColor, string> = {
  grey: "bg-aws-surface-2 text-aws-text-2 border-aws-border",
  blue: "bg-aws-info-bg text-aws-info border-aws-info/40",
  green: "bg-aws-success-bg text-aws-success border-aws-success/40",
  red: "bg-aws-error-bg text-aws-error border-aws-error/40",
  orange: "bg-aws-warning-bg text-aws-warning border-aws-warning/40",
};

export function Badge({ color = "grey", children, className, title }: { color?: BadgeColor; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded-full border px-2 py-px text-xs leading-4 font-bold whitespace-nowrap", BADGE[color], className)}>
      {children}
    </span>
  );
}

/** ID 옆의 복사 버튼 */
export function CopyText({ text, children, className }: { text: string; children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text"
        aria-label={`${text} 복사`}
        title={copied ? "복사됨" : "복사"}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => undefined,
          );
        }}
      >
        <Copy className="size-3.5" aria-hidden />
      </button>
      {children ?? <span className="font-mono text-[13px]">{text}</span>}
      {copied && <span className="text-xs text-aws-success">복사됨</span>}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-aws-text-2" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}
