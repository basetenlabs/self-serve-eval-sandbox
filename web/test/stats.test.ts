import { describe, expect, it } from "vitest";
import { palette } from "../src/lib/models";
import { rank, takeaway, wilson } from "../src/lib/stats";
import type { Model, Summary } from "../src/lib/types";

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

  it("ranks by solve rate, then cost per solved task", () => {
    const S = { glm: s(0.6, 6, 10, 0.1, 100), kimi: s(0.6, 6, 10, 0.05, 100), sonnet: s(0.7, 7, 10, 0.9, 80) };
    expect(rank([glm, kimi, sonnet], S).map((m) => m.key)).toEqual(["sonnet", "kimi", "glm"]);
  });

  it("names the cheapest open model that matches the closed one", () => {
    const S = { glm: s(0.7, 7, 10, 0.2, 120), kimi: s(0.8, 8, 10, 0.3, 90), sonnet: s(0.7, 7, 10, 0.9, 60) };
    const t = takeaway([glm, kimi, sonnet], S);
    expect(t.open?.key).toBe("glm");
    expect(t.sentence).toBe("GLM 4.6 solved as many tasks as Claude Sonnet, 4.5× cheaper per solved task.");
    expect(t.solve?.text).toBe("Same rate");
    expect(t.cost).toEqual({ text: "4.5× cheaper", ahead: true });
    expect(t.time).toEqual({ text: "2.0× slower", ahead: false });
  });

  it("falls back to the strongest open model when none matches", () => {
    const S = { glm: s(0.5, 5, 10, 0.3, 120), sonnet: s(0.8, 8, 10, 0.4, 60) };
    const t = takeaway([glm, sonnet], S);
    expect(t.sentence).toBe("GLM 4.6 reached 63% of Claude Sonnet's solve rate for 25% less per solved task.");
    expect(t.solve).toEqual({ text: "−30 pts", ahead: false });
  });

  it("keeps green for Baseten's open models and blue for the comparison", () => {
    const colors = palette([sonnet, glm, kimi]);
    expect(colors.glm.fill).toBe("#19E76E");
    expect(colors.kimi.fill).toBe("#009735");
    expect(colors.sonnet.fill).toBe("#3DA6FF");
  });
});
