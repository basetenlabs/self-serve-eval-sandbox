import type * as React from "react";
import { Column, DeltaChip } from "@/components/brand";
import { Chevron } from "@/components/brand/icons";
import { dur, pct, plural, usd } from "@/lib/format";
import { isOpen, type Swatch } from "@/lib/models";
import { Count, Scramble } from "@/lib/motion";
import { type Paired, solvedBy, type Takeaway, wilson } from "@/lib/stats";
import type { Model, Summary, Task, Trial } from "@/lib/types";
import { cn } from "@/lib/utils";

type Metric = { key: "pass_at_1" | "cost_per_solved" | "median_seconds"; name: string; units: string; format: (x: number | null) => string; delta?: string; max?: number };

// The brand's head-to-head: Baseten's side is Green, the comparison Blue. Each model keeps the colour
// it has in the table and the chart under this, so a second open model is Dark Green, not Green again.
const GREEN = "var(--color-green)", BLUE = "var(--color-blue)", BLACK = "var(--color-black)";

type Side = { m: Model; fill: string; ink: string };

/**
 * Every model of the run, Baseten's open models above the closed comparison, best first. First who
 * solved which of the same PRs, then one row per metric in the brand's head-to-head form: the metric
 * and its pink delta chip on the left, one bar per model on the right, scaled within the metric.
 * The delta chip is the headline's comparison: the open model it names against the closed one.
 */
