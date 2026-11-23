import * as React from "react";
import { Empty, isActive, LiveDot, Spacer, Surface, Tag } from "@/components/brand";
import { Chevron } from "@/components/brand/icons";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { plural } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import type { AppState, Run } from "@/lib/types";
import { fillAgain, NewRun } from "./NewRun";
import { RunsList } from "./RunsList";

export function HomePage({ state, error, go, hurry }: {
  state: AppState | null; error: string | null; go: (r: Route) => void; hurry: () => void;
}) {
  const live = state?.runs.find((r) => isActive(r.phase));
  const last = state?.runs.find((r) => r.again);
  const [form, setForm] = React.useState(0); // a new key remounts the form, which reads what fillAgain left
  // No hero: the page opens on the form, under a one-line title (the /baseten-design skill's "Open on the content").
  return (
    <>
      {live && <><LiveBanner run={live} /><Spacer /></>}

      <Surface id="new-run" aria-labelledby="new-run-heading" className="scroll-mt-3">
        <div className="ev-head">
          <div>
            <Tag>New run</Tag>
            <h1 id="new-run-heading">Pick the PRs and the models</h1>
            <p>Open models on Baseten and a closed model replay your team's merged pull requests, each in its own sandbox. See what each one solves, what it costs and how long it takes.</p>
          </div>
          {last?.again && (
            <Tip content={`The pull requests and models of ${last.title}. Add a new model, then start.`}>
              <Button variant="outline" onClick={() => { fillAgain(last.again!); setForm((n) => n + 1); }}>Same as last run</Button>
            </Tip>
          )}
        </div>
        {state ? <NewRun key={form} state={state} go={go} hurry={hurry} /> : <ComposerSkeleton error={error} />}
      </Surface>

      <Spacer />
      <Surface id="runs" aria-labelledby="runs-heading" className="scroll-mt-3">
        <div className="ev-head">
          <div>
            <Tag>History</Tag>
            <h2 id="runs-heading">Runs</h2>
          </div>
          {state && state.runs.length > 0 && <span className="label-mono text-muted-foreground">{plural(state.runs.length, "run")}</span>}
        </div>
        {!state ? <div className="bt-skeleton h-40" aria-busy />
          : state.runs.length ? <History runs={state.runs} go={go} />
            : <Empty title="No runs yet">Start the quick sample above. Results land in about half an hour.</Empty>}
      </Surface>
    </>
  );
}

const DAY = 24 * 60 * 60 * 1000;
// `pr-eval serve` listens on this machine; anywhere else the page is hosted and its visitors have no terminal.
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** Every run, with the ones that failed or stopped more than a day ago folded away. */
function History({ runs, go }: { runs: Run[]; go: (r: Route) => void }) {
  const [all, setAll] = React.useState(false);
  const old = (r: Run) => (r.phase === "failed" || r.phase === "stopped") && !!r.started && Date.now() - Date.parse(r.started) > DAY;
  const hidden = runs.filter(old).length;
  return (
    <>
      <RunsList runs={all ? runs : runs.filter((r) => !old(r))} go={go} />
      {hidden > 0 && (
        <Button variant="ghost" className="mt-2" onClick={() => setAll(!all)}>
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
    <Surface as="div" className="tight">
      <div className="bt-press">
        <a href={href({ page: "run", id: run.id })} className="ev-live">
          <span className="label-mono inline-flex items-center gap-2"><LiveDot /> Run in progress</span>
          <span className="title">{run.title}</span>
          <span className="label-mono text-muted-foreground">
            {run.board?.sandboxes ? `${run.board.sandboxes} sandboxes live · ` : ""}{p.total ? `${p.done} of ${p.total} attempts done` : run.detail}
          </span>
          <span className="watch">Watch it <Chevron /></span>
          <span className="meter" aria-hidden><i style={{ transform: `scaleX(${share})` }} /></span>
        </a>
      </div>
    </Surface>
  );
}

function ComposerSkeleton({ error }: { error: string | null }) {
  if (error) {
    return (
      <Empty title="Can't reach the page server">
        <p className="m-0">{LOCAL ? <>Is <code className="font-mono text-[12px] text-black">pr-eval serve</code> still running? </> : "The page's server isn't answering. "}This page retries on its own.</p>
        <div className="mt-4"><Button variant="outline" onClick={() => location.reload()}>Reload</Button></div>
      </Empty>
    );
  }
  return (
    <div className="layout-grid !p-0" aria-busy>
      <div className="bt-main grid content-start gap-10">
        {[132, 280].map((h, i) => (
          <div key={i} className="bt-column"><div className="bt-skeleton mt-8" style={{ height: h }} /></div>
        ))}
      </div>
      <div className="bt-aside">
        <div className="bt-column"><div className="bt-skeleton mt-8 h-56" /></div>
      </div>
    </div>
  );
}
