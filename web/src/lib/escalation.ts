import { pct, plural, usd } from "./format";
import { ordered } from "./models";
import type { Escalation, Model, Outcome } from "./types";

// An escalation run ("Cheapest model first" on the form) sends each PR to its cheapest model, and up to the next
// model only when the ones below didn't solve it. These say what it did in words, for its run page and report.

/** An escalation run's models in its ladder's order, cheapest first; any other run's in the usual order. */
export function inLadder<T extends Model>(models: T[], ladder?: string[] | null): T[] {
  if (!ladder?.length) return ordered(models);
  const at = (m: T) => (ladder.includes(m.key) ? ladder.indexOf(m.key) : ladder.length);
  return [...models].sort((a, b) => at(a) - at(b));
}

/** Each model's label by key, the key itself for one the run doesn't list. */
export const labelsOf = (models: Pick<Model, "key" | "label">[]) =>
  Object.fromEntries(models.map((m) => [m.key, m.label])) as Record<string, string>;

const DID: Record<Outcome, string> = { solved: "solved", failed: "failed", invalid: "not scored" };

/** One PR's way up the ladder: "DeepSeek V4.1 Flash failed, Claude Opus 5.5 solved". */
export function pathText(steps: Escalation["tasks"][number]["steps"], labels: Record<string, string>): string {
  if (!steps.length) return "Not tried yet";
  return steps.map((s) => `${labels[s.model] ?? s.model} ${DID[s.outcome] ?? s.outcome}`).join(", ");
}

/** Where a PR ended up: the model that solved it, unsolved after every model, not scored (an attempt that wasn't
 *  scored ends its climb: the task's or the verifier's trouble, not the model's), or still on its way. */
export function endText(task: Escalation["tasks"][number], labels: Record<string, string>): string {
  if (task.solved_by) return `Solved by ${labels[task.solved_by] ?? task.solved_by}`;
  if (!task.done) return "Not finished";
  const last = task.steps[task.steps.length - 1];
  return last?.outcome === "invalid" ? `Not scored on ${labels[last.model] ?? last.model}` : "Unsolved after every model";
}

/** The run's answer: what the cheapest model solved on its own and how many more the ones above it took, then what
 *  it cost against every model on every PR. */
export function escalationHeadline(e: Escalation, labels: Record<string, string>): { head: string; cost: string | null } {
  const [first, ...rest] = e.ladder;
  const name = (k: string) => labels[k] ?? k;
  if (!first || !e.tasks.length) return { head: "No PR has gone up the models yet.", cost: null };
  const own = e.solved_by[first] ?? 0;
  const more = rest.reduce((n, k) => n + (e.solved_by[k] ?? 0), 0);
  const above = rest.length === 1 ? name(rest[0]) : "the models above it";
  const finished = !e.remaining; // a run still going (or stopped) says what it has so far
  const head = `${finished ? "" : "So far, "}${name(first)} solved ${own} of ${plural(e.tasks.length, "PR")} on its own`
    + (more ? `, and ${above} solved ${more} more.`
      : finished && rest.length && own < e.tasks.length ? `; ${above} solved none of the rest.` : ".");
  return { head, cost: costLine(e) };
}

/** The run's cost against every model on every PR, with the saving; null until it can be said. */
export function costLine(e: Escalation): string | null {
  const every = e.every_model.cost_usd;
  if (e.cost_usd == null || every == null || e.saving == null) {
    return e.remaining ? `${plural(e.remaining, "PR")} still to finish.` : null;
  }
  if (e.saving < 0.005) return `It cost ${usd(e.cost_usd)}: every PR went up to every model, so nothing was saved.`;
  return `It cost ${usd(e.cost_usd)}, against about ${usd(every)} for every model on every PR: ${pct(e.saving)} less.`;
}

const SOURCE: Record<string, string> = {
  "this run": "its cost per try in this run, for the tries an attempt is likely to take",
  "earlier runs": "its cost per attempt in earlier runs",
  prices: "token prices, from a model that ran here",
};

/** What in "every model on every PR" is estimated, and from what, in plain words. */
export function estimateNote(e: Escalation, labels: Record<string, string>): string {
  const every = e.every_model;
  if (!every.estimated_attempts) return "Every model ran on every PR, so nothing here is estimated.";
  const parts = Object.entries(every.estimates).filter(([, x]) => x.attempts > 0).map(([k, x]) =>
    `${plural(x.attempts, "attempt")} of ${labels[k] ?? k} at ${x.cost_per_attempt == null ? "an unknown price" : `${usd(x.cost_per_attempt)} each, ${SOURCE[x.source ?? ""] ?? "estimated"}`}`);
  const known = e.cost_usd != null ? `${usd(e.cost_usd)} is what this run's attempts cost. ` : "";
  return `${known}The rest is estimated: ${every.estimated_usd == null ? "it can't be yet" : `about ${usd(every.estimated_usd)}`} for the ${plural(every.estimated_attempts, "attempt")} this run skipped (${parts.join("; ")}).`;
}
