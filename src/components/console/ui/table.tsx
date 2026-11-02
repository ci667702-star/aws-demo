"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";
import { useEffect, useMemo, useState } from "react";
import { SearchInput } from "./form";

export interface TableColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (item: T) => React.ReactNode;
  /** 정렬 기준 값 (없으면 정렬 불가) */
  sortValue?: (item: T) => string | number;
  /** 검색에 쓰는 텍스트 (없으면 sortValue를 사용) */
  filterValue?: (item: T) => string;
  /** 보조 정보 열 — 기본으로 숨기고 "열 더 보기"를 누르면 표시한다 */
  optional?: boolean;
  minWidth?: number;
}

export interface ResourceTableProps<T> {
  items: T[];
  columns: TableColumn<T>[];
  trackBy: (item: T) => string;
  header?: React.ReactNode;
  selectionType?: "single" | "multi";
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /** 선택 체크박스의 접근성 레이블 */
  rowLabel?: (item: T) => string;
  filtering?: boolean;
  filterPlaceholder?: string;
  empty?: React.ReactNode;
  pageSize?: number;
  variant?: "container" | "embedded";
  ariaLabel: string;
  defaultSort?: { columnId: string; descending?: boolean };
}

export function ResourceTable<T>({
  items,
  columns,
  trackBy,
  header,
  selectionType,
  selectedIds = [],
  onSelectionChange,
  rowLabel,
  filtering = true,
  filterPlaceholder = "리소스 찾기",
  empty,
  pageSize = 20,
  variant = "container",
  ariaLabel,
  defaultSort,
}: ResourceTableProps<T>) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ columnId: string; descending: boolean } | null>(
    defaultSort ? { columnId: defaultSort.columnId, descending: !!defaultSort.descending } : null,
  );
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const hasOptional = columns.some((c) => c.optional);
  const shown = showAll ? columns : columns.filter((c) => !c.optional);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      columns.some((c) => {
        const v = c.filterValue?.(item) ?? c.sortValue?.(item);
        return v !== undefined && String(v).toLowerCase().includes(q);
      }),
    );
  }, [items, columns, filter]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col?.sortValue) return filtered;
    const dir = sort.descending ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const x = col.sortValue!(a);
      const y = col.sortValue!(b);
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), "ko", { numeric: true }) * dir;
    });
  }, [filtered, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages);
  const visible = sorted.slice((current - 1) * pageSize, current * pageSize);

  // 사라진 리소스는 선택에서 뺀다
  const itemIds = useMemo(() => new Set(items.map(trackBy)), [items, trackBy]);
  useEffect(() => {
    if (!onSelectionChange) return;
    const kept = selectedIds.filter((id) => itemIds.has(id));
    if (kept.length !== selectedIds.length) onSelectionChange(kept);
  }, [itemIds, selectedIds, onSelectionChange]);

  const select = (id: string, on: boolean) => {
    if (!onSelectionChange) return;
    if (selectionType === "single") onSelectionChange(on ? [id] : []);
    else onSelectionChange(on ? [...selectedIds.filter((x) => x !== id), id] : selectedIds.filter((x) => x !== id));
  };

  const allVisibleSelected = visible.length > 0 && visible.every((item) => selectedIds.includes(trackBy(item)));

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (!selectionType) return;
    const target = e.target as HTMLElement;
    if (target.closest("a,button,input,select,textarea,label")) return;
    if (selectionType === "single") select(id, true);
    else select(id, !selectedIds.includes(id));
  };

  const table = (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[15px]" aria-label={ariaLabel}>
        <thead>
          <tr className="border-b border-aws-border">
            {selectionType && (
              <th scope="col" className="w-11 px-3 py-3 text-left">
                {selectionType === "multi" ? (
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-[var(--aws-link)]"
                    aria-label="현재 페이지 모두 선택"
                    checked={allVisibleSelected}
                    onChange={(e) => {
                      const ids = visible.map(trackBy);
                      onSelectionChange?.(e.target.checked ? [...new Set([...selectedIds, ...ids])] : selectedIds.filter((x) => !ids.includes(x)));
                    }}
                  />
                ) : (
                  <span className="sr-only">선택</span>
                )}
              </th>
            )}
            {shown.map((c) => {
              const active = sort?.columnId === c.id;
              return (
                <th
                  key={c.id}
                  scope="col"
                  style={{ minWidth: c.minWidth }}
                  aria-sort={active ? (sort!.descending ? "descending" : "ascending") : undefined}
                  className="px-3 py-3 text-left text-sm font-bold whitespace-nowrap text-aws-text-2"
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-aws-text"
                      onClick={() => setSort(active ? { columnId: c.id, descending: !sort!.descending } : { columnId: c.id, descending: false })}
                    >
                      {c.header}
                      {active ? sort!.descending ? <ArrowDown className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden /> : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td colSpan={shown.length + (selectionType ? 1 : 0)} className="text-aws-text-2">
                {filter && items.length > 0 ? (
                  <div className="py-6 text-center text-sm">
                    <p className="font-bold text-aws-text">일치하는 리소스 없음</p>
                    <button type="button" className="mt-2 text-aws-link hover:underline" onClick={() => setFilter("")}>
                      필터 지우기
                    </button>
                  </div>
                ) : (
                  (empty ?? <p className="py-6 text-center text-sm">리소스가 없습니다.</p>)
                )}
              </td>
            </tr>
          ) : (
            visible.map((item) => {
              const id = trackBy(item);
              const selected = selectedIds.includes(id);
              return (
                <tr
                  key={id}
                  onClick={(e) => onRowClick(e, id)}
                  aria-selected={selectionType ? selected : undefined}
                  className={cn(
                    "border-b border-aws-divider last:border-b-0",
                    selectionType && "cursor-pointer",
                    selected ? "bg-aws-selected outline-2 -outline-offset-2 outline-aws-link" : "hover:bg-aws-surface-2",
                  )}
                >
                  {selectionType && (
                    <td className="px-3 py-3 align-middle">
                      <input
                        type={selectionType === "single" ? "radio" : "checkbox"}
                        className="size-4 cursor-pointer accent-[var(--aws-link)]"
                        checked={selected}
                        aria-label={`${rowLabel?.(item) ?? id} 선택`}
                        onChange={(e) => select(id, selectionType === "single" ? true : e.target.checked)}
                      />
                    </td>
                  )}
                  {shown.map((c) => (
                    <td key={c.id} className="px-3 py-3 align-middle text-aws-text">
                      {c.cell(item)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );

  const toolbar = (filtering || pages > 1 || hasOptional) && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {filtering ? <SearchInput value={filter} onChange={(v) => { setFilter(v); setPage(1); }} placeholder={filterPlaceholder} className="w-full max-w-md" /> : <span />}
      {hasOptional && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="text-sm font-bold text-aws-link hover:underline" aria-pressed={showAll}>
          {showAll ? "간단히 보기" : `열 더 보기 (+${columns.length - shown.length})`}
        </button>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-1 text-sm" aria-label="페이지">
          <button type="button" className="rounded p-1 text-aws-text-2 hover:text-aws-text disabled:opacity-40" disabled={current <= 1} onClick={() => setPage(current - 1)} aria-label="이전 페이지">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              aria-current={n === current ? "page" : undefined}
              onClick={() => setPage(n)}
              className={cn("min-w-6 rounded px-1 py-0.5", n === current ? "font-bold text-aws-text" : "text-aws-text-2 hover:text-aws-text")}
            >
              {n}
            </button>
          ))}
          <button type="button" className="rounded p-1 text-aws-text-2 hover:text-aws-text disabled:opacity-40" disabled={current >= pages} onClick={() => setPage(current + 1)} aria-label="다음 페이지">
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </nav>
      )}
    </div>
  );

  if (variant === "embedded") {
    return (
      <div className="space-y-3">
        {header}
        {toolbar}
        {table}
      </div>
    );
  }
  return (
    <section className="rounded-2xl border border-aws-border bg-aws-surface shadow-[0_1px_3px_rgba(0,7,22,0.08)]">
      {(header || toolbar) && (
        <div className="space-y-4 px-6 pt-5 pb-4">
          {header}
          {toolbar}
        </div>
      )}
      <div className="px-3 pb-3">{table}</div>
    </section>
  );
}
