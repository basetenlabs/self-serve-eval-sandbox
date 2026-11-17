import { cap, durShown, pct, plural, ratio, usdShown } from "./format";
import { isOpen } from "./models";
import type { Model, Report, Summary, Task, Trial } from "./types";

/** 95% Wilson interval for k successes in n tries. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Best first: tasks solved, then cost per solved task, then time per task. */
export function rank<T extends Model>(models: T[], S: Record<string, Summary | undefined>): T[] {
  return [...models].sort((a, b) =>
    (S[b.key]?.valid ? S[b.key]!.tasks_solved : -1) - (S[a.key]?.valid ? S[a.key]!.tasks_solved : -1) ||
    (S[a.key]?.cost_per_solved ?? Infinity) - (S[b.key]?.cost_per_solved ?? Infinity) ||
    (S[a.key]?.median_seconds ?? Infinity) - (S[b.key]?.median_seconds ?? Infinity));
}

export interface Takeaway {
  sentence: string;
  /** The paired verdict, split for the report's headline: who solved more, then the cost line. */
  verdict?: { head: string; cost?: string };
  pairs?: Paired;
  open?: Model;
  closed?: Model;
  /** Per metric, the best open model against the closed comparison (see lead()). */
  solve?: Lead;
  cost?: Lead;
  time?: Lead;
}

export type LeadMetric = "pass_at_1" | "cost_per_solved" | "median_seconds";

/** One model's figure against another's, in words: "6.2× cheaper", "5% more", "38% longer", "+10 pts". */
export interface Versus {
  /** Lower case, to sit after a value or inside a sentence: "6.2× cheaper", "about the same". */
  text: string;
  /** Better than the figure it is measured against; null within 5%, or the same solve rate. */
  ahead: boolean | null;
  /** The multiple, "6.2", when the gap is 2× or more. */
  times?: string;
  /** The gap in percent of the other figure, when under 2×. */
  percent?: number;
}

const VERSUS_WORDS: Record<"cost_per_solved" | "median_seconds", { less: string; more: string; times: string }> = {
  cost_per_solved: { less: "cheaper", more: "more", times: "the cost" },
  median_seconds: { less: "faster", more: "longer", times: "as long" },
};

/** A figure rounded the way the page shows it, so "9.8 min" against "7.1 min" reads 38%, as a reader works it out. */
function shown(metric: LeadMetric, v: number): number {
  return metric === "pass_at_1" ? Math.round(v * 100) / 100 : metric === "cost_per_solved" ? usdShown(v) : durShown(v);
}

/** A metric's figure for a model, or null when it has none (no cost per solved task once it solved none). */
function figure(S: Record<string, Summary | undefined>, m: Model, metric: LeadMetric): number | null {
  const v = S[m.key]?.[metric];
  return v != null && Number.isFinite(v) && (metric === "pass_at_1" || v > 0) ? v : null;
}

/**
 * How `value` compares with `base`, both rounded as shown. Cost and time: a multiple from 2×
 * ("6.2× cheaper", "2.1× the cost", "2.1× faster", "2.1× as long"), a percent of the base below that
 * ("25% cheaper", "5% more", "38% longer"), and "about the same" under 5%. Solve rate: points.
 */
export function versus(metric: LeadMetric, value: number | null | undefined, base: number | null | undefined): Versus | null {
  if (value == null || base == null || !Number.isFinite(value) || !Number.isFinite(base)) return null;
  const v = shown(metric, value), b = shown(metric, base);
  if (metric === "pass_at_1") {
    const points = Math.round((v - b) * 100);
    return points ? { text: `${points > 0 ? "+" : "−"}${Math.abs(points)} pts`, ahead: points > 0 } : { text: "same rate", ahead: null };
  }
  if (!(v > 0 && b > 0)) return null;
  const percent = Math.round(Math.abs(v / b - 1) * 100);
  if (percent < 5) return { text: "about the same", ahead: null };
  const words = VERSUS_WORDS[metric];
  if (v < b) return b / v >= 2 ? { text: `${ratio(b / v)}× ${words.less}`, ahead: true, times: ratio(b / v) } : { text: `${percent}% ${words.less}`, ahead: true, percent };
  return v / b >= 2 ? { text: `${ratio(v / b)}× ${words.times}`, ahead: false, times: ratio(v / b) } : { text: `${percent}% ${words.more}`, ahead: false, percent };
}

/** One metric's pink chip: the best open model on it against the closed comparison. */
export interface Lead extends Versus {
  /** The chip: "6.2× cheaper", "38% longer", "+10 pts", "About the same". */
  chip: string;
  /** The line under the chip: "DeepSeek V4.1 Flash 1017 Fast vs Claude Opus 5.5 · solved 5 of 8 PRs vs 6", so a
   *  lower cost from fewer solved PRs reads as the trade-off it is. */
  note: string;
  /** The model the chip is about, and the one it is measured against. */
  model: Model;
  vs: Model;
  /** What each solved, as a sentence for the headline: "It solved 5 of 8 PRs and Claude Opus 5.5 solved 6." */
  solved: string;
}

