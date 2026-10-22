/**
 * IPv4 / CIDR 계산 유틸리티.
 * 모든 주소는 내부적으로 부호 없는 32비트 정수(number)로 다룬다.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Cidr {
  /** 네트워크 주소 (uint32) */
  network: number;
  /** 접두사 길이 (0~32) */
  prefix: number;
  /** 정규화된 표기 (예: 10.0.0.0/16) */
  text: string;
}

const OCTET = /^(0|[1-9]\d{0,2})$/;

/** 엄격한 IPv4 파서. 앞자리 0(예: 010)이나 공백은 허용하지 않는다. */
export function parseIpv4(input: string): number | null {
  if (typeof input !== "string") return null;
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function formatIpv4(value: number): string {
  const v = value >>> 0;
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

export function isValidIpv4(input: string): boolean {
  return parseIpv4(input) !== null;
}

/** 접두사 길이에 해당하는 넷마스크 (uint32). */
export function prefixMask(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function parseCidr(input: string): ParseResult<Cidr> {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { ok: false, error: "CIDR 블록을 입력하세요. 예: 10.0.0.0/16" };
  const slash = text.indexOf("/");
  if (slash < 0 || text.indexOf("/", slash + 1) >= 0) {
    return { ok: false, error: `CIDR 형식이 아닙니다: "${text}". 예: 10.0.0.0/16` };
  }
  const ipPart = text.slice(0, slash);
  const prefixPart = text.slice(slash + 1);
  const ip = parseIpv4(ipPart);
  if (ip === null) {
    return { ok: false, error: `IPv4 주소 부분이 올바르지 않습니다: "${ipPart}"` };
  }
  if (!/^(\d|[12]\d|3[0-2])$/.test(prefixPart)) {
    return { ok: false, error: `접두사 길이는 0~32 사이의 정수여야 합니다: "/${prefixPart}"` };
  }
  const prefix = Number(prefixPart);
  const network = (ip & prefixMask(prefix)) >>> 0;
  if (network !== ip) {
    return {
      ok: false,
      error: `호스트 비트가 0이 아닙니다. 이 범위의 네트워크 주소는 ${formatIpv4(network)}/${prefix} 입니다.`,
    };
  }
  return { ok: true, value: { network, prefix, text: `${formatIpv4(network)}/${prefix}` } };
}

/** 파싱에 실패하면 null을 반환하는 간편 버전. */
export function tryParseCidr(input: string): Cidr | null {
  const r = parseCidr(input);
  return r.ok ? r.value : null;
}

export function cidrSize(cidr: Cidr): number {
  return 2 ** (32 - cidr.prefix);
}

export function cidrFirst(cidr: Cidr): number {
  return cidr.network >>> 0;
}

export function cidrLast(cidr: Cidr): number {
  return (cidr.network + cidrSize(cidr) - 1) >>> 0;
}

export function cidrContainsIp(cidr: Cidr, ip: number): boolean {
  return ((ip & prefixMask(cidr.prefix)) >>> 0) === cidr.network;
}

export function cidrContainsCidr(outer: Cidr, inner: Cidr): boolean {
  return inner.prefix >= outer.prefix && cidrContainsIp(outer, inner.network);
}

export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  return cidrContainsCidr(a, b) || cidrContainsCidr(b, a);
}

/**
 * AWS는 각 서브넷에서 처음 4개와 마지막 1개의 주소를 예약한다.
 * (네트워크 주소, VPC 라우터, DNS, 향후 사용 예약, 브로드캐스트)
 */
export function awsReservedIps(cidr: Cidr): number[] {
  const first = cidrFirst(cidr);
  const last = cidrLast(cidr);
  const size = cidrSize(cidr);
  if (size <= 5) {
    const all: number[] = [];
    for (let i = 0; i < size; i++) all.push((first + i) >>> 0);
    return all;
  }
  return [first, first + 1, first + 2, first + 3, last].map((n) => n >>> 0);
}

export function awsReservedReason(cidr: Cidr, ip: number): string | null {
  const offset = ip - cidr.network;
  if (!cidrContainsIp(cidr, ip)) return null;
  if (offset === 0) return "네트워크 주소";
  if (offset === 1) return "VPC 라우터용 예약 주소";
  if (offset === 2) return "Amazon 제공 DNS용 예약 주소";
  if (offset === 3) return "향후 사용을 위한 예약 주소";
  if (ip === cidrLast(cidr)) return "브로드캐스트 주소(예약)";
  return null;
}

export function isAwsReservedIp(cidr: Cidr, ip: number): boolean {
  return awsReservedIps(cidr).includes(ip >>> 0);
}

/** AWS 기준 사용 가능한 호스트 수 (예약 5개 제외). */
export function awsUsableHostCount(cidr: Cidr): number {
  return Math.max(0, cidrSize(cidr) - 5);
}

export function ipAtOffset(cidr: Cidr, offset: number): number {
  return (cidr.network + offset) >>> 0;
}

const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((c) => tryParseCidr(c)!);

const NON_PUBLIC = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((c) => tryParseCidr(c)!);

/** RFC 1918 사설 주소인지 여부. */
export function isPrivateIp(ip: number): boolean {
  return RFC1918.some((c) => cidrContainsIp(c, ip));
}

export function isRfc1918Cidr(cidr: Cidr): boolean {
  return RFC1918.some((c) => cidrContainsCidr(c, cidr));
}

/**
 * 가상 인터넷에서 라우팅 가능한 공인 주소인지 여부.
 * 시뮬레이터에서는 문서화용 대역(TEST-NET)도 공인 주소로 취급한다.
 */
export function isPublicRoutableIp(ip: number): boolean {
  return !NON_PUBLIC.some((c) => cidrContainsIp(c, ip));
}

export const VPC_PREFIX_MIN = 16;
export const VPC_PREFIX_MAX = 28;

/** VPC CIDR 검증: 형식 + AWS 허용 범위(/16~/28). */
export function validateVpcCidr(input: string): ParseResult<Cidr> {
  const r = parseCidr(input);
  if (!r.ok) return r;
  if (r.value.prefix < VPC_PREFIX_MIN || r.value.prefix > VPC_PREFIX_MAX) {
    return {
      ok: false,
      error: `AWS VPC의 IPv4 CIDR 블록은 /${VPC_PREFIX_MIN} ~ /${VPC_PREFIX_MAX} 범위여야 합니다. (입력: /${r.value.prefix})`,
    };
  }
  return r;
}

/** 서브넷 CIDR 검증: 형식 + AWS 허용 범위(/16~/28). */
export function validateSubnetCidr(input: string): ParseResult<Cidr> {
  const r = parseCidr(input);
  if (!r.ok) return r;
  if (r.value.prefix < VPC_PREFIX_MIN || r.value.prefix > VPC_PREFIX_MAX) {
    return {
      ok: false,
      error: `AWS 서브넷의 IPv4 CIDR 블록은 /${VPC_PREFIX_MIN} ~ /${VPC_PREFIX_MAX} 범위여야 합니다. (입력: /${r.value.prefix})`,
    };
  }
  return r;
}

/** VPC 범위 안에서 기존 블록과 겹치지 않는 다음 서브넷 CIDR을 찾는다. */
export function nextAvailableSubnet(vpc: Cidr, existing: Cidr[], prefix = 24): Cidr | null {
  const p = Math.max(prefix, vpc.prefix);
  const step = 2 ** (32 - p);
  const total = cidrSize(vpc) / step;
  for (let i = 0; i < total; i++) {
    const network = (vpc.network + i * step) >>> 0;
    const candidate: Cidr = { network, prefix: p, text: `${formatIpv4(network)}/${p}` };
    if (!existing.some((e) => cidrsOverlap(e, candidate))) return candidate;
  }
  return null;
}

/** 서로 겹치지 않는 다음 VPC용 /16 블록을 10.x.0.0/16 대역에서 찾는다. */
export function nextAvailableVpcCidr(existing: Cidr[]): Cidr {
  for (let i = 0; i < 256; i++) {
    const c = tryParseCidr(`10.${i}.0.0/16`)!;
    if (!existing.some((e) => cidrsOverlap(e, c))) return c;
  }
  return tryParseCidr("10.0.0.0/16")!;
}

/** 포트 범위 표기 (예: 80, 1024-65535, 전체). */
export function formatPortRange(from: number, to: number): string {
  if (from === 0 && to === 65535) return "전체";
  return from === to ? String(from) : `${from}-${to}`;
}
