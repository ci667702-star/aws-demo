# AWS Playground — 가상 클라우드 인프라 실습 플랫폼

> **비공식 학습용 시뮬레이터입니다.** Amazon Web Services와 제휴하지 않았으며, 실제 AWS 계정·Access Key·IAM 자격 증명을 요구하지 않고,
> 실제 EC2/VPC/RDS/ALB/S3 등 어떤 클라우드 리소스도 만들거나 수정하지 않습니다. 요금이 발생하는 외부 API에 의존하지 않습니다.

AWS를 배우고 싶지만 요금·계정 설정·과금 위험 때문에 실습하기 어려운 학생과 입문자를 위한 웹 애플리케이션입니다.
같은 샌드박스(가상 AWS 환경)를 두 가지 화면으로 다룰 수 있습니다.

| 화면 | 대상 | 특징 |
| --- | --- | --- |
| **쉬운 모드** (`/projects/[id]`) | 처음 배우는 사람 | 리소스를 캔버스에 끌어다 놓고 선으로 연결하는 그림 설계 화면 |
| **심화 모드** (`/console/[id]`) | 실제 콘솔에 익숙해지고 싶은 사람 | AWS 콘솔처럼 서비스 메뉴·목록·생성 마법사·작업 메뉴로 하나씩 직접 설정. 앱이 대신 만들어 주는 리소스가 없음 |

두 화면은 같은 데이터를 쓰므로 언제든 바꿔 볼 수 있습니다. 모든 결과는 브라우저 안의 시뮬레이션 엔진이 **설정값으로 계산한 가상 결과**입니다.

## 빠른 시작

요구 사항: Node.js 20.9 이상 (개발 환경: Node 24, npm 11)

```bash
npm install
npm run dev
```

브라우저에서 <http://localhost:3000> 을 엽니다. 첫 화면에는 미리 만든 샌드박스가 없습니다.

- **샌드박스 생성**: 이름을 정하고 쉬운 모드 / 심화 모드 중 처음 열 화면을 고릅니다 (빈 환경에서 시작).
- **실습 가이드 5종**: 목표가 주어지는 연습 문제. "실습 시작"(심화 모드) 또는 "쉬운 모드로 시작".
- **완성된 예시 아키텍처**: 3-Tier 웹, 퍼블릭 웹 서버, 프라이빗 + NAT 예시를 새 샌드박스로 엽니다.

