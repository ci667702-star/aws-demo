"use client";

import { CircleCheck, Circle, X } from "lucide-react";
import { cn } from "cn";
import { useMemo } from "react";
import { simulateWithTopology } from "@/lib/engine/connectivity-engine";
import { evaluateLab, labById, LABS, type LabContext } from "@/lib/labs/labs";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import { HELP_TOPICS } from "../help-topics";
import { href } from "../router";
import { Button } from "../ui/button";
import { ExpandableSection } from "../ui/layout";
import { Badge } from "../ui/status";

export function ToolsPanel({ onClose }: { onClose: () => void }) {
  const tab = useConsoleUi((s) => s.toolsTab);
  const setTab = useConsoleUi((s) => s.setToolsTab);
  return (
    <aside className="flex h-full flex-col bg-aws-surface" aria-label="도움말 및 실습">
      <div className="flex items-center justify-between gap-2 border-b border-aws-divider px-4 py-2">
        <div role="tablist" aria-label="패널 종류" className="flex gap-1">
          {(
            [
              ["help", "도움말"],
              ["labs", "실습 가이드"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("rounded-full px-3 py-1 text-sm font-bold", tab === id ? "bg-aws-info-bg text-aws-link" : "text-aws-text-2 hover:text-aws-link")}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-aws-text-2 hover:text-aws-text" aria-label="패널 닫기">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{tab === "help" ? <HelpContent /> : <LabGuide />}</div>
    </aside>
  );
}

function HelpContent() {
  const topicId = useConsoleUi((s) => s.helpTopic) ?? "console";
  const openHelp = useConsoleUi((s) => s.openHelp);
  const topic = HELP_TOPICS[topicId] ?? HELP_TOPICS.console;
  const fallback = ["vpc", "subnet", "route-table", "igw", "nat", "security-group", "nacl", "ec2-launch", "alb", "s3", "iam", "cloudwatch", "reachability"];
  const related = (topic.related ?? fallback).filter((t) => t !== topicId && HELP_TOPICS[t]);
  const others = fallback.filter((t) => t !== topicId && !related.includes(t));
  return (
    <article className="space-y-5 text-[15px] leading-relaxed" data-testid="help-content">
      <div className="space-y-2">
        <h2 className="text-xl font-bold text-aws-text">{topic.title}</h2>
        <p className="rounded-xl bg-aws-info-bg px-4 py-3 font-bold text-aws-text">{topic.summary}</p>
      </div>
      {topic.analogy && (
        <section className="rounded-xl border border-aws-border px-4 py-3">
          <h3 className="mb-1 text-sm font-bold text-aws-warning">💡 비유로 이해하기</h3>
          <p className="text-aws-text">{topic.analogy}</p>
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-aws-text-2">자세히</h3>
        {topic.paragraphs.map((p, i) => (
          <p key={i} className="text-aws-text">
            {p}
          </p>
        ))}
      </section>
      {topic.steps && (
        <section>
          <h3 className="mb-1 text-sm font-bold text-aws-text-2">이 시뮬레이터에서 해 보기</h3>
          <ol className="list-decimal space-y-1 pl-6 text-aws-text">
            {topic.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      )}
      {topic.mistakes && (
        <section className="rounded-xl border border-aws-warning/40 bg-aws-warning-bg px-4 py-3">
          <h3 className="mb-1 text-sm font-bold text-aws-warning">⚠ 자주 하는 실수</h3>
          <ul className="list-disc space-y-1 pl-5 text-aws-text">
            {topic.mistakes.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      )}
      {topic.simplifications && (
        <section className="rounded-xl border border-aws-border bg-aws-surface-2 px-4 py-3">
          <h3 className="mb-1 text-sm font-bold text-aws-text-2">이 시뮬레이터의 단순화</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-aws-text-2">
            {topic.simplifications.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="space-y-2 border-t border-aws-divider pt-4">
        {related.length > 0 && <TopicLinks title="관련 주제" ids={related} onOpen={openHelp} />}
        <TopicLinks title="다른 주제" ids={others.slice(0, 8)} onOpen={openHelp} />
      </div>
    </article>
  );
}

function TopicLinks({ title, ids, onOpen }: { title: string; ids: string[]; onOpen: (id: string) => void }) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-bold text-aws-text-2">{title}</p>
      <ul className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <li key={id}>
            <button type="button" onClick={() => onOpen(id)} className="rounded-full border border-aws-border px-3 py-1 text-sm text-aws-link hover:border-aws-link hover:bg-aws-info-bg">
              {HELP_TOPICS[id]?.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabGuide() {
  const projectId = useConsoleProjectId();
  const project = useProject();
  const analysis = useAnalysis();
  const lab = labById(project.labId);
  const setLab = (labId: string | null) => useProjectStore.getState().updateWithoutHistory(projectId, (p) => ({ ...p, labId }));

  const progress = useMemo(() => {
    if (!lab) return null;
    const ctx: LabContext = {
      project: analysis.project,
      topo: analysis.topology,
      findings: analysis.findings,
      health: analysis.health,
      simulate: (request) => simulateWithTopology(analysis.topology, request),
    };
    return evaluateLab(lab, ctx);
  }, [lab, analysis]);

  if (!lab || !progress) {
    return (
      <div className="space-y-4 text-sm">
        <div>
          <h2 className="text-lg font-bold text-aws-text">실습 가이드</h2>
          <p className="mt-1 text-aws-text-2">
            실습을 고르면 단계별 목표가 표시되고, 이 샌드박스의 실제 설정과 분석 결과로 완료 여부를 자동으로 확인합니다. 리소스는 직접 만들어야 합니다.
          </p>
        </div>
        <ul className="space-y-3">
          {LABS.map((l) => (
            <li key={l.id} className="space-y-2 rounded-xl border border-aws-border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="font-bold text-aws-text">
                  {l.order}. {l.title}
                </p>
                <Badge color="blue">{l.level}</Badge>
              </div>
              <p className="text-[13px] text-aws-text-2">{l.summary}</p>
              <Button onClick={() => setLab(l.id)}>이 샌드박스에서 진행</Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const nextIndex = progress.steps.findIndex((s) => !s.done);
  return (
    <div className="space-y-4 text-sm" data-testid="lab-guide">
      <div className="space-y-1">
        <p className="text-xs font-bold text-aws-text-2">실습 {lab.order}</p>
        <h2 className="text-lg font-bold text-aws-text">{lab.title}</h2>
        <p className="text-aws-text-2">{lab.summary}</p>
      </div>
      <div>
        <div className="flex items-center justify-between text-xs text-aws-text-2">
          <span>진행률</span>
          <span data-testid="lab-progress">
            {progress.completedCount}/{progress.steps.length} 단계
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-aws-divider" role="progressbar" aria-valuemin={0} aria-valuemax={progress.steps.length} aria-valuenow={progress.completedCount}>
          <div className="h-full rounded-full bg-aws-success transition-all" style={{ width: `${(progress.completedCount / progress.steps.length) * 100}%` }} />
        </div>
      </div>
      {progress.completed && (
        <p className="rounded-lg bg-aws-success-bg px-3 py-2 font-bold text-aws-success" role="status">
          모든 단계를 완료했습니다! 구성을 바꿔 가며 Reachability Analyzer로 결과가 어떻게 달라지는지 확인해 보세요.
        </p>
      )}
      <ol className="space-y-3">
        {lab.steps.map((step, i) => {
          const done = progress.steps[i]?.done;
          const current = i === nextIndex;
          return (
            <li key={step.id} className={cn("rounded-xl border p-3", current ? "border-aws-link bg-aws-selected" : "border-aws-border")} data-done={done || undefined}>
              <div className="flex items-start gap-2">
                {done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-aws-success" aria-label="완료" /> : <Circle className="mt-0.5 size-4 shrink-0 text-aws-text-3" aria-label="미완료" />}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={cn("font-bold", done ? "text-aws-text-2" : "text-aws-text")}>
                    {i + 1}. {step.title}
                  </p>
                  <p className="text-[13px] leading-5 text-aws-text">{step.instruction}</p>
                  {step.consolePath && (
                    <a href={href(step.consolePath)} className="inline-block text-[13px] font-bold text-aws-link hover:underline">
                      콘솔에서 열기 →
                    </a>
                  )}
                  {!done && (
                    <ExpandableSection header={<span className="text-[13px]">힌트</span>}>
                      <p className="text-[13px] text-aws-text-2">{step.hint}</p>
                    </ExpandableSection>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="border-t border-aws-divider pt-3">
        <Button variant="link" onClick={() => setLab(null)}>
          다른 실습 선택
        </Button>
      </div>
    </div>
  );
}
