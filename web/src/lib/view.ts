import { useCallback, useState } from "react";

// A finished run reads two ways: Simple, the lay of the land on one screen for anyone (what each model solved, what
// it cost, the chart), and Detailed, every PR, attempt, trace and diff for engineers. Simple is the default.

export type ReportView = "simple" | "detail";

export const VIEW_KEY = "pr-eval-report-view";

/** A view's name as an address or storage spells it: "detail" or "detailed", any case. */
export function asView(value: string | null | undefined): ReportView | null {
  const v = value?.trim().toLowerCase();
  return v === "simple" ? "simple" : v === "detail" || v === "detailed" ? "detail" : null;
}

/** The query after the hash, where the run page's routes keep theirs: "#/runs/x/results?view=detail". */
const hashQuery = (hash: string) => (hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");

/** The view a report opens on. A ?view= in the address wins, so a shared link opens the view it names; then the
 *  last one chosen in this browser; then Simple. */
export function initialView(search: string, hash: string, stored: string | null): ReportView {
  const named = (q: string) => asView(new URLSearchParams(q).get("view"));
  return named(search) ?? named(hashQuery(hash)) ?? asView(stored) ?? "simple";
}

/** The address after choosing a view: a ?view= it already carries follows the choice, so reloading it or copying
 *  it keeps the view on screen. Null when there is nothing to change: an address without one stays as it is. */
export function addressFor(search: string, hash: string, view: ReportView): string | null {
  const set = (q: string) => {
    const p = new URLSearchParams(q);
    if (!p.has("view") || p.get("view") === view) return null;
    p.set("view", view);
    return p.toString();
  };
  const inSearch = set(search), inHash = set(hashQuery(hash));
  if (inSearch == null && inHash == null) return null;
  const path = hash.includes("?") ? hash.slice(0, hash.indexOf("?")) : hash;
  return `${inSearch != null ? `?${inSearch}` : search}${inHash != null ? `${path}?${inHash}` : hash}`;
}

/** The view shown and a way to change it. A change is remembered in this browser; the address's own ?view=
 *  follows it. Shared by the standalone report and the run page, so both open on the same view. */
export function useReportView(): [ReportView, (v: ReportView) => void] {
  const [view, setView] = useState<ReportView>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(VIEW_KEY); } catch { /* storage blocked */ }
    return initialView(location.search, location.hash, stored);
  });
  const choose = useCallback((v: ReportView) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ }
    const next = addressFor(location.search, location.hash, v);
    // A report opened from disk may refuse a new address; the view still changes.
    if (next != null) try { history.replaceState(history.state, "", next); } catch { /* file: page */ }
  }, []);
  return [view, choose];
}
