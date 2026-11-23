import { describe, expect, it } from "vitest";
import { addressFor, asView, initialView } from "../src/lib/view";

describe("the report's Simple and Detailed views", () => {
  it("opens on Simple when nothing says otherwise", () => {
    expect(initialView("", "", null)).toBe("simple");
    expect(initialView("?data=run/report.json", "#/", "junk")).toBe("simple");
  });

  it("opens on the view last chosen in this browser", () => {
    expect(initialView("", "", "detail")).toBe("detail");
    expect(initialView("", "#/runs/r1/results", "simple")).toBe("simple");
  });

  it("lets a link's ?view= win over the stored choice", () => {
    expect(initialView("?view=detail", "", "simple")).toBe("detail");
    expect(initialView("?view=simple", "", "detail")).toBe("simple");
    // The run page keeps its query after the hash.
    expect(initialView("", "#/runs/r1/results?view=detail", "simple")).toBe("detail");
    // An unknown name falls back to the stored choice.
    expect(initialView("?view=everything", "", "detail")).toBe("detail");
  });

  it("reads detail and detailed, in any case", () => {
    expect(asView("detail")).toBe("detail");
    expect(asView(" Detailed ")).toBe("detail");
    expect(asView("SIMPLE")).toBe("simple");
    expect(asView("")).toBeNull();
    expect(asView(null)).toBeNull();
  });

  it("moves a ?view= the address carries to the view chosen, and leaves other addresses alone", () => {
    expect(addressFor("?view=simple", "", "detail")).toBe("?view=detail");
    expect(addressFor("?a=1&view=detail", "#/runs/r1", "simple")).toBe("?a=1&view=simple#/runs/r1");
    expect(addressFor("", "#/runs/r1/results?view=simple", "detail")).toBe("#/runs/r1/results?view=detail");
    expect(addressFor("", "#/runs/r1/results", "detail")).toBeNull();
    expect(addressFor("?view=detail", "", "detail")).toBeNull();
  });
});
