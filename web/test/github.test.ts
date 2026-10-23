import { describe, expect, it } from "vitest";
import { parsePasted, pullCount } from "../src/lib/github";

describe("parsePasted", () => {
  it("reads pull request links in the forms people copy", () => {
    const got = parsePasted(`https://github.com/o/a/pull/12
      github.com/o/a/pull/13/files, o/a#12 x/b#9
      https://github.com/x/b/pull/10#discussion_r1`);
    expect(got.pulls).toEqual({ "o/a": [12, 13], "x/b": [9, 10] });
    expect(pullCount(got.pulls)).toBe(4);
    expect(got.repos).toEqual([]);
  });

  it("tells a repository from a pull request and keeps what it can't read", () => {
    expect(parsePasted("https://github.com/o/a.git")).toEqual({ pulls: {}, repos: ["o/a"], unknown: [] });
    expect(parsePasted("o/a hello https://github.com/o/a/issues/3").unknown).toEqual(["hello", "https://github.com/o/a/issues/3"]);
  });
});
