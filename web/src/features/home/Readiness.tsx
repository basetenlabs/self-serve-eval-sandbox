import type * as React from "react";
import { CheckIcon, ChevronRightIcon, ClockIcon, XIcon } from "lucide-react";
import { Column } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GitHubMark } from "./GitHubAccount";

type Item = { ok: boolean | null; label: string; fix: string; action?: React.ReactNode };

/** What a run needs, each with the one thing to do when it's missing. Locally that's this machine's setup.
 * Hosted, visitors have no terminal: the page's own setup is its admins' to fix, and GitHub is the visitor's
 * own sign-in, needed only for their own repos, so it's never a thing to fix. */
export function readiness(state: AppState, onSignIn?: () => void): Item[] {
  const c = state.checks;
  const hosted = state.github.sign_in;
  const baseten = state.models.find((m) => m.provider === "baseten");
  const claude = state.models.find((m) => m.provider === "anthropic");
  const host = (local: string, problem?: string | null) =>
    hosted ? `${problem ? `${problem}. ` : ""}The page's admins need to fix this.` : problem ? `${problem}, then restart pr-eval serve` : local;
  const login = state.github.login;
  const github: Item = hosted
    ? { ok: login ? true : null, label: login ? `GitHub: signed in as @${login}` : "GitHub: needed only for your own repos",
        fix: state.github.public ? "Public repos and the quick sample need no sign-in." : state.quick.ready ? "The quick sample needs no sign-in." : "Sign in to start a run.",
        action: onSignIn && <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onSignIn}><GitHubMark className="size-3.5" /> Sign in with GitHub</Button> }
    : { ok: c.gh, label: "GitHub access", fix: "Run gh auth login in a terminal, then reload this page" };
  return [
    { ok: c.blaxel, label: "Dedicated Blaxel workspace", fix: hosted ? host("", c.blaxel_problem) : c.blaxel_problem || "Configure PR_EVAL_BLAXEL_WORKSPACE or ~/.config/pr-eval/blaxel.json, then restart pr-eval serve" },
    { ok: c.bl_cli, label: "Blaxel CLI", fix: hosted ? host("") : "Install the Blaxel CLI (bl): runs use it to build and find the trial image" },
    github,
    { ok: c.image ? true : null, label: c.image ? "Trial image built" : "Trial image builds on the first run", fix: "A few minutes, once" },
    { ok: !!baseten && !baseten.missing, label: "Baseten key, for open models", fix: host("Set BASETEN_API_KEY, then restart pr-eval serve") },
    { ok: !!claude && !claude.missing, label: "Claude key, for Claude models", fix: host("Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, then restart pr-eval serve") },
    { ok: c.judge.ok, label: `${c.judge.chair ? "Judges" : "Judge"}: ${c.judge.label}${c.judge.effort ? ` at ${c.judge.effort} effort` : ""}${c.judge.chair ? `; ${c.judge.chair} gives the final verdict` : ""}`,
      fix: host("Restart pr-eval serve", c.judge.problem) },
  ];
}

/** What this page needs to run, folded away once it's all there. `onSignIn` starts the hosted GitHub sign-in. */
export function Readiness({ state, onSignIn }: { state: AppState; onSignIn?: () => void }) {
  const items = readiness(state, onSignIn);
  const missing = items.filter((i) => i.ok === false).length;
  if (!missing) {
    return (
      <Column heading="Environment" aside={<Badge variant="solid">All set</Badge>}>
        <details className="group">
          <summary className="label-mono flex cursor-pointer list-none items-center gap-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Workspace, keys and judges are ready
          </summary>
          <div className="mt-3"><Checks items={items} /></div>
        </details>
      </Column>
    );
  }
  return (
    <Column heading="Environment" aside={<Badge variant="danger">{missing} to fix</Badge>}>
      <Checks items={items} />
      <p className="mt-5 text-[12.5px] leading-snug text-muted-foreground">
        Runs use their own Blaxel workspace, never a shared one. Keys are read from the environment, never saved to a file.
      </p>
    </Column>
  );
}

function Checks({ items }: { items: Item[] }) {
  return (
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
            {i.ok !== true && i.action}
          </span>
        </li>
      ))}
    </ul>
  );
}
