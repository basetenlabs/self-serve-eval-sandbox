import * as React from "react";
import { Empty, Eyebrow } from "@/components/brand";
import { commandsSource } from "@/lib/commands";
import { escalationHeadline, labelsOf } from "@/lib/escalation";
import { day, harness, plural } from "@/lib/format";
import { ordered, palette } from "@/lib/models";
import { judgesDecide } from "@/lib/stages";
import { rank, takeaway } from "@/lib/stats";
import type { Report } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ReportView } from "@/lib/view";
import { EscalationResults } from "./Escalation";
import { HeadToHead } from "./HeadToHead";
import { Leaderboard } from "./Leaderboard";
import { Scatter } from "./Scatter";
import { Simple } from "./Simple";
import { TaskSheet } from "./TaskSheet";
import { TasksTable, useTrialsFor } from "./TasksTable";

/** Derived once per report: colours, ranking and the headline comparison. */
export function useReportModel(report: Report) {
  return React.useMemo(() => {
    const S = report.summary;
    const models = ordered(report.models);
    return { S, models, colors: palette(models), ranked: rank(models, S), t: takeaway(models, S, report) };
  }, [report]);
}

/** Facts about a run for its eyebrow: harness, PRs, attempts, tries and dates. */
export function reportFacts(report: Report): string[] {
  const { run, tasks, trials } = report;
  const repos = new Set(tasks.map((t) => t.repo)).size;
  const last = trials.map((t) => t.finished_at).filter(Boolean).sort().pop();
  const dates = last && day(last) !== day(run.created_at) ? `${day(run.created_at)} to ${day(last)}` : day(run.created_at);
  return [harness(run), `${plural(tasks.length, "merged PR")} from ${plural(repos, "repo")}`,
    report.escalation ? "Cheapest model first" : `${plural(run.attempts, "attempt")} per task`,
    ...((run.tries ?? 1) > 1 ? [`up to ${run.tries} tries each`] : []), dates];
}

/** The standalone report's header: facts, then the one-sentence answer. */
export function ReportHeader({ report }: { report: Report }) {
  const { t } = useReportModel(report);
  // Cheapest model first answers its own question: what the cheapest solved, and what climbing saved.
  const climbed = report.escalation && report.trials.length ? escalationHeadline(report.escalation, labelsOf(report.models)) : null;
  const head = climbed?.head ?? t.verdict?.head ?? t.sentence;
  const cost = climbed ? climbed.cost : t.verdict?.cost;
  return (
    <header>
      <Eyebrow parts={reportFacts(report)} />
      <h1 className="ev-title mt-6 max-w-[24ch] text-balance">{head}</h1>
      {cost && <p className="mt-4 max-w-[46ch] text-[24px] leading-[1.3] tracking-[-0.01em] text-balance text-body">{cost}</p>}
    </header>
  );
}

/** How far one PR moves a solve rate on a run this small; null once the sample is big enough. */
export function smallSample(tasks: number, pointer = true): string | null {
  if (tasks >= 30) return null;
  return tasks <= 3 ? `${plural(tasks, "task")}: read it as an example, not a score.`
    : `${plural(tasks, "task")}, so each one moves a solve rate by about ${Math.round(100 / tasks)} points.${pointer ? " Open a model's row for its 95% range." : ""}`;
}

/** Notes that change how to read the run. `sample: false` leaves the small-sample note to the head-to-head's details;
 *  `pointer: false` drops its pointer to the table's rows, for a view without them. */
export function Banners({ report, sample = true, pointer = true, commands = false }: {
  report: Report; sample?: boolean; pointer?: boolean; commands?: boolean;
}) {
  const { run, tasks, trials } = report;
  const expected = (run.tasks ?? []).length * report.models.length * (run.attempts || 1);
  // Cheapest model first counts PRs: how many attempts a PR takes depends on where it's solved.
  const e = report.escalation;
  const finished = e ? `${e.tasks.length - e.remaining} of ${plural(e.tasks.length, "PR")}` : `${trials.length} of ${expected || "?"} attempts`;
  const items: [string, React.ReactNode][] = [];
  const stopped = !report.complete && ["failed", "stopped"].includes(run.status?.phase ?? "") ? run.status?.detail : null;
  if (stopped) {
    items.push(["Stopped", `${finished} had finished. ${stopped}`]);
  } else if (!report.complete) {
    items.push(["In progress", `${finished} had finished at ${new Date(report.generated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Results update as attempts finish.`]);
  }
  if (run.note) items.push(["Note", run.note]);
  if (!run.judge) items.push(["Tests only", "No AI judge on this run: solved means the PR's hidden tests passed."]);
  const small = sample ? smallSample(tasks.length, pointer) : null;
  if (small) items.push(["Small sample", small]);
  // The detailed view says how each repository was installed and tested.
  const used = commands ? Object.entries(run.commands ?? {}) : [];
  for (const [repo, c] of used) {
    items.push([used.length > 1 ? `Commands, ${repo}` : "Commands", (
      <span className="grid gap-1">
        <span>{commandsSource(c)}</span>
        <span>Install: <code className="ev-code break-all">{c.setup}</code></span>
        <span>Test: <code className="ev-code break-all">{c.test}</code></span>
      </span>
    )]);
  }
  if (!items.length) return null;
  return (
    <div className="border-t border-lightGrey2">
      {items.map(([label, text]) => (
        <div key={label} className="flex flex-col gap-1 border-b border-lightGrey2 py-3 sm:flex-row sm:gap-4">
          <span className="label-xs w-32 shrink-0 pt-1 text-black">{label}</span>
          <span className="text-[14px] text-body">{text}</span>
        </div>
      ))}
    </div>
  );
}

