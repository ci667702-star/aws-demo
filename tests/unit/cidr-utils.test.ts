import { describe, expect, it } from "vitest";
import {
  awsReservedIps,
  awsUsableHostCount,
  cidrContainsCidr,
  cidrContainsIp,
  cidrsOverlap,
  formatIpv4,
  isPrivateIp,
  isPublicRoutableIp,
  nextAvailableSubnet,
  parseCidr,
  parseIpv4,
  tryParseCidr,
  validateSubnetCidr,
  validateVpcCidr,
} from "@/lib/engine/cidr-utils";

const ip = (s: string) => parseIpv4(s)!;
const cidr = (s: string) => tryParseCidr(s)!;

describe("IPv4 파싱", () => {
  it("올바른 주소를 32비트 정수로 변환하고 다시 문자열로 만든다", () => {
    expect(parseIpv4("10.0.1.10")).toBe(167772426);
    expect(formatIpv4(parseIpv4("255.255.255.255")!)).toBe("255.255.255.255");
    expect(formatIpv4(parseIpv4("0.0.0.0")!)).toBe("0.0.0.0");
  });

  it.each(["256.0.0.1", "10.0.0", "10.0.0.1.2", "010.0.0.1", "a.b.c.d", " 10.0.0.1", "", "10..0.1"])(
    "잘못된 주소 %j를 거부한다",
    (value) => {
      expect(parseIpv4(value)).toBeNull();
    },
  );
});

describe("CIDR 유효성 검사", () => {
  it("정상 CIDR을 정규화한다", () => {
    const r = parseCidr("10.0.0.0/16");
    expect(r.ok && r.value.text).toBe("10.0.0.0/16");
  });

  it.each([
    ["10.0.0.0", "CIDR 형식"],
    ["10.0.0.0/33", "접두사"],
    ["10.0.0.0/-1", "접두사"],
    ["300.0.0.0/16", "IPv4"],
    ["10.0.1.5/24", "호스트 비트"],
    ["", "입력"],
  ])("잘못된 CIDR %j를 이유와 함께 거부한다", (value, reason) => {
    const r = parseCidr(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(reason);
  });

  it("호스트 비트 오류에서 올바른 네트워크 주소를 안내한다", () => {
    const r = parseCidr("10.0.1.5/24");
    expect(!r.ok && r.error).toContain("10.0.1.0/24");
  });

  it("VPC와 서브넷 CIDR은 /16~/28만 허용한다", () => {
    expect(validateVpcCidr("10.0.0.0/16").ok).toBe(true);
    expect(validateVpcCidr("10.0.0.0/8").ok).toBe(false);
    expect(validateVpcCidr("10.0.0.0/29").ok).toBe(false);
    expect(validateSubnetCidr("10.0.1.0/28").ok).toBe(true);
    expect(validateSubnetCidr("10.0.1.0/30").ok).toBe(false);
  });
});

describe("IP 범위 계산", () => {
  it("CIDR이 IP를 포함하는지 판정한다", () => {
    expect(cidrContainsIp(cidr("10.0.1.0/24"), ip("10.0.1.255"))).toBe(true);
    expect(cidrContainsIp(cidr("10.0.1.0/24"), ip("10.0.2.0"))).toBe(false);
    expect(cidrContainsIp(cidr("0.0.0.0/0"), ip("203.0.113.10"))).toBe(true);
    expect(cidrContainsIp(cidr("10.0.1.10/32"), ip("10.0.1.10"))).toBe(true);
  });

  it("서브넷 포함과 겹침을 판정한다", () => {
    expect(cidrContainsCidr(cidr("10.0.0.0/16"), cidr("10.0.1.0/24"))).toBe(true);
    expect(cidrContainsCidr(cidr("10.0.0.0/16"), cidr("10.1.1.0/24"))).toBe(false);
    expect(cidrContainsCidr(cidr("10.0.1.0/24"), cidr("10.0.0.0/16"))).toBe(false);
    expect(cidrsOverlap(cidr("10.0.0.0/23"), cidr("10.0.1.0/24"))).toBe(true);
    expect(cidrsOverlap(cidr("10.0.0.0/24"), cidr("10.0.1.0/24"))).toBe(false);
  });

  it("AWS 예약 주소 5개를 계산한다", () => {
    const reserved = awsReservedIps(cidr("10.0.1.0/24")).map(formatIpv4);
    expect(reserved).toEqual(["10.0.1.0", "10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.255"]);
    expect(awsUsableHostCount(cidr("10.0.1.0/24"))).toBe(251);
    expect(awsUsableHostCount(cidr("10.0.1.0/28"))).toBe(11);
  });

  it("사설/공인 주소를 구분한다", () => {
    expect(isPrivateIp(ip("10.1.2.3"))).toBe(true);
    expect(isPrivateIp(ip("172.31.0.1"))).toBe(true);
    expect(isPrivateIp(ip("172.32.0.1"))).toBe(false);
    expect(isPublicRoutableIp(ip("203.0.113.10"))).toBe(true);
    expect(isPublicRoutableIp(ip("192.168.0.1"))).toBe(false);
    expect(isPublicRoutableIp(ip("127.0.0.1"))).toBe(false);
  });

  it("VPC 안에서 겹치지 않는 다음 서브넷을 찾는다", () => {
    const next = nextAvailableSubnet(cidr("10.0.0.0/16"), [cidr("10.0.0.0/24"), cidr("10.0.1.0/24")]);
    expect(next?.text).toBe("10.0.2.0/24");
    expect(nextAvailableSubnet(cidr("10.0.0.0/28"), [cidr("10.0.0.0/28")])).toBeNull();
  });
});