/**
 * The best open model on one metric against the closed comparison (the first closed model of
 * `models`). With no closed figure to measure against, or no open one, the best model shown against
 * the runner-up. A tie on the figure as shown goes to the model that solved more, then to the
 * models' order. A model without the figure takes no part. Undefined when fewer than two have it.
 */
export function lead(models: Model[], S: Record<string, Summary | undefined>, metric: LeadMetric): Lead | undefined {
  const has = models.filter((m) => figure(S, m, metric) != null);
  if (has.length < 2) return undefined;
  const v = (m: Model) => shown(metric, figure(S, m, metric)!);
  const solved = (m: Model) => S[m.key]!.tasks_solved;
  const best = (ms: Model[]) => [...ms].sort((a, b) => (metric === "pass_at_1" ? v(b) - v(a) : v(a) - v(b)) || solved(b) - solved(a));
  const closed = models.find((m) => !isOpen(m));
  const opens = has.filter(isOpen);
  const [model, vs] = closed && has.includes(closed) && opens.length ? [best(opens)[0], closed] : best(has);
  const said = versus(metric, figure(S, model, metric), figure(S, vs, metric))!;
  const a = S[model.key]!, b = S[vs.key]!;
  const same = a.tasks_solved === b.tasks_solved && a.tasks === b.tasks;
  const of = `${a.tasks_solved} of ${plural(a.tasks, "PR")}`, theirs = `${b.tasks_solved}${b.tasks === a.tasks ? "" : ` of ${b.tasks}`}`;
  return {
    ...said, chip: cap(said.text), model, vs,
    note: `${model.label} vs ${vs.label} · ${same ? `both solved ${of}` : `solved ${of} vs ${theirs}`}`,
    solved: same ? `Both solved ${of}.` : `${said.ahead != null ? "It" : model.label} solved ${of} and ${vs.label} solved ${theirs}.`,
  };
}

/** The PRs both models have a scored attempt on, split by who solved them. */
export interface Paired {
  n: number;
  both: Task[];
  open: Task[];
  closed: Task[];
  neither: Task[];
  /** PRs left out because one of the two has no scored attempt on them. */
  unscored: number;
}

/** Per model key, the PRs it has a scored attempt on and whether it solved each. A PR counts as
 *  solved when at least half its scored attempts were. A PR a model has no entry for wasn't scored. */
export function solvedBy(trials: Pick<Trial, "model" | "task_id" | "outcome">[]): Map<string, Map<string, boolean>> {
  const tally = new Map<string, Map<string, [number, number]>>();
  for (const t of trials) {
    if (t.outcome === "invalid") continue;
    const per = tally.get(t.model) ?? new Map<string, [number, number]>();
    tally.set(t.model, per);
    const [solved, scored] = per.get(t.task_id) ?? [0, 0];
    per.set(t.task_id, [solved + Number(t.outcome === "solved"), scored + 1]);
  }
  const out = new Map<string, Map<string, boolean>>();
  for (const [model, per] of tally) {
    out.set(model, new Map([...per].map(([id, [solved, scored]]) => [id, solved * 2 >= scored])));
  }
  return out;
}

/** Who solved what, PR by PR, between the two models of the headline. */
export function paired(report: Pick<Report, "tasks" | "trials">, open: Model, closed: Model): Paired {
  const by = solvedBy(report.trials);
  const solved = (m: Model, id: string) => by.get(m.key)?.get(id) ?? null;
  const p: Paired = { n: 0, both: [], open: [], closed: [], neither: [], unscored: 0 };
  for (const task of report.tasks) {
    const o = solved(open, task.id), c = solved(closed, task.id);
    if (o == null || c == null) { if (o != null || c != null) p.unscored++; continue; }
    p.n++;
    (o && c ? p.both : o ? p.open : c ? p.closed : p.neither).push(task);
  }
  return p;
}

