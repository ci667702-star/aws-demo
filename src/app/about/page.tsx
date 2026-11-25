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
  "VPC, Subnet, Internet Gateway, Elastic IP, Route Table, NAT Gateway, Security Group, Network ACL",
  "EC2 (가상 상태: Pending/Running/Stopped/Terminated, 사용자 데이터, IAM 역할), ALB, Target Group, DB Subnet Group, RDS(MySQL/PostgreSQL)",
  "CIDR 검증, 서브넷 포함/충돌 검사, AWS 예약 주소(서브넷당 5개) 반영",
  "Longest Prefix Match 라우팅, local/IGW/NAT 게이트웨이/인스턴스 대상, 기본(main) 라우팅 테이블",
  "보안 그룹(상태 저장, 허용 규칙, SG 참조)과 NACL(상태 비저장, 규칙 번호 순서, 응답 임시 포트) 평가",
  "IGW 1:1 주소 변환, NAT Gateway SNAT, NAT 인스턴스(소스/대상 확인 중지 + 사용자 데이터의 IP 포워딩·MASQUERADE 판정 + 인스턴스 경로), 비대칭 라우팅 탐지",
  "ALB 리스너 → 대상 그룹 전달, 리스너 규칙(경로 패턴 → 전달/고정 응답), 가상 헬스 체크, 라운드 로빈 분산, fail-open",
  "RDS 엔드포인트 가상 DNS, Publicly Accessible과 네트워크 경로의 관계, DB 포트 연결 검사",
  "가상 IAM: 사용자·그룹·역할·정책(JSON 문법 검사), 가상 액세스 키 발급 과정(PGSIM으로 시작하는 연습용 값, 비밀 키 미저장), 정책 평가(명시적 Deny > Allow > 암묵적 거부), 정책 시뮬레이터, 가상 로그인·역할 전환(만들기·바꾸기·삭제를 그 자격 증명의 정책으로 검사), 학교 역할 템플릿",
  "가상 S3: 버킷 이름 규칙, 객체 업로드(16KB 이하 텍스트만 내용 저장), 버전 관리·삭제 마커, 퍼블릭 액세스 차단, 버킷 정책, 정적 웹 사이트, 접근 테스트(네트워크 + 자격 증명 + 정책)",
  "가상 CloudWatch: 리소스 상태와 가상 부하로 계산한 지표, 경보(M/N 데이터 포인트, 누락 데이터 처리, 상태 기록), 대시보드, 콘솔 알림",
  "가상 Lambda: 함수·실행 역할·VPC 연결·예약 동시성·리소스 기반 정책, 코드 템플릿으로 계산하는 테스트 호출(성공·오류·시간 초과·제한과 그 이유)",
  "가상 EventBridge: Scheduler 일정(rate·cron·at, 시간대, 다음 실행 시각)과 기본 이벤트 버스 규칙(이벤트 패턴, 테스트 이벤트), 일정 호출에 따른 Lambda 지표",
  "가상 Secrets Manager: 보안 암호(RDS 자격 증명·키/값, 값은 입력받지 않고 PGSIM 가상 값으로 대신), 버전과 스테이징 레이블(AWSCURRENT·AWSPREVIOUS), 교체 조건 판정과 즉시 교체, 복구 기간이 있는 삭제·취소, GetSecretValue 접근 테스트",
  "가상 Systems Manager: Parameter Store(String·StringList·SecureString, 표준·고급 계층, 계층 경로 조회, 버전 기록, GetParameter 접근 테스트), 관리형 노드 판정(SSM Agent·인스턴스 프로파일·엔드포인트 경로), Session Manager(ssm:StartSession 검사, 정해진 명령과 포트 확인의 가상 출력)",
  "가상 CloudFront: 배포(S3·S3 웹 사이트·ALB 원본, OAC 버킷 정책 검사), 경로 패턴별 동작(뷰어 프로토콜 정책·허용 메서드·캐시 정책), 기본 루트 객체, 요청 테스트(X-Cache Hit/Miss/RefreshHit/Error와 단계별 근거), 가상 엣지 캐시와 무효화, 배포 중→배포 완료 상태",
  "교육용 가정 단가를 사용하는 가상 비용 추정 (NAT 게이트웨이와 NAT 인스턴스 비교, Lambda·Scheduler·보안 암호·고급 파라미터·CloudFront 포함)",
  "리소스 상세 설명(기본 정보·사용 이유·주요 설정·관련 리소스·현재 구성 분석·시뮬레이터 제한)과 설정 항목별 도움말 — 쉬운 모드 오른쪽 패널, 심화 모드 도움말 패널의 '리소스 설명' 탭",
];

const NOT_SUPPORTED = [
  "실제 AWS 계정 연결, API 호출, 리소스 생성 (의도적으로 지원하지 않음)",
  "IPv6, VPC 피어링, Transit Gateway, VPN/Direct Connect, VPC 엔드포인트(S3 게이트웨이 엔드포인트 포함), 프리픽스 목록",
  "ALB 호스트 헤더·쿼리 문자열 조건, 리디렉션·가중치 전달, TLS 인증서, 스티키 세션",
  "ENI 추가, 보조 IP, 인스턴스 메타데이터 서비스",
  "IAM의 Condition·NotAction·권한 경계·SCP·교차 계정 접근, 실제 로그인·암호·MFA (가상 로그인은 암호 없이 전환, 조회 권한은 검사하지 않음)",
  "S3 ACL, 객체 잠금, 수명 주기 규칙, 복제, 이진·대용량 파일 내용 저장 (크기·형식만 기록)",
  "CloudWatch 실제 지표 수집, CloudWatch Logs, SNS 이메일·문자 알림, 경보에 따른 자동 작업(Auto Scaling 등)",
  "실제 OS/애플리케이션 실행(사용자 데이터·iptables 포함), 실제 HTTP 요청, 실제 SQL 쿼리",
  "Lambda 코드 업로드·실행, 버전·별칭·계층·함수 URL, API Gateway·SQS·S3 트리거, EventBridge 사용자 지정 버스·아카이브, 샌드박스 리소스가 만드는 실제 서비스 이벤트",
  "실제 비밀 값의 입력·저장, 고객 관리형 KMS 키, 보안 암호의 리소스 기반 정책·리전 복제, 일정에 따른 자동 교체 실행(예정일만 계산), VPC 인터페이스 엔드포인트",
  "Parameter Store의 파라미터 정책·레이블·공용 파라미터, Run Command·Patch Manager·Session Manager 포트 전달과 세션 기록, 실제 SSM Agent·셸",
  "CloudFront 실제 도메인·엣지 로케이션·지연 시간, 대체 도메인 이름(CNAME)·ACM 인증서, WAF, CloudFront Functions·Lambda@Edge, 오리진 그룹(장애 조치), 쿼리 문자열·헤더 기반 캐시 키",
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
