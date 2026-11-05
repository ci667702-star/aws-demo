"use client";

/**
 * 캔버스 범례: 선 종류(관계)와 서브넷 영역 색의 뜻을 보여 주고, 관계 종류별로 선을 숨기거나 보이게 한다.
 * - strip: 캔버스 밖 한 줄 (리소스 맵)
 * - panel: 캔버스 위 접이식 목록 (쉬운 모드). 리소스를 가리지 않도록 접어서 시작한다
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { cn } from "cn";
import type { RelationCategory } from "@/lib/engine/resource-models";
import { EDGE_STROKES } from "./relation-edge";

/** 범례 순서: 통신 흐름 → 배치·연결 → 보안 → 소속 */
export const LEGEND_ORDER: RelationCategory[] = ["route", "traffic", "placement", "association", "attachment", "security", "membership"];

const CATEGORY_HELP: Record<RelationCategory, string> = {
  route: "라우팅 테이블 → IGW·NAT·인스턴스 (목적지 CIDR)",
  traffic: "ALB → 대상 그룹 → EC2 (요청 방향)",
  placement: "EC2·NAT·ALB·RDS가 놓인 서브넷",
  association: "라우팅 테이블·NACL ↔ 서브넷 (AWS 용어: Association)",
  attachment: "IGW ↔ VPC, 탄력적 IP ↔ NAT·EC2 (AWS 용어: Attach)",
  security: "리소스에 적용된 보안 그룹",
  membership: "VPC에 속한 서브넷·라우팅 테이블 등",
};

const ZONES = [
  { label: "퍼블릭 서브넷", help: "인터넷 게이트웨이로 가는 경로가 있습니다.", className: "border-emerald-500/60 bg-emerald-500/10" },
  { label: "프라이빗 (NAT)", help: "NAT 게이트웨이나 NAT 인스턴스를 거쳐 밖으로만 나갑니다.", className: "border-sky-500/60 bg-sky-500/10" },
  { label: "프라이빗 (격리)", help: "VPC 밖으로 나가는 경로가 없습니다.", className: "border-slate-400/60 bg-slate-500/10" },
];

function LineSwatch({ category }: { category: RelationCategory }) {
  const stroke = EDGE_STROKES[category];
  return (
    <svg width="24" height="10" className="shrink-0" aria-hidden>
      <line x1="1" y1="5" x2="23" y2="5" stroke={stroke.color} strokeWidth={stroke.width + 0.5} strokeDasharray={stroke.dash} />
    </svg>
  );
}

function ZoneSwatch({ className }: { className: string }) {
  return <span className={cn("inline-block h-3 w-5 shrink-0 rounded-sm border-2 border-dashed", className)} aria-hidden />;
}

export function MapLegend({
  hidden,
  onToggle,
  variant,
}: {
  hidden: ReadonlySet<RelationCategory>;
  onToggle: (category: RelationCategory) => void;
  variant: "strip" | "panel";
}) {
  const [open, setOpen] = useState(false);

  if (variant === "strip") {
    return (
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" data-testid="map-legend">
        <ul className="contents" aria-label="관계 선 종류 (눌러서 숨기기·보이기)">
          {LEGEND_ORDER.map((category) => {
            const off = hidden.has(category);
            return (
              <li key={category}>
                <button
                  type="button"
                  aria-pressed={!off}
                  title={`${CATEGORY_HELP[category]} — 눌러서 ${off ? "보이기" : "숨기기"}`}
                  onClick={() => onToggle(category)}
                  className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 hover:bg-muted", off && "text-muted-foreground line-through opacity-60")}
                >
                  <LineSwatch category={category} />
                  {EDGE_STROKES[category].label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border bg-background/95 text-xs shadow-sm", open ? "w-64" : "w-fit")} data-testid="map-legend">
      <button type="button" className="flex w-full items-center gap-1 px-2.5 py-1.5 font-medium" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        범례 · 선 표시
        {hidden.size > 0 && <span className="ml-auto text-[11px] font-normal text-muted-foreground">{hidden.size}종류 숨김</span>}
      </button>
      {open && (
        <div className="max-h-96 space-y-2 overflow-y-auto border-t px-2 py-2">
          <ul className="space-y-0.5" aria-label="관계 선 종류">
            {LEGEND_ORDER.map((category) => {
              const off = hidden.has(category);
              return (
                <li key={category}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    onClick={() => onToggle(category)}
                    className={cn("flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted", off && "opacity-50")}
                  >
                    <LineSwatch category={category} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{EDGE_STROKES[category].label}</span>
                      <span className="block text-[10px] leading-tight text-muted-foreground">{CATEGORY_HELP[category]}</span>
                    </span>
                    {off ? <EyeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="숨김" /> : <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-label="표시" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <ul className="space-y-1 border-t px-1 pt-2" aria-label="서브넷 영역 색">
            {ZONES.map((z) => (
              <li key={z.label} className="flex items-center gap-2">
                <ZoneSwatch className={z.className} />
                <span>
                  {z.label} <span className="text-[10px] text-muted-foreground">{z.help}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t px-1 pt-2 text-[11px] leading-snug text-muted-foreground">
            리소스를 클릭하면 그 리소스와 연결된 선만 강조됩니다. 멀리서 보면 이름만, 확대하면 IP·상태 같은 세부 정보가 보입니다. 기본 NACL의 연결선은 선택했을 때만 보입니다.
          </p>
        </div>
      )}
    </div>
  );
}
