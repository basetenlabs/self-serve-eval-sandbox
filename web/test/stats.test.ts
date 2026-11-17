import { describe, expect, it } from "vitest";
import { palette } from "../src/lib/models";
import { lead, rank, solvedBy, takeaway, versus, wilson } from "../src/lib/stats";
import type { Model, Summary, Task, Trial } from "../src/lib/types";

const s = (pass: number, solved: number, valid: number, cost: number | null, seconds: number | null): Summary => ({
  attempts: valid, valid, invalid: 0, solved, pass_at_1: pass, tasks: valid, tasks_solved: solved, cost_usd: null,
  cost_per_attempt: null, cost_per_solved: cost, median_seconds: seconds, median_turns: null, mean_output_tokens: null,
  mean_input_tokens: null, agent_timeouts: 0, judge_disagreements: 0,
});

const glm: Model = { key: "glm", label: "GLM 4.6", kind: "open", provider: "baseten" };
const kimi: Model = { key: "kimi", label: "Kimi K2", kind: "open", provider: "baseten" };
const sonnet: Model = { key: "sonnet", label: "Claude Sonnet", kind: "closed", provider: "anthropic" };

describe("stats", () => {
  it("gives a 95% range that holds the observed rate", () => {
    const [lo, hi] = wilson(7, 10)!;
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
    expect(wilson(0, 0)).toBeNull();
  });

  it("ranks by tasks solved, then cost per solved task", () => {
    const S = { glm: s(0.6, 6, 10, 0.1, 100), kimi: s(0.6, 6, 10, 0.05, 100), sonnet: s(0.7, 7, 10, 0.9, 80) };
    expect(rank([glm, kimi, sonnet], S).map((m) => m.key)).toEqual(["sonnet", "kimi", "glm"]);
  });

  it("ranks more tasks solved above a higher rate on fewer attempts", () => {
    const S = { glm: s(0.6, 6, 10, 0.1, 100), kimi: s(1, 5, 5, 0.1, 100) };
    expect(rank([kimi, glm], S).map((m) => m.key)).toEqual(["glm", "kimi"]);
  });

  it("names the cheapest open model that matches the closed one", () => {
    const S = { glm: s(0.7, 7, 10, 0.2, 120), kimi: s(0.8, 8, 10, 0.3, 90), sonnet: s(0.7, 7, 10, 0.9, 60) };
    const t = takeaway([glm, kimi, sonnet], S);
    expect(t.open?.key).toBe("glm");
    expect(t.sentence).toBe("GLM 4.6 solved as many tasks as Claude Sonnet and is 4.5× cheaper per solved task.");
    expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual(["glm", "sonnet", "4.5× cheaper"]);
    expect(t.cost?.note).toBe("GLM 4.6 vs Claude Sonnet · both solved 7 of 10 PRs");
    // Each chip is the best open model on that metric against Claude Sonnet: Kimi solves the most, and is
    // the quickest open model though slower than Claude Sonnet.
    expect([t.solve?.model.key, t.solve?.vs.key, t.solve?.chip]).toEqual(["kimi", "sonnet", "+10 pts"]);
    expect([t.time?.model.key, t.time?.vs.key, t.time?.chip, t.time?.ahead]).toEqual(["kimi", "sonnet", "50% longer", false]);
    expect(t.time?.note).toBe("Kimi K2 vs Claude Sonnet · solved 8 of 10 PRs vs 7");
  });

  it("falls back to the strongest open model when none matches", () => {
    const S = { glm: s(0.5, 5, 10, 0.3, 120), sonnet: s(0.8, 8, 10, 0.4, 60) };
    const t = takeaway([glm, sonnet], S);
    expect(t.sentence).toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate and is 25% cheaper per solved task.");
    expect([t.solve?.model.key, t.solve?.chip, t.solve?.note]).toEqual(["glm", "−30 pts", "GLM 4.6 vs Claude Sonnet · solved 5 of 10 PRs vs 8"]);
    // Dearer than the closed model: said as a cost, not as a lead.
    const dear = takeaway([glm, sonnet], { glm: s(0.5, 5, 10, 0.42, 120), sonnet: s(0.8, 8, 10, 0.4, 60) });
    expect(dear.sentence).toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate, but costs 5% more per solved task.");
    expect(takeaway([glm, sonnet], { glm: s(0.5, 5, 10, 0.9, 120), sonnet: s(0.8, 8, 10, 0.4, 60) }).sentence)
      .toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate, but costs 2.3× as much per solved task.");
  });

  it("keeps green for Baseten's open models and blue for the comparison", () => {
    const colors = palette([sonnet, glm, kimi]);
    expect(colors.glm.fill).toBe("var(--color-green)");
    expect(colors.kimi.fill).toBe("var(--color-darkGreen)");
    expect(colors.sonnet.fill).toBe("var(--color-blue)");
  });

  it("never gives a model gold (judges, not scored) or pink (the difference), however many run", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...glm, key: `open${i}` }));
    const fills = Object.values(palette([...many, sonnet, { ...sonnet, key: "other" }, { ...sonnet, key: "third" }])).map((c) => c.fill);
    expect(fills.join(" ")).not.toMatch(/gold|pink/i);
  });

  describe("paired verdict", () => {
    const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, repo: "o/r", pr: i + 1, title: `PR ${i + 1}` }));
    // Who solved each PR, as [glm, sonnet]: "b" both, "g" only GLM, "s" only Sonnet, "-" neither.
    const run = (who: string): { tasks: Task[]; trials: Trial[] } => ({
      tasks,
      trials: [...who].flatMap((w, i) => [
        { trial: `g${i}`, task_id: `t${i}`, model: "glm", attempt: 1, outcome: w === "b" || w === "g" ? "solved" : "failed" },
        { trial: `s${i}`, task_id: `t${i}`, model: "sonnet", attempt: 1, outcome: w === "b" || w === "s" ? "solved" : "failed" },
      ] as Trial[]),
    });

    it("says both solved the same PRs and leads with the cost", () => {
      const S = { glm: s(0.6, 6, 10, 0.1, 100), sonnet: s(0.6, 6, 10, 0.69, 80) };
      const t = takeaway([glm, sonnet], S, run("bbbbbb----"));
      expect(t.pairs?.both.length).toBe(6);
      expect(t.verdict).toEqual({ head: "Both models solved the same 6 PRs.", cost: "GLM 4.6 is 6.9× cheaper per solved task than Claude Sonnet." });
      expect(t.sentence).toBe("Both models solved the same 6 PRs. GLM 4.6 is 6.9× cheaper per solved task than Claude Sonnet.");
      expect([t.cost?.chip, t.cost?.note]).toEqual(["6.9× cheaper", "GLM 4.6 vs Claude Sonnet · both solved 6 of 10 PRs"]);
    });

    it("says both solved as many when they solved different PRs", () => {
      const S = { glm: s(0.6, 6, 10, 0.1, 100), sonnet: s(0.6, 6, 10, 0.1, 80) };
      const t = takeaway([glm, sonnet], S, run("bbbbbgs---"));
      expect(t.verdict).toEqual({ head: "Both models solved 6 PRs.", cost: "Both cost about the same per solved task." });
    });

    it("keeps a small lead too close to call", () => {
      const S = { glm: s(0.4, 4, 10, 0.1, 100), sonnet: s(0.6, 6, 10, 0.5, 80) };
      expect(takeaway([glm, sonnet], S, run("bbbbss----")).verdict?.head).toBe("Too close to call: Claude Sonnet solved 6 PRs, GLM 4.6 solved 4.");
    });

    it("names a clear lead", () => {
      const S = { glm: s(0, 0, 10, null, 100), sonnet: s(0.6, 6, 10, 0.5, 80) };
      const t = takeaway([glm, sonnet], S, run("ssssss----"));
      expect(t.verdict).toEqual({ head: "Claude Sonnet solved 6 PRs, GLM 4.6 solved 0." });
      expect(t.cost).toBeUndefined(); // no cost per solved task for a model that solved none: nothing to compare
    });

    it("leaves out PRs without a scored attempt from both", () => {
      const r = run("bbg-");
      r.tasks = tasks.slice(0, 4);
      r.trials = r.trials.map((x) => (x.task_id === "t3" && x.model === "glm" ? { ...x, outcome: "invalid" } : x));
      const p = takeaway([glm, sonnet], { glm: s(0.7, 2, 3, 0.1, 1), sonnet: s(0.5, 2, 4, 0.1, 1) }, r).pairs!;
      expect([p.n, p.both.length, p.open.length, p.unscored]).toEqual([3, 2, 1, 1]);
    });
  });

  describe("every model shown", () => {
    // A real run's figures: two models solved 6 of 8 PRs each and DeepSeek 5, shown as $1.38, $1.31 and $0.210 per
    // solved task and 9.8, 7.1 and 6.9 min per task. Before, the cost chip said "About even" and the time chip "39% slower".
    const g = { key: "glm-5.3", label: "GLM-5.3", kind: "open", provider: "baseten" } as Model;
    const d = { key: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash 1017", kind: "open", provider: "baseten" } as Model;
    const c = { key: "claude-opus", label: "Claude Opus 5.5", kind: "closed", provider: "anthropic" } as Model;
    const S = {
      [g.key]: s(6 / 8, 6, 8, 1.38030176, 588.9), [c.key]: s(6 / 8, 6, 8, 1.3138080333, 423.25), [d.key]: s(5 / 8, 5, 8, 0.209907744, 414.7),
    };
    const tasks: Task[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, repo: "o/r", pr: i + 1, title: `PR ${i + 1}` }));
    const outcomes = { [g.key]: "ssssss--", [c.key]: "ssssss--", [d.key]: "sssss---" };
    const trials = Object.entries(outcomes).flatMap(([model, who]) =>
      [...who].map((w, i) => ({ trial: `${model}${i}`, task_id: `t${i}`, model, attempt: 1, outcome: w === "s" ? "solved" : "failed" }) as Trial));

    it("puts the open model that costs least against the closed one, with what each solved", () => {
      const t = takeaway([g, d, c], S, { tasks, trials });
      expect([t.open?.key, t.closed?.key]).toEqual([g.key, c.key]); // the headline still pairs the open model that matches Claude
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.ahead, t.cost?.chip]).toEqual([d.key, c.key, true, "6.2× cheaper"]);
      expect(t.cost?.note).toBe("DeepSeek V4.1 Flash 1017 vs Claude Opus 5.5 · solved 5 of 8 PRs vs 6");
      expect(t.verdict).toEqual({
        head: "GLM-5.3 and Claude Opus 5.5 solved the same 6 PRs.",
        cost: "DeepSeek V4.1 Flash 1017 is 6.2× cheaper per solved task than Claude Opus 5.5. It solved 5 of 8 PRs and Claude Opus 5.5 solved 6.",
      });
    });

    it("says the quickest open model takes about the same time, not that the run was slower", () => {
      const t = takeaway([g, d, c], S, { tasks, trials });
      expect([t.time?.model.key, t.time?.vs.key, t.time?.ahead, t.time?.chip]).toEqual([d.key, c.key, null, "About the same"]);
      expect(t.time?.note).toBe("DeepSeek V4.1 Flash 1017 vs Claude Opus 5.5 · solved 5 of 8 PRs vs 6");
    });

    it("says each bar against Claude Opus 5.5, from the figures as shown", () => {
      const bar = (m: Model, metric: "cost_per_solved" | "median_seconds") => versus(metric, S[m.key][metric], S[c.key][metric])?.text;
      expect([bar(d, "cost_per_solved"), bar(g, "cost_per_solved")]).toEqual(["6.2× cheaper", "5% more"]);
      // 9.8 min against 7.1 min is 38% longer, as a reader works it out; the unrounded 588.9 s and 423.25 s would say 39%.
      expect([bar(d, "median_seconds"), bar(g, "median_seconds")]).toEqual(["about the same", "38% longer"]);
    });

    it("calls a gap under 5% about the same and names both", () => {
      const near = { [g.key]: s(6 / 8, 6, 8, 1.36, 400), [c.key]: s(6 / 8, 6, 8, 1.31, 390) };
      const t = takeaway([g, c], near);
      expect([t.cost?.ahead, t.cost?.chip, t.time?.chip, t.solve?.chip]).toEqual([null, "About the same", "About the same", "Same rate"]);
      expect(t.cost?.note).toBe("GLM-5.3 vs Claude Opus 5.5 · both solved 6 of 8 PRs");
      expect(t.sentence).toBe("GLM-5.3 solved as many tasks as Claude Opus 5.5 at about the same cost per solved task.");
      // Three models, the cheapest open one about even with Claude: the line names them rather than saying "both".
      const three = takeaway([g, d, c], { ...near, [d.key]: s(5 / 8, 5, 8, 1.4, 300) }, { tasks, trials });
      expect(three.verdict?.cost).toBe("GLM-5.3 and Claude Opus 5.5 cost about the same per solved task.");
    });

    it("breaks a tie on the figure as shown in favour of the model that solved more", () => {
      const tie = { ...S, [g.key]: s(6 / 8, 6, 8, 0.2104, 588.9), [d.key]: s(5 / 8, 5, 8, 0.2098, 414.7) };
      const t = takeaway([d, g, c], tie, { tasks, trials });
      expect([t.cost?.model.key, t.cost?.chip]).toEqual([g.key, "6.2× cheaper"]); // both $0.210
      expect(t.verdict?.cost).toBe("GLM-5.3 is 6.2× cheaper per solved task than Claude Opus 5.5.");
    });

    it("leaves a model that solved none out of the cost comparison", () => {
      const k = { ...d, key: "kimi", label: "Kimi K3" };
      const none = { [g.key]: s(6 / 8, 6, 8, 0.4, 400), [k.key]: s(3 / 8, 3, 8, 1, 300), [c.key]: s(0, 0, 8, null, 200) };
      const t = takeaway([g, k, c], none);
      // No closed figure to measure against: the cheapest against the runner-up, and no bar is said against Claude.
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual([g.key, "kimi", "2.5× cheaper"]);
      expect(t.cost?.note).toBe("GLM-5.3 vs Kimi K3 · solved 6 of 8 PRs vs 3");
      expect(versus("cost_per_solved", 0.4, null)).toBeNull();
      expect(lead([g, c], none, "cost_per_solved")).toBeUndefined(); // one figure is no comparison
      // Time still has Claude's figure: the quickest open model against it.
      expect([t.time?.model.key, t.time?.vs.key, t.time?.chip]).toEqual(["kimi", c.key, "52% longer"]);
    });

    it("compares open models with each other when there's no closed one", () => {
      const t = takeaway([g, d], S);
      expect([t.open, t.closed]).toEqual([undefined, undefined]);
      expect(t.sentence).toBe("GLM-5.3 solved 6 PRs.");
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual([d.key, g.key, "6.6× cheaper"]);
    });
  });

  describe("one figure against another", () => {
    const cost = (a: number, b: number) => versus("cost_per_solved", a, b)?.text;
    const time = (a: number, b: number) => versus("median_seconds", a, b)?.text;

    it("says a multiple from 2×, a percent below that, and about the same under 5%", () => {
      expect([cost(0.5, 1), cost(0.51, 1), cost(0.95, 1), cost(0.96, 1)]).toEqual(["2.0× cheaper", "49% cheaper", "5% cheaper", "about the same"]);
      expect([cost(1.04, 1), cost(1.05, 1), cost(1.99, 1), cost(2, 1)]).toEqual(["about the same", "5% more", "99% more", "2.0× the cost"]);
      expect(cost(0.05, 1.31)).toBe("26× cheaper");
      expect([time(120, 600), time(450, 600), time(12, 10), time(1300, 600)]).toEqual(["5.0× faster", "25% faster", "20% longer", "2.2× as long"]);
    });

    it("counts solve rate in points and leaves out a missing figure", () => {
      const rate = (a: number, b: number) => versus("pass_at_1", a, b)?.text;
      expect([rate(0.7, 0.6), rate(0.5, 0.8), rate(0.6, 0.6)]).toEqual(["+10 pts", "−30 pts", "same rate"]);
      expect([versus("median_seconds", null, 60), versus("cost_per_solved", 0, 1)]).toEqual([null, null]);
    });
  });

  describe("what each model solved", () => {
    const t = (model: string, task_id: string, outcome: string) => ({ model, task_id, outcome }) as Pick<Trial, "model" | "task_id" | "outcome">;

    it("covers every model of the run, not only the headline's two", () => {
      const by = solvedBy([t("glm", "a", "solved"), t("kimi", "a", "failed"), t("sonnet", "a", "solved"), t("kimi", "b", "solved")]);
      expect([...by.keys()].sort()).toEqual(["glm", "kimi", "sonnet"]);
      expect([by.get("glm")!.get("a"), by.get("kimi")!.get("a"), by.get("kimi")!.get("b")]).toEqual([true, false, true]);
    });

    it("leaves a PR out for a model whose attempt on it was lost", () => {
      const by = solvedBy([t("glm", "a", "invalid"), t("sonnet", "a", "solved")]);
      expect(by.get("glm")?.has("a") ?? false).toBe(false);
      expect(by.get("sonnet")!.get("a")).toBe(true);
    });

    it("counts a PR solved when at least half its scored attempts were", () => {
      const by = solvedBy([t("glm", "a", "solved"), t("glm", "a", "failed"), t("glm", "b", "solved"), t("glm", "b", "failed"), t("glm", "b", "failed"), t("glm", "b", "invalid")]);
      expect([by.get("glm")!.get("a"), by.get("glm")!.get("b")]).toEqual([true, false]);
    });
  });
});
