"use client";

import { ChevronDown, CircleX, Search, X } from "lucide-react";
import { cn } from "cn";
import { createContext, forwardRef, useContext, useId, useMemo, useState } from "react";

const FieldContext = createContext<{ id: string; describedBy?: string; invalid: boolean } | null>(null);

/** 레이블, 설명, 제약 조건, 오류를 갖춘 입력 필드 */
export function FormField({
  label,
  info,
  description,
  constraint,
  error,
  children,
  className,
  optional,
}: {
  label?: React.ReactNode;
  info?: React.ReactNode;
  description?: React.ReactNode;
  constraint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  optional?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const describedBy = [description || constraint ? descId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: !!error }}>
      <div className={cn("min-w-0 space-y-1", className)}>
        {label && (
          <div className="flex items-center gap-1.5">
            <label htmlFor={id} className="text-[15px] font-bold text-aws-text">
              {label}
              {optional && <span className="ml-1 font-normal text-aws-text-2 italic">- 선택 사항</span>}
            </label>
            {info}
          </div>
        )}
        {description && (
          <p id={descId} className="text-sm leading-relaxed text-aws-text-2">
            {description}
          </p>
        )}
        <div>{children}</div>
        {constraint && !error && (
          <p id={description ? undefined : descId} className="text-[13px] leading-snug text-aws-text-2">
            {constraint}
          </p>
        )}
        {error && (
          <p id={errId} className="flex items-start gap-1 text-[13px] font-bold text-aws-error" role="alert">
            <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

function useField() {
  return useContext(FieldContext);
}

export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-aws-border-strong bg-aws-surface px-3 text-[15px] text-aws-text placeholder:text-aws-text-3 placeholder:italic focus:border-aws-focus focus:outline-2 focus:outline-offset-0 focus:outline-aws-focus disabled:cursor-not-allowed disabled:border-aws-disabled disabled:bg-aws-disabled disabled:text-aws-text-3 aria-invalid:border-aws-error aria-invalid:border-l-4";

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, id, ...props }, ref) {
  const field = useField();
  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      autoComplete="off"
      spellCheck={false}
      className={cn(inputClass, className)}
      {...props}
    />
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = "리소스 찾기",
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-aws-text-2" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className={cn(inputClass, "pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden")}
      />
      {value && (
        <button type="button" onClick={() => onChange("")} className="absolute top-1/2 right-2 -translate-y-1/2 text-aws-text-2 hover:text-aws-text" aria-label="검색어 지우기">
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** 네이티브 select (키보드·스크린 리더 지원) */
export function SelectInput({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const field = useField();
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        id={id ?? field?.id}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, "cursor-pointer appearance-none pr-8", !value && "text-aws-text-3 italic")}
      >
        {placeholder !== undefined && (
          <option value="" disabled={false}>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} className="text-aws-text not-italic">
            {o.description ? `${o.label} — ${o.description}` : o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-aws-text-2" aria-hidden />
    </div>
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, id, ...props }, ref) {
  const field = useField();
  return (
    <textarea
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      spellCheck={false}
      className={cn(inputClass, "h-auto min-h-24 py-1.5 font-mono text-[13px] leading-5", className)}
      {...props}
    />
  );
});

export function Checkbox({
  checked,
  onChange,
  children,
  description,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-sm", disabled && "cursor-not-allowed text-aws-text-3", className)}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--aws-link)] disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      {(children || description) && (
        <span className="min-w-0">
          {children && <span className={cn("block", !disabled && "text-aws-text")}>{children}</span>}
          {description && <span className="block text-[13px] text-aws-text-2">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Toggle({ checked, onChange, children, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; description?: React.ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aws-focus disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-aws-link" : "bg-aws-border-strong",
        )}
      >
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-white transition-transform", checked ? "translate-x-3.5" : "translate-x-0.5")} />
      </button>
      <label htmlFor={id} className="cursor-pointer text-sm">
        <span className="block text-aws-text">{children}</span>
        {description && <span className="block text-[13px] text-aws-text-2">{description}</span>}
      </label>
    </div>
  );
}

export interface RadioItem {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

export function RadioGroup({ value, onChange, items, name, "aria-label": ariaLabel }: { value: string; onChange: (v: string) => void; items: RadioItem[]; name?: string; "aria-label"?: string }) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="space-y-2">
      {items.map((item) => (
        <label key={item.value} className={cn("flex cursor-pointer items-start gap-2 text-sm", item.disabled && "cursor-not-allowed text-aws-text-3")}>
          <input
            type="radio"
            name={group}
            value={item.value}
            checked={value === item.value}
            disabled={item.disabled}
            onChange={() => onChange(item.value)}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--aws-link)]"
          />
          <span className="min-w-0">
            <span className="block text-aws-text">{item.label}</span>
            {item.description && <span className="block text-[13px] text-aws-text-2">{item.description}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** 카드 모양 라디오 (AMI, 엔진 선택 등) */
export function Tiles({
  value,
  onChange,
  items,
  columns = 3,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  items: (RadioItem & { image?: React.ReactNode })[];
  columns?: 2 | 3 | 4;
  "aria-label"?: string;
}) {
  const name = useId();
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[columns];
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("grid grid-cols-1 gap-3", cols)}>
      {items.map((item) => {
        const selected = value === item.value;
        return (
          <label
            key={item.value}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-xl border-2 p-3 text-sm transition-colors",
              selected ? "border-aws-link bg-aws-selected" : "border-aws-border hover:border-aws-border-strong",
              item.disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <span className="flex items-start gap-2">
              <input
                type="radio"
                name={name}
                value={item.value}
                checked={selected}
                disabled={item.disabled}
                onChange={() => onChange(item.value)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--aws-link)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-aws-text">{item.label}</span>
                {item.description && <span className="block text-[13px] text-aws-text-2">{item.description}</span>}
              </span>
              {item.image}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** 여러 항목 선택 (검색 + 체크박스 목록 + 선택된 토큰) */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "항목 검색",
  empty = "선택할 수 있는 항목이 없습니다.",
  max,
  "aria-label": ariaLabel,
}: {
  options: SelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  empty?: string;
  max?: number;
  "aria-label"?: string;
}) {
  const [filter, setFilter] = useState("");
  const field = useField();
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.value} ${o.description ?? ""}`.toLowerCase().includes(q)) : options;
  }, [filter, options]);
  const toggle = (value: string, on: boolean) => onChange(on ? [...selected, value] : selected.filter((v) => v !== value));
  const byValue = new Map(options.map((o) => [o.value, o]));
  return (
    <div className="space-y-2" aria-describedby={field?.describedBy}>
      {options.length > 6 && <SearchInput value={filter} onChange={setFilter} placeholder={placeholder} />}
      <div
        role="group"
        aria-label={ariaLabel}
        data-invalid={field?.invalid || undefined}
        className={cn("max-h-56 overflow-y-auto rounded-lg border border-aws-border-strong", field?.invalid && "border-aws-error")}
      >
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-sm text-aws-text-2">{empty}</p>
        ) : (
          visible.map((o) => {
            const on = selected.includes(o.value);
            return (
              <Checkbox
                key={o.value}
                checked={on}
                disabled={o.disabled || (!on && max !== undefined && selected.length >= max)}
                onChange={(v) => toggle(o.value, v)}
                description={o.description}
                className="border-b border-aws-divider px-3 py-2 last:border-b-0 hover:bg-aws-surface-2"
              >
                {o.label}
              </Checkbox>
            );
          })
        )}
      </div>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="선택한 항목">
          {selected.map((v) => (
            <li key={v} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-aws-border-strong bg-aws-surface-2 py-0.5 pr-1 pl-2 text-[13px]">
              <span className="truncate">{byValue.get(v)?.label ?? v}</span>
              <button type="button" onClick={() => toggle(v, false)} className="rounded p-0.5 text-aws-text-2 hover:text-aws-text" aria-label={`${byValue.get(v)?.label ?? v} 선택 해제`}>
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 양식 하단 버튼 영역 (오른쪽 정렬) */
export function FormActions({ children, error }: { children: React.ReactNode; error?: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {error}
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
