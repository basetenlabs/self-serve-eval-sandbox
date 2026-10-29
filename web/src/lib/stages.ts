import { plural } from "./format";
import type { BoardRow, Cell, CellStage, CheckStage, Run } from "./types";

// An attempt's steps in order. Its own sandbox and the verifier's boot together, so the first
// three steps hold two sandboxes and the hidden tests hold one.
export const STEPS = ["sandboxes", "setup", "agent", "tests", "judge"] as const;
export const SANDBOXES: Partial<Record<CellStage, number>> = { sandboxes: 2, setup: 2, agent: 2, tests: 1 };

export type Tone = "boot" | "setup" | "agent" | "tests" | "judge" | "check" | "solved" | "failed" | "invalid" | "idle";

export const STAGE: Record<string, { label: string; tone: Tone; verb?: string }> = {
  queued: { label: "Queued", tone: "idle" },
  waiting: { label: "Waiting for check", tone: "idle" },
  "not-run": { label: "Not run", tone: "idle" },
  "left-out": { label: "Left out", tone: "idle" },
  interrupted: { label: "Stopped", tone: "idle" },
  sandboxes: { label: "Booting sandboxes", tone: "boot", verb: "booting its agent and verifier sandboxes" },
  setup: { label: "Installing deps", tone: "setup", verb: "installing dependencies" },
  agent: { label: "Agent coding", tone: "agent", verb: "agent started coding" },
  tests: { label: "Hidden tests", tone: "tests", verb: "agent sandbox deleted, hidden tests running" },
  judge: { label: "Judges reviewing", tone: "judge", verb: "judges reviewing the change" },
  solved: { label: "Solved", tone: "solved" },
  failed: { label: "Not solved", tone: "failed" },
  invalid: { label: "Not scored", tone: "invalid" },
};

export const CHECK: Record<CheckStage | string, { label: string; tone: Tone }> = {
  passed: { label: "Checked", tone: "solved" },
  "left-out": { label: "Left out", tone: "idle" },
  queued: { label: "Queued", tone: "idle" },
  stopped: { label: "Not checked", tone: "idle" },
  sandboxes: { label: "Booting sandbox", tone: "check" },
  setup: { label: "Installing deps", tone: "check" },
  base: { label: "Tests before fix", tone: "check" },
  reference: { label: "Tests with fix", tone: "check" },
};

export const isLive = (stage: string) => (STEPS as readonly string[]).includes(stage);
export const isChecking = (row: BoardRow) => CHECK[row.check.stage]?.tone === "check";
export const isFinal = (c: Cell) => c.stage === "solved" || c.stage === "failed" || c.stage === "invalid";
export const stepIndex = (stage: string) => (STEPS as readonly string[]).indexOf(stage);

/** Why an attempt didn't count as solved, in a few words. */
export function failReason(c: Pick<Cell, "stage" | "tests_passed" | "judge">): string | null {
  if (c.stage !== "failed") return null;
  if (c.tests_passed === false) return "tests failed";
  if (c.judge === "fail") return "judges said no";
  return null;
}

/** "repo#123", short enough for a feed line. */
export const prName = (row: Pick<BoardRow, "repo" | "pr">) => `${row.repo.split("/").pop()}#${row.pr}`;

/** The five steps of a run and where each one stands. */
export function pipeline(r: Run) {
  const b = r.board;
  const cells = b?.rows.flatMap((row) => row.cells) ?? [];
  const active = r.phase === "collecting" || r.phase === "checking" || r.phase === "running";
  const done = r.phase === "done";
  const doing = (stages: string[]) => cells.some((c) => stages.includes(c.stage));
  const checkedRows = b?.rows.filter((row) => row.check.stage === "passed" || row.check.stage === "left-out").length ?? 0;
  // Runs from before the board existed only have their progress counts.
  const checked = b?.rows.length ? checkedRows === b.rows.length : r.phase !== "collecting" && r.phase !== "checking";
  const finished = b ? cells.filter(isFinal).length : r.progress.done;
  const scored = b ? cells.filter((c) => c.stage !== "left-out" && c.stage !== "not-run").length : r.progress.total;
  const graded = b ? cells.filter((c) => c.stage === "solved" || c.stage === "failed").length : r.progress.done;
  const coding = cells.filter((c) => ["sandboxes", "setup", "agent"].includes(c.stage)).length;
  const grading = cells.filter((c) => c.stage === "tests" || c.stage === "judge").length;
  const passed = b ? b.rows.filter((row) => row.check.stage === "passed").length : r.tasks;
  const leftOut = r.left_out.length;
  type State = "done" | "now" | "todo";
  const st = (ok: boolean, now: boolean): State => (ok ? "done" : now && active ? "now" : "todo");
  return [
    { key: "find", title: "Find PRs", what: "Merged, with tests", state: st(r.phase !== "collecting", r.phase === "collecting"),
      count: b?.rows.length ? `${b.rows.length} found` : r.tasks ? `${r.tasks} found` : null },
    { key: "check", title: "Check", what: "Tests fail before, pass after", state: st(checked, b?.rows.some(isChecking) ?? r.phase === "checking"),
      count: checked && (passed || leftOut) ? `${passed} passed${leftOut ? ` · ${leftOut} left out` : ""}` : null },
    { key: "code", title: "Models code", what: "One sandbox per attempt", state: st(done || (checked && !doing(["queued", "sandboxes", "setup", "agent"]) && scored > 0), doing(["queued", "sandboxes", "setup", "agent"])),
      count: scored ? (coding ? `${coding} coding now` : plural(scored, "attempt")) : null },
    { key: "grade", title: "Grade", what: r.judged === false ? "Hidden tests" : "Hidden tests, then judges", state: st(done, doing(["tests", "judge"])),
      count: scored ? (grading ? `${grading} grading now` : `${graded} graded`) : null },
    { key: "report", title: "Report", what: "Solve rate, cost, time", state: st(done && !!r.report, false),
      count: scored ? `${finished} of ${scored} in` : null },
  ] as { key: string; title: string; what: string; state: State; count: string | null }[];
}
