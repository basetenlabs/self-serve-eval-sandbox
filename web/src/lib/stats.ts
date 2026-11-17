import { dur, durShown, pct, plural, usd, usdShown } from "./format";
import { isOpen, whose } from "./models";
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
  /** Per metric, the best open model and the closed comparison, said from the better one (see lead()). */
  solve?: Lead;
  cost?: Lead;
  time?: Lead;
}

export type LeadMetric = "pass_at_1" | "cost_per_solved" | "median_seconds";

/** One metric's pink chip: the better of two models on it, who serves it, and by how much. */
export interface Lead {
  /** A short statement: "Baseten's DeepSeek V4.1 Flash is 71% cheaper", "Anthropic's Claude Opus 5.5 took
   *  42% less time", "Baseten's GLM-5.3 is 10 points higher"; within 5%, "About the same cost". */
  chip: string;
  /** The gap alone, lower case, for the chart's chip and the headline: "71% cheaper", "42% less time". */
  text: string;
  /** Neither is ahead: within 5% on cost or time, the same solve rate. */
  tie: boolean;
  /** The gap: percent of the other model's figure for cost and time, points of solve rate. */
  gap: number;
  /** What the chip leaves out, for the line under it: on a tie both models with their figures, else the model
   *  it is measured against when more than two are shown; then what each solved when that differs. Empty when
   *  it would add nothing. */
  note: string;
  /** The model the chip names (on a tie, the open one), and the one it is measured against. */
  model: Model;
  vs: Model;
  /** What each solved, for the headline: "Both solved 5 of 8 PRs." or "It solved 5 of 8 PRs and Claude Opus 5.5 solved 6." */
  solved: string;
}

const LEAD_WORDS: Record<LeadMetric, { text: (gap: number) => string; says: (gap: number) => string; tie: string }> = {
  cost_per_solved: { text: (g) => `${g}% cheaper`, says: (g) => `is ${g}% cheaper`, tie: "About the same cost" },
  median_seconds: { text: (g) => `${g}% less time`, says: (g) => `took ${g}% less time`, tie: "About the same time" },
  pass_at_1: { text: (g) => `${g} pts higher`, says: (g) => `is ${plural(g, "point")} higher`, tie: "Same solve rate" },
};

/** A figure rounded the way the page shows it, so "$0.185" against "$0.638" reads 71%, as a reader works it out. */
function shown(metric: LeadMetric, v: number): number {
  return metric === "pass_at_1" ? Math.round(v * 100) / 100 : metric === "cost_per_solved" ? usdShown(v) : durShown(v);
}

/** A metric's figure for a model, or null when it has none (no cost per solved task once it solved none). */
function figure(S: Record<string, Summary | undefined>, m: Model, metric: LeadMetric): number | null {
  const v = S[m.key]?.[metric];
  return v != null && Number.isFinite(v) && (metric === "pass_at_1" || v > 0) ? v : null;
}

/**
 * The best open model on one metric against the closed comparison (the first closed model of
 * `models`), said from the side of whichever of the two is better: "Anthropic's Claude Opus 5.5 took
 * 42% less time". Cost and time say how much less the better one's figure is, as a percent of the other's,
 * so it never passes 100%; under 5% is about the same. With no closed figure to measure against, or no
 * open one, the best two models shown. A tie on the figure as shown goes to the model that solved more,
 * then to the models' order. A model without the figure takes no part. Undefined when fewer than two have it.
 */
export function lead(models: Model[], S: Record<string, Summary | undefined>, metric: LeadMetric): Lead | undefined {
  const has = models.filter((m) => figure(S, m, metric) != null);
  if (has.length < 2) return undefined;
  const v = (m: Model) => shown(metric, figure(S, m, metric)!);
  const higher = metric === "pass_at_1";
  const best = (ms: Model[]) => [...ms].sort((a, b) => (higher ? v(b) - v(a) : v(a) - v(b)) || S[b.key]!.tasks_solved - S[a.key]!.tasks_solved);
  const closed = models.find((m) => !isOpen(m));
  const opens = has.filter(isOpen);
  const [one, other] = closed && has.includes(closed) && opens.length ? [best(opens)[0], closed] : best(has);
  const [hi, lo] = [Math.max(v(one), v(other)), Math.min(v(one), v(other))];
  const gap = higher ? Math.round((hi - lo) * 100) : Math.min(99, Math.round((1 - lo / hi) * 100));
  const tie = higher ? gap === 0 : gap < 5;
  const [model, vs] = !tie && (higher ? v(other) > v(one) : v(other) < v(one)) ? [other, one] : [one, other];
  const words = LEAD_WORDS[metric];
  const a = S[model.key]!, b = S[vs.key]!;
  const same = a.tasks_solved === b.tasks_solved && a.tasks === b.tasks;
  const n = (k: number) => k || "none";
  const of = `${n(a.tasks_solved)} of ${plural(a.tasks, "PR")}`, theirs = `${n(b.tasks_solved)}${b.tasks === a.tasks ? "" : ` of ${b.tasks}`}`;
  const it = `It solved ${of} and ${vs.label} solved ${theirs}.`;
  const show = (m: Model) => ({ cost_per_solved: usd, median_seconds: dur, pass_at_1: pct })[metric](figure(S, m, metric));
  // The chip names nobody on a tie, so the line names both with their figures; otherwise a third model on the
  // page leaves the chip's other side to say.
  const which = tie ? `${model.label} (${show(model)}) and ${vs.label} (${show(vs)}).` : models.length > 2 ? `Compared with ${vs.label}.` : "";
  return {
    chip: tie ? words.tie : `${whose(model)} ${words.says(gap)}`,
    text: tie ? "about the same" : words.text(gap),
    tie, gap, model, vs,
    note: [which, same || higher ? "" : it].filter(Boolean).join(" "),
    solved: same ? `Both solved ${of}.` : tie ? `${model.label} solved ${of} and ${vs.label} solved ${theirs}.` : it,
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

/** The headline's cost line, the same comparison as the cost chip, from the side of the cheaper model:
 *  "DeepSeek V4.1 Flash is 71% cheaper per solved task than Claude Opus 5.5.", with what each solved when
 *  the headline is about other models. */
function costLine(c: Lead, pair: Model[], many: boolean): string {
  const inPair = [c.model, c.vs].every((m) => pair.some((x) => x.key === m.key));
  const line = !c.tie ? `${c.model.label} is ${c.text} per solved task than ${c.vs.label}.`
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
  const same = cost && [cost.model.key, cost.vs.key].sort().join() === [open.key, closed.key].sort().join();
  const tail = !cost || !same ? ""
    : cost.tie ? " at about the same cost per solved task"
    : cost.model.key === open.key ? ` and is ${cost.text} per solved task`
    : `, but ${closed.label} is ${cost.text} per solved task`;
  const after = cost && !same ? ` ${costLine(cost, [open, closed], many)}` : "";

  const pairs = report ? paired(report, open, closed) : undefined;
  const v = pairs?.n ? verdict(open, closed, pairs, cost, many) : undefined;
  const sentence = v ? [v.head, v.cost].filter(Boolean).join(" ") : `${quality}${tail}.${after}`;
  return { sentence, verdict: v, pairs, open, closed, ...leads };
}
