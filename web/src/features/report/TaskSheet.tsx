import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { Eyebrow, Swatch } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compact, day, dur, plural, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import type { Model, Report, Task, Trial, Vote } from "@/lib/types";
import { cn } from "@/lib/utils";
import { taskState, type TrialsFor } from "./TasksTable";
import { TraceView } from "./TraceView";

/** One task: what the agent was asked, then each model's attempts with diffs, tests and the judge. */
export function TaskSheet({ task, report, ranked, colors, trialsFor, onClose }: {
  task: Task | null; report: Report; ranked: Model[]; colors: Record<string, SwatchT>; trialsFor: TrialsFor; onClose: () => void;
}) {
  return (
    <Sheet open={!!task} onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined}>
        {task && <Body task={task} report={report} ranked={ranked} colors={colors} trialsFor={trialsFor} />}
      </SheetContent>
    </Sheet>
  );
}

function Body({ task: t, report, ranked, colors, trialsFor }: { task: Task; report: Report; ranked: Model[]; colors: Record<string, SwatchT>; trialsFor: TrialsFor }) {
  const scope = !t.test_scope ? "the PR's tests" : t.test_scope.startsWith("the ") ? t.test_scope : `the ${t.test_scope}`;
  const unsolved = taskState(t, ranked, trialsFor).unsolved;
  return (
    <>
      <div className="border-b border-rule px-6 pt-6 pb-5 pr-16">
        <Eyebrow parts={[`${t.repo} #${t.pr ?? ""}`, t.language, t.size && `${t.size}${t.lines_changed ? `, ${t.lines_changed} lines in ${t.files_changed} files` : ""}`, t.merged_at && `Merged ${day(t.merged_at)}`]} />
        <SheetTitle className="mt-3 text-[22px] leading-snug font-normal tracking-[-0.01em]">{t.title}</SheetTitle>
        <SheetDescription className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          <span>Graded with {scope}{!report.run.judge ? "" : (report.run.judge.panel?.length ?? 1) > 1 ? ", then a panel of judges" : ", then the judge"}.</span>
          {t.url && (
            <a href={t.url} target="_blank" rel="noopener" className="label-mono inline-flex items-center gap-1 text-foreground hover:underline">
              Merged PR <ArrowUpRightIcon className="size-3.5" />
            </a>
          )}
        </SheetDescription>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <details className="group mb-6 bg-node">
          <summary className="label-mono flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" /> What the agent was asked to do
          </summary>
          <pre className="max-h-80 overflow-auto px-4 pb-4 font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap">{t.instruction || ""}</pre>
        </details>
        {unsolved && (
          <div className="mb-6 bg-warn-surface px-4 py-3 text-[13.5px]">
            <span className="label-mono mr-2">No model solved this</span>
            Check the task before blaming the models: PR tests sometimes assert details, such as an exact error message, that the request never states.
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {ranked.flatMap((m) => trialsFor(t.id, m.key).map((r) => (
            <Attempt key={`${m.key}-${r.attempt}`} t={t} r={r} m={m} swatch={colors[m.key]} runId={report.run.run_id} />
          )))}
        </div>
      </div>
    </>
  );
}

const OUTCOME = {
  solved: { label: "Solved", variant: "solid" as const },
  failed: { label: "Not solved", variant: "default" as const },
  invalid: { label: "Not scored", variant: "warn" as const },
};

function Attempt({ t, r, m, swatch, runId }: { t: Task; r: Trial; m: Model; swatch?: SwatchT; runId: string }) {
  const a = r.agent ?? {};
  const [view, setView] = React.useState("diff");
  const tools = a.tool_calls ? Object.entries(a.tool_calls).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") : "";
  const setAside = r.tests?.set_aside ?? [];
  const patch = React.useMemo(() => withoutCaches(r.patch), [r.patch]);
  const views = [
    { key: "diff", label: "Agent's diff", text: patch.text },
    { key: "trace", label: "Trace", text: null },
    { key: "merged", label: "Merged diff", text: t.reference_patch },
    { key: "tests", label: "Test output", text: r.verifier_tail },
    { key: "message", label: "Last message", text: a.final_message },
  ];
  const rows: [string, React.ReactNode][] = [];
  if (r.outcome === "invalid") rows.push(["Why not scored", r.invalid_reason || "unknown"]);
  if (a.timed_out) rows.push(["Time limit", `Stopped at ${dur(a.seconds)}; graded on what it had changed by then.`]);
  if (r.tests) rows.push(["Hidden tests", <Lead word={r.tests.passed ? "Passed" : "Failed"} rest={`${r.tests.summary ? ` · ${r.tests.summary}` : ""}${setAside.length ? ` · run without the agent's own changes to ${setAside.length} test ${setAside.length === 1 ? "file" : "files"}` : ""}`} />]);
  if (r.judge) rows.push([(r.judge.panel?.length ?? 1) > 1 ? "Judges" : "Judge", r.judge.error ? `Error: ${r.judge.error}` : <Verdicts judge={r.judge} />]);
  // The file count of an older run's diff counts its cache files too, so it's left out there.
  if (r.diff) rows.push(["Change", `${patch.hidden ? "" : `${plural(r.diff.files, "file")}, `}+${r.diff.added} −${r.diff.removed}${tools ? ` · tools: ${tools}` : ""}`]);
  const o = OUTCOME[r.outcome];
  return (
    <article className="column-rule">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3 pb-3">
        <span className="inline-flex items-center gap-2 text-[15px] font-medium"><Swatch swatch={swatch} size={12} />{m.label}</span>
        <span className="label-mono text-muted-foreground">Attempt {r.attempt}</span>
        <Badge variant={o.variant} style={r.outcome === "solved" && swatch ? { background: swatch.fill, color: swatch.ink } : undefined}>{o.label}</Badge>
        <span className="ml-auto flex flex-wrap gap-x-4 font-mono text-[12px] text-muted-foreground">
          <span title={a.cost_source?.startsWith("rebuilt") ? "Stopped at the time limit; cost rebuilt from the agent's log" : undefined}>
            {a.cost_source === "rebuilt-partial" ? "≥ " : ""}{usd(a.cost_usd)}
          </span>
          <span title={a.retry_wait_seconds ? `${dur(a.seconds)} including ${dur(a.retry_wait_seconds)} waiting on provider retries` : undefined}>
            {dur(a.working_seconds ?? a.seconds)}{a.api_retries ? ` (+${dur(a.retry_wait_seconds)} waits)` : ""}
          </span>
          {a.num_turns != null && <span>{a.num_turns} turns</span>}
          <span>{compact(a.tokens?.output)} out</span>
        </span>
      </header>
      {rows.length > 0 && (
        <dl className="mb-3 grid gap-px bg-frame">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-1 bg-background py-2 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="label-mono pt-0.5 text-[10.5px] text-muted-foreground">{k}</dt>
              <dd className="text-[13.5px] leading-snug [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Tabs value={view} onValueChange={setView}>
        <TabsList className="gap-5">
          {views.map((v) => <TabsTrigger key={v.key} value={v.key} className="h-9 text-[11px]">{v.label}</TabsTrigger>)}
        </TabsList>
        {views.map((v) => (
          <TabsContent key={v.key} value={v.key} className="mt-2">
            {v.key === "trace" ? <TraceView runId={runId} trial={r.trial} active={view === "trace"} />
              : <Code text={v.text} diff={v.key === "diff" || v.key === "merged"}
                  empty={v.key === "diff" && patch.hidden ? "This older run saved cache files in place of the change. The trace shows the agent's edits." : undefined} />}
          </TabsContent>
        ))}
      </Tabs>
    </article>
  );
}

/** The final verdict with the chair's overview, then each judge's own vote. */
function Verdicts({ judge: j }: { judge: NonNullable<Trial["judge"]> }) {
  const votes: Vote[] = (j.panel?.length ?? 0) > 1 ? j.panel! : [];
  return (
    <>
      <Lead word={j.verdict === "pass" ? "Pass" : "Fail"} rest={j.reason ? ` · ${j.reason}` : ""} />
      {j.chair?.label && <span className="text-muted-foreground"> ({j.chair.label}, chair)</span>}
      {votes.length > 0 && (
        <ul className="mt-2 grid gap-1.5 border-l border-rule pl-3 text-[12.5px] leading-snug" aria-label="Each judge's vote">
          {votes.map((v, i) => (
            <li key={i} className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2">
              <span className={cn("label-mono pt-px text-[10.5px]", v.verdict === "pass" ? "text-foreground" : "text-muted-foreground")}>
                {v.error ? "No vote" : v.verdict === "pass" ? "Pass" : "Fail"}
              </span>
              <span className="text-muted-foreground"><span className="text-foreground">{v.label}</span> · {v.error ? `didn't answer: ${v.error}` : v.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A verdict word the eye can find down a column of attempts, then the details. */
function Lead({ word, rest }: { word: string; rest: string }) {
  return <><span className="font-medium">{word}</span>{rest}</>;
}

// Runs from before the runner left caches out of the agent's diff carry every .pyc its test runs
// wrote (runner.CACHES), burying the change under binary patches.
const CACHE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)\/|\.py[co]$/;

/** The agent's diff without cache files, and how many files that took out. */
function withoutCaches(patch?: string | null) {
  if (!patch) return { text: patch, hidden: 0 };
  const files = patch.split(/^(?=diff --git )/m);
  const kept = files.filter((f) => !CACHE.test(/^diff --git a\/(\S+)/.exec(f)?.[1] ?? ""));
  return { text: kept.join(""), hidden: files.length - kept.length };
}

function Code({ text, diff, empty }: { text?: string | null; diff: boolean; empty?: string }) {
  if (!text?.trim()) {
    return empty ? <div className="placeholder-cell px-4 py-6 text-center text-[13px] text-muted-foreground">{empty}</div>
      : <div className="placeholder-cell px-4 py-6 text-center label-mono text-muted-foreground">Empty</div>;
  }
  const lines = text.split("\n");
  return (
    <pre className="max-h-[460px] overflow-auto bg-code py-2 font-mono text-[12px] leading-[1.6]">
      {lines.map((line, i) => {
        const kind = !diff ? "" : line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk"
          : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
        return (
          <span key={i} className={cn("block min-w-max px-4",
            kind === "add" && "bg-diff-add", kind === "del" && "bg-diff-del",
            kind === "file" && "mt-2 bg-node font-medium first:mt-0", kind === "hunk" && "text-muted-foreground")}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}
