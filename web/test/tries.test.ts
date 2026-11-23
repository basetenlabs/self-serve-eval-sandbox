import { describe, expect, it } from "vitest";
import { benchMarkdown } from "../src/features/report/markdown";
import { solvedOn } from "../src/lib/stats";
import type { Model, Report, Summary } from "../src/lib/types";

const m: Model = { key: "m", label: "M", kind: "open" };
const s: Summary = {
  attempts: 2, valid: 2, invalid: 0, solved: 1, pass_at_1: 0.5, tasks: 2, tasks_solved: 1, cost_usd: 3, cost_per_attempt: 1.5,
  cost_per_solved: 3, median_seconds: 90, median_turns: null, mean_output_tokens: null, mean_input_tokens: null,
  agent_timeouts: 0, judge_disagreements: 0, tries: 4, cost_per_try: 0.75, solved_on: [0, 1],
};
const report = (tries?: number): Report => ({
  generated_at: "2026-11-20T00:00:00Z", run: { run_id: "r", created_at: "2026-11-20T00:00:00Z", attempts: 1, tries },
  models: [m], summary: { m: s }, slices: [], tasks: [{ id: "o__r-1", repo: "o/r", title: "t" }], trials: [], complete: true,
});

describe("tries", () => {
  it("says which try solved how many attempts", () => {
    expect(solvedOn([5, 2, 1])).toBe("5 on try 1, 2 on try 2, 1 on try 3");
    expect(solvedOn([0, 1])).toBe("1 on try 2");
    expect(solvedOn([])).toBe("–");
    expect(solvedOn(undefined)).toBe("–");
  });

  it("puts the run's tries in the Markdown, and nothing for a run of one try", () => {
    expect(benchMarkdown(report(3), [m])).toContain("up to 3 tries per attempt");
    expect(benchMarkdown(report(3), [m])).toContain("Cost: all valid attempts, every try, / solved attempts.");
    for (const old of [report(undefined), report(1)]) {
      expect(benchMarkdown(old, [m])).not.toContain("tries");
      expect(benchMarkdown(old, [m])).toContain("Cost: all valid attempts / solved attempts.");
    }
  });
});
