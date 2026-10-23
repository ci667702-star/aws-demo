"use client";

import { CircleCheck, CircleX, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { useConsoleUi, type FlashType } from "../console-store";

const STYLE: Record<FlashType, { box: string; icon: React.ElementType }> = {
  success: { box: "bg-aws-flash-success text-white", icon: CircleCheck },
  error: { box: "bg-aws-flash-error text-white", icon: CircleX },
  info: { box: "bg-aws-flash-info text-white", icon: Info },
  warning: { box: "bg-aws-flash-warning text-[#0f141a]", icon: TriangleAlert },
  "in-progress": { box: "bg-aws-flash-info text-white", icon: Loader2 },
};

export function Flashbar() {
  const flashes = useConsoleUi((s) => s.flashes);
  const dismiss = useConsoleUi((s) => s.dismissFlash);
  if (!flashes.length) return null;
  return (
    <ul className="space-y-2" aria-label="알림" data-testid="flashbar">
      {flashes.map((f) => {
        const { box, icon: Icon } = STYLE[f.type];
        return (
          <li key={f.id} role={f.type === "error" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow", box)}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", f.type === "in-progress" && "animate-spin")} aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              {f.header && <p className="font-bold">{f.header}</p>}
              <p className="break-words">{f.content}</p>
              {f.notes && (
                <ul className="list-disc space-y-0.5 pl-4 text-[13px] opacity-95">
                  {f.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
            {f.action && (
              <a
                href={f.action.href}
                onClick={() => dismiss(f.id)}
                className="shrink-0 self-center rounded-full border-2 border-current px-3 py-0.5 text-[13px] font-bold whitespace-nowrap hover:bg-white/15"
              >
                {f.action.label}
              </a>
            )}
            <button type="button" onClick={() => dismiss(f.id)} className="shrink-0 rounded p-0.5 opacity-90 hover:opacity-100" aria-label="알림 닫기">
              <X className="size-4" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
