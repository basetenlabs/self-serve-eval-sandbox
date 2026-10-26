import * as React from "react";
import { Column, LiveDot } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { clock, usd } from "@/lib/format";
import type { Swatch } from "@/lib/models";
import { CHECK, failReason, isLive, prName, STAGE, type Tone } from "@/lib/stages";
import type { Run } from "@/lib/types";
import { toneStyle } from "./Board";
import { cn } from "@/lib/utils";

type Event = { id: number; at: number; tone: Tone; model?: string; who: string; text: string };
let next = 0;

/**
 * What changed since the last poll, as feed lines: checks passing, sandboxes booting, agents
 * starting, attempts finishing. The first look at a run only sets the baseline.
 */
export function useActivity(run: Run, labels: Record<string, string>) {
  const seen = React.useRef(new Map<string, string>());
  const primed = React.useRef(false);
  const [feed, setFeed] = React.useState<Event[]>([]);
  React.useEffect(() => {
    const b = run.board;
    if (!b) return;
    const now = Date.now(), events: Event[] = [];
    const push = (e: Omit<Event, "id" | "at">) => primed.current && events.push({ ...e, id: next++, at: now });
    for (const row of b.rows) {
      const name = prName(row), key = `check|${row.id}`;
      if (seen.current.get(key) !== row.check.stage) {
        const info = CHECK[row.check.stage];
        if (row.check.stage === "passed") push({ tone: "solved", who: name, text: "passed the check: tests fail before, pass after" });
        else if (row.check.stage === "left-out") push({ tone: "idle", who: name, text: `left out: ${row.check.why || "failed the check"}` });
        else if (info?.tone === "check") push({ tone: "check", who: name, text: `check: ${info.label.toLowerCase()}` });
      }
      seen.current.set(key, row.check.stage);
      for (const c of row.cells) {
        const k = `${row.id}|${c.model}|${c.attempt}`;
        if (seen.current.get(k) !== c.stage) {
          const who = `${labels[c.model] ?? c.model} · ${name}`;
          const info = STAGE[c.stage];
          let text = info?.verb;
          if (c.stage === "solved") text = `solved in ${clock(c.seconds ?? 0)}${c.cost != null ? ` for ${usd(c.cost)}` : ""}`;
          if (c.stage === "failed") text = `not solved${failReason(c) ? ` (${failReason(c)})` : ""}`;
          if (c.stage === "invalid") text = `not scored (${c.reason || "infrastructure"})`;
          if (text && info) push({ tone: info.tone, model: c.model, who, text });
        }
        seen.current.set(k, c.stage);
      }
    }
    if (!primed.current) {
      const going = b.rows.flatMap((row) => row.cells).filter((c) => isLive(c.stage)).length;
      events.push({ id: next++, at: now, tone: "idle", who: "Watching", text: `${b.rows.length} PRs, ${going} attempts in flight` });
      primed.current = true;
    }
    if (events.length) setFeed((f) => [...events.reverse(), ...f].slice(0, 80));
  }, [run, labels]);
  return feed;
}

export function Activity({ feed, colors }: { feed: Event[]; colors: Record<string, Swatch> }) {
  const fresh = Date.now() - 3000;
  return (
    <Column heading="Live activity" aside={<Badge variant="live"><LiveDot />Live</Badge>} className="flex min-h-0 flex-col">
      {feed.length ? (
        <ol className="max-h-[560px] min-h-0 overflow-y-auto pr-1" aria-live="polite" aria-relevant="additions">
          {feed.map((e) => {
            const { className, style } = toneStyle(e.tone, e.model ? colors[e.model] : undefined);
            return (
              <li key={e.id} className={cn("grid grid-cols-[12px_1fr_auto] gap-3 border-b border-frame py-2.5 text-[13px] leading-snug", e.at > fresh && "animate-enter")}>
                <span className={cn("mt-1 size-3", className, "animate-none")} style={style} aria-hidden />
                <span className="min-w-0"><b className="font-medium">{e.who}</b> <span className="text-muted-foreground">{e.text}</span></span>
                <time className="num font-mono text-[11px] text-muted-foreground">
                  {new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </time>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="placeholder-cell grid h-40 place-items-center px-6 text-center text-[13px] text-muted-foreground">
          Events stream in here as sandboxes boot, agents code and the judges grade.
        </div>
      )}
    </Column>
  );
}
