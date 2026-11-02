"use client";

/**
 * 쉬운 모드 도구 모음의 '작업 자격 증명' 표시와 전환.
 * 콘솔과 같은 가상 로그인 상태를 쓰므로, IAM 사용자로 로그인하면 그림 빌더에서도 그 사용자의 권한만큼만 바꿀 수 있다.
 */
import Link from "next/link";
import { ArrowLeftRight, ShieldAlert, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { actingIdentity, actingLabel, actingShortName } from "@/lib/engine/iam-session";
import type { Project } from "@/lib/engine/resource-models";
import { signInAsRoot, signInAsUser, switchToRole } from "@/lib/project/iam-actions";
import { useProjectStore } from "@/lib/store/project-store";

type Change = (project: Project) => { ok: true; project: Project } | { ok: false; error: string; hint?: string };

export function IdentityBadge({ projectId }: { projectId: string }) {
  const project = useProjectStore((s) => s.projects[projectId]);
  if (!project) return null;
  const identity = actingIdentity(project);
  const isRoot = identity.kind === "root";
  const { users, roles } = project.services.iam;
  const loginUsers = users.filter((u) => u.consoleAccess);
  const switchable = roles.filter((r) => r.trustedEntity === "account");

  const act = (label: string, change: Change) => {
    const store = useProjectStore.getState();
    const current = store.projects[projectId];
    if (!current) return;
    const r = change(current);
    if (!r.ok) {
      toast.error(r.error, r.hint ? { description: r.hint } : undefined);
      return;
    }
    store.updateWithoutHistory(projectId, () => r.project);
    const who = actingLabel(actingIdentity(r.project));
    store.log({ projectId, kind: "system", message: `${label}: 지금부터 ${who}(으)로 작업합니다 (가상 로그인).` });
    toast.success(`${who}(으)로 작업합니다`, { description: actingIdentity(r.project).kind === "root" ? "루트 사용자는 모든 작업을 할 수 있습니다." : "이 자격 증명의 IAM 정책이 허용하는 변경만 할 수 있습니다." });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(!isRoot && "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:text-amber-200")}
          aria-label={`작업 자격 증명: ${actingLabel(identity)}`}
          data-testid="builder-identity"
        >
          {isRoot ? <ShieldAlert /> : identity.kind === "role" ? <ArrowLeftRight /> : <UserRound />}
          <span className="hidden max-w-28 truncate md:inline">{actingShortName(identity)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="space-y-1">
          <span className="block text-xs text-muted-foreground">작업 자격 증명 (가상 로그인)</span>
          <span className="block">{actingLabel(identity)}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {isRoot ? "루트는 모든 변경을 할 수 있습니다. IAM 사용자로 로그인하면 그 정책이 허용하는 변경만 됩니다." : "이 자격 증명의 정책이 허용하지 않는 추가·변경·삭제는 거부됩니다."}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loginUsers.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">콘솔 액세스가 켜진 IAM 사용자가 없습니다.</p>}
        {loginUsers.map((u) => (
          <DropdownMenuItem key={u.id} disabled={identity.kind === "user" && identity.user.id === u.id} onSelect={() => act("로그인", (p) => signInAsUser(p, u.id))}>
            <UserRound /> {u.name}
          </DropdownMenuItem>
        ))}
        {switchable.length > 0 && <DropdownMenuSeparator />}
        {switchable.map((r) => (
          <DropdownMenuItem key={r.id} disabled={isRoot} onSelect={() => act("역할 전환", (p) => switchToRole(p, r.id))}>
            <ArrowLeftRight /> 역할 {r.name}
            {isRoot && <span className="ml-auto text-[11px] text-muted-foreground">루트는 전환 불가</span>}
          </DropdownMenuItem>
        ))}
        {!isRoot && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act("루트로 돌아가기", (p) => ({ ok: true, project: signInAsRoot(p) }))}>
              <ShieldAlert /> 루트 사용자로 돌아가기
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/console/${projectId}#/iam/templates`}>
            <ShieldCheck /> 학교 역할 템플릿 (심화 모드)
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
