import { describe, expect, it } from "vitest";
import { clock, dur, elapsed, pct, usd } from "../src/lib/format";

describe("format", () => {
  it("shows a dash for numbers that weren't measured, never zero", () => {
    expect(pct(null)).toBe("–");
    expect(usd(undefined)).toBe("–");
    expect(dur(null)).toBe("–");
  });

  it("scales money and durations to readable units", () => {
    expect(usd(0.0423)).toBe("$0.042");
    expect(usd(7.019)).toBe("$7.02");
    expect(usd(152.4)).toBe("$152");
    expect(dur(42)).toBe("42s");
    expect(dur(138)).toBe("2.3 min");
    expect(dur(5040)).toBe("1.4 h");
  });

  it("formats wall clock and timers", () => {
    expect(elapsed(40)).toBe("40s");
    expect(elapsed(3720)).toBe("1h 2m");
    expect(clock(42)).toBe("0:42");
    expect(clock(3729)).toBe("1:02:09");
  });
});
