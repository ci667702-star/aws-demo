import { beforeEach, describe, expect, it } from "vitest";
import { GLOSSARY, glossaryMeaning, splitGlossary } from "@/lib/docs/glossary";
import { buildTopology } from "@/lib/engine/topology-engine";
import { createEmptyProject } from "@/lib/project/factory";
import { firstWebServerSteps, nextFirstStep } from "@/lib/project/first-steps";
import { TUTORIAL_TOPIC_LIST } from "@/components/console/tutorial/tutorial-topics";
import { TUTORIALS } from "@/components/console/tutorial/tutorials";
import { publicWebProject, useDeterministicIds } from "../helpers";

beforeEach(useDeterministicIds);

const terms = (text: string, limit?: number) => splitGlossary(text, limit).flatMap((p) => (typeof p === "string" ? [] : [p.text]));

describe("용어 풀이", () => {
  it("긴 용어를 먼저 찾고, 같은 용어는 처음 한 번만, 최대 개수까지만 표시한다", () => {
    expect(terms("퍼블릭 서브넷의 서버와 프라이빗 서브넷의 DB")).toEqual(["퍼블릭 서브넷", "프라이빗 서브넷"]);
    expect(terms("서브넷을 만들고 다른 서브넷도 만듭니다")).toEqual(["서브넷"]);
    expect(terms("VPC, 서브넷, 보안 그룹, EC2", 2)).toEqual(["VPC", "서브넷"]);
    expect(terms("0.0.0.0/0 → 인터넷 게이트웨이 경로")).toEqual(["0.0.0.0/0", "인터넷 게이트웨이"]);
  });

  it("영문 용어는 단어 중간에서 찾지 않고, 나눈 조각을 이으면 원래 글이 된다", () => {
    expect(terms("IAMReadOnlyAccess와 MyVPC")).toEqual([]);
    expect(terms("EC2에 IAM 역할을 연결")).toEqual(["EC2", "IAM 역할"]);
    const text = "라우팅 테이블에 0.0.0.0/0 경로가 있어야 퍼블릭 서브넷이 됩니다.";
    expect(splitGlossary(text).map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe(text);
  });

  it("모든 풀이는 한두 문장이고, 메뉴 이름으로도 찾을 수 있다", () => {
    for (const e of GLOSSARY) {
      expect(e.meaning.length, e.term).toBeGreaterThan(8);
      expect(e.meaning.length, e.term).toBeLessThan(110);
    }
    expect(glossaryMeaning("라우팅 테이블")).toMatch(/길 안내표/);
    expect(glossaryMeaning("없는 메뉴")).toBeNull();
  });
});

describe("다음 할 일 (첫 웹 서버까지)", () => {
  it("빈 샌드박스는 VPC부터, 웹 서버까지 만든 샌드박스는 통신 확인이 다음 할 일이다", () => {
    const empty = createEmptyProject("빈");
    const steps = firstWebServerSteps(empty, buildTopology(empty));
    expect(steps.map((s) => s.id)).toEqual(["vpc", "subnet", "igw", "route", "sg", "ec2", "verify"]);
    expect(nextFirstStep(steps)?.id).toBe("vpc");

    const web = publicWebProject();
    const done = firstWebServerSteps(web, buildTopology(web));
    expect(done.filter((s) => s.done).map((s) => s.id)).toEqual(["vpc", "subnet", "igw", "route", "sg", "ec2"]);
    expect(nextFirstStep(done)?.id).toBe("verify");
  });

  it("인터넷 경로가 없으면 라우팅 단계가 남는다 (실제 설정으로 판정)", () => {
    const p = publicWebProject({ route: false });
    expect(nextFirstStep(firstWebServerSteps(p, buildTopology(p)))?.id).toBe("route");
  });
});

describe("따라하기 주제 목록", () => {
  it("첫 화면의 주제 목록과 실제 따라하기 정의가 같다", () => {
    expect(TUTORIAL_TOPIC_LIST.map((t) => t.id)).toEqual(TUTORIALS.map((t) => t.id));
    for (const t of TUTORIALS) expect(TUTORIAL_TOPIC_LIST.find((x) => x.id === t.id)).toMatchObject({ title: t.title, minutes: t.minutes });
    for (const t of TUTORIAL_TOPIC_LIST) expect(`${t.short} 따라하기`.length, t.id).toBeLessThanOrEqual(20);
  });
});
