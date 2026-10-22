import Link from "next/link";
import { Cloud } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="inline-flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-violet-600 text-white">
        <Cloud className="size-4" aria-hidden />
      </span>
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">AWS Playground</span>
          <span className="text-[10px] text-muted-foreground">비공식 학습용 시뮬레이터</span>
        </span>
      )}
    </Link>
  );
}

export const DISCLAIMER =
  "AWS Playground는 Amazon Web Services와 제휴하지 않은 독립 학습용 시뮬레이터입니다. 실제 AWS 계정·자격 증명·리소스를 사용하지 않으며 요금이 발생하지 않습니다.";
