# AWS Playground — 가상 클라우드 인프라 실습 플랫폼

> **비공식 학습용 시뮬레이터입니다.** Amazon Web Services와 제휴하지 않았으며, 실제 AWS 계정·Access Key·IAM 자격 증명을 요구하지 않고,
> 실제 EC2/VPC/RDS/ALB 등 어떤 클라우드 리소스도 만들거나 수정하지 않습니다. 요금이 발생하는 외부 API에 의존하지 않습니다.

AWS를 배우고 싶지만 요금·계정 설정·과금 위험 때문에 실습하기 어려운 학생과 입문자를 위한 웹 애플리케이션입니다.
AWS 콘솔과 비슷한 흐름으로 VPC·서브넷·라우팅·보안 그룹·NACL·ALB·RDS를 캔버스에 배치하면, **설정값을 바탕으로** 검증과 통신
시뮬레이션이 계산됩니다. 모든 리소스는 브라우저 안의 시뮬레이션 엔진이 관리하는 가상 객체입니다.

## 빠른 시작

요구 사항: Node.js 20.9 이상 (개발 환경: Node 24, npm 11)

```bash
npm install
npm run dev
```

브라우저에서 <http://localhost:3000> 을 엽니다. 첫 방문 시 예시 프로젝트(3-Tier 웹 아키텍처)가 자동으로 만들어집니다.
프로젝트는 브라우저 `localStorage`에 저장되며 새로고침 후에도 복원됩니다.

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 (Turbopack) |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm test` | Vitest 단위·통합·UI 테스트 |
| `npm run test:e2e` | Playwright E2E 테스트 (개발 서버를 자동으로 띄우거나 실행 중인 서버를 재사용) |

E2E 테스트 브라우저는 둘 중 하나를 준비합니다.

```bash
npx playwright install chromium
```

또는 설치된 Edge/Chrome을 사용합니다 (PowerShell: `$env:PLAYWRIGHT_CHANNEL="msedge"; npm run test:e2e`).

```bash
PLAYWRIGHT_CHANNEL=msedge npm run test:e2e
```

## 기술 스택

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui (Radix) · React Flow (`@xyflow/react` 12) ·
Zustand 5 · Zod 4 · Lucide React · Vitest 5 + React Testing Library · Playwright

## 화면 구성

- **Dashboard (`/`)**: 새 프로젝트, 목록(검색·정렬), 최근 작업, 이름 변경·복제·삭제·JSON 내보내기, 마지막 수정 시간과 리소스 수,
  샘플 아키텍처 3종, Guided Lab 5종(진행률 표시), JSON 가져오기
- **Architecture Builder (`/projects/[id]`)**
  - 왼쪽 팔레트: 클릭 또는 드래그 앤 드롭으로 리소스 추가 (VPC/서브넷 영역 위에 놓거나, 리소스를 선택한 채 추가하면 자동 연결)
  - 중앙 캔버스: 확대·축소·이동, 다중 선택(Shift+드래그, Ctrl/⌘+클릭), Delete로 삭제, 연결점 드래그로 관계 생성, 연결선 선택 후 삭제,
    자동 정렬, VPC/서브넷 네트워크 영역(퍼블릭/프라이빗 색상 구분), 미니맵
  - 오른쪽 설정 패널: 리소스별 상세 설정 (잘못된 값은 이유와 함께 거부), 연결 상세, 프로젝트 개요
  - 상단: 프로젝트명(클릭하여 변경), 저장 상태, 실행 취소/다시 실행, 자동 정렬, 보기 옵션, 검증·시뮬레이션 버튼
  - 하단 패널: 검증 센터 · 시뮬레이션 콘솔 · 실습 가이드 · 가상 비용 · 실행 로그
- **지원 범위와 가정 (`/about`)**: 구현된 동작, 구현되지 않은 기능, 시뮬레이션 가정, 검증 규칙 목록

단축키: `Ctrl/⌘+Z` 실행 취소, `Ctrl/⌘+Shift+Z` 또는 `Ctrl+Y` 다시 실행, `Delete`/`Backspace` 선택 항목 삭제.

## 지원 리소스와 관계

| 분류 | 리소스 |
| --- | --- |
| 네트워킹 | VPC, Subnet, Internet Gateway, Route Table, NAT Gateway |
| 보안 | Security Group (상태 저장), Network ACL (상태 비저장, 규칙 번호 순서) |
| 컴퓨팅 | EC2 (가상 상태 Pending/Running/Stopped/Terminated) |
| 로드 밸런싱 | Application Load Balancer, Target Group |
| 데이터베이스 | DB Subnet Group, RDS (MySQL/PostgreSQL) |

연결은 타입이 있는 관계(`vpc-subnet`, `route-table-subnet`, `route-table-internet-gateway`(경로), `alb-target-group`(리스너 전달),
`target-group-ec2`(대상 등록) 등 19종)로 저장됩니다. 지원되지 않는 관계, 개수 제한 위반(예: VPC당 IGW 1개, 서브넷당 라우팅 테이블 1개),
다른 VPC 사이의 연결(보안 그룹, 대상 등록 등)은 이유와 함께 거부합니다.

## 시뮬레이션 엔진

UI와 분리된 순수 TypeScript 모듈이며, 같은 입력에는 항상 같은 결과를 반환합니다 (무작위 요소 없음).

| 모듈 | 역할 |
| --- | --- |
| `resource-models.ts` | 리소스/연결/프로젝트 타입과 Zod 스키마, 관계 카탈로그 |
| `cidr-utils.ts` | IPv4·CIDR 파싱, 포함/겹침, AWS 예약 주소(서브넷당 5개) |
| `topology-engine.ts` | 소속·연결 관계 해석, 유효 라우팅 테이블(기본 테이블 포함), 퍼블릭/프라이빗 판정(라우팅 기준), 가상 IP·DNS |
| `route-engine.ts` | Longest Prefix Match 경로 선택, 중복 경로 탐지 |
| `security-group-engine.ts` | 보안 그룹 평가 (허용 규칙 합집합, 암묵적 거부, SG 참조) |
| `network-acl-engine.ts` | NACL 평가 (번호 순서, 첫 일치, `*` 거부), 가려진 규칙 탐지 |
| `connectivity-engine.ts` | 종단 간 통신: SG → 라우팅 → NACL → IGW/NAT → SG → 서비스 → 응답 경로(NACL 재평가) |
| `alb-engine.ts` | 리스너·대상 그룹, 가상 헬스 체크(상태·AZ·네트워크·서비스 포트·응답 코드), 라운드 로빈, fail-open |
| `validation-engine.ts` | 68개 검증 규칙 (NET/SEC/EC2/ELB/RDS/GEN, 고유 ID) |
| `simulation-log.ts` | 단계별 로그, 경로, 실패 정보 (통신 실패와 엔진 오류 구분) |
| `connection-rules.ts` | 관계 생성 규칙과 거부 사유 |
| `cost-engine.ts` | 교육용 가상 비용 (가정 단가, 사용자 수정 가능) |

시뮬레이션 결과에는 성공/실패, 가상 이동 경로, 각 단계에서 평가한 경로·규칙 표, 차단 원인과 해결 방법, 관련 AWS 개념이 포함됩니다.
ALB 목적지는 요청 수(최대 100)를 지정해 대상별 분산을 확인할 수 있습니다. 결과 경로는 캔버스에서 순서대로 애니메이션됩니다.

### 단순화한 가정 (요약)

- IPv4만 지원. IPv6, VPC 피어링, Transit Gateway, VPN, VPC 엔드포인트, 프리픽스 목록은 구현하지 않음
- 명시적 NACL이 없는 서브넷은 VPC 기본 NACL(모두 허용), 명시적 라우팅 테이블이 없으면 기본(main) 테이블(없으면 local만)
- 응답 임시 포트는 하나의 값(기본 50000)으로 단순화 — 검증 규칙(SEC-010)은 1024-65535 범위를 대표값으로 검사
- EC2는 "가상 서비스 포트"에서만 응답한다고 가정하며 실제 OS·프로세스는 없음. RDS는 포트 접근만 검사하고 SQL을 실행하지 않음
- ALB 리스너 규칙(경로/호스트 기반), TLS 인증서는 시뮬레이션하지 않음
- 가상 퍼블릭 IP는 198.51.100.0/24, 인터넷 클라이언트는 203.0.113.0/24 (RFC 5737 문서화용 대역)

전체 목록은 앱의 `/about` 페이지에 있습니다.

## Guided Lab

1. Public EC2 구성 · 2. Private EC2 + NAT Gateway · 3. ALB와 EC2 · 4. RDS 연결 · 5. 보안 오류 해결(의도적으로 잘못된 구성)

각 단계의 완료 여부는 버튼 클릭이 아니라 **현재 프로젝트의 실제 설정·검증 결과·시뮬레이션 결과**로 자동 판정됩니다.

## 디렉터리 구조

```
src/
  app/                      Next.js 라우트 (/, /projects/[projectId], /about)
  components/
    app/                    공통 셸 (Providers, 테마, 가져오기 대화 상자 등)
    dashboard/              대시보드
    builder/
      canvas/               React Flow 캔버스, 노드/영역/연결선
      inspector/            리소스별 설정 폼, 규칙 편집기
      panels/               검증 센터, 시뮬레이션 콘솔, 실습, 비용, 실행 로그
    ui/                     shadcn/ui 컴포넌트
  lib/
    engine/                 시뮬레이션·검증 엔진 (순수 TypeScript)
    project/                팩토리, 변경 연산, 자동 정렬, 무결성 검사, JSON 직렬화, 저장소, 샘플, 빌더 DSL
    labs/                   Guided Lab 정의와 판정
    store/                  Zustand 스토어 (프로젝트/Undo·Redo, 편집기 상태)
