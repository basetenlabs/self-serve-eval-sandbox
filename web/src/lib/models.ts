import type { Model } from "./types";

// Green is Baseten: open models served on Baseten take the green ramp first. Closed models are the
// comparison and take blue. Pink stays free for deltas while there are fewer than four open models.
export interface Swatch {
  fill: string; // the Base (or Dark) step: bars, dots, solved cells
  ink: string; // text on fill, from the brand's passing contrast pairs
  tint: string; // the Light step: regions and backgrounds
}

const GREEN = { fill: "#19E76E", ink: "#000000", tint: "#D7FACE" };
const GREEN_DARK = { fill: "#009735", ink: "#000000", tint: "#D7FACE" };
const GOLD = { fill: "#FFBE4D", ink: "#000000", tint: "#FFEDC4" };
const GOLD_DARK = { fill: "#D5700B", ink: "#000000", tint: "#FFEDC4" };
const PINK = { fill: "#FFA9FD", ink: "#000000", tint: "#F4E7F2" };
const PINK_DARK = { fill: "#AC0EB2", ink: "#FFFFFF", tint: "#F4E7F2" };
const BLUE = { fill: "#3DA6FF", ink: "#000000", tint: "#D4EBFF" };
const BLUE_DARK = { fill: "#0065AD", ink: "#FFFFFF", tint: "#D4EBFF" };
const GREY = { fill: "#575D56", ink: "#FFFFFF", tint: "#E3EAE1" };

const OPEN = [GREEN, GREEN_DARK, GOLD, PINK, GOLD_DARK, PINK_DARK];
const CLOSED = [BLUE, BLUE_DARK, GREY];

export const isOpen = (m: Model) => m.kind !== "closed";

/** Baseten's models first, then the comparison, each keeping the run's order. */
export function ordered<T extends Model>(models: T[]): T[] {
  return [...models.filter(isOpen), ...models.filter((m) => !isOpen(m))];
}

/** One swatch per model key, stable for a given list of models. */
export function palette(models: Model[]): Record<string, Swatch> {
  const out: Record<string, Swatch> = {};
  let o = 0, c = 0;
  for (const m of ordered(models)) {
    out[m.key] = isOpen(m) ? OPEN[o++ % OPEN.length] : CLOSED[c++ % CLOSED.length];
  }
  return out;
}

export function initials(label: string): string {
  const words = label.replace(/[^A-Za-z0-9. ]/g, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + (words[1].match(/\d/) ? words[1][0] : words[1][0]) : label.slice(0, 2)).toUpperCase();
}

export function providerLabel(m: Model & { provider?: string }): string {
  if (!isOpen(m)) return m.provider === "anthropic" ? "Closed · Anthropic" : "Closed";
  return m.provider === "baseten" ? "Open · on Baseten" : "Open";
}
