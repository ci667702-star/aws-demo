/**
 * 리소스별 AWS 공식 문서 링크.
 * 설명과 도움말은 이 시뮬레이터의 내부 데이터로 제공하고, 이 링크는 더 공부하고 싶을 때 여는 참고 자료다.
 * 화면이 문서를 불러오지는 않는다 (누르면 새 창으로 열린다). 제목은 해당 문서의 한국어 제목이다.
 */
import type { DocKey } from "./types";

export interface AwsDocLink {
  title: string;
  url: string;
}

const doc = (title: string, path: string): AwsDocLink => ({ title, url: `https://docs.aws.amazon.com/ko_kr/${path}` });

const NAT_COMPARISON = doc("NAT 게이트웨이 및 NAT 인스턴스 비교", "vpc/latest/userguide/vpc-nat-comparison.html");
const NAT_INSTANCE_SETUP = doc("프라이빗 리소스가 VPC 외부에서 통신할 수 있도록 지원 (NAT 인스턴스 구성)", "vpc/latest/userguide/work-with-nat-instances.html");
const VPC_SECURITY = doc("Amazon VPC의 인프라 보안", "vpc/latest/userguide/infrastructure-security.html");
const RDS_IN_VPC = doc("VPC에서 DB 인스턴스를 사용한 작업", "AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html");

export const AWS_DOC_LINKS: Record<DocKey, AwsDocLink[]> = {
  vpc: [
    doc("Amazon VPC란 무엇인가?", "vpc/latest/userguide/what-is-amazon-vpc.html"),
    doc("가상 프라이빗 클라우드 구성", "vpc/latest/userguide/configure-your-vpc.html"),
    doc("VPC CIDR 블록", "vpc/latest/userguide/vpc-cidr-blocks.html"),
  ],
  subnet: [doc("VPC의 서브넷", "vpc/latest/userguide/configure-subnets.html"), doc("서브넷 CIDR 블록", "vpc/latest/userguide/subnet-sizing.html")],
  "internet-gateway": [doc("인터넷 게이트웨이를 사용하여 VPC에 대한 인터넷 액세스 활성화", "vpc/latest/userguide/VPC_Internet_Gateway.html")],
  "elastic-ip": [doc("탄력적 IP 주소를 VPC의 리소스와 연결", "vpc/latest/userguide/vpc-eips.html"), doc("탄력적 IP 주소 (EC2)", "AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html")],
  "route-table": [doc("라우팅 테이블 구성", "vpc/latest/userguide/VPC_Route_Tables.html")],
  "nat-gateway": [doc("NAT 게이트웨이", "vpc/latest/userguide/vpc-nat-gateway.html"), NAT_COMPARISON, doc("NAT 인스턴스", "vpc/latest/userguide/VPC_NAT_Instance.html")],
  "security-group": [doc("보안 그룹을 사용하여 AWS 리소스에 대한 트래픽 제어", "vpc/latest/userguide/vpc-security-groups.html"), VPC_SECURITY],
  "network-acl": [doc("네트워크 액세스 제어 목록으로 서브넷 트래픽 제어", "vpc/latest/userguide/vpc-network-acls.html"), VPC_SECURITY],
  ec2: [
    doc("Amazon EC2란 무엇인가요?", "AWSEC2/latest/UserGuide/concepts.html"),
    doc("Amazon EC2 인스턴스 상태 변경", "AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html"),
    doc("사용자 데이터 입력을 사용하여 EC2 인스턴스를 시작할 때 명령 실행", "AWSEC2/latest/UserGuide/user-data.html"),
    doc("Amazon EC2의 IAM 역할", "AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html"),
    NAT_INSTANCE_SETUP,
  ],
  alb: [
    doc("Application Load Balancer란 무엇입니까?", "elasticloadbalancing/latest/application/introduction.html"),
    doc("Application Load Balancer를 위한 리스너", "elasticloadbalancing/latest/application/load-balancer-listeners.html"),
  ],
  "target-group": [
    doc("Application Load Balancer 대상 그룹", "elasticloadbalancing/latest/application/load-balancer-target-groups.html"),
    doc("Application Load Balancer 대상 그룹의 상태 확인", "elasticloadbalancing/latest/application/target-group-health-checks.html"),
  ],
  "db-subnet-group": [RDS_IN_VPC],
  rds: [
    doc("Amazon Relational Database Service(Amazon RDS)란 무엇입니까?", "AmazonRDS/latest/UserGuide/Welcome.html"),
    doc("Amazon RDS에 대한 다중 AZ 배포 구성 및 관리", "AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html"),
    RDS_IN_VPC,
  ],
  s3: [
    doc("Amazon S3란 무엇인가요?", "AmazonS3/latest/userguide/Welcome.html"),
    doc("Amazon S3 스토리지에 대한 퍼블릭 액세스 차단", "AmazonS3/latest/userguide/access-control-block-public-access.html"),
    doc("Amazon S3를 사용하여 정적 웹 사이트 호스팅", "AmazonS3/latest/userguide/WebsiteHosting.html"),
    doc("S3 버전 관리로 여러 버전의 객체 유지", "AmazonS3/latest/userguide/Versioning.html"),
  ],
  iam: [
    doc("IAM이란 무엇입니까?", "IAM/latest/UserGuide/introduction.html"),
    doc("IAM의 보안 모범 사례", "IAM/latest/UserGuide/best-practices.html"),
    doc("정책 평가 로직", "IAM/latest/UserGuide/reference_policies_evaluation-logic.html"),
    doc("사용자에서 IAM 역할로 전환(콘솔)", "IAM/latest/UserGuide/id_roles_use_switch-role-console.html"),
  ],
  cloudwatch: [
    doc("Amazon CloudWatch란 무엇인가요?", "AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html"),
    doc("Amazon CloudWatch의 지표", "AmazonCloudWatch/latest/monitoring/working_with_metrics.html"),
    doc("Amazon CloudWatch 경보 사용", "AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html"),
  ],
};

/** NAT 인스턴스 도움말에서 쓰는 문서 */
export const NAT_INSTANCE_DOC_LINKS: AwsDocLink[] = [NAT_INSTANCE_SETUP, NAT_COMPARISON];
