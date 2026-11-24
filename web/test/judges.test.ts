import { describe, expect, it } from "vitest";
import { failReason, judgeReview, judgesDecide } from "../src/lib/stages";

describe("the judges' review", () => {
  it("sits beside the tests' outcome on a cell, and says when the judges gave none", () => {
    expect(judgeReview({ judge: "fail", judge_reason: "Hardcodes the value." })).toEqual({ glyph: "✕", text: "Judges: fail. Hardcodes the value." });
    expect(judgeReview({ judge: "pass" })?.glyph).toBe("✓");
    expect(judgeReview({ judge: "error" })?.text).toMatch(/tests alone/);
    expect(judgeReview({})).toBeNull(); // no judge was asked
    expect(failReason({ stage: "solved", tests_passed: true, judge: "fail" })).toBeNull(); // a no never unsolves it
  });

  it("decided solved only on runs from before the judges reviewed", () => {
    expect(judgesDecide({ review: true })).toBe(false);
    expect(judgesDecide({ model: "a+b>b" } as { review?: boolean })).toBe(true);
    expect(judgesDecide(null)).toBe(false);
  });
});
