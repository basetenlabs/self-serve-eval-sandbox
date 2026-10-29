import { pct, plural, ratio } from "./format";
import { isOpen } from "./models";
import type { Model, Report, Summary, Task } from "./types";

/** 95% Wilson interval for k successes in n tries. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Best first: solve rate, then cost per solved task, then time per task. */
export function rank<T extends Model>(models: T[], S: Record<string, Summary | undefined>): T[] {
  return [...models].sort((a, b) =>
    (S[b.key]?.pass_at_1 ?? -1) - (S[a.key]?.pass_at_1 ?? -1) ||
    (S[a.key]?.cost_per_solved ?? Infinity) - (S[b.key]?.cost_per_solved ?? Infinity) ||
    (S[a.key]?.median_seconds ?? Infinity) - (S[b.key]?.median_seconds ?? Infinity));
}

export interface Delta {
  text: string;
  /** Whether the open model comes out ahead on this metric; null when they tie. */
  ahead: boolean | null;
}

export interface Takeaway {
  sentence: string;
  /** The paired verdict, split for the report's headline: who solved more, then the cost line. */
  verdict?: { head: string; cost?: string };
  pairs?: Paired;
  open?: Model;
  closed?: Model;
  solve?: Delta;
  cost?: Delta;
  time?: Delta;
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

/** Who solved what, PR by PR. A PR counts as solved when at least half its scored attempts were. */
export function paired(report: Pick<Report, "tasks" | "trials">, open: Model, closed: Model): Paired {
  const tally = new Map<string, [number, number]>();
  for (const t of report.trials) {
    if (t.outcome === "invalid" || (t.model !== open.key && t.model !== closed.key)) continue;
    const k = `${t.model}\u0000${t.task_id}`;
    const [solved, scored] = tally.get(k) ?? [0, 0];
    tally.set(k, [solved + Number(t.outcome === "solved"), scored + 1]);
  }
  const solved = (m: Model, id: string) => {
    const x = tally.get(`${m.key}\u0000${id}`);
    return x ? x[0] * 2 >= x[1] : null;
  };
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
 *  the PRs one model solved and the other didn't make it unlikely by chance; otherwise it's too close to call. */
function verdict(open: Model, closed: Model, p: Paired, S: Record<string, Summary | undefined>): { head: string; cost?: string } {
  const o = p.both.length + p.open.length, c = p.both.length + p.closed.length;
  let head: string;
  if (!o && !c) head = "No solved PRs yet.";
  else if (o === c) head = p.open.length ? `Both models solved ${plural(o, "PR")}.` : `Both models solved the same ${plural(o, "PR")}.`;
  else {
    const [lead, x, other, y] = o > c ? [open, o, closed, c] : [closed, c, open, o];
    const counts = `${lead.label} solved ${plural(x, "PR")}, ${other.label} solved ${y}.`;
    head = signTest(p.open.length, p.closed.length) < 0.05 ? counts : `Too close to call: ${counts}`;
  }
  const co = S[open.key]?.cost_per_solved, cc = S[closed.key]?.cost_per_solved;
  if (!co || !cc) return { head };
  const [cheaper, x] = cc >= co ? [open, cc / co] : [closed, co / cc];
  const cost = x >= 2 ? `${cheaper.label} costs ${ratio(x)}× less per solved task.`
    : x >= 1.05 ? `${cheaper.label} costs ${pct(1 - 1 / x)} less per solved task.`
    : "Both cost about the same per solved task.";
  return { head, cost };
}

/** How much less (or more) the open model needs than the closed one: "3.4× cheaper", "35% cheaper",
 *  "2.1× the cost", "35% more". `worse` is [multiple, percentage] wording. */
function lessIsBetter(closed: number | null | undefined, open: number | null | undefined,
                      better: string, worse: [string, string]): Delta | undefined {
  if (!closed || !open) return undefined;
  const x = closed / open;
  if (x >= 2) return { text: `${ratio(x)}× ${better}`, ahead: true };
  if (x >= 1.05) return { text: `${pct(1 - 1 / x)} ${better}`, ahead: true };
  if (x <= 0.5) return { text: `${ratio(1 / x)}× ${worse[0]}`, ahead: false };
  if (x <= 0.95) return { text: `${pct(1 / x - 1)} ${worse[1]}`, ahead: false };
  return { text: "About even", ahead: null };
}

/**
 * The report's question: can an open model on Baseten do this work for less? Names the cheapest
 * open model that solves at least as many as the closed one, else the strongest open model. Given
 * the trials, it leads with the paired verdict on the PRs both attempted.
 */
export function takeaway(models: Model[], S: Record<string, Summary | undefined>, report?: Pick<Report, "tasks" | "trials">): Takeaway {
  const valid = models.filter((m) => S[m.key]?.valid);
  const closed = valid.find((m) => !isOpen(m));
  const opens = valid.filter(isOpen);
  if (!closed || !opens.length) {
    const top = rank(valid, S)[0];
    return { sentence: top ? `${top.label} solved ${pct(S[top.key]!.pass_at_1)} of attempts.` : "No finished attempts yet." };
  }
  const s = (m: Model) => S[m.key]!;
  const strongest = [...opens].sort((a, b) => (s(b).pass_at_1 ?? 0) - (s(a).pass_at_1 ?? 0) ||
    (s(a).cost_per_solved ?? 1e9) - (s(b).cost_per_solved ?? 1e9))[0];
  const matching = opens
    .filter((m) => (s(m).pass_at_1 ?? 0) >= (s(closed).pass_at_1 ?? 0) - 1e-9 && s(m).cost_per_solved != null)
    .sort((a, b) => s(a).cost_per_solved! - s(b).cost_per_solved!);
  const open = matching[0] ?? strongest;
  const c = s(closed), o = s(open);

  let quality: string;
  const rel = c.pass_at_1 ? (o.pass_at_1 ?? 0) / c.pass_at_1 : null;
  if (!c.solved && !o.solved) quality = `Neither ${closed.label} nor ${open.label} has solved a task yet`;
  else if (rel == null) quality = `${open.label} solved ${pct(o.pass_at_1)} of attempts`;
  else if (o.solved > c.solved) quality = `${open.label} solved more tasks than ${closed.label}`;
  else if (o.solved === c.solved) quality = `${open.label} solved as many tasks as ${closed.label}`;
  else quality = `${open.label} reached ${pct(rel)} of ${closed.label}'s solve rate`;

  const cost = c.solved && o.solved ? lessIsBetter(c.cost_per_solved, o.cost_per_solved, "cheaper", ["the cost", "more"]) : undefined;
  let tail = "";
  if (cost?.ahead === true) tail = cost.text.includes("×") ? `, ${cost.text} per solved task` : ` for ${cost.text.replace("cheaper", "less")} per solved task`;
  else if (cost?.ahead === false) tail = cost.text.includes("×") ? `, but at ${cost.text} per solved task` : `, but costs ${cost.text} per solved task`;
  else if (cost) tail = " at about the same cost per solved task";

  const diff = (o.pass_at_1 ?? 0) - (c.pass_at_1 ?? 0);
  const points = Math.round(Math.abs(diff) * 100);
  const solve: Delta = points === 0 ? { text: "Same rate", ahead: null }
    : { text: `${diff > 0 ? "+" : "−"}${points} pts`, ahead: diff > 0 };
  const time = lessIsBetter(c.median_seconds, o.median_seconds, "faster", ["slower", "slower"]);
  const pairs = report ? paired(report, open, closed) : undefined;
  const v = pairs?.n ? verdict(open, closed, pairs, S) : undefined;
  const sentence = v ? [v.head, v.cost].filter(Boolean).join(" ") : `${quality}${tail}.`;
  return { sentence, verdict: v, pairs, open, closed, solve, cost, time };
}
