/**
 * 따라하기 주제 목록 (이름·설명·예상 시간).
 * 단계 정의(tutorials.ts)는 판정 코드가 많아 무겁기 때문에, 첫 화면처럼 목록만 필요한 곳은 이 파일만 불러온다.
 */
export interface TutorialTopic {
  id: string;
  title: string;
  /** 샌드박스 이름 등에 쓰는 짧은 이름 */
  short: string;
  description: string;
  minutes: number;
}

export const TUTORIAL_TOPICS = {
  "console-tour": {
    id: "console-tour",
    title: "화면 둘러보기",
    short: "화면 둘러보기",
    description: "콘솔 화면의 각 부분이 무엇인지 1분 안에 살펴봅니다.",
    minutes: 1,
  },
  "first-web-server": {
    id: "first-web-server",
    title: "첫 웹 서버 만들기",
    short: "첫 웹 서버",
    description: "VPC부터 EC2까지 직접 만들고 인터넷에서 접속되는지 확인합니다. 단계마다 실제 설정이 맞는지 확인해 '완료'로 표시합니다.",
    minutes: 10,
  },
  "iam-access-key": {
    id: "iam-access-key",
    title: "IAM 사용자와 가상 액세스 키 발급",
    short: "IAM 액세스 키",
    description: "그룹으로 권한을 주고, 사용자를 만든 뒤 가상 액세스 키를 발급해 봅니다. 실제 키는 만들어지지 않습니다.",
    minutes: 5,
  },
  "s3-static-site": {
    id: "s3-static-site",
    title: "S3로 정적 웹 사이트 공개하기",
    short: "S3 웹 사이트",
    description: "버킷을 만들고 index.html을 올린 뒤, 퍼블릭 액세스 차단·버킷 정책을 바꿔 웹 사이트로 공개합니다.",
    minutes: 7,
  },
  "cloudwatch-alarm": {
    id: "cloudwatch-alarm",
    title: "CloudWatch로 과부하 경보 받기",
    short: "CloudWatch 경보",
    description: "서버에 가상 부하를 주고 CPU 그래프를 본 뒤, 기준을 넘으면 알려 주는 경보를 만듭니다. 실행 중인 서버가 있어야 합니다.",
    minutes: 6,
  },
  "nat-instance": {
    id: "nat-instance",
    title: "NAT 인스턴스로 비용 줄이기",
    short: "NAT 인스턴스",
    description: "NAT 게이트웨이 대신 EC2 한 대로 프라이빗 서브넷의 외부 통신을 만듭니다. AWS 문서의 NAT 인스턴스 절차를 따라 하고 비용을 비교합니다.",
    minutes: 15,
  },
  "lambda-schedule": {
    id: "lambda-schedule",
    title: "Lambda를 일정에 따라 실행하기",
    short: "Lambda 일정",
    description: "서버 없이 코드를 실행하는 Lambda 함수를 만들고, EventBridge Scheduler 일정으로 정해진 시각마다 호출되게 합니다. 실행 역할과 지표도 확인합니다.",
    minutes: 10,
  },
} as const satisfies Record<string, TutorialTopic>;

export type TutorialTopicId = keyof typeof TUTORIAL_TOPICS;

export const TUTORIAL_TOPIC_LIST: TutorialTopic[] = Object.values(TUTORIAL_TOPICS);

export const isTutorialTopicId = (id: string): id is TutorialTopicId => id in TUTORIAL_TOPICS;