const VIEWS: [ReportView, string, string][] = [
  ["simple", "Simple", "What each model solved and cost, on one screen"],
  ["detail", "Detailed", "Every PR, attempt, trace and diff"],
];

/** Simple or Detailed, as chips like the page's other choices. */
export function ViewSwitch({ view, onView }: { view: ReportView; onView: (v: ReportView) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="label-xs text-muted-foreground">View</span>
      <div className="bt-toolbar ev-chips" role="radiogroup" aria-label="View">
        {VIEWS.map(([v, label, title]) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} title={title}
            className={cn("bt-chip", view === v && "active")} onClick={() => onView(v)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/** Results, in the view chosen: Simple (per model what it solved and cost, and quality against cost) or Detailed
 *  (every model side by side, the table of them, and quality against cost). `onOpen` opens a PR's attempts
 *  from the head-to-head. */
export function Results({ report, onOpen, view, onView }: {
  report: Report; onOpen?: (taskId: string) => void; view: ReportView; onView: (v: ReportView) => void;
}) {
  const { S, colors, ranked, t } = useReportModel(report);
  // With a head-to-head, the small-sample note sits in its details, next to the solve rates it qualifies.
  const inDetails = !!t.pairs?.n;
  let body: React.ReactNode;
  // Nothing to compare until an attempt finishes, e.g. a run where no PR passed the check.
  if (!report.trials.length) {
    body = report.complete
      ? <Empty title="No attempts ran">No model attempted a task in this run, so there's nothing to compare.</Empty>
      : <Empty title="No results yet">Results appear here as attempts finish.</Empty>;
  } else if (view === "simple") {
    body = (
      <div className="grid gap-14">
        <Banners report={report} pointer={false} />
        {report.escalation && <EscalationResults report={report} colors={colors} onOpen={onOpen} />}
        <Simple report={report} ranked={ranked} colors={colors} t={t} />
      </div>
    );
  } else {
    body = (
      <div className="grid gap-14">
        <Banners report={report} sample={!inDetails} commands />
        {report.escalation && <EscalationResults report={report} colors={colors} onOpen={onOpen} />}
        <HeadToHead t={t} S={S} ranked={ranked} colors={colors} trials={report.trials} judgesDecide={judgesDecide(report.run.judge)} attempts={report.run.attempts} tries={report.run.tries ?? 1} onOpen={onOpen}
          sample={inDetails ? smallSample(report.tasks.length, false) : null} />
        <Leaderboard report={report} ranked={ranked} colors={colors} />
        <Scatter models={ranked} S={S} colors={colors} />
      </div>
    );
  }
  return (
    <div className="grid gap-8">
      <div className="flex justify-end"><ViewSwitch view={view} onView={onView} /></div>
      {body}
    </div>
  );
}

export function Tasks({ report, openId, onOpen }: { report: Report; openId?: string | null; onOpen?: (id: string | null) => void }) {
  const { colors, ranked } = useReportModel(report);
  return <TasksTable report={report} ranked={ranked} colors={colors} openId={openId} onOpen={onOpen} />;
}

/** One task's attempts in a drawer, opened from anywhere on the run page (the live board). */
export function TaskDrawer({ report, taskId, onClose }: { report: Report; taskId: string | null; onClose: () => void }) {
  const { colors, ranked } = useReportModel(report);
  const trialsFor = useTrialsFor(report);
  const task = taskId ? report.tasks.find((t) => t.id === taskId) ?? null : null;
  return <TaskSheet task={task} report={report} ranked={ranked} colors={colors} trialsFor={trialsFor} onClose={onClose} />;
}
