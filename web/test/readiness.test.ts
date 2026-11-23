import { describe, expect, it } from "vitest";
import { readiness } from "../src/features/home/Readiness";
import type { AppState } from "../src/lib/types";

const state = (hosted: boolean, pub = true): AppState => ({
  checks: { sandboxes: true, gh: false, image: true, judge: { label: "Judge", ok: true } },
  models: [], runs: [], quick: { tasks: 6, repos: 3, ready: true }, default_limit: 5, max_limit: 40, busy: false,
  github: { hosted, public: pub }, favorites: [],
});

describe("readiness", () => {
  it("never asks a hosted visitor to fix GitHub from a terminal, or to sign in with GitHub", () => {
    const items = readiness(state(true));
    expect(items.find((i) => i.label.startsWith("GitHub"))).toBeUndefined(); // the page reads public repos itself
    expect(items.map((i) => i.fix).join(" ")).not.toMatch(/gh auth|terminal|pr-eval serve|[Ss]ign in/);
    expect(items.map((i) => `${i.label} ${i.fix}`).join(" ")).not.toMatch(/Sandboxes|CLI|image|_KEY|--judge/);
    const quickOnly = readiness(state(true, false)).find((i) => i.label.startsWith("GitHub"))!;
    expect(quickOnly.ok).toBeNull(); // the admins' to fix, not the visitor's
    expect(quickOnly.fix).not.toMatch(/[Ss]ign in/);
  });

  it("keeps the gh check locally", () => {
    const github = readiness(state(false)).find((i) => i.label === "GitHub access")!;
    expect(github.ok).toBe(false);
    expect(github.fix).toMatch(/gh auth login/);
  });
});
