import * as React from "react";
import { Eyebrow } from "@/components/brand";
import { day, plural } from "@/lib/format";
import { ordered, palette } from "@/lib/models";
import { rank, takeaway } from "@/lib/stats";
import type { Report } from "@/lib/types";
import { HeadToHead } from "./HeadToHead";
import { Leaderboard } from "./Leaderboard";
import { Scatter } from "./Scatter";
import { Slices } from "./Slices";
import { TaskSheet } from "./TaskSheet";
import { TasksTable, useTrialsFor } from "./TasksTable";

/** Derived once per report: colours, ranking and the headline comparison. */
export function useReportModel(report: Report) {
  return React.useMemo(() => {
    const S = report.summary;
    const models = ordered(report.models);
    return { S, models, colors: palette(models), ranked: rank(models, S), t: takeaway(models, S) };
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
      <h1 className="mt-5 max-w-[24ch] text-[34px] leading-[1.1] font-normal tracking-[-0.03em] text-balance sm:text-[46px]">{t.sentence}</h1>
    </header>
  );
}

export function Banners({ report }: { report: Report }) {
  const { run, tasks, trials } = report;
  const expected = (run.tasks ?? []).length * report.models.length * (run.attempts || 1);
  const items: [string, string][] = [];
  if (!report.complete) {
    items.push(["In progress", `${trials.length} of ${expected || "?"} attempts had finished at ${new Date(report.generated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Results update as attempts finish.`]);
  }
  if (run.note) items.push(["Note", run.note]);
  if (!run.judge) items.push(["Tests only", "No AI judge on this run: solved means the PR's hidden tests passed. Running pr-eval rejudge on it adds the judge later."]);
  if (tasks.length < 30) items.push(["Small sample", `${plural(tasks.length, "task")}. Differences of a few points are noise at this size; open a model's row for its 95% range.`]);
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

/** Results: the head-to-head, every model, quality against cost and the breakdown by task type. */
export function Results({ report }: { report: Report }) {
  const { S, colors, ranked, t } = useReportModel(report);
  return (
    <div className="grid gap-14">
      <Banners report={report} />
      <HeadToHead t={t} S={S} />
      <Leaderboard report={report} ranked={ranked} colors={colors} />
      <Scatter models={ranked} S={S} colors={colors} />
      <Slices slices={report.slices} ranked={ranked} colors={colors} />
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
