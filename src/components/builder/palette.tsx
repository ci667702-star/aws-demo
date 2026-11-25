"use client";

/**
 * 쉬운 모드의 리소스 팔레트.
 * 처음에는 첫 웹 서버에 필요한 '자주 쓰는 리소스' 6개만 보이고, 나머지는 '리소스 더 보기'로 연다
 * (샌드박스에 이미 다른 리소스가 있거나 실습 문제라면 처음부터 모두 보인다). 이름은 한국어를 먼저, AWS 영문 이름을 작게 쓴다.
 */
import { ChevronDown, ChevronUp, CircleHelp } from "lucide-react";
import { describeAllowedRelations } from "@/lib/engine/connection-rules";
import type { ResourceType } from "@/lib/engine/resource-models";
import { ResourceIcon } from "@/components/resource-visuals";
import { DocIcon } from "@/components/docs/resource-doc-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { docShortLabel, getResourceDoc, SERVICE_DOC_KEYS } from "@/lib/docs";
import { RESOURCE_PLAIN_NAME } from "@/lib/docs/glossary";
import { useGuidePrefs } from "@/lib/store/guide-prefs";
import type { InspectorDoc } from "@/lib/store/editor-store";
import { RESOURCE_DRAG_TYPE } from "./canvas/architecture-canvas";

/** 첫 웹 서버에 필요한 순서대로 */
export const BASIC_PALETTE_TYPES: ResourceType[] = ["vpc", "subnet", "internet-gateway", "route-table", "security-group", "ec2"];

const MORE_GROUPS: { label: string; types: ResourceType[] }[] = [
  { label: "네트워킹", types: ["nat-gateway", "elastic-ip"] },
  { label: "보안", types: ["network-acl"] },
  { label: "컴퓨팅", types: ["lambda"] },
  { label: "로드 밸런싱", types: ["alb", "target-group"] },
  { label: "데이터베이스", types: ["db-subnet-group", "rds"] },
];
const MORE_COUNT = MORE_GROUPS.reduce((n, g) => n + g.types.length, 0);

const groupTitle = "px-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";

function PaletteItem({ type, onAdd, onInfo }: { type: ResourceType; onAdd: (type: ResourceType) => void; onInfo?: (doc: InspectorDoc) => void }) {
  const name = RESOURCE_PLAIN_NAME[type];
  return (
    <li className="group relative">
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
            aria-label={`${name.ko} 추가`}
            data-testid={`palette-${type}`}
          >
            <ResourceIcon type={type} size="sm" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate">{name.ko}</span>
              {!name.ko.includes(name.en) && <span className="truncate text-[11px] text-muted-foreground">{name.en}</span>}
            </span>
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
          // 마우스를 쓰는 화면에서는 항목에 올렸을 때만 보인다 (터치 화면·키보드 포커스에서는 항상 보인다)
          className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/80 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-background hover:text-sky-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:hover)]:opacity-0"
          aria-label={`${name.ko} 설명 보기`}
          title={`${name.ko} 설명 보기`}
          data-testid={`palette-info-${type}`}
          onClick={() => onInfo({ kind: "preview", type })}
        >
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

export function Palette({ onAdd, onInfo, showAllByDefault = false }: { onAdd: (type: ResourceType) => void; onInfo?: (doc: InspectorDoc) => void; showAllByDefault?: boolean }) {
  const prefShowAll = useGuidePrefs((s) => s.paletteShowAll);
  const showAll = prefShowAll || showAllByDefault;
  return (
    <nav className="flex h-full flex-col overflow-y-auto" aria-label="AWS 리소스 팔레트" data-testid="palette">
      <div className="border-b px-3 py-2">
        <p className="text-xs font-semibold">리소스</p>
        <p className="text-[11px] text-muted-foreground">끌어다 놓거나 눌러서 추가</p>
      </div>
      <div className="flex-1 space-y-3 p-2">
        <div>
          <p className={groupTitle} title="인터넷에서 접속되는 첫 웹 서버에 필요한 리소스입니다 (위에서부터 순서대로).">
            자주 쓰는 리소스
          </p>
          <ul className="space-y-0.5">
            {BASIC_PALETTE_TYPES.map((type) => (
              <PaletteItem key={type} type={type} onAdd={onAdd} onInfo={onInfo} />
            ))}
          </ul>
        </div>
        {showAll ? (
          <>
            {MORE_GROUPS.map((group) => (
              <div key={group.label}>
                <p className={groupTitle}>{group.label}</p>
                <ul className="space-y-0.5">
                  {group.types.map((type) => (
                    <PaletteItem key={type} type={type} onAdd={onAdd} onInfo={onInfo} />
                  ))}
                </ul>
              </div>
            ))}
            {onInfo && (
              <div>
                <p className={groupTitle} title="캔버스에 놓지 않는 가상 서비스입니다. 누르면 설명과 현재 구성을 봅니다.">
                  서비스 (VPC 밖)
                </p>
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
              </div>
            )}
            {prefShowAll && !showAllByDefault && (
              <button
                type="button"
                onClick={() => useGuidePrefs.getState().setPaletteShowAll(false)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid="palette-show-less"
              >
                <ChevronUp className="size-3.5" aria-hidden /> 자주 쓰는 리소스만 보기
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => useGuidePrefs.getState().setPaletteShowAll(true)}
            className="flex w-full flex-col items-start gap-0.5 rounded-md border border-dashed px-2 py-1.5 text-left hover:border-sky-500 hover:bg-muted"
            data-testid="palette-show-more"
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-sky-700 dark:text-sky-300">
              <ChevronDown className="size-3.5" aria-hidden /> 리소스 더 보기 ({MORE_COUNT})
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">NAT·로드 밸런서·DB·Lambda와 VPC 밖 서비스 설명</span>
          </button>
        )}
      </div>
    </nav>
  );
}
