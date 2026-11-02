import { toast } from "sonner";
import type { HistoryResult } from "@/lib/store/project-store";

/** 실행 취소·다시 실행 결과 알림: 되돌릴 것이 없으면 안내, 권한이 없어 거부되면 오류와 해결 방법 */
export function notifyHistory(result: HistoryResult, kind: "undo" | "redo") {
  if (result.ok) return;
  if (result.reason === "empty") toast.info(kind === "undo" ? "실행 취소할 작업이 없습니다." : "다시 실행할 작업이 없습니다.");
  else toast.error(result.error, result.hint ? { description: result.hint } : undefined);
}
