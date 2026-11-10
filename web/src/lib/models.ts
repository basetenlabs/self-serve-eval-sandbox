import type { Model } from "./types";

// Green is Baseten: open models served on Baseten take Green, then Dark Green (the second member of the family).
// Closed models are the comparison: Blue, then Dark Blue. Anything left over is a grey, so Gold (judges, not
// scored) and Pink (the difference between two models) keep their meaning however many models run.
export interface Swatch {
  fill: string; // the Base (or Dark) step: bars, dots, solved cells
  ink: string; // text on fill, from the brand's passing contrast pairs
  tint: string; // the Light step: regions and backgrounds
}

const c = (name: string) => `var(--color-${name})`;
const GREEN = { fill: c("green"), ink: c("black"), tint: c("lightGreen") };
const GREEN_DARK = { fill: c("darkGreen"), ink: c("white"), tint: c("lightGreen") };
const BLUE = { fill: c("blue"), ink: c("black"), tint: c("lightBlue") };
const BLUE_DARK = { fill: c("darkBlue"), ink: c("white"), tint: c("lightBlue") };
const GREY = (step: string, ink: string) => ({ fill: c(step), ink: c(ink), tint: c("lightGrey2") });

// Open models take the dark greys first and closed ones the light greys, so leftovers stay apart.
const OPEN = [GREEN, GREEN_DARK, GREY("darkGrey1", "white"), GREY("darkGrey2", "white"), GREY("darkGrey3", "black")];
const CLOSED = [BLUE, BLUE_DARK, GREY("lightGrey3", "black"), GREY("darkGrey3", "black")];

export const isOpen = (m: Model) => m.kind !== "closed";

/** Baseten's models first, then the comparison, each keeping the run's order. */
export function ordered<T extends Model>(models: T[]): T[] {
  return [...models.filter(isOpen), ...models.filter((m) => !isOpen(m))];
}

/** One swatch per model key, stable for a given list of models. */
export function palette(models: Model[]): Record<string, Swatch> {
  const out: Record<string, Swatch> = {};
  let o = 0, k = 0;
  for (const m of ordered(models)) {
    out[m.key] = isOpen(m) ? OPEN[o++ % OPEN.length] : CLOSED[k++ % CLOSED.length];
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
