"use client";

import { CircleHelp } from "lucide-react";
import { describeAllowedRelations } from "@/lib/engine/connection-rules";
import { RESOURCE_TYPE_INFO, type ResourceType } from "@/lib/engine/resource-models";
import { ResourceIcon } from "@/components/resource-visuals";
import { DocIcon } from "@/components/docs/resource-doc-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { docShortLabel, getResourceDoc, SERVICE_DOC_KEYS } from "@/lib/docs";
import type { InspectorDoc } from "@/lib/store/editor-store";
import { RESOURCE_DRAG_TYPE } from "./canvas/architecture-canvas";

const GROUPS: { label: string; types: ResourceType[] }[] = [
  { label: "네트워킹", types: ["vpc", "subnet", "internet-gateway", "route-table", "nat-gateway", "elastic-ip"] },
  { label: "보안", types: ["security-group", "network-acl"] },
  { label: "컴퓨팅", types: ["ec2"] },
  { label: "로드 밸런싱", types: ["alb", "target-group"] },
  { label: "데이터베이스", types: ["db-subnet-group", "rds"] },
];

export function Palette({ onAdd, onInfo }: { onAdd: (type: ResourceType) => void; onInfo?: (doc: InspectorDoc) => void }) {
  return (
    <nav className="flex h-full flex-col overflow-y-auto" aria-label="AWS 리소스 팔레트" data-testid="palette">
      <div className="border-b px-3 py-2">
        <p className="text-xs font-semibold">리소스</p>
        <p className="text-[11px] text-muted-foreground">끌어다 놓거나 클릭해 추가{onInfo ? " · ? 버튼으로 설명 보기" : ""}</p>
      </div>
      <div className="flex-1 space-y-3 p-2">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</p>
            <ul className="space-y-0.5">
              {group.types.map((type) => {
                const info = RESOURCE_TYPE_INFO[type];
                return (
                  <li key={type} className="relative">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData(RESOURCE_DRAG_TYPE, type);
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onClick={() => onAdd(type)}
                          className={`flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing${onInfo ? " pr-7" : ""}`}
                          aria-label={`${info.label} 추가`}
                          data-testid={`palette-${type}`}
                        >
                          <ResourceIcon type={type} size="sm" />
                          <span className="truncate">{info.label}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64 flex-col items-start">
                        <span>{getResourceDoc(type).summary}</span>
                        <span className="opacity-70">연결 가능: {describeAllowedRelations(type)}</span>
                      </TooltipContent>
                    </Tooltip>
                    {onInfo && (
                      <button
                        type="button"
                        className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/80 hover:bg-background hover:text-sky-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label={`${info.label} 설명 보기`}
                        title={`${info.label} 설명 보기`}
                        data-testid={`palette-info-${type}`}
                        onClick={() => onInfo({ kind: "preview", type })}
                      >
                        <CircleHelp className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {onInfo && (
          <div>
            <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">서비스 (VPC 밖)</p>
            <ul className="space-y-0.5">
              {SERVICE_DOC_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => onInfo({ kind: "service", key, itemId: null })}
                    aria-label={`${docShortLabel(key)} 설명과 현재 구성 보기`}
                    data-testid={`palette-service-${key}`}
                  >
                    <DocIcon docKey={key} size="sm" />
                    <span className="truncate">{docShortLabel(key)}</span>
                    <CircleHelp className="ml-auto size-3.5 text-muted-foreground/80" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <p className="px-1 pt-1 text-[10px] leading-snug text-muted-foreground">캔버스에 놓지 않는 가상 서비스입니다. 누르면 설명과 현재 구성을 봅니다.</p>
          </div>
        )}
      </div>
      <div className="border-t p-2 text-[11px] leading-relaxed text-muted-foreground">
        <p>VPC/서브넷 영역 위에 놓으면 자동으로 연결됩니다.</p>
        <p>리소스를 선택한 상태에서 클릭하면 선택한 리소스와 연결을 시도합니다.</p>
      </div>
    </nav>
  );
}
