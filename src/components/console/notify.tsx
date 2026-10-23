"use client";

/**
 * 콘솔 알림 (sonner 토스트 라이브러리 사용).
 * 짧은 제목 + 필요하면 설명 목록과 이동 버튼을 보여 준다.
 */
import { toast } from "sonner";

export type NotifyType = "success" | "error" | "info" | "warning";

export interface NotifyInput {
  type: NotifyType;
  title: string;
  /** 제목 아래 한 줄 설명 */
  description?: string;
  /** 추가로 알려 줄 내용 (목록으로 표시) */
  notes?: string[];
  /** 토스트 안의 이동 버튼 (해시 경로) */
  action?: { label: string; href: string };
}

const DURATION: Record<NotifyType, number> = { success: 6000, info: 7000, warning: 9000, error: 12000 };

export function notify(input: NotifyInput): string | number {
  const hasBody = !!input.description || !!input.notes?.length;
  const description = hasBody ? (
    <div className="space-y-1">
      {input.description && <p>{input.description}</p>}
      {input.notes?.length ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {input.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : undefined;
  return toast[input.type](input.title, {
    description,
    duration: DURATION[input.type],
    action: input.action
      ? {
          label: input.action.label,
          onClick: () => {
            window.location.hash = input.action!.href.replace(/^#/, "");
          },
        }
      : undefined,
  });
}
