import * as React from "react";
import { Empty, isActive, LiveDot, Spacer, Surface, Tag } from "@/components/brand";
import { Chevron } from "@/components/brand/icons";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { plural } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import type { AppState, Run } from "@/lib/types";
// The Model APIs scene from the design skill (scripts/make_cube.py --family pink --scene --inline), inline so its
// terminal face is set in the page's Geist Mono. The phone gets a squarer crop with the cube centred.
import scene from "@/assets/hero.svg?raw";
import scenePhone from "@/assets/hero-phone.svg?raw";
import { fillAgain, NewRun } from "./NewRun";
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
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <>
      {installed && <InstalledNote action={installed} onClose={() => setInstalled(null)} />}
      <Surface className="ev-hero">
        <h1 className="ev-hero-title">{"Find the open model that\ndoes your team's coding work"}</h1>
        <div className="ev-scene">
          <div className="visual max-sm:hidden" dangerouslySetInnerHTML={{ __html: scene }} />
          <div className="visual sm:hidden" dangerouslySetInnerHTML={{ __html: scenePhone }} />
          <div className="corner">
            <p>
              Replay your team's merged pull requests with open models on Baseten and a closed model, side by side, each
              attempt in its own sandbox. See what each one solves, what it costs and how long it takes.
            </p>
            <div className="ctas">
              <Button chevron onClick={() => jump("new-run")}>Start a run</Button>
              <Button variant="outline" chevron onClick={() => jump("runs")}>See past runs</Button>
            </div>
          </div>
        </div>
        <ol className="ev-steps" aria-label="How a run works">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span className="bt-numeral">{s.n}</span>
              <h2>{s.title}</h2>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </Surface>

      {live && <><Spacer /><LiveBanner run={live} /></>}

      <Spacer />
      <Surface id="new-run" aria-labelledby="new-run-heading" className="scroll-mt-3">
        <div className="ev-head">
          <div>
            <Tag>New run</Tag>
            <h2 id="new-run-heading">Pick the PRs and the models</h2>
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
        {!state ? <div className="ev-skeleton h-40" aria-busy />
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
      <a href={href({ page: "run", id: run.id })} className="ev-live">
        <span className="label-mono inline-flex items-center gap-2"><LiveDot /> Run in progress</span>
        <span className="title">{run.title}</span>
        <span className="label-mono text-muted-foreground">
          {run.board?.sandboxes ? `${run.board.sandboxes} sandboxes live · ` : ""}{p.total ? `${p.done} of ${p.total} attempts done` : run.detail}
        </span>
        <span className="watch">Watch it <Chevron /></span>
        <span className="meter" aria-hidden><i style={{ transform: `scaleX(${share})` }} /></span>
      </a>
    </Surface>
  );
}

/** GitHub opened this page in a new tab: the person's first tab is where they were, and it looks again on its own. */
function InstalledNote({ action, onClose }: { action: string; onClose: () => void }) {
  return (
    <Surface as="div" className="tight">
      <div role="status" className="bt-notice success flex-wrap items-center">
        <span className="min-w-0 flex-1">
          {action === "request"
            ? "GitHub sent your request to the organization's owners. Once one approves it, your repositories show up on the page you started from."
            : "GitHub saved the repositories Baseten Eval Sandbox can read."}{" "}
          <span className="text-body">You can close this tab and go back to the one you started in: it looks again when you return.</span>
        </span>
        <Button variant="ghost" onClick={onClose}>Dismiss</Button>
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
          <div key={i} className="bt-column"><div className="ev-skeleton mt-8" style={{ height: h }} /></div>
        ))}
      </div>
      <div className="bt-aside">
        <div className="bt-column"><div className="ev-skeleton mt-8 h-56" /></div>
      </div>
    </div>
  );
}
