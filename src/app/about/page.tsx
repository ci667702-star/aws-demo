import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brand, DISCLAIMER } from "@/components/app/brand";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SIMULATION_ASSUMPTIONS } from "@/lib/engine/connectivity-engine";
import { RESOURCE_TYPE_INFO, RESOURCE_TYPES } from "@/lib/engine/resource-models";
import { VALIDATION_RULES } from "@/lib/engine/validation-engine";

export const metadata: Metadata = {
  title: "지원 범위와 가정",
};

const SUPPORTED = [
  "VPC, Subnet, Internet Gateway, Route Table, NAT Gateway, Security Group, Network ACL",
  "EC2 (가상 상태: Pending/Running/Stopped/Terminated), ALB, Target Group, DB Subnet Group, RDS(MySQL/PostgreSQL)",
  "CIDR 검증, 서브넷 포함/충돌 검사, AWS 예약 주소(서브넷당 5개) 반영",
  "Longest Prefix Match 라우팅, local/IGW/NAT 대상, 기본(main) 라우팅 테이블",
  "보안 그룹(상태 저장, 허용 규칙, SG 참조)과 NACL(상태 비저장, 규칙 번호 순서, 응답 임시 포트) 평가",
  "IGW 1:1 주소 변환, NAT Gateway SNAT, 비대칭 라우팅 탐지",
  "ALB 리스너 → 대상 그룹 전달, 가상 헬스 체크, 라운드 로빈 분산, fail-open",
  "RDS 엔드포인트 가상 DNS, Publicly Accessible과 네트워크 경로의 관계, DB 포트 연결 검사",
  "교육용 가정 단가를 사용하는 가상 비용 추정",
];

const NOT_SUPPORTED = [
  "실제 AWS 계정 연결, API 호출, 리소스 생성 (의도적으로 지원하지 않음)",
  "IPv6, VPC 피어링, Transit Gateway, VPN/Direct Connect, VPC 엔드포인트, 프리픽스 목록",
  "ALB 리스너 규칙(경로/호스트 기반 라우팅), TLS 인증서, 스티키 세션, 가중치 기반 분산",
  "Elastic IP 수동 할당, ENI 추가, 보조 IP, 인스턴스 메타데이터/IAM 역할",
  "실제 OS/애플리케이션 실행, 실제 HTTP 요청, 실제 SQL 쿼리",
  "실제 AWS 요금표 (비용은 교육용 가정값)",
];

export default function AboutPage() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
        <Brand />
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <ArrowLeft /> 대시보드
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-10 px-4 py-10">
        <section className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">지원 범위와 단순화한 가정</h1>
          <p className="text-sm text-muted-foreground">{DISCLAIMER}</p>
          <p className="text-sm text-muted-foreground">
            시뮬레이터는 AWS의 실제 개념과 규칙을 최대한 반영하지만, 아래에 적힌 범위만 구현합니다. 구현되지 않은 기능은
            결과에 영향을 주지 않으며, 지원한다고 표시하지 않습니다.
          </p>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border bg-card p-5">
            <h2 className="mb-3 font-semibold">구현된 동작</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {SUPPORTED.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border bg-card p-5">
            <h2 className="mb-3 font-semibold">구현되지 않은 기능</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              {NOT_SUPPORTED.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 font-semibold">시뮬레이션 가정</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {SIMULATION_ASSUMPTIONS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            가상 퍼블릭 IP는 문서화용 대역 198.51.100.0/24(TEST-NET-2)에서, 가상 인터넷 클라이언트는 203.0.113.0/24(TEST-NET-3)에서
            배정합니다. 실제 공인 IP가 아닙니다. 가상 리전은 ap-northeast-2(가용 영역 a~d)를 가정합니다.
          </p>
        </section>

        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 font-semibold">지원 리소스</h2>
          <div className="flex flex-wrap gap-2">
            {RESOURCE_TYPES.map((t) => (
              <Badge key={t} variant="outline" title={RESOURCE_TYPE_INFO[t].description}>
                {RESOURCE_TYPE_INFO[t].label}
              </Badge>
            ))}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 font-semibold">검증 규칙 ({VALIDATION_RULES.length}개)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">ID</th>
                  <th className="py-1.5 pr-3 font-medium">기본 심각도</th>
                  <th className="py-1.5 font-medium">규칙</th>
                </tr>
              </thead>
              <tbody>
                {VALIDATION_RULES.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1.5 pr-3 font-mono text-xs">{r.id}</td>
                    <td className="py-1.5 pr-3 text-xs">{r.severity === "error" ? "오류" : r.severity === "warning" ? "경고" : "정보"}</td>
                    <td className="py-1.5">{r.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
