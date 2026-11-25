import { describe, expect, it } from "vitest";
import { outcome, proposer } from "../src/features/run/Setup";
import { pipeline, settingUp, setupCount, STAGE, CHECK } from "../src/lib/stages";
import type { BoardRow, Run, SetupProgress } from "../src/lib/types";

const setup = (tries: SetupProgress["tries"], state: SetupProgress["state"] = "working"): SetupProgress => ({
  repo: "o/r", pr: 32, of: 5, started_at: "2026-11-24T23:04:14Z", state, now: "trying install `pip install -e .` (try 2 of 5)",
  sandboxes: 1, tries,
});
const row = (id: string): BoardRow => ({
  id, repo: "o/r", pr: id, title: "t", language: "Python", check: { stage: "setup-wait" },
  cells: [{ model: "m", attempt: 1, stage: "setup-wait" }],
} as unknown as BoardRow);
const run = (over: Partial<Run>): Run => ({
  id: "r", title: "o/r", started: "2026-11-24T23:04:06Z", tasks: 0, active_at: "2026-11-24T23:05:00Z", models: [],
  phase: "collecting", detail: "", progress: { done: 0, total: 0 }, checking: { done: 0, total: 10 }, left_out: [],
  summary: {}, report: null, lost: 0, resumable: false, board: { rows: [row("1"), row("2")], sandboxes: 1 }, ...over,
});

describe("setup", () => {
  const first = { n: 1, by: "default", setup: "uv pip install -e .", started_at: "2026-11-24T23:04:14Z", step: "tests", seconds: 42, error: "FileNotFoundError: x" };
  const second = { n: 2, by: "DeepSeek V4.1 Flash", setup: "uv pip install -r dev-requirements.txt", started_at: "2026-11-24T23:06:31Z" };

  it("shows the run past finding PRs and on its setup tries, not waiting for a check", () => {
    const r = run({ step: "commands", setup: { "o/r": setup([first, second]) } });
    expect(settingUp(r)?.repo).toBe("o/r");
    const [find, check] = pipeline(r);
    expect(find.state).toBe("done");
    expect(check).toMatchObject({ state: "now", what: "Working out install and test commands", count: "Setup try 2 of 5" });
    expect(STAGE["setup-wait"].label).toBe("Waiting for setup");
    expect(CHECK["setup-wait"].label).toBe("Waiting for setup");
  });

  it("counts the next try while the model looks around between tries", () => {
    expect(setupCount(setup([first]))).toBe("Setup try 2 of 5");
    expect(setupCount(setup([]))).toBe("Setup try 1 of 5");
  });

  it("is no setup once the commands are settled, or for a run that never needed them", () => {
    expect(settingUp(run({ step: null, setup: { "o/r": setup([first], "done") } }))).toBeNull();
    expect(settingUp(run({ step: "commands" }))).toBeNull();
    expect(pipeline(run({}))[0].state).toBe("now"); // still finding PRs
  });

  it("says who proposed each try and how it went", () => {
    expect(proposer("default")).toBe("Its default commands");
    expect(proposer("guess")).toBe("A guess from its files");
    expect(proposer("DeepSeek V4.1 Flash")).toBe("DeepSeek V4.1 Flash's commands");
    expect(outcome(first)).toBe("✕ Tests failed");
    expect(outcome(second)).toBe("Trying");
    expect(outcome({ ...second, step: "passed" })).toBe("✓ Passed");
  });
});
