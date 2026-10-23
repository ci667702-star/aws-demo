/**
 * AWS 스타일 오류 코드의 쉬운 설명.
 * 콘솔 동작이 돌려주는 오류 메시지는 "[코드] 내용" 형식이다.
 */
export const ERROR_EXPLANATIONS: Record<string, string> = {
  InvalidParameterValue: "입력한 값의 형식이나 범위가 올바르지 않다는 뜻입니다. 입력값을 다시 확인하세요.",
  InvalidParameterCombination: "각각은 맞지만 함께 쓸 수 없는 설정을 골랐다는 뜻입니다.",
  InvalidParameter: "선택한 값끼리 맞지 않습니다. 대부분 서로 다른 VPC의 리소스를 함께 고른 경우입니다.",
  MissingParameter: "꼭 필요한 항목이 비어 있습니다.",
  "InvalidVpc.Range": "VPC CIDR 크기가 허용 범위(/16 ~ /28)를 벗어났습니다.",
  "InvalidSubnet.Range": "서브넷 CIDR이 VPC 범위 밖이거나 크기가 허용 범위를 벗어났습니다.",
  "InvalidSubnet.Conflict": "같은 VPC의 다른 서브넷과 주소 범위가 겹칩니다. 겹치지 않는 범위를 고르세요.",
  DependencyViolation: "다른 리소스가 아직 이 리소스를 사용하고 있어서 삭제하거나 분리할 수 없습니다. 의존하는 리소스를 먼저 정리하세요.",
  "Resource.AlreadyAssociated": "이미 다른 곳에 연결되어 있습니다. 하나만 연결할 수 있는 리소스입니다.",
  "Gateway.NotAttached": "VPC에 인터넷 게이트웨이가 연결되어 있지 않습니다. 인터넷이 필요한 작업은 IGW 연결이 먼저입니다.",
  RouteAlreadyExists: "같은 목적지에 대한 경로가 이미 있습니다. 목적지 하나에는 경로 하나만 둘 수 있습니다.",
  "InvalidPermission.Duplicate": "똑같은 규칙이 이미 있습니다.",
  "InvalidGroup.Duplicate": "같은 VPC에 같은 이름의 보안 그룹이 있습니다.",
  "InvalidGroup.NotFound": "보안 그룹을 찾을 수 없거나 다른 VPC에 있습니다.",
  CannotDelete: "AWS가 자동으로 만든 기본 리소스라 삭제할 수 없습니다.",
  NetworkAclEntryAlreadyExists: "같은 규칙 번호가 이미 있습니다. 규칙 번호는 겹치면 안 됩니다.",
  IncorrectInstanceState: "지금 상태(예: 실행 중, 종료됨)에서는 이 작업을 할 수 없습니다.",
  "InvalidIPAddress.InUse": "그 주소는 이미 다른 리소스가 쓰고 있습니다.",
  InsufficientFreeAddressesInSubnet: "서브넷에 남은 IP 주소가 없습니다. 더 큰 서브넷을 쓰세요.",
  SecurityGroupsPerInstanceLimitExceeded: "보안 그룹을 너무 많이 골랐습니다 (최대 5개).",
  AddressLimitExceeded: "더 이상 할당할 수 있는 가상 퍼블릭 주소가 없습니다.",
  "InvalidAssociationID.NotFound": "연결되어 있지 않은 상태라 해제할 것이 없습니다.",
  ValidationError: "입력값이 규칙에 맞지 않습니다 (이름 형식, 포트 범위 등).",
  DuplicateTargetGroupName: "같은 이름의 대상 그룹이 이미 있습니다.",
  DuplicateLoadBalancerName: "같은 이름의 로드 밸런서가 이미 있습니다.",
  DuplicateListener: "같은 포트의 리스너가 이미 있습니다.",
  TargetGroupAssociationLimit: "이 대상 그룹은 이미 다른 로드 밸런서에서 쓰고 있습니다.",
  InvalidTarget: "등록할 수 없는 대상입니다 (종료됨 또는 다른 VPC).",
  ResourceInUse: "로드 밸런서 리스너 등에서 사용 중이라 삭제할 수 없습니다.",
  InvalidConfigurationRequest: "설정 조합이 올바르지 않습니다.",
  InvalidSubnet: "선택한 서브넷이 이 작업에 맞지 않습니다.",
  InvalidSecurityGroup: "선택한 보안 그룹을 쓸 수 없습니다.",
  DBSubnetGroupDoesNotCoverEnoughAZs: "DB 서브넷 그룹에는 서로 다른 가용 영역의 서브넷이 2개 이상 필요합니다.",
  DBSubnetGroupAlreadyExists: "같은 이름의 DB 서브넷 그룹이 있습니다.",
  InvalidDBSubnetGroupStateFault: "DB가 이 서브넷 그룹을 쓰고 있어서 바꾸거나 삭제할 수 없습니다.",
  InvalidVPCNetworkStateFault: "VPC 설정(DNS 등)이 이 작업을 허용하지 않습니다.",
  InvalidDBInstanceState: "DB가 지금 상태에서는 이 작업을 할 수 없습니다.",
  DBInstanceAlreadyExists: "같은 식별자의 DB가 있습니다.",
  DefaultVpcAlreadyExists: "기본 VPC는 리전마다 하나만 있을 수 있습니다.",
  AccessDenied: "권한 설정 때문에 거부되었습니다.",
  BucketAlreadyExists: "같은 이름의 버킷이 이미 있습니다. 버킷 이름은 모두 달라야 합니다.",
  BucketNotEmpty: "버킷 안에 객체가 남아 있어 삭제할 수 없습니다. 먼저 비우세요.",
  InvalidBucketName: "버킷 이름 규칙(소문자·숫자·하이픈, 3~63자 등)에 맞지 않습니다.",
  MalformedPolicy: "정책 JSON의 형식이나 내용이 올바르지 않습니다.",
  MalformedPolicyDocument: "IAM 정책 JSON의 형식이나 내용이 올바르지 않습니다. 편집기 아래의 검사 결과를 확인하세요.",
  NoSuchBucket: "해당 버킷이 없습니다. 이미 삭제되었을 수 있습니다.",
  BucketAlreadyOwnedByYou: "이 계정에 같은 이름의 버킷이 이미 있습니다.",
  TooManyBuckets: "만들 수 있는 버킷 수를 넘었습니다.",
  TooManyObjects: "이 시뮬레이터에서 버킷에 저장할 수 있는 객체 수를 넘었습니다.",
  IllegalVersioningConfigurationException: "버전 관리 상태를 그렇게 바꿀 수 없습니다. 한 번 켠 버전 관리는 끌 수 없고 일시 중지만 할 수 있습니다.",
  InvalidArgument: "입력한 값(이름, 문서 경로 등)이 올바르지 않습니다.",
  NoSuchVersion: "해당 버전이 없습니다. 이미 삭제되었을 수 있습니다.",
  NoSuchKey: "버킷에 해당 키(경로)의 객체가 없습니다.",
  InvalidRequest: "지금 설정에서는 이 요청을 처리할 수 없습니다.",
  EntityTooLarge: "올린 파일이 허용 크기보다 큽니다.",
  ResourceNotFound: "해당 리소스를 찾을 수 없습니다.",
  EntityAlreadyExists: "같은 이름의 IAM 항목이 이미 있습니다.",
  LimitExceeded: "만들 수 있는 개수를 넘었습니다.",
  DeleteConflict: "다른 항목이 아직 연결되어 있어 삭제할 수 없습니다.",
  NoSuchEntity: "해당 IAM 항목을 찾을 수 없습니다.",
};

/** "[코드] 내용" 형식에서 코드를 꺼낸다 */
export function errorCode(message: string): string | null {
  return /^\[([^\]]+)\]/.exec(message)?.[1] ?? null;
}

export function explainError(message: string): string | null {
  const code = errorCode(message);
  if (!code) return null;
  return ERROR_EXPLANATIONS[code] ?? (code.endsWith(".NotFound") || code.endsWith("NotFound") ? "해당 리소스를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다." : null);
}

/** 콘솔 동작 결과의 오류와 해결 방법을 한 문자열로 */
export function withHint(result: { error: string; hint?: string }): string {
  return result.hint ? `${result.error}\n→ 해결 방법: ${result.hint}` : result.error;
}