export function HeadToHead({ t, S, ranked, colors, trials, judged, attempts, onOpen, sample }: {
  t: Takeaway; S: Record<string, Summary>; ranked: Model[]; colors: Record<string, Swatch>; trials: Trial[];
  judged: boolean; attempts: number; onOpen?: (taskId: string) => void; sample?: string | null;
}) {
  if (!t.open || !t.closed) return null;
  const grid = !!t.pairs?.n;
  const scored = ranked.filter((m) => S[m.key]?.valid);
  const sides: Side[] = [...scored.filter(isOpen), ...scored.filter((m) => !isOpen(m))]
    .map((m) => ({ m, fill: colors[m.key]?.fill ?? (isOpen(m) ? GREEN : BLUE), ink: colors[m.key]?.ink ?? BLACK }));
  const many = sides.length > 2;
  // With more than two models the chip says which two it measures.
  const pair = many ? `${t.open.label} vs ${t.closed.label}` : null;
  const fills = (open: boolean) => [...new Set(sides.filter((s) => isOpen(s.m) === open).map((s) => s.fill))];
  const metrics: Metric[] = [
    ...(grid ? [] : [{ key: "pass_at_1", name: "Solve rate", units: "% of attempts · higher is better", format: (x: number | null) => pct(x), delta: t.solve?.text, max: 1 } as Metric]),
    { key: "cost_per_solved", name: "Cost per solved task", units: "USD · lower is better", format: usd, delta: t.cost?.text },
    { key: "median_seconds", name: "Time per task", units: "Median per attempt · lower is better", format: dur, delta: t.time?.text },
  ];
  return (
    <Column
      heading={many ? "Side by side" : "Head to head"}
      aside={
        <span className="label-mono flex items-center gap-4 text-muted-foreground">
          {([["Open, on Baseten", fills(true)], ["Closed", fills(false)]] as const).map(([name, chips]) => (
            <span key={name} className="inline-flex items-center gap-2">
              <span aria-hidden className="inline-flex">{chips.map((fill) => <span key={fill} className="size-2.5" style={{ background: fill }} />)}</span>
              {name}
            </span>
          ))}
        </span>
      }
    >
      <div>
        {grid && <Solved p={t.pairs!} sides={sides} by={solvedBy(trials)} S={S} judged={judged} attempts={attempts} onOpen={onOpen} sample={sample} />}
        {metrics.map((metric) => {
          const values = sides.map((s) => S[s.m.key]?.[metric.key] ?? null);
          const max = metric.max ?? (Math.max(...values.map((v) => v ?? 0)) || 1);
          return (
            <div key={metric.key} className={ROW}>
              <div>
                <h3 className="text-[20px] leading-7 font-normal">{metric.name}</h3>
                <div className="label-mono mt-0.5 text-muted-foreground">{metric.units}</div>
                {metric.delta && <DeltaChip className="mt-3">{metric.delta}</DeltaChip>}
                {metric.delta && pair && <div className="label-xs mt-2 max-w-[30ch] leading-[1.5] text-muted-foreground">{pair}</div>}
              </div>
              <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:gap-y-0">
                {sides.map((s, i) => {
                  const v = values[i];
                  const w = v == null ? 0 : Math.max(0.5, (v / max) * 100);
                  const inside = w >= 45; // under half the track the value sits after the bar, so it never spills onto the name
                  return (
                    <div key={s.m.key} className="contents">
                      <div className={cn("label-mono truncate text-foreground sm:text-right", i > 0 && "max-sm:mt-2")} title={s.m.label}>{s.m.label}</div>
                      <div className="relative h-10 bg-surface">
                        {v == null ? (
                          <div className="placeholder-cell flex h-full items-center px-3 label-mono text-muted-foreground">Not measured</div>
                        ) : (
                          <div className="relative h-full origin-left animate-grow" style={{ width: `${w}%`, background: s.fill, animationDelay: `${i * 80}ms` }}>
                            <span className={cn("num absolute top-1/2 -translate-y-1/2 font-mono text-[12px] whitespace-nowrap", inside ? "right-3" : "left-full ml-2 text-foreground")}
                              style={inside ? { color: s.ink } : undefined}>
                              {metric.format(v)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="label-xs border-t border-lightGrey2 pt-3 text-muted-foreground">{grid ? "Cost and time scaled within each metric" : "Solve rate out of 100%; cost and time scaled within each metric"}</div>
    </Column>
  );
}

const ROW = "grid items-center gap-x-8 gap-y-3 border-t border-rule py-6 first:border-t-0 first:pt-2 md:grid-cols-[300px_minmax(0,1fr)]";

// One card per model: two side by side, three in a row from tablet width, four in a row on a wide
// screen. More than four wrap, with blank cells finishing the last row so no grey gap shows.
const CARDS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-1 sm:grid-cols-3", 4: "grid-cols-2 xl:grid-cols-4" };

/** What each model solved on the headline's PRs, big, with its cost per solved task. The solve rate,
 *  its 95% range and each PR's result stay in a details row under it. */
function Solved({ p, sides: shown, by, S, judged, attempts, onOpen, sample }: {
  p: Paired; sides: Side[]; by: Map<string, Map<string, boolean>>; S: Record<string, Summary>; judged: boolean; attempts: number;
  onOpen?: (taskId: string) => void; sample?: string | null;
}) {
  // How to read the rates, said only once someone opens them.
  const notes: [string, string][] = [
    ["Single pass", "Read these rates as a floor. Each attempt is one pass with no second try and no human review, and the agent never sees the PR's tests or reaches GitHub or package registries. In real work a developer reviews the change, runs the tests and sends the agent back for another pass."],
    ...(sample ? [["Small sample", sample] as [string, string]] : []),
  ];
  // Solved by both of the headline's models first, then by one, so the list reads like the figures above it.
  const tasks = [...p.both, ...p.open, ...p.closed, ...p.neither];
  // A model beyond the headline's two may have lost its attempt on one of these PRs: that PR counts
  // as not scored for it, said on its card.
  const sides = shown.map((s) => {
    const mine = by.get(s.m.key);
    const has = new Set(tasks.filter((task) => mine?.get(task.id)));
    return { ...s, has, n: has.size, scored: new Set(tasks.filter((task) => mine?.has(task.id))) };
  });
  const many = sides.length > 2;
  const blanks = sides.length > 4 ? { two: sides.length % 2, three: (3 - (sides.length % 3)) % 3 } : { two: 0, three: 0 };
  return (
    <div className={cn(ROW, "items-start")}>
      <div>
        <h3 className="text-[20px] leading-7 font-normal">Solved</h3>
        <div className="label-mono mt-0.5 text-muted-foreground">The same {plural(p.n, "PR")} · higher is better</div>
        <p className="mt-3 max-w-[34ch] text-[14px] leading-5 text-muted-foreground">
          Solved = the PR's own hidden tests pass{judged ? " and the judges agree" : ""}. The model never sees the tests or the merged diff.
          {attempts > 1 ? " A PR counts as solved when at least half its attempts were." : ""}
        </p>
      </div>
      <div className="grid gap-4">
        <div className={cn("grid gap-px bg-lightGrey2", CARDS[sides.length] ?? "grid-cols-2 lg:grid-cols-3")}>
          {sides.map((s) => (
            <div key={s.m.key} className="min-w-0 bg-surface p-5">
              <div className="label-mono flex min-w-0 items-center gap-2 text-foreground">
                <span aria-hidden className="size-2.5 shrink-0" style={{ background: s.fill }} />
                <span className="truncate" title={s.m.label}>{s.m.label}</span>
              </div>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <span className="num text-[48px] leading-none tracking-[-0.03em]"><Count value={s.n} /><span className="ml-2 text-[20px] tracking-[-0.01em]">solved</span></span>
                <span className="text-[16px] text-muted-foreground">
                  <b className="num font-medium text-foreground"><Scramble value={usd(S[s.m.key]?.cost_per_solved)} /></b> per solved task
                </span>
              </div>
              {s.scored.size < tasks.length && (
                <div className="label-xs mt-3 text-muted-foreground">{tasks.length - s.scored.size} of these PRs not scored</div>
              )}
            </div>
          ))}
          {Array.from({ length: blanks.two }, (_, i) => <div key={`two-${i}`} aria-hidden className="bg-surface lg:hidden" />)}
          {Array.from({ length: blanks.three }, (_, i) => <div key={`three-${i}`} aria-hidden className="hidden bg-surface lg:block" />)}
        </div>
        <details className="ev-details">
          <summary>
            <Chevron />Solve rate, 95% range and each PR
          </summary>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-px bg-lightGrey2">
              {notes.map(([label, text]) => (
                <div key={label} className="flex flex-col gap-1 bg-background py-2.5 sm:flex-row sm:gap-4">
                  <span className="label-xs w-28 shrink-0 pt-0.5 text-foreground">{label}</span>
                  <span className="text-[14px] leading-5 text-muted-foreground">{text}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] text-muted-foreground">
              {sides.map((s) => {
                const r = S[s.m.key];
                const ci = r ? wilson(r.solved, r.valid) : null;
                return (
                  <span key={s.m.key} className="inline-flex items-center gap-2">
                    <span aria-hidden className="size-2" style={{ background: s.fill }} />
                    {s.m.label} <b className="num font-medium text-foreground">{pct(r?.pass_at_1)}</b> per attempt
                    {ci && <span className="num">(95% range {pct(ci[0])}–{pct(ci[1])})</span>}
                  </span>
                );
              })}
            </div>
            <ul className="grid grid-cols-[minmax(0,1fr)] border-t border-lightGrey2">
              {tasks.map((task) => (
                <li key={task.id} className="border-b border-lightGrey2">
                  <PullRow task={task} onOpen={onOpen}>
                    {sides.map((s) => {
                      const state = s.has.has(task) ? "Solved" : s.scored.has(task) ? "Not solved" : "Not scored";
                      const mark = state === "Not scored" ? null
                        : <span aria-hidden className="size-2" style={state === "Solved" ? { background: s.fill } : { border: "1px solid var(--color-darkGrey3)" }} />;
                      // Two models have room for the word; more show the square alone, in the order of the line above.
                      return many ? (
                        <span key={s.m.key} className="inline-flex w-4 shrink-0 justify-center" title={`${s.m.label}: ${state}`}>
                          {mark}<span className="sr-only">{s.m.label}: {state}</span>
                        </span>
                      ) : (
                        <span key={s.m.key} className="label-xs inline-flex w-24 shrink-0 items-center gap-1.5 text-muted-foreground">
                          {mark}{state === "Solved" ? "Solved" : "—"}
                        </span>
                      );
                    })}
                  </PullRow>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </div>
  );
}

/** One PR's line: opens its attempts on the page, or the PR on GitHub where the page can't. */
function PullRow({ task, onOpen, children }: { task: Task; onOpen?: (taskId: string) => void; children: React.ReactNode }) {
  const body = (
    <>
      <span className="w-36 shrink-0 truncate font-mono text-[12px] text-muted-foreground">{task.repo.split("/").pop()}#{task.pr}</span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-foreground group-hover/pr:underline">{task.title || `#${task.pr}`}</span>
      {children}
    </>
  );
  const cls = "group/pr flex w-full min-w-0 items-center gap-3 px-1.5 py-1.5 text-left hover:bg-muted focus-visible:outline-offset-0";
  const title = `${task.repo}#${task.pr}: ${task.title}`;
  if (onOpen) return <button type="button" onClick={() => onOpen(task.id)} className={cls} title={title}>{body}</button>;
  return task.url
    ? <a href={task.url} target="_blank" rel="noopener" className={cls} title={title}>{body}</a>
    : <div className={cls} title={title}>{body}</div>;
}
