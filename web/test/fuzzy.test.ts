import { describe, expect, it } from "vitest";
import { match } from "../src/lib/fuzzy";

const pull = (number: number, title: string, author = "ana") => ({ number, title, author });
const rank = (query: string, pulls: ReturnType<typeof pull>[]) =>
  pulls.map((p) => ({ p, m: match(query, p) })).filter((x) => x.m).sort((a, b) => b.m!.score - a.m!.score).map((x) => x.p.number);

describe("finding pull requests", () => {
  const pulls = [pull(4203, "fix(context): binding of nested form values"), pull(4549, "chore(deps): bump golang.org/x/net"),
    pull(4861, "feat: Context.ShouldBindBodyWith for XML", "bo"), pull(120, "docs: readme")];

  it("matches words anywhere and abbreviations of one word", () => {
    expect(rank("ctx bind", pulls)).toEqual([4203, 4861]);
    expect(rank("bump net", pulls)).toEqual([4549]);
    expect(match("zz", pulls[0])).toBeNull();
    expect(match("cvs", pulls[0])).toBeNull(); // c..v..s only across words: no match
  });

  it("finds a pull request by its number, with or without #", () => {
    expect(rank("#42", pulls)[0]).toBe(4203);
    expect(rank("4549", pulls)).toEqual([4549]);
  });

  it("finds the author's pull requests", () => {
    expect(rank("bo", pulls)[0]).toBe(4861);
  });

  it("marks the matched letters of the title", () => {
    const m = match("bind", pulls[0])!;
    expect(m.hits.map((i) => pulls[0].title[i]).join("")).toBe("bind");
  });
});
