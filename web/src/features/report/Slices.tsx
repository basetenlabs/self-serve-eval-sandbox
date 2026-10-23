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

/** The same comparison within each language, change size and repository. */
export function Slices({ slices, ranked, colors }: { slices: Slice[]; ranked: Model[]; colors: Record<string, SwatchT> }) {
  const [key, setKey] = React.useState<Key>("pass_at_1");
  if (!slices.length) return null;
  const metric = METRICS[key];
  const groups = [...new Set(slices.map((s) => s.dimension))].map((d) => ({ dimension: d, rows: slices.filter((s) => s.dimension === d) }));
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
      <p className="-mt-1 mb-6 text-[14px] text-muted-foreground" aria-live="polite">{metric.hint}</p>
      <div className="grid gap-10">
        {groups.map((g) => {
          const all = g.rows.flatMap((sl) => ranked.map((m) => (sl.models[m.key]?.valid ? sl.models[m.key][key] : null))).filter((v): v is number => v != null);
          const max = key === "pass_at_1" ? 1 : Math.max(...all, 0) || 1;
          return (
            <div key={g.dimension} className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-rule">
                    <th scope="col" className="label-mono w-[22%] py-2 pr-3 text-left font-normal text-foreground">{g.dimension}</th>
                    <th scope="col" className="label-mono w-16 py-2 pr-3 text-right font-normal text-muted-foreground">Tasks</th>
                    {ranked.map((m) => (
                      <th key={m.key} scope="col" className="py-2 pr-3 text-left font-normal">
                        <span className="label-mono inline-flex items-center gap-2 text-muted-foreground"><Swatch swatch={colors[m.key]} />{m.label}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((sl) => {
                    const values = ranked.map((m) => (sl.models[m.key]?.valid ? sl.models[m.key][key] : null));
                    const present = values.filter((v): v is number => v != null);
                    const best = present.length > 1 ? (metric.higher ? Math.max(...present) : Math.min(...present)) : null;
                    const label = g.dimension === "Change size" ? sl.value[0].toUpperCase() + sl.value.slice(1) : sl.value;
                    return (
                      <tr key={sl.value} className="border-b border-frame">
                        <th scope="row" className="truncate py-3 pr-3 text-left font-normal">{label}</th>
                        <td className="num py-3 pr-3 text-right text-muted-foreground">{sl.tasks}</td>
                        {ranked.map((m, i) => {
                          const s = sl.models[m.key];
                          const v = values[i];
                          const lead = v != null && best != null && Math.abs(v - best) < 1e-9;
                          return (
                            <td key={m.key} className="py-3 pr-3 align-top">
                              <div className="flex items-baseline gap-2">
                                <span className={cn("num text-[16px]", lead && "font-semibold")}>{metric.format(v)}</span>
                                {lead && <span className="label-mono text-[9.5px] text-muted-foreground">Best</span>}
                              </div>
                              <div className="mt-1 h-1.5 bg-node" aria-hidden>
                                {v != null && <div className="h-full animate-grow" style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: colors[m.key]?.fill }} />}
                              </div>
                              <div className="mt-1 text-[11.5px] text-muted-foreground">
                                {s?.valid ? (key === "pass_at_1" ? `${s.solved} / ${s.valid} solved` : `${pct(s.pass_at_1)} solved · ${s.valid} tries`) : "No valid attempts"}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </Column>
  );
}
