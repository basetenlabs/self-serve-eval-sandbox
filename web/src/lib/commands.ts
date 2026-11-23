import { usd } from "./format";
import type { CommandsUsed } from "./types";

/** Where a run's install and test commands for a repository came from, in a sentence. */
export function commandsSource(c: CommandsUsed): string {
  const on = c.proven_on?.pr ? ` on #${c.proven_on.pr}` : "";
  if (c.source === "given") return "Given when the run started.";
  if (c.source === "saved") return `Worked out by an earlier run${on} and kept for this repository.`;
  if (c.source === "default") return `The repository's default commands${on ? `, proved${on}` : ""}.`;
  const tries = c.tries && c.tries > 1 ? ` after ${c.tries} tries` : "";
  const cost = c.cost_usd ? `, for ${usd(c.cost_usd)} on ${c.model ?? "a model"}` : "";
  return `Worked out when the run started, proved${on}${tries}${cost}.`;
}
