import { describe, expect, it } from "vitest";
import { kindOf, mix, mixLabel } from "../src/lib/pulls";
import type { PullRow } from "../src/lib/types";

const row = (number: number, title: string, lines = 50, extra: Partial<PullRow> = {}): PullRow =>
  ({ number, title, url: "", files: 2, lines, tests: 1, ...extra });

describe("kindOf", () => {
  it("reads conventional prefixes and plain words", () => {
    expect(kindOf("feat: add a city search")).toBe("feature");
    expect(kindOf("fix(router): handle empty path")).toBe("fix");
    expect(kindOf("fix: escape HTML in titles to stop XSS")).toBe("security");
    expect(kindOf("Sanitize redirect targets")).toBe("security");
    expect(kindOf("Add support for trailing slashes")).toBe("feature");
    expect(kindOf("Refactor the loader")).toBe("other");
    expect(kindOf("middleware: preserve status after empty ReadFrom")).toBe("fix");
    expect(kindOf("feat: handle new locales")).toBe("feature");
    expect(kindOf("router: reject path traversal in static files")).toBe("security");
  });
});

describe("mix", () => {
  const rows = [
    row(10, "feat: one"), row(9, "feat: two"), row(8, "feat: three"),
    row(7, "fix: one"), row(6, "fix: two", 900), row(5, "fix: three"),
    row(4, "security: one"), row(3, "Refactor"),
    row(2, "fix: no tests", 20, { why: "doesn't change both code and tests" }), row(1, "chore: bump", 5, { maintenance: true }),
  ];
  it("takes security, fixes and features in turn, small ones first, others only to fill, never an unusable one", () => {
    expect(mix(rows, 6)).toEqual([4, 7, 10, 5, 9, 8]);
    expect(mix(rows, 8)).toEqual([4, 7, 10, 5, 9, 8, 3, 6]);
    expect(mix(rows, 100)).not.toContain(2);
    expect(mix(rows, 100)).not.toContain(1);
  });
  it("says what the set is made of", () => {
    expect(mixLabel(rows, mix(rows, 6))).toBe("1 security, 2 fixes, 3 features");
    expect(mixLabel(rows, mix(rows, 8))).toBe("1 security, 3 fixes, 3 features, 1 other");
  });
});
