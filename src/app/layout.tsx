import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import { Providers } from "@/components/app/providers";

export const metadata: Metadata = {
  title: {
    default: "AWS Playground — 가상 클라우드 인프라 실습",
    template: "%s · AWS Playground",
  },
  description:
    "실제 AWS 계정이나 요금 없이 VPC, 서브넷, 보안 그룹, ALB, RDS를 설계하고 가상 통신을 시뮬레이션하는 비공식 학습용 플랫폼",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" suppressHydrationWarning className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
