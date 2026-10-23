"use client";

import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";

export type AlertType = "info" | "success" | "warning" | "error";

const ALERT: Record<AlertType, { icon: React.ElementType; box: string; icon_: string }> = {
  info: { icon: Info, box: "border-aws-info bg-aws-info-bg", icon_: "text-aws-info" },
  success: { icon: CircleCheck, box: "border-aws-success bg-aws-success-bg", icon_: "text-aws-success" },
  warning: { icon: TriangleAlert, box: "border-aws-warning bg-aws-warning-bg", icon_: "text-aws-warning" },
  error: { icon: CircleX, box: "border-aws-error bg-aws-error-bg", icon_: "text-aws-error" },
};

export function Alert({
  type = "info",
  header,
  children,
  action,
  onDismiss,
  className,
}: {
  type?: AlertType;
  header?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const { icon: Icon, box, icon_ } = ALERT[type];
  return (
    <div role={type === "error" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl border-2 px-4 py-3 text-sm text-aws-text", box, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon_)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {header && <div className="font-bold">{header}</div>}
        {children && <div className="break-words text-aws-text [&_a]:text-aws-link [&_a]:underline">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 self-start rounded p-0.5 text-aws-text-2 hover:text-aws-text" aria-label="알림 닫기">
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
