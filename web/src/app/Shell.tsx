import { ChevronRightIcon, MoonIcon, SunIcon } from "lucide-react";
import * as React from "react";
import { BasetenLogo, LiveDot } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { href, type Route, useTheme } from "@/lib/hooks";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The page frame: top bar, the blueprint guides of baseten.co, and a footer. */
export function Shell({ state, route, go, offline, children }: {
  state: AppState | null;
  route: Route;
  go: (r: Route) => void;
  offline: boolean;
  children: React.ReactNode;
}) {
  const [theme, toggleTheme] = useTheme();
  const live = state?.runs.find((r) => ["collecting", "checking", "running"].includes(r.phase));
  const sandboxes = live?.board?.sandboxes ?? 0;
  const slot = React.useRef<HTMLDivElement>(null);

  // On the hosted page the sign-in gateway appends a Sign out form to the body; it belongs up here.
  React.useEffect(() => {
    const form = document.querySelector("form.auth-session");
    if (form && slot.current && form.parentElement !== slot.current) slot.current.append(form);
  });

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-dashed border-rule bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-4 px-4 sm:px-6 md:guide-x md:px-8">
          <a href="#/" onClick={(e) => { e.preventDefault(); go({ page: "home" }); }} className="flex items-center gap-3" aria-label="Eval Sandbox home">
            <BasetenLogo className="h-[22px] w-auto" />
            <span className="h-5 w-px bg-rule" aria-hidden />
            <span className="label-mono text-[12px] whitespace-nowrap text-foreground">Eval Sandbox</span>
          </a>
          {route.page === "run" && (
            <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-muted-foreground md:flex">
              <ChevronRightIcon className="size-3.5 shrink-0" />
              <a href={href({ page: "home" })} className="label-mono hover:text-foreground">Runs</a>
              <ChevronRightIcon className="size-3.5 shrink-0" />
              <span className="label-mono truncate text-foreground">{route.id}</span>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            {offline ? (
              <span className="label-mono hidden items-center gap-2 text-[#AC0EB2] sm:inline-flex dark:text-[#FFA9FD]">
                <span className="size-1.5 bg-current" /> Page server unreachable
              </span>
            ) : live ? (
              <a
                href={href({ page: "run", id: live.id })}
                className="label-mono hidden items-center gap-2 bg-[#D7FACE] px-2.5 py-1.5 text-black transition-colors hover:bg-[#19E76E] sm:inline-flex dark:bg-[#213026] dark:text-[#19E76E] dark:hover:bg-[#213026]/70"
              >
                <LiveDot /> Run in progress
                {sandboxes > 0 && <span className="opacity-70">· {sandboxes} sandboxes</span>}
              </a>
            ) : state ? (
              <span className="label-mono hidden items-center gap-2 text-muted-foreground sm:inline-flex">
                <span className="size-1.5 bg-foreground" /> Ready
              </span>
            ) : null}
            <Tip content={theme === "dark" ? "Light theme" : "Dark theme"}>
              <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </Button>
            </Tip>
            <div ref={slot} className="session-slot contents" />
          </div>
        </div>
      </header>
      <main className={cn("mx-auto max-w-[1320px] md:guide-x")}>{children}</main>
      <footer className="border-t border-dashed border-rule">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-6 md:guide-x md:px-8">
          <span className="label-mono text-muted-foreground">Baseten ▪ Eval Sandbox</span>
          <span className="label-mono text-muted-foreground">
            Also from a terminal: <code className="normal-case tracking-normal text-foreground">pr-eval run --quick</code>
          </span>
        </div>
      </footer>
    </div>
  );
}
