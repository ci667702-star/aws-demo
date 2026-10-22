import {
  ArrowLeftRight,
  Boxes,
  Database,
  Globe,
  Layers,
  ListChecks,
  Network,
  Route,
  Server,
  ShieldCheck,
  Split,
  Target,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { RESOURCE_TYPE_INFO, type ResourceType } from "@/lib/engine/resource-models";

export const RESOURCE_ICONS: Record<ResourceType, LucideIcon> = {
  vpc: Network,
  subnet: Boxes,
  "internet-gateway": Globe,
  "route-table": Route,
  "nat-gateway": ArrowLeftRight,
  "security-group": ShieldCheck,
  "network-acl": ListChecks,
  ec2: Server,
  alb: Split,
  "target-group": Target,
  "db-subnet-group": Layers,
  rds: Database,
};

/** 카테고리별 색상 (Tailwind 클래스) */
export const CATEGORY_STYLES: Record<
  (typeof RESOURCE_TYPE_INFO)[ResourceType]["category"],
  { icon: string; chip: string; border: string; label: string }
> = {
  networking: {
    icon: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    chip: "bg-sky-500/10 text-sky-800 dark:text-sky-200",
    border: "border-l-sky-500",
    label: "네트워킹",
  },
  security: {
    icon: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    chip: "bg-rose-500/10 text-rose-800 dark:text-rose-200",
    border: "border-l-rose-500",
    label: "보안",
  },
  compute: {
    icon: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    chip: "bg-amber-500/10 text-amber-800 dark:text-amber-200",
    border: "border-l-amber-500",
    label: "컴퓨팅",
  },
  "load-balancing": {
    icon: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    chip: "bg-violet-500/10 text-violet-800 dark:text-violet-200",
    border: "border-l-violet-500",
    label: "로드 밸런싱",
  },
  database: {
    icon: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    chip: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    border: "border-l-emerald-500",
    label: "데이터베이스",
  },
};

export function ResourceIcon({ type, className, size = "md" }: { type: ResourceType; className?: string; size?: "sm" | "md" | "lg" }) {
  const Icon = RESOURCE_ICONS[type];
  const style = CATEGORY_STYLES[RESOURCE_TYPE_INFO[type].category];
  const box = size === "sm" ? "size-6 rounded-md" : size === "lg" ? "size-10 rounded-lg" : "size-8 rounded-md";
  const icon = size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4";
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", box, style.icon, className)} aria-hidden>
      <Icon className={icon} />
    </span>
  );
}

export type Tone = "ok" | "warn" | "error" | "info" | "muted" | "accent";

export const TONE_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/12 text-amber-800 dark:text-amber-300 border-amber-500/30",
  error: "bg-red-500/12 text-red-700 dark:text-red-300 border-red-500/30",
  info: "bg-sky-500/12 text-sky-800 dark:text-sky-300 border-sky-500/30",
  muted: "bg-muted text-muted-foreground border-border",
  accent: "bg-violet-500/12 text-violet-800 dark:text-violet-300 border-violet-500/30",
};

export function ToneBadge({ tone, children, className, title }: { tone: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
