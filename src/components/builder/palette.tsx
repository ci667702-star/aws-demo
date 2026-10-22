"use client";

import { describeAllowedRelations } from "@/lib/engine/connection-rules";
import { RESOURCE_TYPE_INFO, type ResourceType } from "@/lib/engine/resource-models";
import { ResourceIcon } from "@/components/resource-visuals";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RESOURCE_DRAG_TYPE } from "./canvas/architecture-canvas";

const GROUPS: { label: string; types: ResourceType[] }[] = [
  { label: "네트워킹", types: ["vpc", "subnet", "internet-gateway", "route-table", "nat-gateway"] },
  { label: "보안", types: ["security-group", "network-acl"] },
  { label: "컴퓨팅", types: ["ec2"] },
  { label: "로드 밸런싱", types: ["alb", "target-group"] },
  { label: "데이터베이스", types: ["db-subnet-group", "rds"] },
];

export function Palette({ onAdd }: { onAdd: (type: ResourceType) => void }) {
  return (
    <nav className="flex h-full flex-col overflow-y-auto" aria-label="AWS 리소스 팔레트" data-testid="palette">
      <div className="border-b px-3 py-2">
        <p className="text-xs font-semibold">리소스</p>
        <p className="text-[11px] text-muted-foreground">끌어다 놓거나 클릭해 추가</p>
      </div>
      <div className="flex-1 space-y-3 p-2">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</p>
            <ul className="space-y-0.5">
              {group.types.map((type) => {
                const info = RESOURCE_TYPE_INFO[type];
                return (
                  <li key={type}>
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
                          className="flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
                          aria-label={`${info.label} 추가`}
                          data-testid={`palette-${type}`}
                        >
                          <ResourceIcon type={type} size="sm" />
                          <span className="truncate">{info.label}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64 flex-col items-start">
                        <span>{info.description}</span>
                        <span className="opacity-70">연결 가능: {describeAllowedRelations(type)}</span>
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t p-2 text-[11px] leading-relaxed text-muted-foreground">
        <p>VPC/서브넷 영역 위에 놓으면 자동으로 연결됩니다.</p>
        <p>리소스를 선택한 상태에서 클릭하면 선택한 리소스와 연결을 시도합니다.</p>
      </div>
    </nav>
  );
}