/** Two-sided exact sign test on the PRs only one model solved (McNemar's exact test). */
function signTest(x: number, y: number): number {
  const n = x + y;
  if (!n) return 1;
  let tail = 0, c = 1;
  for (let i = 0; i <= Math.min(x, y); i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** "Both models solved the same 6 PRs." Worded around solved work. A lead only counts as clear when
 *  the PRs one model solved and the other didn't make it unlikely by chance; otherwise it's too close to call.
 *  With more models shown than these two, it names them. */
function verdict(open: Model, closed: Model, p: Paired, cost: Lead | undefined, many: boolean): { head: string; cost?: string } {
  const o = p.both.length + p.open.length, c = p.both.length + p.closed.length;
  const both = many ? `${open.label} and ${closed.label}` : "Both models";
  let head: string;
  if (!o && !c) head = "No solved PRs yet.";
  else if (o === c) head = p.open.length ? `${both} ${many ? "each solved" : "solved"} ${plural(o, "PR")}.` : `${both} solved the same ${plural(o, "PR")}.`;
  else {
    const [lead, x, other, y] = o > c ? [open, o, closed, c] : [closed, c, open, o];
    const counts = `${lead.label} solved ${plural(x, "PR")}, ${other.label} solved ${y}.`;
    head = signTest(p.open.length, p.closed.length) < 0.05 ? counts : `Too close to call: ${counts}`;
  }
  return cost ? { head, cost: costLine(cost, [open, closed], many) } : { head };
}

/** What the chip's model pays per solved task against the other, after its name: "is 6.2× cheaper per
 *  solved task than Claude Opus 5.5", "costs 5% more per solved task than …", "costs 2.1× as much per solved task as …". */
function costs(c: Lead): string {
  return c.ahead ? `is ${c.text} per solved task than ${c.vs.label}`
    : c.times ? `costs ${c.times}× as much per solved task as ${c.vs.label}`
    : `costs ${c.percent}% more per solved task than ${c.vs.label}`;
}

/** The headline's cost line, the same comparison as the cost chip: the open model that costs least per
 *  solved task against the closed one, with what each solved when the headline is about other models. */
function costLine(c: Lead, pair: Model[], many: boolean): string {
  const inPair = [c.model, c.vs].every((m) => pair.some((x) => x.key === m.key));
  const line = c.ahead != null ? `${c.model.label} ${costs(c)}.`
    : inPair && !many ? "Both cost about the same per solved task."
    : `${c.model.label} and ${c.vs.label} cost about the same per solved task.`;
  return inPair ? line : `${line} ${c.solved}`;
}

/**
 * The report's question: can an open model on Baseten do this work for less? Names the cheapest
 * open model that solves at least as many as the closed one, else the strongest open model. Given
 * the trials, it leads with the paired verdict on the PRs both attempted. Cost, time and solve rate
 * each put the best open model on that metric against the closed one, so a third model that costs
 * least is never left out of the comparison.
 */
export function takeaway(models: Model[], S: Record<string, Summary | undefined>, report?: Pick<Report, "tasks" | "trials">): Takeaway {
  const valid = models.filter((m) => S[m.key]?.valid);
  const leads = { solve: lead(valid, S, "pass_at_1"), cost: lead(valid, S, "cost_per_solved"), time: lead(valid, S, "median_seconds") };
  const closed = valid.find((m) => !isOpen(m));
  const opens = valid.filter(isOpen);
  if (!closed || !opens.length) {
    const top = rank(valid, S)[0];
    return { sentence: top ? `${top.label} solved ${plural(S[top.key]!.tasks_solved, "PR")}.` : "No finished attempts yet.", ...leads };
  }
  const s = (m: Model) => S[m.key]!;
  const strongest = [...opens].sort((a, b) => (s(b).pass_at_1 ?? 0) - (s(a).pass_at_1 ?? 0) ||
    (s(a).cost_per_solved ?? 1e9) - (s(b).cost_per_solved ?? 1e9))[0];
  const matching = opens
    .filter((m) => (s(m).pass_at_1 ?? 0) >= (s(closed).pass_at_1 ?? 0) - 1e-9 && s(m).cost_per_solved != null)
    .sort((a, b) => s(a).cost_per_solved! - s(b).cost_per_solved!);
  const open = matching[0] ?? strongest;
  const c = s(closed), o = s(open);
  const many = valid.length > 2;

  let quality: string;
  const rel = c.pass_at_1 ? (o.pass_at_1 ?? 0) / c.pass_at_1 : null;
  if (!c.solved && !o.solved) quality = `Neither ${closed.label} nor ${open.label} has solved a task yet`;
  else if (rel == null) quality = `${open.label} solved ${pct(o.pass_at_1)} of attempts`;
  else if (o.solved > c.solved) quality = `${open.label} solved more tasks than ${closed.label}`;
  else if (o.solved === c.solved) quality = `${open.label} solved as many tasks as ${closed.label}`;
  else quality = `${open.label} reached ${pct(rel)} of ${closed.label}'s solve rate`;

  // The cost joins the sentence when it compares the same two models; another model's is its own sentence.
  const cost = leads.cost;
  const same = cost && cost.model.key === open.key && cost.vs.key === closed.key;
  const tail = !cost || !same ? ""
    : cost.ahead == null ? " at about the same cost per solved task"
    : cost.ahead ? ` and is ${cost.text} per solved task`
    : `, but costs ${cost.times ? `${cost.times}× as much` : `${cost.percent}% more`} per solved task`;
  const after = cost && !same ? ` ${costLine(cost, [open, closed], many)}` : "";

  const pairs = report ? paired(report, open, closed) : undefined;
  const v = pairs?.n ? verdict(open, closed, pairs, cost, many) : undefined;
  const sentence = v ? [v.head, v.cost].filter(Boolean).join(" ") : `${quality}${tail}.${after}`;
  return { sentence, verdict: v, pairs, open, closed, ...leads };
}
