/**
 * 처음 보는 사람을 위한 AWS 용어 한 줄 풀이.
 * 안내 글(쉽게 이해하기, 따라하기 설명, 다음 할 일) 속 용어에 점선 밑줄을 긋고 이 풀이를 보여 준다.
 * 시뮬레이터 안의 학습용 데이터이며, 자세한 설명은 각 화면의 '정보' 링크와 리소스 설명에 있다.
 */
import { RESOURCE_TYPE_INFO, type ResourceType } from "@/lib/engine/resource-models";

export interface GlossaryEntry {
  /** 풀이 제목에 쓰는 이름 */
  term: string;
  /** 글에서 찾을 표기 (긴 표기가 먼저 일치한다) */
  forms: string[];
  meaning: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: "VPC", forms: ["VPC"], meaning: "AWS 안에 만드는 나만의 가상 네트워크입니다. 서버와 DB를 이 안에 둡니다." },
  { term: "서브넷", forms: ["서브넷"], meaning: "VPC의 주소 범위를 나눈 구역입니다. 서버는 서브넷 하나에 놓이고, 서브넷은 가용 영역 하나에 속합니다." },
  { term: "퍼블릭 서브넷", forms: ["퍼블릭 서브넷"], meaning: "라우팅 테이블에 인터넷 게이트웨이로 가는 경로(0.0.0.0/0)가 있는 서브넷입니다. 퍼블릭 IP가 있는 서버는 인터넷과 직접 통신합니다." },
  { term: "프라이빗 서브넷", forms: ["프라이빗 서브넷"], meaning: "인터넷 게이트웨이로 가는 경로가 없는 서브넷입니다. 인터넷에서 바로 들어올 수 없어 DB나 내부 서버를 둡니다." },
  { term: "인터넷 게이트웨이", forms: ["인터넷 게이트웨이", "IGW"], meaning: "VPC와 인터넷을 잇는 출입문입니다. VPC 하나에 하나만 연결합니다." },
  { term: "NAT 게이트웨이", forms: ["NAT 게이트웨이"], meaning: "프라이빗 서브넷의 서버가 인터넷으로 나가는 요청만 할 수 있게 해 주는 출구입니다. 밖에서 먼저 들어오는 연결은 받지 않습니다." },
  { term: "NAT 인스턴스", forms: ["NAT 인스턴스"], meaning: "NAT 게이트웨이 대신 EC2 인스턴스로 만든 출구입니다. 비용은 적지만 직접 설정하고 관리해야 합니다." },
  { term: "라우팅 테이블", forms: ["라우팅 테이블"], meaning: "서브넷의 길 안내표입니다. 목적지 주소마다 트래픽을 어디로 보낼지 적습니다." },
  { term: "탄력적 IP", forms: ["탄력적 IP"], meaning: "바뀌지 않는 고정 퍼블릭 IP 주소입니다. 인스턴스를 중지했다 다시 시작해도 그대로입니다." },
  { term: "보안 그룹", forms: ["보안 그룹"], meaning: "인스턴스·로드 밸런서·DB에 붙이는 방화벽입니다. 허용할 트래픽만 적고, 허용한 요청의 응답은 자동으로 나갑니다." },
  { term: "네트워크 ACL", forms: ["네트워크 ACL", "NACL"], meaning: "서브넷 단위의 방화벽입니다. 허용·거부 규칙을 번호 순서로 확인하고, 응답 트래픽도 따로 허용해야 합니다." },
  { term: "CIDR", forms: ["CIDR"], meaning: "IP 주소 범위를 적는 방법입니다. 예: 10.0.0.0/16 — / 뒤의 숫자가 작을수록 범위가 넓습니다." },
  { term: "0.0.0.0/0", forms: ["0.0.0.0/0"], meaning: "모든 IPv4 주소, 즉 인터넷 전체를 뜻하는 CIDR입니다." },
  { term: "가용 영역", forms: ["가용 영역"], meaning: "한 리전 안에서 서로 떨어져 있는 데이터 센터 묶음입니다. 여러 곳에 나눠 두면 한 곳에 장애가 나도 버팁니다." },
  { term: "리전", forms: ["리전"], meaning: "AWS 데이터 센터가 모여 있는 지역입니다. 예: 서울(ap-northeast-2)" },
  { term: "EC2 인스턴스", forms: ["EC2 인스턴스", "EC2"], meaning: "AWS의 가상 서버입니다. OS(AMI)·크기(인스턴스 유형)·서브넷·보안 그룹을 골라 시작합니다." },
  { term: "AMI", forms: ["AMI"], meaning: "서버를 시작할 때 쓰는 OS 이미지입니다. 예: Amazon Linux 2023" },
  { term: "퍼블릭 IP", forms: ["퍼블릭 IP"], meaning: "인터넷에서 서버를 찾아올 때 쓰는 주소입니다. 퍼블릭 서브넷의 서버도 이 주소가 있어야 인터넷과 통신합니다." },
  { term: "프라이빗 IP", forms: ["프라이빗 IP"], meaning: "VPC 안에서만 쓰는 주소입니다. 인터넷에서는 이 주소로 찾아올 수 없습니다." },
  { term: "로드 밸런서", forms: ["로드 밸런서", "Application Load Balancer", "ALB"], meaning: "들어온 요청을 여러 서버에 나눠 보내는 장치입니다. 상태 검사에 실패한 서버로는 보내지 않습니다." },
  { term: "대상 그룹", forms: ["대상 그룹"], meaning: "로드 밸런서가 요청을 나눠 보낼 서버 목록입니다." },
  { term: "상태 검사 (헬스 체크)", forms: ["헬스 체크", "상태 검사"], meaning: "서버가 정상인지 주기적으로 보내 보는 확인 요청입니다. 실패한 서버는 요청을 받지 않습니다." },
  { term: "리스너", forms: ["리스너"], meaning: "로드 밸런서가 요청을 받는 프로토콜·포트(예: HTTP 80)와, 받은 요청을 어디로 보낼지 정한 설정입니다." },
  { term: "RDS", forms: ["RDS"], meaning: "AWS가 설치·백업을 관리해 주는 관계형 데이터베이스(MySQL·PostgreSQL 등)입니다." },
  { term: "DB 서브넷 그룹", forms: ["DB 서브넷 그룹"], meaning: "RDS를 둘 수 있는 서브넷 목록입니다. 서로 다른 가용 영역의 서브넷이 2개 이상 있어야 합니다." },
  { term: "S3", forms: ["S3"], meaning: "파일(객체)을 저장하는 저장소 서비스입니다. 파일은 버킷에 담습니다." },
  { term: "버킷", forms: ["버킷"], meaning: "S3에서 파일(객체)을 담는 통입니다. 버킷 이름은 전 세계에서 하나뿐이어야 합니다." },
  { term: "버킷 정책", forms: ["버킷 정책"], meaning: "S3 버킷에 붙여 누가 그 버킷을 쓸 수 있는지 정하는 JSON 정책입니다." },
  { term: "IAM", forms: ["IAM"], meaning: "누가(사용자·역할) 무엇을(작업) 할 수 있는지 정하는 권한 관리 서비스입니다." },
  { term: "IAM 역할", forms: ["IAM 역할"], meaning: "사람이나 서비스(EC2·Lambda 등)가 잠시 빌려 쓰는 권한 묶음입니다. 키를 서버에 저장하지 않아도 됩니다." },
  { term: "실행 역할", forms: ["실행 역할"], meaning: "Lambda 함수가 실행될 때 맡는 IAM 역할입니다. 함수가 할 수 있는 일을 정합니다." },
  { term: "IAM 정책", forms: ["IAM 정책"], meaning: "허용하거나 거부할 작업과 대상을 적은 JSON 문서입니다. 사용자·그룹·역할에 연결합니다." },
  { term: "액세스 키", forms: ["액세스 키"], meaning: "프로그램(CLI·SDK)이 AWS에 요청할 때 쓰는 키입니다. 이 시뮬레이터의 키는 연습용 가상 값입니다." },
  { term: "Lambda", forms: ["Lambda"], meaning: "서버 없이, 요청·일정·이벤트가 올 때만 코드를 실행하는 서비스입니다." },
  { term: "CloudWatch", forms: ["CloudWatch"], meaning: "리소스의 지표(CPU 사용률 등)를 모으고 경보를 보내는 모니터링 서비스입니다." },
  { term: "경보", forms: ["경보"], meaning: "지표가 정한 기준을 넘으면 상태가 ALARM으로 바뀌어 알려 주는 CloudWatch 기능입니다." },
  { term: "EventBridge", forms: ["EventBridge"], meaning: "정해진 시각이나 이벤트가 오면 Lambda 같은 대상을 호출하는 서비스입니다." },
  { term: "CloudFront", forms: ["CloudFront"], meaning: "콘텐츠를 사용자와 가까운 엣지에서 캐시해 빠르게 전달하는 CDN입니다." },
  { term: "Secrets Manager", forms: ["Secrets Manager"], meaning: "DB 암호·API 키 같은 비밀 값을 보관하고, 권한이 있는 애플리케이션만 읽게 하는 서비스입니다." },
  { term: "Systems Manager", forms: ["Systems Manager"], meaning: "설정 값 보관(Parameter Store)과 SSH 없는 서버 접속(Session Manager)을 제공하는 관리 서비스입니다." },
  { term: "포트", forms: ["포트"], meaning: "서버 안에서 어느 프로그램이 받을지 정하는 번호입니다. 예: HTTP 80, HTTPS 443, SSH 22" },
  { term: "인바운드", forms: ["인바운드"], meaning: "밖에서 들어오는 트래픽입니다." },
  { term: "아웃바운드", forms: ["아웃바운드"], meaning: "안에서 밖으로 나가는 트래픽입니다." },
  { term: "Reachability Analyzer", forms: ["Reachability Analyzer"], meaning: "출발지에서 목적지까지 통신이 닿는지 라우팅·보안 그룹·네트워크 ACL을 단계별로 따져 보는 분석 도구입니다." },
  { term: "샌드박스", forms: ["샌드박스"], meaning: "연습용 가상 AWS 환경 하나입니다. 여러 개를 만들어 서로 영향 없이 따로 연습할 수 있습니다." },
];

