import * as React from "react";
import { Column, Empty, isActive, Swatch } from "@/components/brand";
import { useNow } from "@/lib/api";
import { clock, pct, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import { isChecking, isFinal, isLive, SANDBOXES, STAGE, type Tone } from "@/lib/stages";
import type { Model, Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Activity, useActivity } from "./Activity";
import { Board, BoardLegend, toneStyle } from "./Board";

/** The run as it happens: the sandbox fleet, progress, scores so far, the board and a feed. */
export function LivePanel({ run, models, colors, onOpen }: { run: Run; models: Model[]; colors: Record<string, SwatchT>; onOpen?: (taskId: string) => void }) {
  const active = isActive(run.phase);
  const now = useNow(1000, active);
  const labels = React.useMemo(() => Object.fromEntries(models.map((m) => [m.key, m.label])), [models]);
  const feed = useActivity(run, labels);
  const b = run.board;
  if (!b) {
    return <Empty title={active ? "Finding pull requests" : "No board for this run"}>{run.detail || "The board fills in as PRs are found and checked."}</Empty>;
  }
  // A run that ended before any model started has no fleet, progress or scores to show.
  if (!active && !b.rows.some((row) => row.cells.some((c) => isFinal(c) || isLive(c.stage)))) {
    return <Empty title="No attempts ran">{run.phase === "stopped" ? "The run was stopped before any model started." : "The run ended before any model started; the note above says why."}</Empty>;
  }
  return (
    <div className="grid gap-12">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,1.1fr)]">
        <Fleet run={run} colors={colors} />
        <Progress run={run} now={now} />
        <Scores run={run} models={models} colors={colors} />
      </div>
      {b.rows.length > 0 && (
        <div className={cn("grid gap-10", active && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
          <Column heading="Board" aside={<span className="label-xs text-muted-foreground">{onOpen ? "Open a finished cell for its diff and trace" : "One row per PR · one cell per attempt"}</span>} className="min-w-0">
            <Board run={run} models={models} colors={colors} now={now} onOpen={onOpen} />
            <div className="mt-4"><BoardLegend judged={run.judged !== false} /></div>
          </Column>
          {active && <Activity feed={feed} colors={colors} />}
        </div>
      )}
    </div>
  );
}

/** One square per Blaxel sandbox, in board order so a square changes colour in place. */
function Fleet({ run, colors }: { run: Run; colors: Record<string, SwatchT> }) {
  const b = run.board!;
  const active = isActive(run.phase);
  const vms: { tone: Tone; model?: string; verifier?: boolean }[] = [];
  if (active) {
    for (const row of b.rows) {
      if (isChecking(row)) vms.push({ tone: "check" });
      for (const c of row.cells) {
        const n = SANDBOXES[c.stage] ?? 0;
        const tone = STAGE[c.stage]?.tone ?? "idle";
        if (n === 2) vms.push({ tone, model: c.model }, { tone: "tests", verifier: true });
        else if (n === 1) vms.push({ tone: "tests" });
      }
    }
  }
  const cells = b.rows.flatMap((r) => r.cells);
  const scored = cells.filter((c) => c.stage !== "left-out" && c.stage !== "not-run").length;
  const capacity = Math.min(96, Math.max(vms.length, (b.concurrency || 8) * 2));
  return (
    <Column heading="Sandboxes" aside={active ? <span className="label-xs text-muted-foreground">Up to {capacity} at once</span> : null}>
      <div className="flex items-baseline gap-3">
        <span className="ev-figure">{active ? b.sandboxes : 0}</span>
        <span className="text-[14px] text-muted-foreground">{active ? "running in parallel" : `all deleted · ${scored * 2} used`}</span>
      </div>
      {active && (
        <>
          <div className="ev-fleet mt-6" aria-hidden>
            {Array.from({ length: capacity }, (_, i) => {
              const v = vms[i];
              if (!v) return <i key={i} className="aspect-square ev-tone idle" />;
              if (v.verifier) return <i key={i} className="aspect-square ev-tone verifier" />;
              const { className, style } = toneStyle(v.tone, v.model ? colors[v.model] : undefined);
              return <i key={i} className={cn("aspect-square transition-colors duration-500", className)} style={style} />;
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-2"><i className="size-2.5 bg-lightGreen" />Agent, in its model's colour</span>
            <span className="inline-flex items-center gap-2"><i className="ev-tone verifier size-2.5" />Verifier waiting</span>
            <span className="inline-flex items-center gap-2"><i className="size-2.5 bg-darkGrey1" />Hidden tests</span>
            <span className="inline-flex items-center gap-2"><i className="ev-tone idle size-2.5" />Free</span>
          </div>
        </>
      )}
    </Column>
  );
}

function Progress({ run, now }: { run: Run; now: number }) {
  const active = isActive(run.phase);
  const cells = run.board!.rows.flatMap((r) => r.cells);
  const finished = cells.filter(isFinal).length;
  const scored = cells.filter((c) => c.stage !== "left-out" && c.stage !== "not-run").length;
  const share = scored ? finished / scored : 0;
  let seconds = run.started ? ((active ? now : new Date(run.active_at).getTime()) - new Date(run.started).getTime()) / 1000 : null;
  if (!active && seconds != null && seconds > 3 * 3600) seconds = null; // regraded or resumed later: the span isn't the run's time
  return (
    <Column heading="Progress">
      <div className="flex items-baseline gap-3">
        <span className="ev-figure">{Math.round(share * 100)}%</span>
        <span className="text-[14px] text-muted-foreground">{finished} of {scored || "–"} attempts</span>
      </div>
      <div className="ev-meter mt-6" aria-hidden>
        <i className="!bg-black" style={{ width: `${share * 100}%` }} />
      </div>
      {seconds != null && (
        <div className="mt-6">
          <div className="label-xs text-muted-foreground">{active ? "Wall clock" : "Total wall clock"}</div>
          <div className="num mt-2 font-mono text-[24px] leading-8">{clock(seconds)}</div>
        </div>
      )}
    </Column>
  );
}

function Scores({ run, models, colors }: { run: Run; models: Model[]; colors: Record<string, SwatchT> }) {
  const cells = run.board!.rows.flatMap((r) => r.cells);
  return (
    <Column heading={isActive(run.phase) ? "Solved so far" : "Solved"}>
      <ul className="grid gap-4">
        {models.map((m) => {
          const mine = cells.filter((c) => c.model === m.key);
          const solved = mine.filter((c) => c.stage === "solved").length;
          const graded = mine.filter((c) => c.stage === "solved" || c.stage === "failed").length;
          const spent = mine.reduce((s, c) => s + (c.cost || 0), 0);
          return (
            <li key={m.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium"><Swatch swatch={colors[m.key]} /><span className="truncate">{m.label}</span></span>
                <span className="num text-[24px] leading-8">{graded ? `${solved}/${graded}` : "–"}</span>
              </div>
              {m.model && <div className="truncate font-mono text-[12px] text-muted-foreground">{m.model}</div>}
              <div className="mt-2 h-2 bg-lightGrey1" aria-hidden>
                <div className="h-full transition-[width] duration-700" style={{ width: `${graded ? (100 * solved) / graded : 0}%`, background: colors[m.key]?.fill }} />
              </div>
              <div className="label-xs mt-2 text-muted-foreground">
                {[graded ? `${pct(solved / graded)} solved` : "Waiting for results", spent ? `${usd(spent)} spent` : null, solved ? `${usd(spent / solved)} per solve` : null].filter(Boolean).join(" · ")}
              </div>
            </li>
          );
        })}
      </ul>
    </Column>
  );
}
