import * as React from "react";
import { Empty, Eyebrow } from "@/components/brand";
import { day, plural } from "@/lib/format";
import { ordered, palette } from "@/lib/models";
import { rank, takeaway } from "@/lib/stats";
import type { Report } from "@/lib/types";
import { HeadToHead } from "./HeadToHead";
import { Leaderboard } from "./Leaderboard";
import { Scatter } from "./Scatter";
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

/** Facts about a run for its eyebrow: harness, PRs, attempts and dates. */
export function reportFacts(report: Report): string[] {
  const { run, tasks, trials } = report;
  const repos = new Set(tasks.map((t) => t.repo)).size;
  const last = trials.map((t) => t.finished_at).filter(Boolean).sort().pop();
  const dates = last && day(last) !== day(run.created_at) ? `${day(run.created_at)} to ${day(last)}` : day(run.created_at);
  return [`Claude Code ${run.harness_version ?? ""}`.trim(), `${plural(tasks.length, "merged PR")} from ${plural(repos, "repo")}`,
    `${plural(run.attempts, "attempt")} per task`, dates];
}

/** The standalone report's header: facts, then the one-sentence answer. */
export function ReportHeader({ report }: { report: Report }) {
  const { t } = useReportModel(report);
  return (
    <header>
      <Eyebrow parts={reportFacts(report)} />
      <h1 className="mt-5 max-w-[24ch] text-[34px] leading-[1.1] font-normal tracking-[-0.03em] text-balance sm:text-[46px]">{t.verdict?.head ?? t.sentence}</h1>
      {t.verdict?.cost && <p className="mt-4 max-w-[46ch] text-[22px] leading-snug tracking-[-0.01em] text-balance text-muted-foreground">{t.verdict.cost}</p>}
    </header>
  );
}

/** How far one PR moves a solve rate on a run this small; null once the sample is big enough. */
export function smallSample(tasks: number, pointer = true): string | null {
  if (tasks >= 30) return null;
  return tasks <= 3 ? `${plural(tasks, "task")}: read it as an example, not a score.`
    : `${plural(tasks, "task")}, so each one moves a solve rate by about ${Math.round(100 / tasks)} points.${pointer ? " Open a model's row for its 95% range." : ""}`;
}

/** Notes that change how to read the run. `sample: false` leaves the small-sample note to the head-to-head's details. */
export function Banners({ report, sample = true }: { report: Report; sample?: boolean }) {
  const { run, tasks, trials } = report;
  const expected = (run.tasks ?? []).length * report.models.length * (run.attempts || 1);
  const items: [string, string][] = [];
  if (!report.complete) {
    items.push(["In progress", `${trials.length} of ${expected || "?"} attempts had finished at ${new Date(report.generated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Results update as attempts finish.`]);
  }
  if (run.note) items.push(["Note", run.note]);
  if (!run.judge) items.push(["Tests only", "No AI judge on this run: solved means the PR's hidden tests passed."]);
  const small = sample ? smallSample(tasks.length) : null;
  if (small) items.push(["Small sample", small]);
  if (!items.length) return null;
  return (
    <div className="grid gap-px bg-frame">
      {items.map(([label, text]) => (
        <div key={label} className="flex flex-col gap-1 bg-background py-3 sm:flex-row sm:gap-4">
          <span className="label-mono w-32 shrink-0 pt-0.5 text-foreground">{label}</span>
          <span className="text-[14px] text-muted-foreground">{text}</span>
        </div>
      ))}
    </div>
  );
}

/** Results: the head-to-head, every model, and quality against cost.
 *  `onOpen` opens a PR's attempts from the head-to-head. */
export function Results({ report, onOpen }: { report: Report; onOpen?: (taskId: string) => void }) {
  const { S, colors, ranked, t } = useReportModel(report);
  // Nothing to compare until an attempt finishes, e.g. a run where no PR passed the check.
  if (!report.trials.length) {
    return report.complete
      ? <Empty title="No attempts ran">No model attempted a task in this run, so there's nothing to compare.</Empty>
      : <Empty title="No results yet">Results appear here as attempts finish.</Empty>;
  }
  // With a head-to-head, the small-sample note sits in its details, next to the solve rates it qualifies.
  const inDetails = !!t.pairs?.n;
  return (
    <div className="grid gap-14">
      <Banners report={report} sample={!inDetails} />
      <HeadToHead t={t} S={S} judged={!!report.run.judge} attempts={report.run.attempts} onOpen={onOpen}
        sample={inDetails ? smallSample(report.tasks.length, false) : null} />
      <Leaderboard report={report} ranked={ranked} colors={colors} />
      <Scatter models={ranked} S={S} colors={colors} />
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
