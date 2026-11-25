import { Column, DeltaChip, Swatch } from "@/components/brand";
import { DASH, dur, pct, usd } from "@/lib/format";
import { isOpen, servedBy, type Swatch as SwatchT } from "@/lib/models";
import { type Lead, solvedShare, type Takeaway } from "@/lib/stats";
import type { Model, Report, Summary } from "@/lib/types";
import { Scatter } from "./Scatter";

/**
 * The simple view: a finished run on one screen, for anyone. The takeaway chips, then per model what it solved,
 * what a solved task cost and how long a task took, beside quality against cost with its frontier. No PR lists,
 * traces or diffs: those are the detailed view's.
 */
export function Simple({ report, ranked, colors, t }: { report: Report; ranked: Model[]; colors: Record<string, SwatchT>; t: Takeaway }) {
  const S = report.summary;
  // Baseten's open models first, then the comparison, as in the side by side; each best first.
  const shown = [...ranked.filter(isOpen), ...ranked.filter((m) => !isOpen(m))].filter((m) => S[m.key]);
  // The side by side's chips. Solve rate only without a PR-by-PR count, which the headline already says. Not on a
  // cheapest-first run: its models had different PRs, the harder ones going to the models above.
  const chips = report.escalation ? [] : ([["Solve rate", t.pairs?.n ? undefined : t.solve], ["Cost per solved task", t.cost], ["Time per task", t.time]] as [string, Lead | undefined][])
    .filter((c): c is [string, Lead] => !!c[1]);
  return (
    <div className="grid gap-14">
      {chips.length > 0 && (
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {chips.map(([name, c]) => (
            <div key={name} className="min-w-0">
              <div className="label-xs text-muted-foreground">{name}</div>
              <DeltaChip className="mt-2 max-w-full whitespace-normal text-balance">{c.chip}</DeltaChip>
              {c.note && <p className="mt-2 max-w-[34ch] text-[14px] leading-5 text-muted-foreground">{c.note}</p>}
            </div>
          ))}
        </div>
      )}
      <div className="grid items-start gap-14 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:gap-12">
        <Column heading="Every model">
          <ul>
            {shown.map((m) => (
              <Row key={m.key} m={m} s={S[m.key]} swatch={colors[m.key]} unscored={report.complete && !report.escalation ? report.tasks.length - S[m.key].tasks : 0} />
            ))}
          </ul>
        </Column>
        <Scatter models={ranked} S={S} colors={colors} />
      </div>
    </div>
  );
}

/** One model: PRs solved of those it was scored on, cost per solved task and time per task. */
function Row({ m, s, swatch, unscored }: { m: Model; s: Summary; swatch?: SwatchT; unscored: number }) {
  return (
    <li className="border-b border-lightGrey2 py-5 first:pt-1">
      <div className="flex min-w-0 items-center gap-2.5">
        <Swatch swatch={swatch} size={12} />
        <span className="truncate text-[16px] font-medium">{m.label}</span>
        <span className="label-xs shrink-0 text-muted-foreground">{isOpen(m) ? "Open · on Baseten" : `Closed · ${servedBy(m) ?? "comparison"}`}</span>
      </div>
      {/* One row each for labels, values and notes, so a label that wraps on a phone keeps the values level. */}
      <div className="mt-3 grid grid-cols-3 grid-rows-[auto_auto_auto] gap-x-4">
        <Figure label="PRs solved" value={s.valid ? `${s.tasks_solved} of ${s.tasks}` : DASH}
          note={s.valid ? `${pct(solvedShare(s))}${unscored > 0 ? ` · ${unscored} not scored` : ""}` : "None scored"} />
        <Figure label="Cost per solved task" value={usd(s.cost_per_solved)}
          note={s.cost_per_solved != null ? `${usd(s.cost_usd)} in total` : s.valid && !s.solved ? "Solved none" : "Not measured"} />
        <Figure label="Time per task" value={dur(s.median_seconds)} note="Median, agent time" />
      </div>
    </li>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid">
      <div className="label-xs self-end text-muted-foreground">{label}</div>
      <div className="num mt-2 text-[24px] leading-8 tracking-[-0.02em]">{value}</div>
      <div className="mt-1 text-[12px] text-muted-foreground">{note}</div>
    </div>
  );
}
