import type * as React from "react";
import { Chevron, Cross, Tick } from "@/components/brand/icons";
import { Column } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import type { AppState } from "@/lib/types";

type Item = { ok: boolean | null; label: string; fix: string; action?: React.ReactNode };

/** What a run needs, each with the one thing to do when it's missing. Locally that's this machine's setup.
 * Hosted, visitors have no terminal and see none of the plumbing: the page's own setup is one line its admins
 * fix, and GitHub is the visitor's own sign-in, needed only for their own repos, so it's never a thing to fix. */
export function readiness(state: AppState): Item[] {
  const c = state.checks;
  const hosted = state.github.sign_in;
  const baseten = state.models.find((m) => m.provider === "baseten");
  const claude = state.models.find((m) => m.provider === "anthropic");
  const host = (local: string, problem?: string | null) =>
    hosted ? `${problem ? `${problem}. ` : ""}The page's admins need to fix this.` : problem ? `${problem}, then restart pr-eval serve` : local;
  const login = state.github.login;
  const github: Item = hosted
    ? { ok: login ? true : null, label: login ? `GitHub: signed in as @${login}` : "GitHub: needed only for your own repos",
        fix: state.github.public ? "Public repos and the quick sample need no sign-in." : state.quick.ready ? "The quick sample needs no sign-in." : "Sign in under New run to start a run." }
    : { ok: c.gh, label: "GitHub access", fix: "Run gh auth login in a terminal, then reload this page" };
  if (hosted) {
    const ready = c.sandboxes && !!baseten && !baseten.missing && !!claude && !claude.missing && c.judge.ok;
    return [github, { ok: ready, label: ready ? "Models and judges ready" : "This page isn't ready to run", fix: "Its admins are fixing it." }];
  }
  return [
    { ok: c.sandboxes, label: "Baseten Sandboxes, where attempts run",
      fix: `${c.sandboxes_problem || "Set BASETEN_API_KEY to a personal key or a team creator service account key."} Then restart pr-eval serve.` },
    github,
    { ok: c.image ? true : null, label: c.image ? "Trial image built" : "Trial image builds on the first run", fix: "A few minutes, once" },
    { ok: !!baseten && !baseten.missing, label: "Baseten key, for open models", fix: host("Set BASETEN_API_KEY, then restart pr-eval serve") },
    { ok: !!claude && !claude.missing, label: "Claude key, for Claude models", fix: host("Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, then restart pr-eval serve") },
    { ok: c.judge.ok, label: `${c.judge.chair ? "Judges" : "Judge"}: ${c.judge.label}${c.judge.effort ? ` at ${c.judge.effort} effort` : ""}${c.judge.chair ? `; ${c.judge.chair} gives the final verdict` : ""}`,
      fix: host("Restart pr-eval serve", c.judge.problem) },
  ];
}

/** What this page needs to run, folded away once it's all there. Sign-in lives in New run, not here. */
export function Readiness({ state }: { state: AppState }) {
  const items = readiness(state);
  const missing = items.filter((i) => i.ok === false).length;
  if (!missing) {
    return (
      <Column heading="Environment" aside={<Badge variant="live">All set</Badge>}>
        <details className="ev-details">
          <summary>
            <Chevron />
            {state.github.sign_in ? "Ready to run" : "Sandboxes, keys and judges are ready"}
          </summary>
          <div className="mt-3"><Checks items={items} /></div>
        </details>
      </Column>
    );
  }
  return (
    <Column heading="Environment" aside={<Badge variant="danger">{missing} to fix</Badge>}>
      <Checks items={items} />
      {!state.github.sign_in && (
        <p className="ev-small mt-6">
          Each attempt runs in sandboxes of its own on Baseten, deleted when it ends. Keys are read from the environment, never saved to a file.
        </p>
      )}
    </Column>
  );
}

function Checks({ items }: { items: Item[] }) {
  return (
    <ul className="ev-checks">
      {items.map((i) => (
        <li key={i.label}>
          <span className="mark" data-ok={i.ok === true ? "yes" : i.ok === null ? "wait" : "no"} aria-label={i.ok === true ? "Ready" : i.ok === null ? "Pending" : "Missing"}>
            {i.ok === true ? <Tick /> : i.ok === null ? null : <Cross />}
          </span>
          <span className="min-w-0">
            {i.label}
            {i.ok !== true && <span className="fix">{i.fix}</span>}
            {i.ok !== true && i.action}
          </span>
        </li>
      ))}
    </ul>
  );
}
