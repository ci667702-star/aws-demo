"use client";

/**
 * 지금 작업하는 자격 증명(가상 로그인) 표시와 전환.
 * - 상단 메뉴: 현재 사용자·역할과 할 수 있는 일 요약, IAM 사용자로 로그인·역할 전환·루트로 돌아가기
 * - 배너: 루트가 아닐 때 화면 위에 누구로 작업 중인지 알려 준다
 * 전환은 실행 취소 기록에 남기지 않는다 (AWS에서도 로그인은 리소스 변경이 아니다).
 */
import { ArrowLeftRight, Check, KeyRound, LogOut, ShieldAlert, ShieldCheck, UserRound, X } from "lucide-react";
import { cn } from "cn";
import { useCallback } from "react";
import { DropdownMenu as Menu_ } from "radix-ui";
import { actingArn, actingIdentity, actingLabel, actingPrincipal, actingShortName, type ActingIdentity } from "@/lib/engine/iam-session";
import { CAPABILITIES, capabilityRow, type CapabilityDecision } from "@/lib/engine/iam-templates";
import type { Project } from "@/lib/engine/resource-models";
import { signInAsRoot, signInAsUser, switchBack, switchToRole } from "@/lib/project/iam-actions";
import { useProjectStore } from "@/lib/store/project-store";
import { useConsoleProjectId, useProject } from "../console-context";
import { notify } from "../notify";
import { href, navigate } from "../router";
import { menuContent, menuItem, navButton } from "./nav-styles";

/** 로그인·전환 동작 (실행 취소 기록 없이 저장, 결과는 알림으로) */
export function useSessionActions() {
  const projectId = useConsoleProjectId();
  return useCallback(
    (label: string, change: (project: Project) => { ok: true; project: Project } | { ok: false; error: string; hint?: string }) => {
      const store = useProjectStore.getState();
      const current = store.projects[projectId];
      if (!current) return;
      const r = change(current);
      if (!r.ok) {
        notify({ type: "error", title: `${label}할 수 없습니다`, description: r.error, notes: r.hint ? [r.hint] : [] });
        return;
      }
      store.updateWithoutHistory(projectId, () => r.project);
      const who = actingLabel(actingIdentity(r.project));
      store.log({ projectId, kind: "system", message: `${label}: 지금부터 ${who}(으)로 작업합니다 (가상 로그인).` });
      notify({ type: "success", title: `${who}(으)로 작업합니다`, description: actingIdentity(r.project).kind === "root" ? "루트 사용자는 모든 작업을 할 수 있습니다." : "이 자격 증명의 IAM 정책이 허용하는 작업만 할 수 있습니다." });
    },
    [projectId],
  );
}

const ok = (project: Project) => ({ ok: true as const, project });

export function CapabilityChips({ row, compact = false }: { row: Record<string, CapabilityDecision>; compact?: boolean }) {
  return (
    <ul className={cn("flex flex-wrap gap-1", compact && "text-[12px]")} aria-label="할 수 있는 일">
      {CAPABILITIES.filter((c) => c.id !== "read").map((c) => {
        const d = row[c.id];
        const allowed = d === "allowed";
        return (
          <li
            key={c.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px]",
              allowed ? "border-aws-success/40 bg-aws-success-bg text-aws-success" : d === "explicit-deny" ? "border-aws-error/40 bg-aws-error-bg text-aws-error" : "border-aws-border text-aws-text-3",
            )}
            title={allowed ? "할 수 있음" : d === "explicit-deny" ? "명시적 Deny로 막힘" : "허용하는 정책 없음 (암묵적 거부)"}
          >
            {allowed ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
            {c.label}
          </li>
        );
      })}
    </ul>
  );
}

function IdentityIcon({ identity, className }: { identity: ActingIdentity; className?: string }) {
  if (identity.kind === "root") return <ShieldAlert className={className} aria-hidden />;
  if (identity.kind === "role") return <ArrowLeftRight className={className} aria-hidden />;
  return <UserRound className={className} aria-hidden />;
}