샌드박스는 브라우저 `localStorage`에 저장되며 새로고침 후에도 복원됩니다.

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 (Turbopack) |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm test` | Vitest 단위·통합·UI 테스트 |
| `npm run test:e2e` | Playwright E2E 테스트 (개발 서버를 자동으로 띄우거나 실행 중인 서버를 재사용) |

E2E 테스트 브라우저는 `npx playwright install chromium`으로 설치하거나, 설치된 Edge/Chrome을 씁니다
(PowerShell: `$env:PLAYWRIGHT_CHANNEL="msedge"; npm run test:e2e`).

## 기술 스택

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui (Radix) · React Flow (`@xyflow/react` 12) ·
Zustand 5 · Zod 4 · sonner (알림 토스트) · driver.js (단계별 팝업 튜토리얼) · Lucide React · Vitest 5 + React Testing Library · Playwright

## 심화 모드(콘솔)에서 할 수 있는 일

| 서비스 | 화면과 동작 |
| --- | --- |
| 네트워크 (VPC) | VPC(기본 VPC 생성 포함)·서브넷·라우팅 테이블·인터넷 게이트웨이·NAT 게이트웨이·탄력적 IP·네트워크 ACL·보안 그룹. 생성·편집·연결·삭제를 AWS 오류 코드(`[DependencyViolation]` 등)와 함께 검사 |
| 서버 (EC2) | 인스턴스 시작 마법사(AMI, 유형, 서브넷, 퍼블릭 IP, 보안 그룹, 사용자 데이터, **IAM 역할**), 상태 수명 주기(Pending → Running 등), 대상 그룹·헬스 체크 |
| 로드 밸런서 (ALB) | 리스너, 기본 작업, **리스너 규칙**(경로 패턴 → 다른 대상 그룹으로 전달 / 고정 응답), 규칙 경로 테스트 |
| 데이터베이스 (RDS) | DB 서브넷 그룹, DB 인스턴스, 퍼블릭 액세스와 네트워크 경로 |
| 스토리지 (S3, 가상) | 버킷 이름 규칙(전역 중복 체험 포함), 객체 업로드·폴더, 버전 관리와 삭제 마커, 기본 암호화, 퍼블릭 액세스 차단, 버킷 정책(예시 포함), 정적 웹 사이트 호스팅과 가상 브라우저(샌드박스 iframe), **S3 접근 테스트**(네트워크 → 자격 증명 → 정책 → 객체 순서로 판정) |
| 권한 관리 (IAM, 가상) | 사용자·그룹·역할·정책, 정책 시각적 편집기 + JSON 검사, **가상 액세스 키 발급 과정**(용도 선택 → 대안 안내 → 한 번만 보이는 비밀 키 → .csv), 키 비활성화/삭제, 보안 권장 사항, **정책 시뮬레이터** |
| 모니터링 (CloudWatch, 가상) | **가상 부하**(분당 요청 수·시간), 지표 그래프(EC2·ALB·RDS·NAT), 경보 생성 마법사(M/N 데이터 포인트, 누락 데이터 처리), 경보 상태 기록, 대시보드 위젯, 상태가 바뀌면 콘솔 알림 |
| 분석 도구 | Reachability Analyzer(단계별 근거, ALB 대상 분산, HTTP 경로), 리소스 맵, 구성 검사, 가상 비용 추정, 이벤트 기록 |

### 배우기 쉽게 만든 장치

- **순차 팝업 튜토리얼 5종** (상단 "튜토리얼" 메뉴): 콘솔 둘러보기 · 첫 웹 서버 만들기 · IAM 가상 액세스 키 발급 · S3 정적 웹 사이트 공개 ·
  CloudWatch 과부하 경보. 설정이 실제로 맞아야 다음 단계로 자동으로 넘어갑니다.
- **쉽게 이해하기** 안내: 각 화면 위의 접을 수 있는 요약(비유, 해 볼 순서).
- **도움말 패널**: "정보" 링크 → 자세한 설명, 자주 하는 실수, 이 시뮬레이터의 단순화.
- **오류 설명**: `[오류 코드] 메시지 → 해결 방법 → 오류 코드 뜻`을 한 번에 표시.
- **알림 토스트**(sonner): 작업 결과와 다음 행동 버튼(예: "VPC에 연결"). 화면 상단 가운데에 떠서 양식 버튼을 가리지 않습니다.
- 넓은 글자와 여백, 보조 정보 열은 "열 더 보기"로 숨김, 라이트/다크 테마.

### 가상 자격 증명에 대한 안전 장치

- 액세스 키는 `PGSIM`으로 시작하는 연습용 가상 값이며 실제 AWS에서 동작하지 않습니다. 비밀 키는 만들 때 한 번만 보여 주고 **저장하지 않습니다**
  (마지막 4자리만 보관). 콘솔 로그인·MFA는 표시만 바뀌며 암호를 받지 않습니다.
- 업로드한 파일은 이 브라우저에만 남고, 16KB 이하 텍스트 파일만 내용을 저장합니다(나머지는 크기·형식만 기록).
- 정적 웹 사이트 미리 보기는 스크립트·폼·이동이 모두 막힌 `sandbox` iframe에서만 그립니다.

## 쉬운 모드(그림 빌더)

- 왼쪽 팔레트에서 리소스를 끌어다 놓고, 연결점 드래그로 관계를 만듭니다 (VPC/서브넷 영역, 퍼블릭/프라이빗 색상 구분, 자동 정렬, 미니맵).
- 오른쪽 설정 패널에서 리소스별 설정, 하단 패널에서 검증 센터 · 시뮬레이션 콘솔 · 실습 가이드 · 가상 비용 · 실행 로그.
- "둘러보기" 버튼으로 화면 구성을 팝업으로 안내합니다. 경로 기반 ALB 규칙처럼 콘솔 전용 설정은 심화 모드에서 편집합니다.

단축키: `Ctrl/⌘+Z` 실행 취소, `Ctrl/⌘+Shift+Z` 또는 `Ctrl+Y` 다시 실행, `Delete`/`Backspace` 선택 항목 삭제.

## 시뮬레이션 엔진

UI와 분리된 순수 TypeScript 모듈입니다. 같은 입력에는 항상 같은 결과를 돌려줍니다 (CloudWatch 잡음도 해시 기반이라 결정적).

| 모듈 | 역할 |
| --- | --- |
| `resource-models.ts` | 리소스/연결/서비스(IAM·S3·CloudWatch)/프로젝트 타입과 Zod 스키마, 관계 카탈로그 |
| `cidr-utils.ts` | IPv4·CIDR 파싱, 포함/겹침, AWS 예약 주소(서브넷당 5개) |
| `topology-engine.ts` | 소속·연결 관계, 유효 라우팅 테이블, 퍼블릭/프라이빗 판정(라우팅 기준), 가상 IP·DNS |
| `route-engine.ts` | Longest Prefix Match 경로 선택, 중복 경로 탐지 |
| `security-group-engine.ts` / `network-acl-engine.ts` | 보안 그룹(허용 합집합, 암묵적 거부, SG 참조) / NACL(번호 순서, 첫 일치, 상태 비저장) |
| `connectivity-engine.ts` | 종단 간 통신: SG → 라우팅 → NACL → IGW/NAT → SG → 서비스(ALB 리스너 규칙 포함) → 응답 경로 |
| `alb-engine.ts` | 대상 그룹, 가상 헬스 체크, 라운드 로빈, fail-open |
| `iam-engine.ts` | 정책 JSON 검사, 와일드카드 일치, 평가(명시적 Deny > Allow > 암묵적 거부), 관리형 정책(학습용 단순화) |
| `s3-engine.ts` | 버킷·객체 규칙, 퍼블릭 판정, 접근 평가(네트워크·자격 증명·IAM·버킷 정책·퍼블릭 액세스 차단), 정적 웹 사이트 응답 |
| `cloudwatch-engine.ts` | 상태·가상 부하·헬스로 분 단위 지표 계산, 집계(평균/합계/최대/최소), 경보 평가와 상태 기록 |
| `validation-engine.ts` | 72개 검증 규칙 (NET/SEC/EC2/ELB/RDS/GEN, 고유 ID) |
| `simulation-log.ts` | 단계별 로그, 경로, 실패 정보 (통신 실패와 엔진 오류 구분) |
| `connection-rules.ts` / `cost-engine.ts` | 관계 생성 규칙과 거부 사유 / 교육용 가상 비용 |

### 단순화한 가정 (요약)

- IPv4만 지원. IPv6, VPC 피어링, Transit Gateway, VPN, VPC 엔드포인트, 프리픽스 목록은 구현하지 않음
- 명시적 NACL이 없는 서브넷은 VPC 기본 NACL(모두 허용), 명시적 라우팅 테이블이 없으면 기본(main) 테이블
- 응답 임시 포트는 하나의 값(기본 50000)으로 단순화
- EC2는 "가상 서비스 포트"에서만 응답하며 실제 OS·프로세스는 없음. RDS는 포트 접근만 검사
- ALB 리스너 규칙은 경로 패턴 조건과 전달·고정 응답만 지원 (호스트 헤더·쿼리 조건, 리디렉션, 가중치 전달, TLS 인증서는 미지원)
- IAM: Condition은 무시(경고 표시), NotAction/NotResource·권한 경계·SCP·교차 계정은 미지원. 같은 계정 기준으로 평가
- S3: ACL 비활성화(정책만 사용), 객체 잠금·수명 주기·복제 미지원. EC2 → S3는 퍼블릭 엔드포인트(인터넷 경로)로만 접근
- CloudWatch: 지표는 실제 수집값이 아니라 계산값. 경보는 콘솔을 열어 둔 동안 평가해 알림을 띄우며, 이메일·문자(SNS)는 보내지 않음
- 가상 퍼블릭 IP는 198.51.100.0/24, 인터넷 클라이언트는 203.0.113.0/24, 가상 S3 엔드포인트는 192.0.2.80 (RFC 5737 문서화용 대역)

전체 목록은 앱의 `/about` 페이지에 있습니다.

## Guided Lab

1. Public EC2 구성 · 2. Private EC2 + NAT Gateway · 3. ALB와 EC2 · 4. RDS 연결 · 5. 보안 오류 해결(의도적으로 잘못된 구성)

각 단계의 완료 여부는 버튼 클릭이 아니라 **현재 샌드박스의 실제 설정·검증 결과·시뮬레이션 결과**로 자동 판정됩니다. 두 모드 모두에서 진행할 수 있습니다.

## 디렉터리 구조

```
src/
  app/                      Next.js 라우트 (/, /projects/[projectId], /console/[projectId], /about)
  components/
    app/                    공통 셸 (Providers, 테마, 가져오기 대화 상자 등)
    dashboard/              샌드박스 목록, 모드 선택, 실습·예시
    builder/                쉬운 모드: 캔버스, 설정 패널, 하단 패널, 둘러보기
    console/                심화 모드
      shell/                상단 메뉴, 사이드 메뉴, 도움말 패널
      pages/                서비스별 화면 (vpc·ec2·rds 공통 파일, iam/, s3/, cloudwatch/, listener-rules)
      tutorial/             순차 팝업 튜토리얼 (driver.js)
      ui/                   콘솔 UI 부품 (표, 양식, 탭, 알림, 쉽게 이해하기)
      map/                  리소스 맵
    ui/                     shadcn/ui 컴포넌트 (sonner 토스트 포함)
  lib/
    engine/                 시뮬레이션·검증 엔진 (순수 TypeScript)
    project/                콘솔 동작(console/iam/s3/cloudwatch-actions), 팩토리, 변경 연산, 무결성 검사, 저장소, 샘플
    labs/                   Guided Lab 정의와 판정
    store/                  Zustand 스토어 (프로젝트/Undo·Redo, 편집기 상태)
