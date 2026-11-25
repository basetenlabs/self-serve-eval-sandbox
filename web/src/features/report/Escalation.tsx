import { Column, DeltaChip, Stat, Swatch } from "@/components/brand";
import { endText, estimateNote, inLadder, labelsOf, pathText } from "@/lib/escalation";
import { DASH, pct, plural, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import type { Report } from "@/lib/types";
import { PullRow } from "./HeadToHead";

/**
 * An escalation run's own results, at the top of both views: what it cost against every model on every PR (the part
 * that is estimated said plainly), how many PRs each model solved of those that reached it, and each PR's way up.
 */
export function EscalationResults({ report, colors, onOpen }: {
  report: Report; colors: Record<string, SwatchT>; onOpen?: (taskId: string) => void;
}) {
  const e = report.escalation!;
  const labels = labelsOf(report.models);
  const models = inLadder(report.models, e.ladder);
  const tasks = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
  const every = e.every_model;
  const ran = Object.values(e.tried).reduce((n, x) => n + x, 0);
  return (
    <section className="grid gap-10" aria-label="Cheapest model first">
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Stat label="This run" value={usd(e.cost_usd)} note={`${plural(ran, "attempt")}, cheapest model first`} />
        <Stat label="Every model on every PR" value={every.cost_usd == null ? DASH : `≈ ${usd(every.cost_usd)}`}
          note={every.estimated_attempts ? `${usd(every.estimated_usd)} of it estimated` : "Nothing estimated"} />
        <div className="min-w-0">
          <div className="label-xs text-muted-foreground">Saved</div>
          <div className="mt-2 flex min-h-[38px] items-center">
            {e.saving == null ? <span className="num text-[32px] leading-[1.2]">{DASH}</span> : <DeltaChip>{pct(e.saving)} less</DeltaChip>}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {e.saving != null ? "Than every model on every PR" : e.remaining ? `Once ${plural(e.remaining, "PR")} ${e.remaining === 1 ? "finishes" : "finish"}` : "Not measured"}
          </div>
        </div>
      </div>
      <p className="max-w-[80ch] text-[14px] leading-5 text-body">{estimateNote(e, labels)}</p>
      <div className="grid items-start gap-14 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:gap-12">
        <Column heading="Cheapest model first">
          <ol>
            {models.map((m, i) => (
              <li key={m.key} className="flex min-w-0 items-center gap-2.5 border-b border-lightGrey2 py-4 first:pt-1">
                <span className="label-xs w-6 shrink-0 text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                <Swatch swatch={colors[m.key]} size={12} />
                <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{m.label}</span>
                <span className="num shrink-0 text-[16px]">{e.solved_by[m.key] ?? 0} of {plural(e.tried[m.key] ?? 0, "PR")}</span>
                <span className="label-xs w-14 shrink-0 text-muted-foreground">solved</span>
              </li>
            ))}
            <li className="flex min-w-0 items-center gap-2.5 py-4">
              <span className="w-6 shrink-0" />
              <span className="min-w-0 flex-1 text-[16px] text-body">Unsolved after every model</span>
              <span className="num shrink-0 text-[16px]">{plural(e.unsolved, "PR")}</span>
              <span className="w-14 shrink-0" />
            </li>
          </ol>
        </Column>
        <Column heading="Each PR" aside={<span className="label-mono text-muted-foreground">{plural(e.tasks.length, "PR")}</span>}>
          <ul>
            {e.tasks.map((t) => {
              const task = tasks[t.task_id] ?? { id: t.task_id, repo: t.task_id, title: t.task_id };
              return (
                <li key={t.task_id} className="border-b border-lightGrey2 py-2">
                  <PullRow task={task} onOpen={onOpen}>
                    <span className="label-xs shrink-0 text-muted-foreground">{endText(t, labels)}</span>
                  </PullRow>
                  <p className="px-1.5 text-[12px] text-muted-foreground">{pathText(t.steps, labels)}</p>
                </li>
              );
            })}
          </ul>
        </Column>
      </div>
    </section>
  );
}
