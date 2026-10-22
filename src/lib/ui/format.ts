const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return "방금 전";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDateTime(iso);
}

export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  return new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" }).format(t);
}

export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  return new Intl.DateTimeFormat("ko", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(t);
}

export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
