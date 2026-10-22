/**
 * 가상 리소스 ID 생성기.
 * AWS 형식(예: vpc-0a1b2c3d)을 흉내 내지만 실제 AWS ID가 아니다.
 * 테스트에서는 setIdGenerator로 결정적인 생성기를 주입할 수 있다.
 */

export type IdGenerator = (prefix: string) => string;

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

const randomGenerator: IdGenerator = (prefix) => `${prefix}-${randomHex(8)}`;

let current: IdGenerator = randomGenerator;

export function createId(prefix: string): string {
  return current(prefix);
}

export function setIdGenerator(generator: IdGenerator | null): void {
  current = generator ?? randomGenerator;
}

/** 접두사별 일련번호를 붙이는 결정적 생성기 (테스트/샘플용). */
export function sequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  };
}

/** 문자열의 결정적 32비트 해시 (FNV-1a). 가상 IP 배정 등에 사용한다. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
