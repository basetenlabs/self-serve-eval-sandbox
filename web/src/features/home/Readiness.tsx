import { CheckIcon, ClockIcon, XIcon } from "lucide-react";
import { Column } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";

type Item = { ok: boolean | null; label: string; fix: string };

/** What a run needs from this machine, each with the one thing to do when it's missing. */
export function readiness(state: AppState): Item[] {
  const c = state.checks;
  const baseten = state.models.find((m) => m.provider === "baseten");
  const claude = state.models.find((m) => m.provider === "anthropic");
  return [
    { ok: c.blaxel, label: "Dedicated Blaxel workspace", fix: c.blaxel_problem || "Configure PR_EVAL_BLAXEL_WORKSPACE or ~/.config/pr-eval/blaxel.json, then restart pr-eval serve" },
    { ok: c.bl_cli, label: "Blaxel CLI", fix: "Install the Blaxel CLI (bl): runs use it to build and find the trial image" },
    { ok: c.gh, label: "GitHub access", fix: "Run gh auth login in a terminal, then reload this page" },
    { ok: c.image ? true : null, label: c.image ? "Trial image built" : "Trial image builds on the first run", fix: "A few minutes, once" },
    { ok: !!baseten && !baseten.missing, label: "Baseten key, for open models", fix: "Set BASETEN_API_KEY, then restart pr-eval serve" },
    { ok: !!claude && !claude.missing, label: "Claude key, for Claude models", fix: "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, then restart pr-eval serve" },
    { ok: c.judge.ok, label: `Judge: ${c.judge.model}${c.judge.effort ? `, ${c.judge.effort} effort` : ""}`, fix: c.judge.problem || `Set ${c.judge.env}, then restart pr-eval serve` },
  ];
}

export function Readiness({ state }: { state: AppState }) {
  const items = readiness(state);
  const missing = items.filter((i) => i.ok === false).length;
  return (
    <Column heading="Environment" aside={missing ? <Badge variant="danger">{missing} to fix</Badge> : <Badge variant="solid">All set</Badge>}>
      <ul className="grid gap-px bg-frame">
        {items.map((i) => (
          <li key={i.label} className="flex gap-3 bg-background py-3">
            <span
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center",
                i.ok === true ? "bg-primary text-primary-foreground" : i.ok === null ? "placeholder-cell text-muted-foreground" : "bg-[#AC0EB2] text-white dark:bg-[#FFA9FD] dark:text-black",
              )}
              aria-label={i.ok === true ? "Ready" : i.ok === null ? "Pending" : "Missing"}
            >
              {i.ok === true ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i.ok === null ? <ClockIcon className="size-3" /> : <XIcon className="size-3.5" strokeWidth={3} />}
            </span>
            <span className="min-w-0 text-[14px] leading-5">
              {i.label}
              {i.ok !== true && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">{i.fix}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[12.5px] leading-snug text-muted-foreground">
        Runs use their own Blaxel workspace, never a shared one. Keys stay on this machine.
      </p>
    </Column>
  );
}
