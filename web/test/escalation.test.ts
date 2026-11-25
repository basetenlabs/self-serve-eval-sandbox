import { describe, expect, it } from "vitest";
import { costLine, endText, escalationHeadline, estimateNote, inLadder, pathText } from "../src/lib/escalation";
import { counted, pipeline } from "../src/lib/stages";
import type { Escalation, Model, Run } from "../src/lib/types";

const labels = { flash: "DeepSeek V4.1 Flash", glm: "GLM-5.3", opus: "Claude Opus 5.5" };

function run(e: Partial<Escalation> = {}): Escalation {
  return {
    ladder: ["flash", "glm", "opus"],
    tasks: [
      { task_id: "a", solved_by: "flash", done: true, steps: [{ model: "flash", outcome: "solved" }] },
      { task_id: "b", solved_by: "opus", done: true, steps: [{ model: "flash", outcome: "failed" }, { model: "glm", outcome: "failed" }, { model: "opus", outcome: "solved" }] },
      { task_id: "c", solved_by: null, done: true, steps: [{ model: "flash", outcome: "failed" }, { model: "glm", outcome: "failed" }, { model: "opus", outcome: "failed" }] },
    ],
    solved_by: { flash: 1, glm: 0, opus: 1 }, tried: { flash: 3, glm: 2, opus: 2 }, unsolved: 1, remaining: 0,
    cost_usd: 4,
    every_model: { cost_usd: 10, estimated_usd: 6, estimated_attempts: 2, estimates: {
      flash: { attempts: 0, cost_per_attempt: null, source: null },
      glm: { attempts: 1, cost_per_attempt: 1, source: "this run" },
      opus: { attempts: 1, cost_per_attempt: 5, source: "earlier runs" },
    } },
    saving: 0.6,
    ...e,
  };
}

describe("cheapest model first", () => {
  it("orders an escalation run's models by its ladder, any other run's as usual", () => {
    const models = [{ key: "opus", label: "O", kind: "closed" }, { key: "glm", label: "G", kind: "open" }, { key: "flash", label: "F", kind: "open" }] as Model[];
    expect(inLadder(models, ["flash", "glm", "opus"]).map((m) => m.key)).toEqual(["flash", "glm", "opus"]);
    expect(inLadder(models, null).map((m) => m.key)).toEqual(["glm", "flash", "opus"]); // open models first
  });

  it("says each PR's way up the ladder and where it ended", () => {
    const [a, b, c] = run().tasks;
    expect(pathText(b.steps, labels)).toBe("DeepSeek V4.1 Flash failed, GLM-5.3 failed, Claude Opus 5.5 solved");
    expect(endText(a, labels)).toBe("Solved by DeepSeek V4.1 Flash");
    expect(endText(c, labels)).toBe("Unsolved after every model");
    expect(endText({ ...c, done: false }, labels)).toBe("Not finished");
    expect(pathText([], labels)).toBe("Not tried yet");
    // An attempt that wasn't scored ends the climb: the task's or the verifier's trouble, not the model's.
    const stuck = { task_id: "e", solved_by: null, done: true,
      steps: [{ model: "flash", outcome: "failed" as const }, { model: "glm", outcome: "invalid" as const, invalid_reason: "task-unstated-name" }] };
    expect(pathText(stuck.steps, labels)).toBe("DeepSeek V4.1 Flash failed, GLM-5.3 not scored");
    expect(endText(stuck, labels)).toBe("Not scored on GLM-5.3");
  });

  it("leads with what the cheapest model solved and what climbing saved", () => {
    const h = escalationHeadline(run(), labels);
    expect(h.head).toBe("DeepSeek V4.1 Flash solved 1 of 3 PRs on its own, and the models above it solved 1 more.");
    expect(h.cost).toBe("It cost $4.00, against about $10.00 for every model on every PR: 60% less.");
    const two = run({ ladder: ["flash", "opus"], solved_by: { flash: 3, opus: 0 } });
    expect(escalationHeadline(two, labels).head).toBe("DeepSeek V4.1 Flash solved 3 of 3 PRs on its own.");
    expect(escalationHeadline(run({ solved_by: { flash: 1, glm: 0, opus: 0 } }), labels).head)
      .toBe("DeepSeek V4.1 Flash solved 1 of 3 PRs on its own; the models above it solved none of the rest.");
  });

  it("shows no saving until every PR has finished, and says what is estimated", () => {
    expect(costLine(run({ saving: null, remaining: 2 }))).toBe("2 PRs still to finish.");
    expect(escalationHeadline(run({ saving: null, remaining: 2, solved_by: { flash: 1, glm: 0, opus: 0 } }), labels).head)
      .toBe("So far, DeepSeek V4.1 Flash solved 1 of 3 PRs on its own.");
    expect(costLine(run({ saving: 0 }))).toBe("It cost $4.00: every PR went up to every model, so nothing was saved.");
    expect(estimateNote(run(), labels)).toBe("$4.00 is what this run's attempts cost. The rest is estimated: about $6.00 for the "
      + "2 attempts this run skipped (1 attempt of GLM-5.3 at $1.00 each, its cost per try in this run, for the tries an attempt is likely to take; "
      + "1 attempt of Claude Opus 5.5 at $5.00 each, its cost per attempt in earlier runs).");
    const none = run({ every_model: { cost_usd: 4, estimated_usd: 0, estimated_attempts: 0, estimates: {} } });
    expect(estimateNote(none, labels)).toBe("Every model ran on every PR, so nothing here is estimated.");
  });

  it("counts no cell a cheaper model made unneeded, and waits for the ones that may still run", () => {
    expect(counted({ stage: "not-needed" })).toBe(false);
    expect(counted({ stage: "cheaper" })).toBe(true);
    const r = {
      phase: "running", tasks: 2, progress: { done: 2, total: 4 }, left_out: [], report: null,
      board: { rows: [
        { check: { stage: "passed" }, cells: [{ stage: "solved" }, { stage: "not-needed" }] },
        { check: { stage: "passed" }, cells: [{ stage: "failed" }, { stage: "agent" }] },
      ] },
    } as unknown as Run;
    expect(pipeline(r).find((s) => s.key === "report")!.count).toBe("2 of 3 in");
  });
});
