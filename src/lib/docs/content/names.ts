/**
 * 리소스 이름 도움말 중 Name 태그가 아닌 경우.
 * VPC·서브넷·EC2 등은 이름이 'Name' 태그일 뿐이지만(NAME_TAG_HELP), 아래 리소스는 이름 자체가 리소스의 속성이다.
 */
import type { DocKey, FieldHelp } from "../types";

export const RESOURCE_NAME_HELP: Partial<Record<DocKey, FieldHelp>> = {
  "security-group": {
    title: "보안 그룹 이름 (GroupName)",
    meaning: "보안 그룹 자체의 이름입니다. Name 태그와 별개로, 만들 때 반드시 정하는 값입니다.",
    purpose: "규칙과 연결 대상을 볼 때 어떤 용도의 그룹인지 구분합니다.",
    values: "실제 AWS: 최대 255자, 같은 VPC 안에서 고유. 'sg-'로 시작할 수 없습니다.",
    realAws: "만든 뒤에는 그룹 이름을 바꿀 수 없습니다(Name 태그는 따로 바꿀 수 있음). 이름은 트래픽 허용 여부에 영향을 주지 않습니다.",
    simulator: "캔버스와 목록에 표시되는 이름이며 쉬운 모드에서는 학습을 위해 바꿀 수 있습니다. 허용 여부 계산에는 이름이 아니라 규칙만 씁니다.",
    mistakes: ["이름을 web-sg로 지었지만 인바운드 규칙이 없어 아무 연결도 허용되지 않음"],
    example: "web-sg, alb-sg, db-sg",
  },
  alb: {
    title: "로드 밸런서 이름",
    meaning: "로드 밸런서의 고유 이름입니다. DNS 이름의 앞부분에 쓰입니다.",
    purpose: "여러 로드 밸런서를 구분하고, DNS 이름만 보고도 어떤 서비스인지 알 수 있게 합니다.",
    values: "실제 AWS: 리전 안에서 고유, 최대 32자, 영문·숫자·하이픈 (하이픈으로 시작하거나 끝날 수 없음)",
    realAws: "만든 뒤에는 이름을 바꿀 수 없습니다. DNS 이름은 '이름-임의값.리전.elb.amazonaws.com' 형식으로 만들어집니다.",
    simulator: "가상 DNS 이름(이름-숫자.ap-northeast-2.elb.playground.local)의 앞부분에 쓰입니다. 쉬운 모드에서는 바꿀 수 있고, 요청 전달 계산에는 영향을 주지 않습니다.",
    mistakes: ["이름에 public을 넣으면 인터넷에서 접근된다고 생각함 — 접근 범위는 체계(Scheme)와 서브넷이 정합니다"],
    example: "web-alb",
  },
  "target-group": {
    title: "대상 그룹 이름",
    meaning: "대상 그룹의 고유 이름입니다. 리스너와 규칙에서 전달 대상을 고를 때 이 이름으로 구분합니다.",
    purpose: "같은 로드 밸런서 뒤의 여러 서비스(web, api 등)를 구분합니다.",
    values: "실제 AWS: 리전 안에서 고유, 최대 32자, 영문·숫자·하이픈",
    realAws: "만든 뒤에는 이름을 바꿀 수 없습니다. 이름은 전달과 헬스 체크 동작에 영향을 주지 않습니다.",
    simulator: "표시용 이름이며 쉬운 모드에서는 바꿀 수 있습니다. 전달·헬스 체크 계산에는 쓰지 않습니다.",
    mistakes: ["이름이 비슷한 대상 그룹을 리스너에 잘못 연결함 — 프로토콜:포트와 등록된 대상을 함께 확인하세요"],
    example: "web-tg (HTTP:80), api-tg (HTTP:8080)",
  },
  rds: {
    title: "DB 인스턴스 식별자",
    meaning: "DB 인스턴스의 고유 이름입니다. 엔드포인트 주소의 앞부분에 쓰입니다.",
    purpose: "여러 데이터베이스를 구분하고 애플리케이션이 접속할 엔드포인트를 알아보기 쉽게 합니다.",
    values: "실제 AWS: 계정·리전 안에서 고유, 영문자로 시작, 최대 63자, 영문 소문자·숫자·하이픈",
    realAws: "바꿀 수는 있지만 바꾸면 엔드포인트 주소도 바뀌어 애플리케이션의 접속 설정을 함께 고쳐야 합니다.",
    simulator: "가상 엔드포인트(식별자.c숫자.ap-northeast-2.rds.playground.local)의 앞부분에 쓰입니다. 실제 DB와 DNS는 없습니다.",
    mistakes: ["식별자를 바꾼 뒤 애플리케이션이 예전 엔드포인트로 접속하려 함"],
    example: "orders-db",
  },
  "db-subnet-group": {
    title: "DB 서브넷 그룹 이름",
    meaning: "DB 서브넷 그룹의 고유 이름입니다. RDS를 만들 때 이 이름으로 그룹을 고릅니다.",
    purpose: "DB를 둘 서브넷 묶음(예: 프라이빗 DB 서브넷 2개)을 구분합니다.",
    values: "실제 AWS: 최대 255자, 영문·숫자·공백·마침표·밑줄·하이픈. 'default'는 쓸 수 없습니다.",
    realAws: "만든 뒤에는 이름을 바꿀 수 없고, 설명과 포함할 서브넷만 바꿀 수 있습니다.",
    simulator: "표시용 이름이며 쉬운 모드에서는 바꿀 수 있습니다. DB 배치 계산에는 이름이 아니라 포함된 서브넷만 씁니다.",
    mistakes: ["이름에 private를 넣었지만 실제로는 퍼블릭 서브넷이 포함됨"],
    example: "db-private-subnets",
  },
};
