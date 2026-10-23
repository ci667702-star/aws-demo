"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "cn";
import { useId, useState } from "react";

/** 페이지 제목 (h1) + 설명 + 오른쪽 작업 버튼 */
export function PageHeader({
  title,
  counter,
  info,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  counter?: string;
  info?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-[26px] leading-tight font-bold break-all text-aws-text">
            {title}
            {counter && <span className="ml-2 text-lg font-normal text-aws-text-2">{counter}</span>}
          </h1>
          {info && <span className="text-sm font-normal">{info}</span>}
        </div>
        {description && <p className="max-w-3xl text-[15px] leading-relaxed text-aws-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 컨테이너 머리글 (h2) */
export function ContainerHeader({
  title,
  counter,
  info,
  description,
  actions,
}: {
  title: React.ReactNode;
  counter?: string;
  info?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-[19px] leading-snug font-bold text-aws-text">
            {title}
            {counter && <span className="ml-2 font-normal text-aws-text-2">{counter}</span>}
          </h2>
          {info && <span className="text-sm font-normal">{info}</span>}
        </div>
        {description && <p className="text-[15px] leading-relaxed text-aws-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Container({
  header,
  footer,
  children,
  className,
  disablePadding,
  id,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  disablePadding?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-2xl border border-aws-border bg-aws-surface shadow-[0_1px_3px_rgba(0,7,22,0.08)]", className)}>
      {header && <div className={cn("px-6 pt-5", children ? "pb-4" : "pb-5")}>{header}</div>}
      {children !== undefined && children !== null && children !== false && (
        <div className={cn(!disablePadding && "px-6 pb-6", !header && !disablePadding && "pt-6")}>{children}</div>
      )}
      {footer && <div className="border-t border-aws-divider px-6 py-4">{footer}</div>}
    </section>
  );
}

export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  info?: React.ReactNode;
}

/** 세부 정보 (레이블 / 값) 격자 */
export function KeyValueGrid({ items, columns = 3 }: { items: KeyValueItem[]; columns?: 1 | 2 | 3 | 4 }) {
  const cols = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[columns];
  return (
    <dl className={cn("grid grid-cols-1 gap-x-10 gap-y-5", cols)}>
      {items.map((item, i) => (
        <div key={i} className="min-w-0 space-y-0.5">
          <dt className="flex items-center gap-1.5 text-sm font-bold text-aws-text-2">
            {item.label}
            {item.info}
          </dt>
          <dd className="text-[15px] break-words text-aws-text">{item.value === "" || item.value == null ? "-" : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExpandableSection({
  header,
  children,
  defaultExpanded = false,
  variant = "default",
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  variant?: "default" | "container";
}) {
  const [open, setOpen] = useState(defaultExpanded);
  const id = useId();
  const content = (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-1.5 text-left font-bold text-aws-text hover:text-aws-link",
          variant === "container" ? "px-6 py-5 text-[19px]" : "py-1 text-[15px]",
        )}
      >
        {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
        {header}
      </button>
      {open && (
        <div id={id} className={cn(variant === "container" ? "px-6 pb-6" : "pt-2 pl-5")}>
          {children}
        </div>
      )}
    </>
  );
  if (variant === "container") {
    return <section className="rounded-2xl border border-aws-border bg-aws-surface shadow-[0_1px_3px_rgba(0,7,22,0.08)]">{content}</section>;
  }
  return <div>{content}</div>;
}

/** 표가 비었을 때 등 가운데 정렬 안내 */
export function EmptyState({ title, description, action }: { title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p className="text-base font-bold text-aws-text">{title}</p>
      {description && <p className="max-w-lg text-[15px] leading-relaxed text-aws-text-2">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** 세로로 쌓는 묶음. tour를 주면 튜토리얼이 이 영역을 가리킬 수 있다 (data-tour) */
export function SpaceBetween({ size = "l", children, className, tour }: { size?: "xs" | "s" | "m" | "l"; children: React.ReactNode; className?: string; tour?: string }) {
  const gap = { xs: "gap-1", s: "gap-2", m: "gap-4", l: "gap-6" }[size];
  return (
    <div className={cn("flex flex-col", gap, className)} data-tour={tour}>
      {children}
    </div>
  );
}
