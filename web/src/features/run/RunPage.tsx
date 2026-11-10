import * as React from "react";
import { Empty, Eyebrow, isActive, LiveDot, PhaseBadge, Spacer, Surface } from "@/components/brand";
import { Back, Chevron, External } from "@/components/brand/icons";
import { Confirm } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { fillAgain } from "@/features/home/NewRun";
import { Results, TaskDrawer, Tasks } from "@/features/report/ReportView";
import { post, useReport } from "@/lib/api";
import { plural, when } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import { ordered, palette } from "@/lib/models";
import { pipeline } from "@/lib/stages";
import { takeaway } from "@/lib/stats";
import type { AppState, Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LivePanel } from "./LivePanel";
import { Pipeline } from "./Pipeline";

export function RunPage({ id, tab, task, state, go, hurry }: {
  id: string; tab?: string; task?: string; state: AppState | null; go: (r: Route, replace?: boolean) => void; hurry: () => void;
}) {
  const run = state?.runs.find((r) => r.id === id);
  // report.json is rewritten as attempts finish; fetch it again whenever the count moves.
  const version = run ? `${run.progress.done}|${run.phase}|${run.report}` : null;
  const { report } = useReport(run?.report ? id : null, version);

  if (!state) return <Surface><div className="ev-skeleton h-96" aria-busy /></Surface>;
  if (!run) {
    return (
      <Surface>
        <Empty title="Run not found">
          No run called <code className="ev-code">{id}</code> in this jobs folder.
          <div className="mt-4"><Button variant="outline" onClick={() => go({ page: "home" })}>All runs</Button></div>
        </Empty>
      </Surface>
    );
  }

  const active = isActive(run.phase);
  const current = tab === "results" || tab === "tasks" || tab === "board" ? tab : active || !run.report ? "board" : "results";
  const models = ordered(run.models);
  const colors = palette(models);
  // An open task lives in the address, so a link can point straight at one attempt's trace.
  const open = (taskId: string | null) => go({ page: "run", id, tab: current, task: taskId ?? undefined }, true);
  const finished = report ? new Set(report.trials.map((t) => t.task_id)) : null;
  // The headline: the paired verdict, with its cost line under it.
  const t = report?.trials.length ? takeaway(ordered(report.models), report.summary, report) : null;
  const sentence = t?.verdict
    ? <>{t.verdict.head}{t.verdict.cost && <span className="mt-2 block text-[16px] text-body">{t.verdict.cost}</span>}</>
    : t?.sentence ?? null;
  const board = <TabsTrigger value="board">{active ? "Live" : "Board"}</TabsTrigger>;
  const results = <TabsTrigger value="results" disabled={!run.report}>Results</TabsTrigger>;
  return (
    <>
      <RunHeader run={run} state={state} sentence={sentence} hurry={hurry} go={go} />
      <Spacer />
      <Surface aria-label="Run steps">
        <Pipeline run={run} />
        <RunNotes run={run} />
      </Surface>
      <Spacer />
      <Surface>
        <Tabs value={current} onValueChange={(v) => go({ page: "run", id, tab: v }, true)}>
          <TabsList aria-label="Run views" className="mb-10">
            {/* A finished run opens on its results, so they come first; a live run leads with the board. */}
            {!active && run.report ? <>{results}{board}</> : <>{board}{results}</>}
            <TabsTrigger value="tasks" disabled={!run.report}>Tasks{report ? <span className="count">{report.tasks.length}</span> : null}</TabsTrigger>
          </TabsList>
          <TabsContent value="board">
            <LivePanel run={run} models={models} colors={colors} onOpen={finished ? (t) => finished.has(t) && open(t) : undefined} />
            {report && current === "board" && <TaskDrawer report={report} taskId={task ?? null} onClose={() => open(null)} />}
          </TabsContent>
          <TabsContent value="results">
            {report ? <Results report={report} onOpen={open} /> : <Loading />}
            {report && current === "results" && <TaskDrawer report={report} taskId={task ?? null} onClose={() => open(null)} />}
          </TabsContent>
          <TabsContent value="tasks">{report ? <Tasks report={report} openId={task ?? null} onOpen={open} /> : <Loading />}</TabsContent>
        </Tabs>
      </Surface>
    </>
  );
}