const FORMS = GLOSSARY.flatMap((entry) => entry.forms.map((form) => ({ form, entry }))).sort((a, b) => b.form.length - a.form.length);
const BY_FORM = new Map(FORMS.map((f) => [f.form, f.entry]));
const PATTERN = new RegExp(FORMS.map((f) => f.form.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "g");

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

export type GlossaryPiece = string | { text: string; entry: GlossaryEntry };

/**
 * 글을 일반 글과 용어로 나눈다. 같은 용어는 처음 한 번만, 한 글에서 최대 limit개만 표시한다 (밑줄이 너무 많으면 읽기 어렵다).
 * 영문 용어는 단어 중간(예: "IAMReadOnly")에서는 찾지 않는다.
 */
export function splitGlossary(text: string, limit = 3): GlossaryPiece[] {
  const out: GlossaryPiece[] = [];
  const used = new Set<GlossaryEntry>();
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    if (used.size >= limit) break;
    const entry = BY_FORM.get(m[0])!;
    const start = m.index;
    const end = start + m[0].length;
    if (used.has(entry)) continue;
    if (isWordChar(m[0][0]) && (isWordChar(text[start - 1]) || text[start - 1] === ".")) continue;
    if (isWordChar(m[0][m[0].length - 1]) && isWordChar(text[end])) continue;
    used.add(entry);
    if (start > last) out.push(text.slice(last, start));
    out.push({ text: m[0], entry });
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 메뉴 이름처럼 용어 하나뿐인 글의 풀이 (없으면 null) */
export function glossaryMeaning(label: string): string | null {
  return BY_FORM.get(label.trim())?.meaning ?? null;
}

/** 쉬운 모드 팔레트에 쓰는 이름: 한국어 이름을 먼저, AWS 영문 이름을 작게 */
export const RESOURCE_PLAIN_NAME: Record<ResourceType, { ko: string; en: string }> = {
  vpc: { ko: "VPC (가상 네트워크)", en: RESOURCE_TYPE_INFO.vpc.label },
  subnet: { ko: "서브넷", en: RESOURCE_TYPE_INFO.subnet.label },
  "internet-gateway": { ko: "인터넷 게이트웨이", en: RESOURCE_TYPE_INFO["internet-gateway"].label },
  "route-table": { ko: "라우팅 테이블", en: RESOURCE_TYPE_INFO["route-table"].label },
  "nat-gateway": { ko: "NAT 게이트웨이", en: RESOURCE_TYPE_INFO["nat-gateway"].label },
  "elastic-ip": { ko: "탄력적 IP", en: RESOURCE_TYPE_INFO["elastic-ip"].label },
  "security-group": { ko: "보안 그룹", en: RESOURCE_TYPE_INFO["security-group"].label },
  "network-acl": { ko: "네트워크 ACL", en: RESOURCE_TYPE_INFO["network-acl"].label },
  ec2: { ko: "EC2 (가상 서버)", en: RESOURCE_TYPE_INFO.ec2.label },
  lambda: { ko: "Lambda 함수", en: RESOURCE_TYPE_INFO.lambda.label },
  alb: { ko: "로드 밸런서", en: RESOURCE_TYPE_INFO.alb.label },
  "target-group": { ko: "대상 그룹", en: RESOURCE_TYPE_INFO["target-group"].label },
  "db-subnet-group": { ko: "DB 서브넷 그룹", en: RESOURCE_TYPE_INFO["db-subnet-group"].label },
  rds: { ko: "RDS 데이터베이스", en: RESOURCE_TYPE_INFO.rds.label },
};
