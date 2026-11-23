import { describe, expect, it } from "vitest";
import { frontier, solvedShare } from "../src/lib/stats";
import type { Summary } from "../src/lib/types";

const p = (key: string, cost: number, share: number) => ({ key, cost, share });

describe("the cost and share-solved frontier", () => {
  it("keeps the models no other model beats on both, cheapest first", () => {
    // cheap solves least, mid costs more and solves more, best costs most and solves most; worse is beaten by mid.
    const pts = [p("best", 0.9, 0.8), p("worse", 0.6, 0.4), p("cheap", 0.1, 0.3), p("mid", 0.4, 0.6)];
    expect(frontier(pts)).toEqual(["cheap", "mid", "best"]);
  });

  it("drops a model beaten on one figure and tied on the other", () => {
    expect(frontier([p("a", 0.2, 0.5), p("same-cost", 0.2, 0.4)])).toEqual(["a"]);
    expect(frontier([p("a", 0.2, 0.5), p("same-share", 0.3, 0.5)])).toEqual(["a"]);
  });

  it("keeps both of two models with the same figures", () => {
    expect(frontier([p("b", 0.2, 0.5), p("a", 0.2, 0.5)]).sort()).toEqual(["a", "b"]);
  });

  it("is one model when it beats every other on both", () => {
    expect(frontier([p("glm", 0.1, 0.9), p("sonnet", 0.8, 0.7), p("kimi", 0.3, 0.5)])).toEqual(["glm"]);
  });

  it("handles one model, none, and points missing a figure", () => {
    expect(frontier([p("only", 0.5, 0.5)])).toEqual(["only"]);
    expect(frontier([])).toEqual([]);
    expect(frontier([p("a", 0.5, 0.5), p("no-cost", Number.NaN, 1), p("free", Infinity, 1)])).toEqual(["a"]);
  });

  it("measures share solved over the PRs a model was scored on", () => {
    const s = { tasks: 8, tasks_solved: 5 } as Summary;
    expect(solvedShare(s)).toBe(0.625);
    expect(solvedShare({ tasks: 0, tasks_solved: 0 } as Summary)).toBeNull();
    expect(solvedShare(undefined)).toBeNull();
  });
});
