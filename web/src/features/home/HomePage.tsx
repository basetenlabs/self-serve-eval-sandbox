import { ArrowRightIcon, CheckIcon, ChevronRightIcon, RepeatIcon } from "lucide-react";
import * as React from "react";
import { Empty, Eyebrow, isActive, LiveDot } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { plural } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import type { AppState, Run } from "@/lib/types";
import { fillAgain, NewRun } from "./NewRun";
import { Readiness } from "./Readiness";
import { RunsList } from "./RunsList";

const STEPS = [
  { n: "01", title: "Pick PRs", text: "Merged pull requests that came with tests." },
  { n: "02", title: "Check", text: "A PR's tests must fail before its change and pass after." },
  { n: "03", title: "Models code", text: "Each model gets only the request, in its own sandbox." },
  { n: "04", title: "Grade", text: "Hidden tests in a fresh sandbox, then AI judges." },
];

// Back from adding repositories to the GitHub App, in a tab GitHub opened: install, update, or request
// (an organization's owner has to approve it).
const fromGitHub = new URLSearchParams(location.search).get("setup_action");

export function HomePage({ state, error, go, hurry }: {
  state: AppState | null; error: string | null; go: (r: Route) => void; hurry: () => void;
}) {
  const live = state?.runs.find((r) => isActive(r.phase));
  const last = state?.runs.find((r) => r.again);
  const [form, setForm] = React.useState(0); // a new key remounts the form, which reads what fillAgain left
  const [installed, setInstalled] = React.useState(fromGitHub);
  React.useEffect(() => {
    if (fromGitHub) history.replaceState(null, "", location.pathname + location.hash); // a reload doesn't say it again
  }, []);
  return (
    <>
      {installed && <InstalledNote action={installed} onClose={() => setInstalled(null)} />}
      <section className="px-4 pt-8 pb-8 sm:px-6 md:px-8 md:pt-12">
        <Eyebrow parts={["Baseten", "Open-model coding eval"]} />
        <h1 className="mt-4 max-w-[24ch] text-[32px] leading-[1.08] font-normal tracking-[-0.03em] text-balance sm:text-[44px]">
          Can an open model do your team's coding work?
        </h1>
        <p className="mt-4 max-w-[62ch] text-[16px] leading-relaxed text-muted-foreground">
          Replay your team's merged pull requests with open models on Baseten and a closed model, side by side, each attempt in its own Blaxel sandbox.
          See what each one solves, what it costs and how long it takes.
        </p>
        <ol className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4" aria-label="How a run works">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative column-rule pt-2.5">
              <div className="flex items-center justify-between">
                <span className="label-mono text-foreground">{s.n} · {s.title}</span>
                {i < STEPS.length - 1 && <ArrowRightIcon className="hidden size-4 text-line lg:block" aria-hidden />}
              </div>
              <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground max-sm:hidden">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {live && <LiveBanner run={live} />}

      <section className="border-t border-dashed border-rule">
        <div id="new-run" className="min-w-0 scroll-mt-20 px-4 py-10 sm:px-6 md:px-8">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="label-mono text-muted-foreground">New run</div>
              <h2 className="mt-1 text-[28px] leading-tight tracking-[-0.02em]">Pick the PRs and the models</h2>
            </div>
            {last?.again && (
              <Tip content={`The pull requests and models of ${last.title}. Add a new model, then start.`}>
                <Button type="button" variant="outline" size="sm" onClick={() => { fillAgain(last.again!); setForm((n) => n + 1); }}>
                  <RepeatIcon className="size-3.5" />Same as last run
                </Button>
              </Tip>
            )}
          </div>
          {state ? <NewRun key={form} state={state} go={go} hurry={hurry} aside={<Readiness state={state} />} /> : <ComposerSkeleton error={error} />}
        </div>
      </section>

      <section className="border-t border-dashed border-rule px-4 py-10 sm:px-6 md:px-8" aria-labelledby="runs-heading">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <div className="label-mono text-muted-foreground">History</div>
            <h2 id="runs-heading" className="mt-1 text-[28px] leading-tight tracking-[-0.02em]">Runs</h2>
          </div>
          {state && state.runs.length > 0 && <span className="label-mono text-muted-foreground">{plural(state.runs.length, "run")}</span>}
        </div>
        {!state ? <div className="h-40 animate-pulse bg-node" />
          : state.runs.length ? <History runs={state.runs} go={go} />
            : <Empty title="No runs yet">Start the quick sample above. Results land in a few minutes.</Empty>}
      </section>
    </>
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** Every run, with the ones that failed or stopped more than a day ago folded away. */
function History({ runs, go }: { runs: Run[]; go: (r: Route) => void }) {
  const [all, setAll] = React.useState(false);
  const old = (r: Run) => (r.phase === "failed" || r.phase === "stopped") && !!r.started && Date.now() - Date.parse(r.started) > DAY;
  const hidden = runs.filter(old).length;
  return (
    <>
      <RunsList runs={all ? runs : runs.filter((r) => !old(r))} go={go} />
      {hidden > 0 && (
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setAll(!all)}>
          {all ? "Hide" : "Show"} {plural(hidden, "older failed or stopped run")}
        </Button>
      )}
    </>
  );
}

/** A run is going: say so above the fold and link to its live board. */
function LiveBanner({ run }: { run: Run }) {
  const p = run.progress;
  const share = p.total ? p.done / p.total : 0;
  return (
    <a
      href={href({ page: "run", id: run.id })}
      className="group relative block border-t border-dashed border-rule bg-[#ECF6EA] px-4 py-5 text-black transition-colors hover:bg-[#D7FACE] sm:px-6 md:px-8 dark:bg-[#213026] dark:text-white dark:hover:bg-[#213026]/80"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="label-mono inline-flex items-center gap-2"><LiveDot /> Run in progress</span>
        <span className="text-[17px]">{run.title}</span>
        <span className="label-mono opacity-70">
          {run.board?.sandboxes ? `${run.board.sandboxes} sandboxes live · ` : ""}{p.total ? `${p.done} of ${p.total} attempts done` : run.detail}
        </span>
        <span className="label-mono ml-auto inline-flex items-center gap-1">Watch it <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" /></span>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-black/10 dark:bg-white/10">
        <div className="h-full bg-[#009735] transition-[width] duration-700 dark:bg-[#19E76E]" style={{ width: `${share * 100}%` }} />
      </div>
    </a>
  );
}

/** GitHub opened this page in a new tab: the person's first tab is where they were, and it looks again on its own. */
function InstalledNote({ action, onClose }: { action: string; onClose: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-dashed border-rule bg-surface px-4 py-4 text-[14px] sm:px-6 md:px-8">
      <CheckIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {action === "request"
          ? "GitHub sent your request to the organization's owners. Once one approves it, your repositories show up on the page you started from."
          : "GitHub saved the repositories Baseten Eval Sandbox can read."}{" "}
        <span className="text-muted-foreground">You can close this tab and go back to the one you started in: it looks again when you return.</span>
      </span>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>Dismiss</Button>
    </div>
  );
}

function ComposerSkeleton({ error }: { error: string | null }) {
  if (error) {
    return (
      <Empty title="Can't reach the page server">
        Is <code className="font-mono text-foreground">pr-eval serve</code> still running? This page retries on its own.
        <div className="mt-4"><Button variant="outline" size="sm" onClick={() => location.reload()}>Reload</Button></div>
      </Empty>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-0" aria-busy>
      <div className="grid gap-10 lg:pr-8">
        {[132, 280].map((h, i) => (
          <div key={i} className="column-rule pt-14"><div className="animate-pulse bg-node" style={{ height: h }} /></div>
        ))}
      </div>
      <div className="lg:border-l lg:border-dashed lg:border-rule lg:pl-8">
        <div className="column-rule pt-14"><div className="h-56 animate-pulse bg-node" /></div>
      </div>
    </div>
  );
}