tests/
  unit/                     CIDR, 라우팅, SG/NACL, 토폴로지·ALB, 연결 규칙·변경 연산, 검증 규칙(규칙별 트리거)
  integration/              종단 간 통신, 명세 실험 시나리오, 저장/복원·JSON, Guided Lab
  ui/                       React Testing Library (대시보드, 빌더)
e2e/                        Playwright
legacy-cra/                 기존 Create React App 템플릿 원본 (삭제하지 않고 보존, 빌드/테스트 대상 아님)
```

## 테스트 현황

- `npm test`: 12개 파일, 218개 테스트 통과 (단위 · 통합 · UI)
  - 68개 검증 규칙 각각에 트리거 테스트가 있고, 규칙 누락 시 실패하는 메타 테스트 포함
  - 명세의 실험(앱 포트 차단, 리스너 제거, 대상 등록 해제, 기본 경로 제거, EC2 중지)마다 실패 원인이 달라지는지 검증
- `npm run test:e2e`: 7개 시나리오 통과 (Microsoft Edge 채널로 확인)
- `npm run lint`, `npm run typecheck`, `npm run build` 통과

## 알려진 제한 사항

- 데이터는 브라우저 `localStorage`에만 저장됩니다 (기기 간 동기화 없음, 약 5MB 제한). 중요한 프로젝트는 JSON으로 내보내세요.
- 여러 탭에서 같은 프로젝트를 동시에 편집하면 마지막 저장이 우선합니다.
- 캔버스 편집은 넓은 화면에 최적화되어 있습니다. 좁은 화면에서는 팔레트/설정 패널이 오버레이로 열리고 도구 모음이 가로로 스크롤됩니다.
- EC2 퍼블릭 IP는 시작/중지 후에도 같은 가상 주소를 유지합니다 (실제 AWS에서는 바뀔 수 있음).
- Elastic IP 수동 할당, 보조 ENI, 경로 기반 ALB 규칙, IPv6 등은 구현되지 않았습니다.

## 다음 단계 후보

- VPC 피어링 / Transit Gateway와 라우팅 전파
- ALB 리스너 규칙(경로·호스트 기반), HTTPS 인증서 개념, NLB
- VPC 엔드포인트(Gateway/Interface)와 S3 같은 관리형 서비스 접근 시뮬레이션
- Bastion 호스트·SSM 접속 실습, IAM 개념 학습 모듈
- IndexedDB 저장소와 프로젝트 버전 기록, 공유 링크(읽기 전용) 내보내기
- 시뮬레이션 결과 비교(변경 전/후 diff) 화면
