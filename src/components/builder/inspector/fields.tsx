"use client";

import { useId, useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";
import { cn } from "cn";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type CommitResult = string | null | void;

/**
 * 검증 후 확정되는 텍스트 입력.
 * Enter/포커스 해제 시 validate를 통과해야만 onCommit을 호출한다. 잘못된 값은 저장하지 않고 이유를 표시한다.
 */
export function TextField({
  label,
  value,
  onCommit,
  validate,
  placeholder,
  hint,
  mono,
  disabled,
  maxLength = 128,
  testId,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => CommitResult;
  validate?: (value: string) => string | null;
  placeholder?: string;
  hint?: React.ReactNode;
  mono?: boolean;
  disabled?: boolean;
  maxLength?: number;
  testId?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (value !== prev) {
    setPrev(value);
    if (!focused) {
      setDraft(value);
      setError(null);
    }
  }

  const commit = () => {
    if (draft === value) {
      setError(null);
      return;
    }
    const problem = validate?.(draft) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    const result = onCommit(draft);
    setError(typeof result === "string" ? result : null);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        data-testid={testId}
        className={cn("h-8", mono && "font-mono text-[13px]")}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(value);
            setError(null);
          }
        }}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-1 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            {error} <span className="text-muted-foreground">(적용되지 않음 · Esc로 되돌리기)</span>
          </span>
        </p>
      ) : (
        hint && <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** 정수 입력 (범위 검증 포함) */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  hint,
  testId,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => CommitResult;
  min: number;
  max: number;
  hint?: React.ReactNode;
  testId?: string;
}) {
  return (
    <TextField
      label={label}
      value={String(value)}
      hint={hint}
      testId={testId}
      maxLength={12}
      validate={(v) => {
        if (!/^-?\d+$/.test(v.trim())) return "정수를 입력하세요.";
        const n = Number(v);
        if (n < min || n > max) return `${min}~${max} 사이의 값이어야 합니다.`;
        return null;
      }}
      onCommit={(v) => onCommit(Number(v))}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  hint?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <NativeSelect id={id} value={value} onChange={onChange} options={options} disabled={disabled} testId={testId} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NativeSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  className,
  testId,
  ariaLabel,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full appearance-none rounded-lg border border-input bg-transparent py-1 pr-7 pl-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  );
}

export function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={testId} />
    </div>
  );
}

export interface CheckItem {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function CheckList({
  label,
  items,
  onToggle,
  empty,
}: {
  label: string;
  items: CheckItem[];
  onToggle: (id: string, checked: boolean) => void;
  empty?: React.ReactNode;
}) {
  const baseId = useId();
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty ?? "선택할 수 있는 항목이 없습니다."}</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => {
            const id = `${baseId}-${item.id}`;
            return (
              <div key={item.id} className={cn("flex items-start gap-2 rounded-md px-1 py-0.5", item.disabled && "opacity-60")} title={item.disabledReason}>
                <Checkbox
                  id={id}
                  checked={item.checked}
                  disabled={item.disabled}
                  onCheckedChange={(v) => onToggle(item.id, v === true)}
                  className="mt-0.5"
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm leading-tight">
                  {item.label}
                  {(item.description || item.disabledReason) && (
                    <span className="block text-[11px] text-muted-foreground">{item.disabled ? item.disabledReason : item.description}</span>
                  )}
                </label>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-4">
        <button
          type="button"
          className="flex flex-1 items-center gap-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} aria-hidden />
          {title}
        </button>
        {actions}
      </div>
      {open && (
        <div id={id} className="mt-2 space-y-3 px-4">
          {children}
        </div>
      )}
    </section>
  );
}

export function InfoRow({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right break-all", mono && "font-mono text-[12px]")}>{children}</span>
    </div>
  );
}

export function Callout({ tone = "info", children }: { tone?: "info" | "warn" | "error"; children: React.ReactNode }) {
  const styles = {
    info: "border-sky-500/30 bg-sky-500/5",
    warn: "border-amber-500/40 bg-amber-500/10",
    error: "border-red-500/40 bg-red-500/5",
  } as const;
  return <div className={cn("rounded-md border p-2 text-xs leading-relaxed", styles[tone])}>{children}</div>;
}
