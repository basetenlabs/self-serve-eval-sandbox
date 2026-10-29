import { ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { Column, DeltaChip } from "@/components/brand";
import { dur, pct, plural, usd } from "@/lib/format";
import { type Paired, type Takeaway, wilson } from "@/lib/stats";
import type { Model, Summary, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

type Metric = { key: "pass_at_1" | "cost_per_solved" | "median_seconds"; name: string; units: string; format: (x: number | null) => string; delta?: string; max?: number };

// The brand's head-to-head: Baseten's bar is always Green, the comparison always Blue.
const GREEN = "#19E76E", BLUE = "#3DA6FF";

/**
 * Baseten's open model against the closed comparison. First who solved which of the same PRs, then
 * one row per metric in the brand's head-to-head form: the metric and its pink delta chip on the
 * left, the Baseten bar directly above the comparison bar on the right, scaled within the metric.
 */
export function HeadToHead({ t, S, judged, attempts, onOpen, sample }: {
  t: Takeaway; S: Record<string, Summary>; judged: boolean; attempts: number; onOpen?: (taskId: string) => void; sample?: string | null;
}) {
  if (!t.open || !t.closed) return null;
  const grid = !!t.pairs?.n;
  const metrics: Metric[] = [
    ...(grid ? [] : [{ key: "pass_at_1", name: "Solve rate", units: "% of attempts · higher is better", format: (x: number | null) => pct(x), delta: t.solve?.text, max: 1 } as Metric]),
    { key: "cost_per_solved", name: "Cost per solved task", units: "USD · lower is better", format: usd, delta: t.cost?.text },
    { key: "median_seconds", name: "Time per task", units: "Median per attempt · lower is better", format: dur, delta: t.time?.text },
  ];
  const sides = [{ m: t.open, fill: GREEN }, { m: t.closed, fill: BLUE }];
  return (
    <Column
      heading="Head to head"
      aside={
        <span className="label-mono flex items-center gap-4 text-muted-foreground">
          <span className="inline-flex items-center gap-2"><span aria-hidden className="size-2.5" style={{ background: GREEN }} />Open, on Baseten</span>
          <span className="inline-flex items-center gap-2"><span aria-hidden className="size-2.5" style={{ background: BLUE }} />Closed</span>
        </span>
      }
    >
      <div>
        {grid && <Solved p={t.pairs!} open={t.open} closed={t.closed} S={S} judged={judged} attempts={attempts} onOpen={onOpen} sample={sample} />}
        {metrics.map((metric) => {
          const values = sides.map((s) => S[s.m.key]?.[metric.key] ?? null);
          const max = metric.max ?? (Math.max(...values.map((v) => v ?? 0)) || 1);
          return (
            <div key={metric.key} className={ROW}>
              <div>
                <h3 className="text-[20px] leading-7 font-normal">{metric.name}</h3>
                <div className="label-mono mt-0.5 text-muted-foreground">{metric.units}</div>
                {metric.delta && <DeltaChip className="mt-3">{metric.delta}</DeltaChip>}
              </div>
              <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-x-4">
                {sides.map((s, i) => {
                  const v = values[i];
                  const w = v == null ? 0 : Math.max(0.5, (v / max) * 100);
                  const inside = w >= 22;
                  return (
                    <div key={s.m.key} className="contents">
                      <div className="label-mono truncate text-right text-foreground" title={s.m.label}>{s.m.label}</div>
                      <div className="relative h-10 bg-surface">
                        {v == null ? (
                          <div className="placeholder-cell flex h-full items-center px-3 label-mono text-muted-foreground">Not measured</div>
                        ) : (
                          <div className="relative h-full origin-left animate-grow" style={{ width: `${w}%`, background: s.fill, animationDelay: `${i * 80}ms` }}>
                            <span className={cn("num absolute top-1/2 -translate-y-1/2 font-mono text-[13px] whitespace-nowrap", inside ? "right-3 text-black" : "left-full ml-2 text-foreground")}>
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
      <div className="label-mono border-t border-rule pt-3 text-[10.5px] text-muted-foreground">{grid ? "Cost and time scaled within each metric" : "Solve rate out of 100%; cost and time scaled within each metric"}</div>
    </Column>
  );
}

const ROW = "grid items-center gap-x-8 gap-y-3 border-t border-rule py-6 first:border-t-0 first:pt-2 md:grid-cols-[300px_minmax(0,1fr)]";

/** What each model solved, big, with its cost per solved task. The solve rate, its 95% range and
 *  each PR's result stay in a details row under it. */
function Solved({ p, open, closed, S, judged, attempts, onOpen, sample }: {
  p: Paired; open: Model; closed: Model; S: Record<string, Summary>; judged: boolean; attempts: number; onOpen?: (taskId: string) => void; sample?: string | null;
}) {
  // How to read the rates, said only once someone opens them.
  const notes: [string, string][] = [
    ["Single pass", "Read these rates as a floor. Each attempt is one pass with no second try and no human review, and the agent never sees the PR's tests or reaches GitHub or package registries. In real work a developer reviews the change, runs the tests and sends the agent back for another pass."],
    ...(sample ? [["Small sample", sample] as [string, string]] : []),
  ];
  const sides = [
    { m: open, fill: GREEN, n: p.both.length + p.open.length, has: new Set([...p.both, ...p.open]) },
    { m: closed, fill: BLUE, n: p.both.length + p.closed.length, has: new Set([...p.both, ...p.closed]) },
  ];
  // Solved by both first, then by one, so the list reads like the figures above it.
  const tasks = [...p.both, ...p.open, ...p.closed, ...p.neither];
  return (
    <div className={cn(ROW, "items-start")}>
      <div>
        <h3 className="text-[20px] leading-7 font-normal">Solved</h3>
        <div className="label-mono mt-0.5 text-muted-foreground">The same {plural(p.n, "PR")} · higher is better</div>
        <p className="mt-3 max-w-[34ch] text-[13px] leading-5 text-muted-foreground">
          Solved = the PR's own hidden tests pass{judged ? " and the judges agree" : ""}. The model never sees the tests or the merged diff.
          {attempts > 1 ? " A PR counts as solved when at least half its attempts were." : ""}
        </p>
      </div>
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-px bg-frame shadow-[0_0_0_1px_var(--frame)]">
          {sides.map((s) => (
            <div key={s.m.key} className="min-w-0 bg-surface p-5">
              <div className="label-mono flex min-w-0 items-center gap-2 text-foreground">
                <span aria-hidden className="size-2.5 shrink-0" style={{ background: s.fill }} />
                <span className="truncate" title={s.m.label}>{s.m.label}</span>
              </div>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <span className="num text-[46px] leading-none tracking-[-0.03em]">{s.n}<span className="ml-2 text-[20px] tracking-[-0.01em]">solved</span></span>
                <span className="text-[15px] text-muted-foreground">
                  <b className="num font-medium text-foreground">{usd(S[s.m.key]?.cost_per_solved)}</b> per solved task
                </span>
              </div>
            </div>
          ))}
        </div>
        <details className="group">
          <summary className="label-mono inline-flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />Solve rate, 95% range and each PR
          </summary>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-px bg-frame">
              {notes.map(([label, text]) => (
                <div key={label} className="flex flex-col gap-1 bg-background py-2.5 sm:flex-row sm:gap-4">
                  <span className="label-mono w-28 shrink-0 pt-0.5 text-[10.5px] text-foreground">{label}</span>
                  <span className="text-[13px] leading-5 text-muted-foreground">{text}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
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
            <ul className="grid grid-cols-[minmax(0,1fr)] border-t border-frame">
              {tasks.map((task) => (
                <li key={task.id} className="border-b border-frame">
                  <PullRow task={task} onOpen={onOpen}>
                    {sides.map((s) => (
                      <span key={s.m.key} className="label-mono inline-flex w-24 shrink-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                        <span aria-hidden className="size-2" style={s.has.has(task) ? { background: s.fill } : { boxShadow: "inset 0 0 0 1px var(--line)" }} />
                        {s.has.has(task) ? "Solved" : "—"}
                      </span>
                    ))}
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
      <span className="w-36 shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">{task.repo.split("/").pop()}#{task.pr}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground group-hover/pr:underline">{task.title || `#${task.pr}`}</span>
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
