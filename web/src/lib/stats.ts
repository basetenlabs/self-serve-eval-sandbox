import { pct, ratio } from "./format";
import { isOpen } from "./models";
import type { Model, Summary } from "./types";

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
  open?: Model;
  closed?: Model;
  solve?: Delta;
  cost?: Delta;
  time?: Delta;
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
 * open model that solves at least as many as the closed one, else the strongest open model.
 */
export function takeaway(models: Model[], S: Record<string, Summary | undefined>): Takeaway {
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
  return { sentence: `${quality}${tail}.`, open, closed, solve, cost, time };
}
