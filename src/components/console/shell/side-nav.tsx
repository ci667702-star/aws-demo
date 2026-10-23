"use client";

import { X } from "lucide-react";
import { cn } from "cn";
import { href } from "../router";
import { activeNavPath, NAVIGATION, SERVICES, TOOLS, type ServiceId } from "./navigation";

export function SideNav({ service, path, onNavigate, onClose }: { service: ServiceId; path: string; onNavigate?: () => void; onClose: () => void }) {
  const nav = NAVIGATION[service];
  const active = activeNavPath(service, path);
  const linkClass = (p: string) =>
    cn(
      "block rounded-r-md border-l-4 py-1 pr-3 pl-4 text-sm",
      active === p ? "border-aws-link font-bold text-aws-link" : "border-transparent text-aws-text-2 hover:text-aws-link",
    );
  return (
    <nav aria-label={`${nav.title} 탐색`} className="flex h-full flex-col overflow-y-auto pb-6">
      <div className="flex items-center justify-between gap-2 border-b border-aws-divider px-5 py-4">
        <a href={href(nav.root)} onClick={onNavigate} className="text-lg font-bold text-aws-text hover:text-aws-link">
          {service === "tools" ? "도구" : SERVICES.find((s) => s.id === service)?.name}
        </a>
        <button type="button" onClick={onClose} className="rounded p-1 text-aws-text-2 hover:text-aws-text" aria-label="탐색 창 닫기">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-4 py-4">
        {service !== "tools" && (
          <a href={href(nav.root)} onClick={onNavigate} className={linkClass(nav.root)} aria-current={active === nav.root ? "page" : undefined}>
            {nav.title}
          </a>
        )}
        {nav.sections.map((section, i) => (
          <div key={i} className="space-y-1">
            {section.title && <p className="px-5 pb-1 text-xs font-bold tracking-wide text-aws-text-2 uppercase">{section.title}</p>}
            <ul className="space-y-0.5">
              {section.links.map((link) => (
                <li key={link.path}>
                  <a href={href(link.path)} onClick={onNavigate} className={linkClass(link.path)} aria-current={active === link.path ? "page" : undefined}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-auto space-y-1 border-t border-aws-divider pt-4">
        <p className="px-5 pb-1 text-xs font-bold tracking-wide text-aws-text-2 uppercase">다른 서비스·도구</p>
        <ul className="space-y-0.5">
          {SERVICES.filter((s) => s.id !== service).map((s) => (
            <li key={s.id}>
              <a href={href(s.root)} onClick={onNavigate} className={linkClass(`svc:${s.id}`)}>
                {s.name}
              </a>
            </li>
          ))}
          {service !== "tools" &&
            TOOLS.filter((t) => t.id !== "reachability").map((t) => (
              <li key={t.id}>
                <a href={href(t.path)} onClick={onNavigate} className={linkClass(`tool:${t.id}`)}>
                  {t.name}
                </a>
              </li>
            ))}
        </ul>
      </div>
    </nav>
  );
}
