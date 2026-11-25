"use client";

/**
 * 튜토리얼이 가리키는 곳을 화면에서 밝게 표시한다.
 * - 작업할 곳(양식 등): 밝은 테두리를 두르고, '주변 어둡게'가 켜져 있으면 나머지를 어둡게 낮춘다.
 * - 다른 화면으로 가는 메뉴·링크: 깜빡이는 테두리만 두른다 (지금 화면은 그대로 읽을 수 있게).
 * 표시는 화면 위에 그리기만 하고 클릭을 막지 않는다 (튜토리얼 중에도 콘솔 전체를 그대로 쓸 수 있다).
 * 대상의 크기·위치가 바뀌면(양식이 늘어남, 스크롤, 창 크기) 따라간다.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 상단 메뉴 안의 요소 (검색창, 도움말 버튼 등). 아니면 상단 메뉴 아래에서만 표시한다 */
  inHeader: boolean;
}

const sameBoxes = (a: Box[], b: Box[]) => a.length === b.length && a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h && r.inHeader === b[i].inHeader);

/** 모서리가 둥근 사각형 경로 (어둡게 덮는 면에 구멍을 낼 때 쓴다) */
function roundedRect({ x, y, w, h }: Pick<Box, "x" | "y" | "w" | "h">, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${x + rr} ${y}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - 2 * rr}a${rr} ${rr} 0 0 1 -${rr} ${rr}h-${w - 2 * rr}a${rr} ${rr} 0 0 1 -${rr} -${rr}v-${h - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} -${rr}Z`;
}

/** 콘솔 상단 메뉴의 높이 */
const HEADER_HEIGHT = 52;
const HEADER_BOTTOM = HEADER_HEIGHT + 8;
const ACTIVE_ATTR = "data-tour-active";
const HEADER_SELECTOR = '[data-testid="console-top-nav"]';

export function TutorialSpotlight({
  resolve,
  dim,
  pulse,
  watchKey,
}: {
  /** 지금 표시할 요소 (화면이 바뀔 때마다 다시 부른다) */
  resolve: () => Element[];
  /** 주변을 어둡게 */
  dim: boolean;
  /** 눌러야 할 곳: 테두리를 깜빡인다 */
  pulse: boolean;
  /** 단계·화면이 바뀌면 달라지는 값 (바뀌면 대상으로 한 번 스크롤한다) */
  watchKey: string;
}) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const overlayRef = useRef<SVGSVGElement>(null);
  // 효과 안에서 최신 resolve를 읽는다
  const resolveRef = useRef(resolve);
  useEffect(() => {
    resolveRef.current = resolve;
  });

  useEffect(() => {
    let frame = 0;
    let scrolled = false;
    let marked: Element[] = [];
    let observed: Element[] = [];
    const sizes = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => schedule()) : null;

    const measure = () => {
      frame = 0;
      const elements = resolveRef.current();
      // E2E·접근성 보조: 지금 표시 중인 요소에 표시를 남긴다
      for (const el of marked) if (!elements.includes(el)) el.removeAttribute(ACTIVE_ATTR);
      for (const el of elements) if (!el.hasAttribute(ACTIVE_ATTR)) el.setAttribute(ACTIVE_ATTR, "");
      marked = elements;
      // 대상 크기가 바뀌면 다시 잰다
      if (sizes && (elements.length !== observed.length || elements.some((el, i) => el !== observed[i]))) {
        for (const el of observed) sizes.unobserve(el);
        for (const el of elements) sizes.observe(el);
        observed = elements;
      }
      const next: Box[] = [];
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const pad = r.width > 240 ? 8 : 5;
        next.push({ x: Math.round(r.left - pad), y: Math.round(r.top - pad), w: Math.round(r.width + pad * 2), h: Math.round(r.height + pad * 2), inHeader: !!el.closest(HEADER_SELECTOR) });
      }
      setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
      setViewport((prev) => (prev.w === window.innerWidth && prev.h === window.innerHeight ? prev : { w: window.innerWidth, h: window.innerHeight }));
      // 대상이 처음 나타났을 때 화면 밖이면 한 번 스크롤한다 (그 뒤에는 사용자의 스크롤을 건드리지 않는다)
      if (!scrolled && elements.length) {
        scrolled = true;
        const el = elements[0];
        const r = el.getBoundingClientRect();
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        const offscreen = r.top < HEADER_BOTTOM || r.top > window.innerHeight * 0.6 || r.bottom < HEADER_BOTTOM;
        if (offscreen && r.height > 0) el.scrollIntoView?.({ block: pulse ? "nearest" : "start", behavior: reduceMotion ? "auto" : "smooth" });
      }
    };
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    // 화면 내용이 바뀌면(페이지 이동, 양식이 늘어남, 메뉴 펼침) 대상과 위치를 다시 찾는다
    const mutations =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((list) => {
            // 이 표시 자체가 바뀐 것은 무시한다
            if (list.every((m) => overlayRef.current?.contains(m.target) || (m.type === "attributes" && m.attributeName === ACTIVE_ATTR))) return;
            schedule();
          })
        : null;
    mutations?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-expanded", ACTIVE_ATTR] });
    sizes?.observe(document.body);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations?.disconnect();
      sizes?.disconnect();
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      for (const el of marked) el.removeAttribute(ACTIVE_ATTR);
    };
  }, [watchKey, pulse]);

  if (typeof document === "undefined" || !boxes.length) return null;
  // 화면 안의 대상은 스크롤되어 상단 메뉴 밑으로 들어가면 거기서 잘린다 (메뉴 위에 테두리가 그려지지 않게)
  const holes = boxes.flatMap((b) => {
    if (b.inHeader) return [b];
    const top = Math.max(b.y, HEADER_HEIGHT);
    const h = b.y + b.h - top;
    return h > 0 ? [{ ...b, y: top, h }] : [];
  });
  const dimPath = dim ? `M0 0H${viewport.w}V${viewport.h}H0Z${holes.map((b) => roundedRect(b, 14)).join("")}` : null;
  return createPortal(
    <svg ref={overlayRef} className="pg-spot" aria-hidden data-testid="tutorial-spotlight" data-dim={dim || undefined}>
      <defs>
        <clipPath id="pg-spot-below-header">
          <rect x={0} y={HEADER_HEIGHT} width={viewport.w} height={Math.max(0, viewport.h - HEADER_HEIGHT)} />
        </clipPath>
      </defs>
      {dimPath && <path d={dimPath} fillRule="evenodd" className="pg-spot-dim" />}
      {boxes.map((b, i) => (
        <g key={i} clipPath={b.inHeader ? undefined : "url(#pg-spot-below-header)"}>
          <g className={pulse ? "pg-spot-pulse" : undefined}>
            <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx={17} className="pg-spot-glow" />
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={14} className="pg-spot-ring" />
          </g>
        </g>
      ))}
    </svg>,
    document.body,
  );
}