export function IdentityMenu() {
  const project = useProject();
  const act = useSessionActions();
  const identity = actingIdentity(project);
  const principal = actingPrincipal(identity);
  const { users, roles, groups } = project.services.iam;
  const loginUsers = users.filter((u) => u.consoleAccess);
  const switchableRoles = roles.filter((r) => r.trustedEntity === "account");
  const isRoot = identity.kind === "root";
  return (
    <Menu_.Root modal={false}>
      <Menu_.Trigger
        className={cn(navButton, "max-w-44", !isRoot && "bg-amber-400/20 text-amber-100 ring-1 ring-amber-300/50")}
        aria-label={`현재 자격 증명: ${actingLabel(identity)}`}
        data-testid="identity-menu"
      >
        <IdentityIcon identity={identity} className="size-[18px] shrink-0" />
        <span className="hidden truncate lg:inline">{actingShortName(identity)}</span>
      </Menu_.Trigger>
      <Menu_.Portal>
        <Menu_.Content align="end" sideOffset={8} className={cn(menuContent, "max-h-[80vh] w-[min(94vw,24rem)] overflow-y-auto")}>
          <div className="space-y-2 px-3 pt-2 pb-2">
            <p className="text-[13px] font-bold text-aws-text-2">지금 작업하는 자격 증명 (가상 로그인)</p>
            <p className="flex items-center gap-2 text-[15px] font-bold">
              <IdentityIcon identity={identity} className="size-4 shrink-0" /> {actingLabel(identity)}
            </p>
            <p className="font-mono text-[12px] break-all text-aws-text-2">{actingArn(identity)}</p>
            {isRoot ? (
              <p className="rounded-lg border border-aws-warning/40 bg-aws-warning-bg px-3 py-2 text-[13px] text-aws-text">
                루트 사용자는 모든 권한이 있습니다. 실무에서는 루트를 평소에 쓰지 않고, 역할에 맞는 최소 권한의 IAM 사용자로 작업합니다. 아래에서 IAM 사용자로 로그인해 권한 차이를 직접 확인해 보세요.
              </p>
            ) : (
              principal && (
                <div className="space-y-1">
                  <p className="text-[13px] text-aws-text-2">할 수 있는 일 (정책 평가 결과)</p>
                  <CapabilityChips row={capabilityRow(project, principal)} compact />
                </div>
              )
            )}
          </div>
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
          <Menu_.Label className="px-3 pt-1 pb-1 text-[13px] font-bold text-aws-text-2">IAM 사용자로 로그인</Menu_.Label>
          {loginUsers.length === 0 && <p className="px-3 pb-2 text-[13px] text-aws-text-2">콘솔 액세스가 켜진 사용자가 없습니다. 역할 템플릿으로 예시 사용자를 만들 수 있습니다.</p>}
          {loginUsers.map((u) => {
            const current = identity.kind === "user" && identity.user.id === u.id;
            const groupNames = u.groupIds.map((g) => groups.find((x) => x.id === g)?.name).filter(Boolean);
            return (
              <Menu_.Item
                key={u.id}
                className={cn(menuItem, "items-start")}
                disabled={current}
                onSelect={() => act("로그인", (p) => signInAsUser(p, u.id))}
                data-testid={`sign-in-${u.name}`}
              >
                <UserRound className="mt-0.5 size-4 shrink-0 text-aws-link" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-bold">
                    {u.name} {current && <span className="font-normal text-aws-text-2">· 지금 사용 중</span>}
                  </span>
                  <span className="block truncate text-[13px] text-aws-text-2">{groupNames.length ? `그룹 ${groupNames.join(", ")}` : `직접 연결된 정책 ${u.policyIds.length}개`}</span>
                </span>
              </Menu_.Item>
            );
          })}
          {users.length > loginUsers.length && <p className="px-3 pb-1 text-[12px] text-aws-text-3">콘솔 액세스가 없는 사용자 {users.length - loginUsers.length}명은 로그인할 수 없습니다 (CLI·SDK 전용).</p>}
          {switchableRoles.length > 0 && (
            <>
              <Menu_.Separator className="my-1 h-px bg-aws-divider" />
              <Menu_.Label className="px-3 pt-1 pb-1 text-[13px] font-bold text-aws-text-2">역할 전환 (Switch role)</Menu_.Label>
              {isRoot && <p className="px-3 pb-1 text-[12px] text-aws-text-3">루트 사용자는 역할로 전환할 수 없습니다. IAM 사용자로 로그인한 뒤 전환하세요.</p>}
              {switchableRoles.map((r) => (
                <Menu_.Item key={r.id} className={menuItem} disabled={isRoot || (identity.kind === "role" && identity.role.id === r.id)} onSelect={() => act("역할 전환", (p) => switchToRole(p, r.id))}>
                  <ArrowLeftRight className="size-4 shrink-0 text-aws-link" aria-hidden />
                  {r.name}
                </Menu_.Item>
              ))}
            </>
          )}
          <Menu_.Separator className="my-1 h-px bg-aws-divider" />
          {identity.kind === "role" && identity.sourceUser && (
            <Menu_.Item className={menuItem} onSelect={() => act("돌아가기", (p) => ok(switchBack(p)))}>
              <LogOut className="size-4 shrink-0" aria-hidden /> {identity.sourceUser.name}(으)로 돌아가기
            </Menu_.Item>
          )}
          {!isRoot && (
            <Menu_.Item className={menuItem} onSelect={() => act("루트로 돌아가기", (p) => ok(signInAsRoot(p)))} data-testid="sign-in-root">
              <ShieldAlert className="size-4 shrink-0" aria-hidden /> 루트 사용자로 돌아가기
            </Menu_.Item>
          )}
          <Menu_.Item className={menuItem} onSelect={() => navigate("/iam/templates")}>
            <ShieldCheck className="size-4 shrink-0" aria-hidden /> 학교 역할 템플릿 (최소 권한)
          </Menu_.Item>
          <Menu_.Item className={menuItem} onSelect={() => navigate("/iam/simulator")}>
            <KeyRound className="size-4 shrink-0" aria-hidden /> 정책 시뮬레이터로 권한 확인
          </Menu_.Item>
        </Menu_.Content>
      </Menu_.Portal>
    </Menu_.Root>
  );
}

