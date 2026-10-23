"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "cn";
import { forwardRef } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

export type ButtonVariant = "primary" | "normal" | "link" | "icon";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-aws-primary bg-aws-primary text-aws-primary-fg hover:border-aws-primary-hover hover:bg-aws-primary-hover disabled:border-aws-disabled disabled:bg-aws-disabled disabled:text-aws-text-3",
  normal:
    "border-aws-link bg-aws-surface text-aws-link hover:border-aws-link-hover hover:bg-aws-info-bg hover:text-aws-link-hover disabled:border-aws-border disabled:bg-aws-surface disabled:text-aws-text-3",
  link: "border-transparent bg-transparent text-aws-link hover:bg-aws-info-bg hover:text-aws-link-hover disabled:text-aws-text-3 disabled:bg-transparent",
  icon: "border-transparent bg-transparent px-1.5 text-aws-text-2 hover:bg-aws-surface-2 hover:text-aws-text disabled:text-aws-text-3",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

export const buttonClass = (variant: ButtonVariant = "normal", className?: string) =>
  cn(
    "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border-2 px-4 text-[14px] leading-none font-bold whitespace-nowrap transition-colors select-none",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aws-focus disabled:cursor-not-allowed",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    VARIANT[variant],
    className,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "normal", loading, iconLeft, iconRight, className, children, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : iconLeft}
      {children}
      {iconRight}
    </button>
  );
});

/** href로 이동하는 버튼 모양 링크 */
export function ButtonLink({
  variant = "normal",
  className,
  iconLeft,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; iconLeft?: React.ReactNode }) {
  return (
    <a className={buttonClass(variant, className)} {...props}>
      {iconLeft}
      {children}
    </a>
  );
}

export interface DropdownItem {
  id: string;
  text: string;
  disabled?: boolean;
  /** 비활성 이유 (툴팁) */
  disabledReason?: string;
  description?: string;
  /** 위험한 동작 (빨간 글자) */
  danger?: boolean;
}

export interface DropdownGroup {
  id: string;
  text: string;
  items: DropdownItem[];
}

function isGroup(x: DropdownItem | DropdownGroup): x is DropdownGroup {
  return "items" in x;
}

/** AWS 콘솔의 "작업 ▼" 버튼 */
export function ButtonDropdown({
  label,
  items,
  onItemClick,
  variant = "normal",
  disabled,
  align = "end",
}: {
  label: string;
  items: (DropdownItem | DropdownGroup)[];
  onItemClick: (id: string) => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  align?: "start" | "end";
}) {
  const renderItem = (item: DropdownItem) => (
    <DropdownMenuPrimitive.Item
      key={item.id}
      disabled={item.disabled}
      onSelect={() => onItemClick(item.id)}
      title={item.disabled ? item.disabledReason : undefined}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-[15px] outline-none",
        "data-[highlighted]:bg-aws-info-bg data-[highlighted]:text-aws-link-hover",
        "data-[disabled]:cursor-not-allowed data-[disabled]:text-aws-text-3",
        item.danger && "text-aws-error data-[highlighted]:text-aws-error",
      )}
    >
      <span>{item.text}</span>
      {item.description && <span className="text-[13px] text-aws-text-2">{item.description}</span>}
    </DropdownMenuPrimitive.Item>
  );
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
        <Button variant={variant} iconRight={<ChevronDown aria-hidden />} disabled={disabled}>
          {label}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={4}
          className="z-50 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] min-w-60 overflow-y-auto rounded-xl border border-aws-border bg-aws-surface p-1.5 text-aws-text shadow-xl"
        >
          {items.map((entry) =>
            isGroup(entry) ? (
              <DropdownMenuPrimitive.Group key={entry.id} className="border-t border-aws-divider py-1 first:border-t-0 first:pt-0">
                <DropdownMenuPrimitive.Label className="px-3 py-1 text-[13px] font-bold text-aws-text-2">{entry.text}</DropdownMenuPrimitive.Label>
                {entry.items.map(renderItem)}
              </DropdownMenuPrimitive.Group>
            ) : (
              renderItem(entry)
            ),
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
