import { plural } from "./format";
import type { BoardRow, Cell, CellStage, CheckStage, Run, SetupProgress } from "./types";

// An attempt's steps in order. Its own sandbox and the verifier's boot together, so the first
// three steps hold two sandboxes and the hidden tests hold one.
export const STEPS = ["sandboxes", "setup", "agent", "tests", "judge"] as const;
export const SANDBOXES: Partial<Record<CellStage, number>> = { sandboxes: 2, setup: 2, agent: 2, tests: 1 };

export type Tone = "boot" | "setup" | "agent" | "tests" | "judge" | "check" | "solved" | "failed" | "invalid" | "idle";

export const STAGE: Record<string, { label: string; tone: Tone; verb?: string }> = {
  queued: { label: "Queued", tone: "idle" },
  waiting: { label: "Waiting for check", tone: "idle" },
  "setup-wait": { label: "Waiting for setup", tone: "idle" },
  "not-run": { label: "Not run", tone: "idle" },
  "left-out": { label: "Left out", tone: "idle" },
  interrupted: { label: "Stopped", tone: "idle" },
  // Cheapest model first: a model waits until the ones below it have had their turn, and isn't needed once one solves it.
  cheaper: { label: "Waiting for a cheaper model", tone: "idle" },
  "not-needed": { label: "Not needed", tone: "idle" },
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
  "setup-wait": { label: "Waiting for setup", tone: "idle" },
  sandboxes: { label: "Booting sandbox", tone: "check" },
  setup: { label: "Installing deps", tone: "check" },
  base: { label: "Tests before fix", tone: "check" },
  reference: { label: "Tests with fix", tone: "check" },
};

export const isLive = (stage: string) => (STEPS as readonly string[]).includes(stage);
export const isChecking = (row: BoardRow) => CHECK[row.check.stage]?.tone === "check";
export const isFinal = (c: Cell) => c.stage === "solved" || c.stage === "failed" || c.stage === "invalid";
export const stepIndex = (stage: string) => (STEPS as readonly string[]).indexOf(stage);
/** Whether a cell is an attempt of the run: one left out, never run, or not needed (a cheaper model solved its PR) isn't. */
export const counted = (c: Pick<Cell, "stage">) => c.stage !== "left-out" && c.stage !== "not-run" && c.stage !== "not-needed";

/** Whether a run's judges decided solved along with its tests: only runs from before they reviewed beside them. */
export const judgesDecide = (judge?: { review?: boolean } | null) => !!judge && !judge.review;

/** The judges' review of a finished attempt, for its cell's mark and tip; null when no judge was asked. */
export function judgeReview(c: Pick<Cell, "judge" | "judge_reason">): { glyph: string; text: string } | null {
  if (c.judge === "pass") return { glyph: "✓", text: `Judges: pass${c.judge_reason ? `. ${c.judge_reason}` : "."}` };
  if (c.judge === "fail") return { glyph: "✕", text: `Judges: fail${c.judge_reason ? `. ${c.judge_reason}` : "."}` };
  if (c.judge === "error") return { glyph: "!", text: "The judges didn't answer. The hidden tests alone scored it, as always." };
  return null;
}

/** Why an attempt didn't count as solved, in a few words. */
export function failReason(c: Pick<Cell, "stage" | "tests_passed" | "judge">): string | null {
  if (c.stage !== "failed") return null;
  if (c.tests_passed === false) return "tests failed";
  if (c.judge === "fail") return "judges said no";
  return null;
}

/** "repo#123", short enough for a feed line. */
export const prName = (row: Pick<BoardRow, "repo" | "pr">) => `${row.repo.split("/").pop()}#${row.pr}`;

/** The repository whose install and test commands a live run is working out now, if any. */
export function settingUp(r: Run): SetupProgress | null {
  if (r.step !== "commands") return null;
  return Object.values(r.setup ?? {}).find((s) => s.state === "working") ?? null;
}

/** The setup try a run is on, or is about to start: "Setup try 2 of 5". */
export function setupCount(s: SetupProgress): string {
  const last = s.tries.at(-1);
  const current = last && !last.step ? s.tries.length : s.tries.length + 1;
  return `Setup try ${Math.min(current, s.of)} of ${s.of}`;
}

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
  const scored = b ? cells.filter(counted).length : r.progress.total;
  const graded = b ? cells.filter((c) => c.stage === "solved" || c.stage === "failed").length : r.progress.done;
  const coding = cells.filter((c) => ["sandboxes", "setup", "agent"].includes(c.stage)).length;
  const grading = cells.filter((c) => c.stage === "tests" || c.stage === "judge").length;
  const passed = b ? b.rows.filter((row) => row.check.stage === "passed").length : r.tasks;
  const leftOut = r.left_out.length;
  // Working out a repository's commands comes after its PRs are found and before any is checked.
  const setup = settingUp(r);
  type State = "done" | "now" | "todo";
  const st = (ok: boolean, now: boolean): State => (ok ? "done" : now && active ? "now" : "todo");
  return [
    { key: "find", title: "Find PRs", what: "Merged, with tests", state: st(r.phase !== "collecting" || !!setup, r.phase === "collecting"),
      count: b?.rows.length ? `${b.rows.length} found` : r.tasks ? `${r.tasks} found` : null },
    { key: "check", title: "Check", what: setup ? "Working out install and test commands" : "Tests fail before, pass after",
      state: st(checked, !!setup || (b?.rows.some(isChecking) ?? r.phase === "checking")),
      count: setup ? setupCount(setup) : checked && (passed || leftOut) ? `${passed} passed${leftOut ? ` · ${leftOut} left out` : ""}` : null },
    { key: "code", title: "Models code", what: "One sandbox per attempt", state: st(done || (checked && !doing(["queued", "sandboxes", "setup", "agent"]) && scored > 0), doing(["queued", "sandboxes", "setup", "agent"])),
      count: scored ? (coding ? `${coding} coding now` : plural(scored, "attempt")) : null },
    { key: "grade", title: "Grade", what: r.judged === false ? "Hidden tests" : "Hidden tests, then judges", state: st(done, doing(["tests", "judge"])),
      count: scored ? (grading ? `${grading} grading now` : `${graded} graded`) : null },
    { key: "report", title: "Report", what: "Solved, cost, time", state: st(done && !!r.report, false),
      count: scored ? `${finished} of ${scored} in` : null },
  ] as { key: string; title: string; what: string; state: State; count: string | null }[];
}