/** 루트가 아닐 때 화면 위에 보이는 안내 띠 */
export function IdentityBanner() {
  const project = useProject();
  const act = useSessionActions();
  const identity = actingIdentity(project);
  if (identity.kind === "root") return null;
  const groups = identity.kind === "user" ? identity.user.groupIds.map((g) => project.services.iam.groups.find((x) => x.id === g)?.name).filter(Boolean) : [];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-[14px] text-amber-950 sm:px-6 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100" role="status" data-testid="identity-banner">
      <IdentityIcon identity={identity} className="size-4 shrink-0" />
      <span>
        <strong>{actingLabel(identity)}</strong>(으)로 작업 중{groups.length ? ` · 그룹 ${groups.join(", ")}` : ""} — 이 자격 증명의 정책이 허용하지 않는 생성·변경·삭제는 거부됩니다.
      </span>
      <span className="ml-auto flex gap-3">
        <a className="font-bold underline" href={href(identity.kind === "user" ? `/iam/users/${identity.user.id}` : `/iam/roles/${identity.role.id}`)}>
          권한 보기
        </a>
        <button type="button" className="font-bold underline" onClick={() => act("루트로 돌아가기", (p) => ok(signInAsRoot(p)))}>
          루트로 돌아가기
        </button>
      </span>
    </div>
  );
}
