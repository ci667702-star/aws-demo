"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const subscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const current = mounted ? (theme ?? "system") : "system";
  const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
  const label = current === "light" ? "라이트 모드" : current === "dark" ? "다크 모드" : "시스템 설정";
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={() => setTheme(next)} aria-label={`테마: ${label} (클릭하여 변경)`}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>테마: {label}</TooltipContent>
    </Tooltip>
  );
}
