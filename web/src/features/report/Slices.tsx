import * as React from "react";
import { Column, Swatch } from "@/components/brand";
import { SegmentList, SegmentTrigger, Tabs } from "@/components/ui/tabs";
import { dur, pct, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import type { Model, Slice } from "@/lib/types";
import { cn } from "@/lib/utils";

type Key = "pass_at_1" | "cost_per_solved" | "median_seconds";
const METRICS: Record<Key, { label: string; format: (x: number | null) => string; higher: boolean; hint: string }> = {
  pass_at_1: { label: "Solve rate", format: (x) => pct(x), higher: true, hint: "Higher is better. Share of valid attempts solved; attempts lost to infrastructure don't count." },
  cost_per_solved: { label: "Cost per solved", format: usd, higher: false, hint: "Lower is better. Everything spent, failed attempts included, divided by solved attempts. A dash means nothing was solved." },
  median_seconds: { label: "Time per task", format: dur, higher: false, hint: "Lower is better. Median agent time per valid attempt. Setup, grading and provider retry waits are left out." },
};

/** The same comparison within each language, change size and repository, as one table whose columns
 *  line up across the groups. A group with a single value only repeats the overall result, so it's
 *  left out. When one model leads a row alone, its figure is bold and the others' bars step back. */
export function Slices({ slices, ranked, colors }: { slices: Slice[]; ranked: Model[]; colors: Record<string, SwatchT> }) {
  const [key, setKey] = React.useState<Key>("pass_at_1");
  const metric = METRICS[key];
  const groups = [...new Set(slices.map((s) => s.dimension))]
    .map((d) => ({ dimension: d, rows: slices.filter((s) => s.dimension === d) }))
    .filter((g) => g.rows.length > 1);
  if (!groups.length) return null;
  const all = groups.flatMap((g) => g.rows.flatMap((sl) => ranked.map((m) => (sl.models[m.key]?.valid ? sl.models[m.key][key] : null))))
    .filter((v): v is number => v != null);
  const max = key === "pass_at_1" ? 1 : Math.max(...all, 0) || 1;
  return (
    <Column
      heading="By task type"
      aside={
        <Tabs value={key} onValueChange={(v) => setKey(v as Key)}>
          <SegmentList aria-label="Metric">
            {(Object.keys(METRICS) as Key[]).map((k) => <SegmentTrigger key={k} value={k}>{METRICS[k].label}</SegmentTrigger>)}
          </SegmentList>
        </Tabs>
      }
    >
      <p className="-mt-1 mb-5 text-[14px] text-muted-foreground" aria-live="polite">{metric.hint}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-collapse text-[14px]">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-16" />
            {ranked.map((m) => <col key={m.key} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="pb-2" />
              <th scope="col" className="label-mono pr-4 pb-2 text-right font-normal text-muted-foreground">Tasks</th>
              {ranked.map((m) => (
                <th key={m.key} scope="col" className="pr-6 pb-2 text-left font-normal">
                  <span className="label-mono flex min-w-0 items-center gap-2 text-foreground"><Swatch swatch={colors[m.key]} /><span className="truncate">{m.label}</span></span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.dimension}>
              <tr>
                <th scope="colgroup" colSpan={2 + ranked.length} className="label-mono border-b border-rule pt-5 pb-2 text-left font-normal text-muted-foreground">{g.dimension}</th>
              </tr>
              {g.rows.map((sl) => {
                const values = ranked.map((m) => (sl.models[m.key]?.valid ? sl.models[m.key][key] : null));
                const present = values.filter((v): v is number => v != null);
                const top = present.length > 1 ? (metric.higher ? Math.max(...present) : Math.min(...present)) : null;
                const alone = top != null && present.filter((v) => Math.abs(v - top) < 1e-9).length === 1;
                const label = g.dimension === "Change size" ? sl.value[0].toUpperCase() + sl.value.slice(1) : sl.value;
                return (
                  <tr key={sl.value} className="border-b border-frame">
                    <th scope="row" className="truncate py-2.5 pr-3 text-left font-normal" title={label}>{label}</th>
                    <td className="num py-2.5 pr-4 text-right text-muted-foreground">{sl.tasks}</td>
                    {ranked.map((m, i) => {
                      const s = sl.models[m.key];
                      const v = values[i];
                      const lead = alone && v != null && Math.abs(v - top!) < 1e-9;
                      return (
                        <td key={m.key} className="py-2.5 pr-6" title={s?.valid ? `${m.label}: ${s.solved} of ${s.valid} attempts solved` : `${m.label}: no valid attempts`}>
                          <div className="flex items-center gap-3">
                            <span className={cn("num w-16 shrink-0 text-[15px]", lead && "font-semibold")}>{metric.format(v)}</span>
                            <div className="h-1.5 min-w-0 flex-1 bg-node" aria-hidden>
                              {v != null && (
                                <div
                                  className={cn("h-full animate-grow", alone && !lead && "opacity-40")}
                                  style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: colors[m.key]?.fill }}
                                />
                              )}
                            </div>
                            {key === "pass_at_1" && <span className="num w-10 shrink-0 text-right text-[12px] text-muted-foreground">{s?.valid ? `${s.solved}/${s.valid}` : ""}</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </Column>
  );
}