tests/
  unit/                     CIDR, 라우팅, SG/NACL, 토폴로지·ALB, ALB 규칙, IAM, S3, CloudWatch, 콘솔 동작, 검증 규칙
  integration/              종단 간 통신, 시나리오, 저장/복원·JSON, Guided Lab, 수명 주기
  ui/                       React Testing Library (대시보드, 쉬운 모드, 콘솔, IAM·S3·CloudWatch·ALB 규칙 화면)
e2e/                        Playwright
legacy-cra/                 기존 Create React App 템플릿 원본 (삭제하지 않고 보존, 빌드/테스트 대상 아님)
```

## 테스트 현황

- `npm test`: 20개 파일, 308개 테스트 통과 (단위 · 통합 · UI)
  - 검증 규칙마다 트리거 테스트, IAM 평가(Deny 우선·암묵적 거부)와 가상 키(비밀 키 미저장), S3 이름 규칙·버전 관리·접근 평가·정적 웹 사이트,
    CloudWatch 지표·경보 상태 전이, ALB 경로 규칙·고정 응답
- `npm run test:e2e`: 6개 시나리오 통과 (Chromium) — 콘솔만으로 웹 서버 구성, 오류 코드, 실습 판정, 모바일 가로 넘침, IAM 키 발급 + S3 웹 사이트 공개
- `npm run lint`, `npm run typecheck`, `npm run build` 통과

## 알려진 제한 사항

- 데이터는 브라우저 `localStorage`에만 저장됩니다 (기기 간 동기화 없음, 약 5MB 제한). 중요한 샌드박스는 JSON으로 내보내세요.
- 여러 탭에서 같은 샌드박스를 동시에 편집하면 마지막 저장이 우선합니다.
- CloudWatch 경보 알림은 콘솔 화면이 열려 있는 동안에만 뜹니다. 지표 기록은 가상 부하 설정으로부터 다시 계산하므로 부하를 지우면 지난 그래프도 바뀝니다.
- S3는 이진 파일·큰 파일의 내용을 저장하지 않습니다 (미리 보기·다운로드 불가).
- 쉬운 모드 캔버스는 넓은 화면에 최적화되어 있습니다. IAM·S3·CloudWatch와 ALB 경로 규칙은 심화 모드에서만 편집합니다.

## 다음 단계 후보

- VPC 피어링 / Transit Gateway, VPC 엔드포인트(S3 게이트웨이 엔드포인트)
- ALB 호스트 헤더 조건·리디렉션, HTTPS 인증서 개념, NLB
- Auto Scaling 그룹(경보에 따라 인스턴스 수 조절), CloudWatch Logs
- IAM Condition 평가, 역할 전환(AssumeRole) 체험
- IndexedDB 저장소와 버전 기록, 읽기 전용 공유 링크
