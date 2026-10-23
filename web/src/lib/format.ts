// Number and time formats. A dash stands for "not measured", never zero.

export const DASH = "–";

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? DASH : `${(x * 100).toFixed(digits)}%`);

export const usd = (x: number | null | undefined) =>
  x == null ? DASH : x >= 100 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;

/** Short spend figure for running totals: $7.02, $0.43. */
export const money = (x: number | null | undefined) => (x == null ? DASH : `$${x.toFixed(2)}`);

/** A duration in seconds as 42s, 2.3 min or 1.4 h. */
export const dur = (s: number | null | undefined) =>
  s == null ? DASH : s < 90 ? `${Math.round(s)}s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;

/** Elapsed wall clock as 1d 2h 5m, 12m, 40s. */
export function elapsed(seconds: number | null | undefined): string {
  if (seconds == null) return DASH;
  const minutes = Math.floor(seconds / 60);
  if (!minutes) return `${Math.round(seconds)}s`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return [days ? `${days}d` : null, hours ? `${hours}h` : null, minutes % 60 ? `${minutes % 60}m` : null].filter(Boolean).join(" ");
}

/** A running timer: 0:42, 12:05, 1:02:09. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export const compact = (n: number | null | undefined) =>
  n == null ? DASH : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;

/** A ratio for "3.4× cheaper": one decimal below 10, whole numbers above. */
export const ratio = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function day(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function when(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const secondsSince = (iso: string | null | undefined, now = Date.now()) =>
  iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : 0;
