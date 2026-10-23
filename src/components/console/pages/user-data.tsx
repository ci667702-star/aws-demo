"use client";

/** 사용자 데이터(가상 애플리케이션) 입력 — 인스턴스 시작 마법사와 사용자 데이터 편집에서 공용 */
import { useState } from "react";
import type { ConfigOf } from "@/lib/engine/resource-models";
import { userDataFor, type UserDataTemplate } from "@/lib/project/console-actions";
import { FormField, RadioGroup, TextArea, TextInput } from "../ui/form";
import { InfoLink } from "../ui/links";

type Ami = ConfigOf<"ec2">["ami"];

export interface UserDataDraft {
  template: UserDataTemplate;
  ports: string;
  responseCode: string;
  script: string;
  setTemplate: (t: UserDataTemplate, ami: Ami) => void;
  setPorts: (v: string) => void;
  setResponseCode: (v: string) => void;
  setScript: (v: string) => void;
  toValue: (ami?: Ami) => { ok: true; value: { listenPorts: number[]; httpResponseCode: number; userData: string } } | { ok: false; error: string };
}

function inferTemplate(ami: Ami, value: { listenPorts: number[]; userData: string }): UserDataTemplate {
  const web = userDataFor(ami, "web-server");
  const none = userDataFor(ami, "none");
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(value.listenPorts, web.listenPorts) && value.userData === web.script) return "web-server";
  if (same(value.listenPorts, none.listenPorts) && !value.userData) return "none";
  return "custom";
}

export function useUserDataDraft(ami: Ami, initial?: { listenPorts: number[]; httpResponseCode: number; userData: string }): UserDataDraft {
  const [template, setTemplateState] = useState<UserDataTemplate>(() => (initial ? inferTemplate(ami, initial) : "none"));
  const [ports, setPorts] = useState(() => (initial ? initial.listenPorts.join(", ") : userDataFor(ami, "none").listenPorts.join(", ")));
  const [responseCode, setResponseCode] = useState(() => String(initial?.httpResponseCode ?? 200));
  const [script, setScript] = useState(() => initial?.userData ?? "");
  return {
    template,
    ports,
    responseCode,
    script,
    setTemplate: (t, currentAmi) => {
      setTemplateState(t);
      if (t !== "custom") {
        const preset = userDataFor(currentAmi, t);
        setPorts(preset.listenPorts.join(", "));
        setScript(preset.script);
      }
    },
    setPorts,
    setResponseCode,
    setScript,
    toValue: (currentAmi = ami) => {
      const preset = template === "custom" ? null : userDataFor(currentAmi, template);
      let listenPorts: number[];
      if (preset) listenPorts = preset.listenPorts;
      else {
        const parts = ports.split(/[,\s]+/).filter(Boolean);
        if (parts.some((p) => !/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535)) {
          return { ok: false, error: "가상 서비스 포트는 1~65535 사이의 숫자를 쉼표로 구분해 입력하세요 (예: 22, 8080)." };
        }
        listenPorts = [...new Set(parts.map(Number))].sort((a, b) => a - b);
      }
      const code = Number(responseCode);
      if (!/^\d{3}$/.test(responseCode.trim()) || code < 100 || code > 599) return { ok: false, error: "가상 HTTP 응답 코드는 100~599 사이여야 합니다." };
      return { ok: true, value: { listenPorts, httpResponseCode: code, userData: preset ? preset.script : script } };
    },
  };
}

export function UserDataFields({ ami, draft, disabled }: { ami: Ami; draft: UserDataDraft; disabled?: boolean }) {
  const web = userDataFor(ami, "web-server");
  const base = userDataFor(ami, "none");
  return (
    <div className="space-y-4">
      <FormField label="사용자 데이터 템플릿" info={<InfoLink topic="user-data" />} description="실제 스크립트는 실행되지 않습니다. 선택에 따라 인스턴스가 응답할 가상 서비스 포트가 정해집니다.">
        <RadioGroup
          aria-label="사용자 데이터 템플릿"
          value={draft.template}
          onChange={(v) => !disabled && draft.setTemplate(v as UserDataTemplate, ami)}
          items={[
            { value: "none", label: "없음", description: `AMI 기본 서비스만 응답 (포트 ${base.listenPorts.join(", ")})`, disabled },
            { value: "web-server", label: "웹 서버 설치", description: `웹 서버를 설치하는 스크립트 — 포트 ${web.listenPorts.join(", ")} 응답`, disabled },
            { value: "custom", label: "사용자 지정", description: "가상 서비스 포트를 직접 지정", disabled },
          ]}
        />
      </FormField>
      {draft.template === "custom" && (
        <FormField label="가상 서비스 포트" constraint="쉼표로 구분 (예: 22, 8080)">
          <TextInput value={draft.ports} onChange={(e) => draft.setPorts(e.target.value)} disabled={disabled} placeholder="22, 8080" />
        </FormField>
      )}
      <FormField label="가상 HTTP 응답 코드" description="HTTP 요청과 로드 밸런서 헬스 체크에 이 코드로 응답합니다. 500 등으로 바꿔 헬스 체크 실패를 실험할 수 있습니다." constraint="100~599">
        <TextInput value={draft.responseCode} onChange={(e) => draft.setResponseCode(e.target.value)} disabled={disabled} inputMode="numeric" className="max-w-32" />
      </FormField>
      <FormField label="사용자 데이터" description={draft.template === "custom" ? "참고용 스크립트 (실행되지 않음)" : "템플릿이 만든 스크립트 (실행되지 않음)"}>
        <TextArea value={draft.template === "custom" ? draft.script : draft.template === "web-server" ? web.script : ""} onChange={(e) => draft.setScript(e.target.value)} disabled={disabled || draft.template !== "custom"} rows={5} />
      </FormField>
    </div>
  );
}
