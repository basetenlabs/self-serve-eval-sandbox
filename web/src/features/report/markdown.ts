import { dur, elapsed, pct, usd } from "@/lib/format";
import type { Model, Report } from "@/lib/types";

/** The ranking as a Markdown table, for pasting into a doc or a PR. */
export function benchMarkdown(report: Report, ranked: Model[]): string {
  const S = report.summary, run = report.run;
  const repos = new Set(report.tasks.map((t) => t.repo)).size;
  const multi = (run.attempts || 1) > 1;
  const cols = ["Model", "Solved / pass rate", ...(multi ? [`Solved in ${run.attempts} tries (pass@${run.attempts})`] : []),
    "Time per task (median)", "Total wall clock", "Cost per solved task"];
  const rows = ranked.map((m) => {
    const s = S[m.key];
    return [m.label, `${s.solved}/${s.valid} ${pct(s.pass_at_1)}`,
      ...(multi ? [`${s.tasks_solved}/${s.tasks} ${s.tasks ? pct(s.tasks_solved / s.tasks) : "–"}`] : []),
      dur(s.median_seconds), elapsed(s.timing?.elapsed_seconds), usd(s.cost_per_solved)];
  });
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "----").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    `Claude Code ${run.harness_version || ""}, ${report.tasks.length} merged PRs from ${repos} ${repos === 1 ? "repo" : "repos"}, ` +
      `${run.attempts} attempt(s) each. Time per task: median agent time. Total wall clock: first attempt to last result, ` +
      "including waits and pauses. Cost: all valid attempts / solved attempts.",
  ].join("\n").replace(/ {2,}/g, " ");
}
