import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { Empty, Eyebrow, isActive, LiveDot } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import type { AppState, Run } from "@/lib/types";
import { NewRun } from "./NewRun";
import { Readiness } from "./Readiness";
import { RunsList } from "./RunsList";

const STEPS = [
  { n: "01", title: "Pick PRs", text: "Paste pull request links, or take a repository's latest merges that came with tests." },
  { n: "02", title: "Check", text: "Keep a PR only if its tests fail before the change and pass after." },
  { n: "03", title: "Models code", text: "Each model gets the PR's request in its own sandbox, without the answer." },
  { n: "04", title: "Grade", text: "Hidden tests run in a fresh sandbox, then a judge model reads the change." },
];

export function HomePage({ state, error, go, hurry }: {
  state: AppState | null; error: string | null; go: (r: Route) => void; hurry: () => void;
}) {
  const live = state?.runs.find((r) => isActive(r.phase));
  return (
    <>
      <section className="px-4 pt-12 pb-10 sm:px-6 md:px-8 md:pt-16">
        <Eyebrow parts={["Baseten", "Open-model coding eval"]} />
        <h1 className="mt-5 max-w-[17ch] text-[40px] leading-[1.05] font-normal tracking-[-0.035em] text-balance sm:text-[56px]">
          Can an open model do your team's coding work?
        </h1>
        <p className="mt-5 max-w-[60ch] text-[17px] leading-relaxed text-muted-foreground">
          Replay real merged pull requests against open models on Baseten and a closed model side by side.
          Every attempt runs in its own Blaxel sandbox; you get solve rate, cost and time per task, and every step each agent took.
        </p>
        <ol className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4" aria-label="How a run works">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative column-rule pt-3">
              <div className="flex items-center justify-between">
                <span className="label-mono text-foreground">{s.n} · {s.title}</span>
                {i < STEPS.length - 1 && <ArrowRightIcon className="hidden size-4 text-line lg:block" aria-hidden />}
              </div>
              <p className="mt-2 text-[14px] leading-snug text-muted-foreground">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {live && <LiveBanner run={live} />}

      <section className="grid border-t border-dashed border-rule lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 px-4 py-10 sm:px-6 md:px-8">
          <div className="mb-8 flex items-end justify-between gap-4">
            <div>
              <div className="label-mono text-muted-foreground">New run</div>
              <h2 className="mt-1 text-[28px] leading-tight tracking-[-0.02em]">Pick the PRs and the models</h2>
            </div>
          </div>
          {state ? <NewRun state={state} go={go} hurry={hurry} /> : <ComposerSkeleton error={error} />}
        </div>
        <aside className="border-t border-dashed border-rule px-4 py-10 sm:px-6 md:px-8 lg:border-t-0 lg:border-l">
          <div className="lg:sticky lg:top-24">
            {state ? <Readiness state={state} /> : <div className="h-72 animate-pulse bg-node" />}
          </div>
        </aside>
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
          : state.runs.length ? <RunsList runs={state.runs} go={go} />
            : <Empty title="No runs yet">Start the quick sample above. Results land in a few minutes.</Empty>}
      </section>
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
    <div className="grid gap-10" aria-busy>
      {[132, 120, 96].map((h, i) => (
        <div key={i} className="column-rule pt-14"><div className="animate-pulse bg-node" style={{ height: h }} /></div>
      ))}
    </div>
  );
}
