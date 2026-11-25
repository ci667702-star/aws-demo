"use client";

import { useEffect, useRef } from "react";
import { alarmHistory, type AlarmState } from "@/lib/engine/cloudwatch-engine";
import { useProject } from "../../console-context";
import { notify } from "../../notify";
import { conditionText, useMetricModel, useNow } from "./cw-shared";

/**
 * 콘솔이 열려 있는 동안 경보 상태 변화를 지켜보다가 가상 알림(토스트)을 띄운다.
 * 실제 AWS의 SNS 알림(이메일·문자)을 흉내 낸 것으로, 아무것도 외부로 보내지 않는다.
 * 콘솔 셸이 항상 띄우므로 CloudWatch 화면 코드와 따로 둔다 (첫 화면에서 CloudWatch 화면까지 불러오지 않게).
 */
export function AlarmWatcher() {
  const project = useProject();
  const model = useMetricModel();
  const now = useNow();
  const previous = useRef<Map<string, AlarmState> | null>(null);
  useEffect(() => {
    const alarms = project.services.cloudwatch.alarms;
    const next = new Map(alarms.map((a) => [a.id, alarmHistory(model, a, now, 30).current.state]));
    const before = previous.current;
    previous.current = next;
    if (!before) return;
    for (const a of alarms) {
      if (!a.notify) continue;
      const was = before.get(a.id);
      const is = next.get(a.id);
      if (!is || was === is) continue;
      if (is === "ALARM") {
        notify({ type: "warning", title: `경보 ${a.name}이(가) 경보 상태(ALARM)가 되었습니다`, description: conditionText(a), action: { label: "경보 보기", href: `#/cloudwatch/alarms/${a.id}` } });
      } else if (is === "OK" && was === "ALARM") {
        notify({ type: "success", title: `경보 ${a.name}이(가) 정상(OK)으로 돌아왔습니다`, action: { label: "경보 보기", href: `#/cloudwatch/alarms/${a.id}` } });
      }
    }
  }, [project, model, now]);
  return null;
}
