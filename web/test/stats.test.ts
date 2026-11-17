import { describe, expect, it } from "vitest";
import { palette } from "../src/lib/models";
import { lead, rank, solvedBy, takeaway, wilson } from "../src/lib/stats";
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
    expect(t.sentence).toBe("GLM 4.6 solved as many tasks as Claude Sonnet and is 78% cheaper per solved task.");
    expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual(["glm", "sonnet", "Baseten's GLM 4.6 is 78% cheaper"]);
    expect(t.cost?.note).toBe("Compared with Claude Sonnet.");
    // Each chip is the best open model on that metric and Claude Sonnet, said from the better one: Kimi
    // solves the most; it is also the quickest open model, but Claude Sonnet is quicker still.
    expect([t.solve?.model.key, t.solve?.vs.key, t.solve?.chip, t.solve?.note]).toEqual(["kimi", "sonnet", "Baseten's Kimi K2 is 10 points higher", "Compared with Claude Sonnet."]);
    expect([t.time?.model.key, t.time?.vs.key, t.time?.chip]).toEqual(["sonnet", "kimi", "Anthropic's Claude Sonnet took 33% less time"]);
    expect(t.time?.note).toBe("Compared with Kimi K2. It solved 7 of 10 PRs and Kimi K2 solved 8.");
  });

  it("falls back to the strongest open model when none matches", () => {
    const S = { glm: s(0.5, 5, 10, 0.3, 120), sonnet: s(0.8, 8, 10, 0.4, 60) };
    const t = takeaway([glm, sonnet], S);
    expect(t.sentence).toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate and is 25% cheaper per solved task.");
    // Two models: the chip says who and by how much; the solve rates are the bars, so nothing goes under it.
    expect([t.solve?.model.key, t.solve?.chip, t.solve?.note]).toEqual(["sonnet", "Anthropic's Claude Sonnet is 30 points higher", ""]);
    // Dearer than the closed model: the closed one is the cheaper, by a percent of the open one's cost.
    const dear = takeaway([glm, sonnet], { glm: s(0.5, 5, 10, 0.42, 120), sonnet: s(0.8, 8, 10, 0.4, 60) });
    expect(dear.sentence).toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate, but Claude Sonnet is 5% cheaper per solved task.");
    expect(dear.cost?.chip).toBe("Anthropic's Claude Sonnet is 5% cheaper");
    expect(takeaway([glm, sonnet], { glm: s(0.5, 5, 10, 0.9, 120), sonnet: s(0.8, 8, 10, 0.4, 60) }).sentence)
      .toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate, but Claude Sonnet is 56% cheaper per solved task.");
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
      expect(t.verdict).toEqual({ head: "Both models solved the same 6 PRs.", cost: "GLM 4.6 is 86% cheaper per solved task than Claude Sonnet." });
      expect(t.sentence).toBe("Both models solved the same 6 PRs. GLM 4.6 is 86% cheaper per solved task than Claude Sonnet.");
      expect([t.cost?.chip, t.cost?.note]).toEqual(["Baseten's GLM 4.6 is 86% cheaper", ""]);
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
      // $0.210 against $1.31: 84% cheaper, from the figures as shown.
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual([d.key, c.key, "Baseten's DeepSeek V4.1 Flash 1017 is 84% cheaper"]);
      expect(t.cost?.note).toBe("Compared with Claude Opus 5.5. It solved 5 of 8 PRs and Claude Opus 5.5 solved 6.");
      expect(t.verdict).toEqual({
        head: "GLM-5.3 and Claude Opus 5.5 solved the same 6 PRs.",
        cost: "DeepSeek V4.1 Flash 1017 is 84% cheaper per solved task than Claude Opus 5.5. It solved 5 of 8 PRs and Claude Opus 5.5 solved 6.",
      });
    });

    it("says the quickest open model takes about the same time, not that the run was slower", () => {
      const t = takeaway([g, d, c], S, { tasks, trials });
      // 6.9 min against 7.1 min.
      expect([t.time?.model.key, t.time?.vs.key, t.time?.tie, t.time?.chip]).toEqual([d.key, c.key, true, "About the same time"]);
      expect(t.time?.note).toBe("DeepSeek V4.1 Flash 1017 solved 5 of 8 PRs and Claude Opus 5.5 solved 6.");
    });

    it("names the better of two models and who serves it, from the figures as shown", () => {
      // A real two-model run: both solved 11 of 13 PRs, at $0.185 and $0.638 per solved task, in 3.8 and 2.2 min.
      const flash = { ...d, label: "DeepSeek V4.1 Flash" };
      const two = { [flash.key]: s(11 / 13, 11, 13, 0.18545244581818182, 226.5), [c.key]: s(11 / 13, 11, 13, 0.6383802545454546, 132.3) };
      const t = takeaway([flash, c], two);
      expect([t.cost?.chip, t.cost?.note]).toEqual(["Baseten's DeepSeek V4.1 Flash is 71% cheaper", ""]);
      expect([t.time?.chip, t.time?.note]).toEqual(["Anthropic's Claude Opus 5.5 took 42% less time", ""]);
      expect(t.sentence).toBe("DeepSeek V4.1 Flash solved as many tasks as Claude Opus 5.5 and is 71% cheaper per solved task.");
      // The maker comes from the model's config; a run from before that field reads it from the provider.
      const made = { ...c, provider: "openai", maker: "OpenAI", label: "GPT-6.1" };
      expect(takeaway([flash, made], { ...two, [made.key]: two[c.key] }).time?.chip).toBe("OpenAI's GPT-6.1 took 42% less time");
    });

    it("calls a gap under 5% about the same and names both", () => {
      const near = { [g.key]: s(6 / 8, 6, 8, 1.36, 400), [c.key]: s(6 / 8, 6, 8, 1.31, 390) };
      const t = takeaway([g, c], near);
      expect([t.cost?.tie, t.cost?.chip, t.time?.chip, t.solve?.chip]).toEqual([true, "About the same cost", "About the same time", "Same solve rate"]);
      expect(t.cost?.note).toBe("");
      expect(t.sentence).toBe("GLM-5.3 solved as many tasks as Claude Opus 5.5 at about the same cost per solved task.");
      // Three models, the cheapest open one about even with Claude: the chip's line and the headline name them.
      const three = takeaway([g, d, c], { ...near, [d.key]: s(5 / 8, 5, 8, 1.4, 300) }, { tasks, trials });
      expect(three.cost?.note).toBe("GLM-5.3 and Claude Opus 5.5.");
      expect(three.verdict?.cost).toBe("GLM-5.3 and Claude Opus 5.5 cost about the same per solved task.");
    });

    it("breaks a tie on the figure as shown in favour of the model that solved more", () => {
      const tie = { ...S, [g.key]: s(6 / 8, 6, 8, 0.2104, 588.9), [d.key]: s(5 / 8, 5, 8, 0.2098, 414.7) };
      const t = takeaway([d, g, c], tie, { tasks, trials });
      expect([t.cost?.model.key, t.cost?.chip]).toEqual([g.key, "Baseten's GLM-5.3 is 84% cheaper"]); // both $0.210
      expect(t.verdict?.cost).toBe("GLM-5.3 is 84% cheaper per solved task than Claude Opus 5.5.");
    });

    it("leaves a model that solved none out of the cost comparison", () => {
      const k = { ...d, key: "kimi", label: "Kimi K3" };
      const none = { [g.key]: s(6 / 8, 6, 8, 0.4, 400), [k.key]: s(3 / 8, 3, 8, 1, 300), [c.key]: s(0, 0, 8, null, 200) };
      const t = takeaway([g, k, c], none);
      // No closed figure to measure against: the cheapest against the runner-up.
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual([g.key, "kimi", "Baseten's GLM-5.3 is 60% cheaper"]);
      expect(t.cost?.note).toBe("Compared with Kimi K3. It solved 6 of 8 PRs and Kimi K3 solved 3.");
      expect(lead([g, c], none, "cost_per_solved")).toBeUndefined(); // one figure is no comparison
      // Time still has Claude's figure: the quickest open model and Claude, which is quicker.
      expect([t.time?.model.key, t.time?.vs.key, t.time?.chip]).toEqual([c.key, "kimi", "Anthropic's Claude Opus 5.5 took 34% less time"]);
      expect(t.time?.note).toBe("Compared with Kimi K3. It solved none of 8 PRs and Kimi K3 solved 3.");
    });

    it("compares open models with each other when there's no closed one", () => {
      const t = takeaway([g, d], S);
      expect([t.open, t.closed]).toEqual([undefined, undefined]);
      expect(t.sentence).toBe("GLM-5.3 solved 6 PRs.");
      expect([t.cost?.model.key, t.cost?.vs.key, t.cost?.chip]).toEqual([d.key, g.key, "Baseten's DeepSeek V4.1 Flash 1017 is 85% cheaper"]);
    });
  });

  describe("how much better", () => {
    const o = { key: "o", label: "Open", kind: "open", provider: "baseten" } as Model;
    const k = { key: "k", label: "Closed", kind: "closed", provider: "anthropic" } as Model;
    const chip = (metric: "cost_per_solved" | "median_seconds", a: number, b: number) =>
      lead([o, k], { o: s(0.5, 5, 10, metric === "cost_per_solved" ? a : 1, metric === "median_seconds" ? a : 60),
        k: s(0.5, 5, 10, metric === "cost_per_solved" ? b : 1, metric === "median_seconds" ? b : 60) }, metric)?.chip;

    it("says a percent of the other's figure, never a multiple, and about the same under 5%", () => {
      expect([chip("cost_per_solved", 0.5, 1), chip("cost_per_solved", 0.95, 1), chip("cost_per_solved", 0.96, 1)])
        .toEqual(["Baseten's Open is 50% cheaper", "Baseten's Open is 5% cheaper", "About the same cost"]);
      expect([chip("cost_per_solved", 2, 1), chip("cost_per_solved", 0.004, 1.31)]).toEqual(["Anthropic's Closed is 50% cheaper", "Baseten's Open is 99% cheaper"]);
      expect([chip("median_seconds", 120, 600), chip("median_seconds", 600, 120), chip("median_seconds", 61, 60)])
        .toEqual(["Baseten's Open took 80% less time", "Anthropic's Closed took 80% less time", "About the same time"]);
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
