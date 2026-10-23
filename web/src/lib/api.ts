import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, PullList, RepoInfo, Report, Trace } from "./types";

// The page polls quickly while a run is going and slowly otherwise. Every action goes through
// `pr-eval serve`, which runs it as an ordinary `pr-eval run` process.
const FAST_MS = 2500;
const SLOW_MS = 15000;

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal, headers: { accept: "application/json" } });
  if (res.status === 401 || res.redirected) {
    location.reload(); // the hosted page's sign-in expired; the gateway shows its sign-in page
    throw new Error("Signed out");
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json() as Promise<T>;
}

export async function post<T = { ok?: boolean; id?: string; error?: string }>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    return (await res.json()) as T;
  } catch {
    return { error: `The page server answered ${res.status}.` } as T;
  }
}

export const repoInfo = (name: string, signal?: AbortSignal) =>
  getJSON<RepoInfo>(`/api/repo?name=${encodeURIComponent(name)}`, signal);

/** A repository's latest merged pull requests, or the given ones, with whether each can be a task. */
export function usePulls(repo: string | null, numbers?: number[], count?: number) {
  const url = repo ? `/api/prs?repo=${encodeURIComponent(repo)}${numbers?.length ? `&numbers=${numbers.join(",")}` : ""}${count ? `&count=${count}` : ""}` : null;
  const [got, setGot] = useState<{ url: string; repo: string; list: PullList } | null>(null);
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    // The server's own answers carry `error`, sent with HTTP 400, so read the body either way.
    fetch(url, { cache: "no-store", signal: abort.signal, headers: { accept: "application/json" } })
      .then((res) => res.json() as Promise<PullList>)
      .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }) as PullList)
      .then((list) => { if (!abort.signal.aborted) setGot({ url, repo: repo!, list }); });
    return () => abort.abort();
  }, [url, repo]);
  const list = got && got.url === url ? got.list : null;
  // While a longer list of the same repository loads, the shorter one stays on screen.
  const shown = list ?? (got && got.repo === repo && !got.list.error ? got.list : null);
  return { list, shown, loading: !!url && !list };
}

/** One attempt's condensed trace, fetched when `enabled` first turns true. */
export function useTrace(runId: string, trial: string, enabled: boolean) {
  const [trace, setTrace] = useState<Trace | null>(null);
  useEffect(() => {
    if (!enabled || trace) return;
    const abort = new AbortController();
    fetch(`/api/trace?run=${encodeURIComponent(runId)}&trial=${encodeURIComponent(trial)}`,
      { cache: "no-store", signal: abort.signal, headers: { accept: "application/json" } })
      .then((res) => res.json() as Promise<Trace>)
      .catch(() => ({ error: "The trace didn't load. Is the page server still running?" }) as Trace)
      .then((t) => { if (!abort.signal.aborted) setTrace(t); });
    return () => abort.abort();
  }, [runId, trial, enabled, trace]);
  return trace;
}

/** The page's state; `viewing` names the run on screen, so its board comes along even when it isn't the latest. */
export function useAppState(viewing?: string) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const fast = useRef(false);
  const run = useRef(viewing);
  run.current = viewing;

  const refresh = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const next = await getJSON<AppState>(`/api/state${run.current ? `?run=${encodeURIComponent(run.current)}` : ""}`);
      setState(next);
      setError(null);
      fast.current = next.busy;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      timer.current = window.setTimeout(refresh, fast.current ? FAST_MS : SLOW_MS);
    }
  }, []);

  /** Poll quickly for a while, e.g. right after starting or stopping a run. */
  const hurry = useCallback(() => {
    fast.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, viewing]); // again when another run comes on screen

  return { state, error, refresh, hurry };
}

/** A run's report.json, fetched again whenever `version` changes (more attempts finished). */
export function useReport(runId: string | null, version: string | number | null) {
  const [report, setReport] = useState<Report | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!runId || version == null) return;
    const abort = new AbortController();
    getJSON<Report>(`/${encodeURIComponent(runId)}/report.json`, abort.signal)
      .then((r) => { setReport(r); setMissing(false); })
      .catch((e) => { if (!abort.signal.aborted) { setMissing(true); console.warn(e); } });
    return () => abort.abort();
  }, [runId, version]);
  useEffect(() => { setReport(null); setMissing(false); }, [runId]);
  return { report, missing };
}

/** The current time, ticking every `ms`, for live timers. */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return now;
}
