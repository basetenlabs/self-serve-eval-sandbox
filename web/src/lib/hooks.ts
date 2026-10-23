import { useCallback, useEffect, useState } from "react";

// ---------- hash routes: #/ and #/runs/<id>[/<tab>] ----------

export type Route = { page: "home" } | { page: "run"; id: string; tab?: string };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "runs" && parts[1]) return { page: "run", id: parts[1], tab: parts[2] };
  return { page: "home" };
}

export const href = (route: Route) =>
  route.page === "run" ? `#/runs/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ""}` : "#/";

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((r: Route, replace = false) => {
    const next = href(r);
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
    setRoute(r);
    if (!replace) window.scrollTo({ top: 0 });
  }, []);
  return [route, go];
}

// ---------- theme: light is the brand default; dark is remembered per browser ----------

export function useTheme(): ["light" | "dark", () => void] {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light");
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try { localStorage.setItem("pr-eval-theme", next); } catch { /* private window */ }
      return next;
    });
  }, []);
  return [theme, toggle];
}

/** A value kept in localStorage for this browser, e.g. the last models chosen. */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
  }, [key]);
  return [value, set];
}