function RunHeader({ run, state, sentence, hurry, go }: {
  run: Run; state: AppState; sentence: React.ReactNode; hurry: () => void; go: (r: Route) => void;
}) {
  const toast = useToast();
  const [stopping, setStopping] = React.useState(false);
  const active = isActive(run.phase);
  React.useEffect(() => { if (!active) setStopping(false); }, [active]);
  const stop = async () => {
    setStopping(true);
    const res = await post(`/api/runs/${encodeURIComponent(run.id)}/stop`);
    if (res.error) { setStopping(false); toast("Couldn't stop the run", { body: res.error, tone: "danger" }); }
    hurry();
  };
  const resume = async () => {
    const res = await post(`/api/runs/${encodeURIComponent(run.id)}/resume`);
    if (res.error) toast("Couldn't resume", { body: res.error, tone: "danger" });
    else toast("Resumed", { body: "Unfinished attempts run again." });
    hurry();
  };
  const again = () => {
    fillAgain(run.again!);
    go({ page: "home" });
    requestAnimationFrame(() => document.getElementById("new-run")?.scrollIntoView());
  };
  const vs = ordered(run.models).map((m) => m.label).join(" vs ");
  const reportUrl = run.report ? `/${run.report.replace(/^\//, "")}` : null;
  return (
    <Surface as="header">
      <a href={href({ page: "home" })} className="bt-link text-darkGrey2">
        <span className="chevron"><Back /></span>All runs
      </a>
      <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
        <div className="min-w-0 max-w-[860px] lg:flex-1">
          <Eyebrow parts={[run.tasks ? plural(run.tasks, "PR") : null, vs, run.judged === false ? "Hidden tests only" : "Hidden tests + judges", when(run.started)]} />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h1 className="ev-title">{run.title}</h1>
            <PhaseBadge phase={run.phase} className="mt-1" />
          </div>
          {/* A live run says what it's doing; its takeaway so far, once attempts finish, sits under that. */}
          {active && (
            <p className={cn("mt-4 flex max-w-[60ch] items-baseline gap-3 leading-snug text-balance",
              sentence ? "text-[16px] text-body" : "text-[20px] tracking-[-0.01em]")} aria-live="polite">
              <LiveDot className="-translate-y-0.5" />
              <span>{now(run)}</span>
            </p>
          )}
          {sentence && <p className={cn("max-w-[46ch] text-[24px] leading-[1.3] tracking-[-0.01em] text-balance", active ? "mt-2" : "mt-4")}>{sentence}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {active && (
            <Confirm
              title="Stop this run?"
              description="Attempts in progress end and their sandboxes are deleted. Finished results stay, and Resume picks up where it left off."
              action="Stop run"
              onConfirm={stop}
              trigger={<Button variant="danger" disabled={stopping}>{stopping ? "Stopping" : "Stop"}</Button>}
            />
          )}
          {run.resumable && (
            <Button variant="outline" onClick={resume} disabled={!!state.blocked}>Resume</Button>
          )}
          {!active && run.again && (
            <Tip content="A new run on the same pull requests and models. Add a model before you start.">
              <Button variant="outline" onClick={again}>Run again</Button>
            </Tip>
          )}
          {reportUrl && (
            <Button asChild>
              <a href={reportUrl} target="_blank" rel="noopener">Shareable report<External /></a>
            </Button>
          )}
        </div>
      </div>
    </Surface>
  );
}

/** What a live run is doing right now, in one sentence. */
function now(run: Run): string {
  const step = pipeline(run).find((s) => s.state === "now")?.key;
  const { done, total } = run.progress;
  const sofar = total ? ` ${done} of ${total} attempts finished.` : "";
  if (step === "find") return "Finding merged pull requests that came with tests.";
  if (step === "check") return "Checking that each pull request's tests fail before the fix and pass after.";
  if (step === "code") return `Models coding, each attempt in its own Blaxel sandbox.${sofar}`;
  if (step === "grade") return `Grading with the hidden tests${run.judged === false ? "" : ", then the judges"}.${sofar}`;
  return `${run.detail ? run.detail.replace(/\.?$/, ".") : "Starting."}${sofar}`;
}

/** Why a run stopped, what was left out and the log's tail when something broke. */
function RunNotes({ run }: { run: Run }) {
  const p = run.progress, k = run.checking;
  let line: string | null = null;
  if (run.phase === "stopped") line = `Stopped${p.total ? ` with ${p.done} of ${p.total} attempts finished` : ""}. Resume to carry on where it left off.`;
  else if (run.phase === "done" && run.resumable) line = `${plural(run.lost, "attempt")} ${run.lost === 1 ? "was" : "were"} lost to sandbox, setup or provider problems, not the models. Resume runs ${run.lost === 1 ? "it" : "them"} again.`;
  else if (run.phase === "collecting" || run.phase === "failed" || (run.phase === "checking" && !k.total)) line = run.detail;
  if (!line && !run.left_out.length && !run.note && !run.log) return null;
  return (
    <div className="mt-8 border-t border-lightGrey2">
      {line && <Note label={run.phase === "failed" ? "Failed" : "Status"}>{line}</Note>}
      {run.note && <Note label="Note">{run.note}</Note>}
      {run.left_out.length > 0 && (
        <Note label="Left out">
          <details className="ev-details">
            <summary>
              <Chevron />
              {plural(run.left_out.length, "PR")} failed the check (setup, not the models)
            </summary>
            <ul className="mt-3 grid gap-1 pl-4 text-[14px]">
              {run.left_out.map((t) => <li key={t.id}><span className="ev-code">#{t.pr}</span> {t.why}</li>)}
            </ul>
          </details>
        </Note>
      )}
      {run.log && (
        <Note label="Log">
          <details className="ev-details" open={run.phase === "failed"}>
            <summary>
              <Chevron />Last lines of the run's log
            </summary>
            <pre className="ev-terminal mt-3 max-h-72">{run.log}</pre>
          </details>
        </Note>
      )}
    </div>
  );
}

function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-lightGrey2 py-3 sm:flex-row sm:gap-4">
      <span className="label-xs w-24 shrink-0 pt-1 text-black">{label}</span>
      <div className="min-w-0 flex-1 text-[14px] text-body">{children}</div>
    </div>
  );
}

function Loading() {
  return <div className="grid gap-6" aria-busy>{[180, 260, 200].map((h, i) => <div key={i} className="ev-skeleton" style={{ height: h }} />)}</div>;
}
