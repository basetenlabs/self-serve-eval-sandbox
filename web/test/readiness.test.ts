import { describe, expect, it } from "vitest";
import { readiness } from "../src/features/home/Readiness";
import type { AppState } from "../src/lib/types";

const state = (sign_in: boolean, login: string | null = null): AppState => ({
  checks: { blaxel: true, bl_cli: true, gh: false, image: true, judge: { label: "Judge", ok: true } },
  models: [], runs: [], quick: { tasks: 6, repos: 3, ready: true }, default_limit: 5, max_limit: 40, busy: false,
  github: { sign_in, login }, favorites: [],
});

describe("readiness", () => {
  it("never asks a hosted visitor to fix GitHub from a terminal", () => {
    const items = readiness(state(true));
    const github = items.find((i) => i.label.startsWith("GitHub"))!;
    expect(github.ok).toBeNull(); // not a thing to fix: needed only for your own repos
    expect(items.map((i) => i.fix).join(" ")).not.toMatch(/gh auth|terminal|pr-eval serve/);
    expect(readiness(state(true, "octocat")).find((i) => i.label.startsWith("GitHub"))!.ok).toBe(true);
  });

  it("keeps the gh check locally", () => {
    const github = readiness(state(false)).find((i) => i.label === "GitHub access")!;
    expect(github.ok).toBe(false);
    expect(github.fix).toMatch(/gh auth login/);
  });
});
