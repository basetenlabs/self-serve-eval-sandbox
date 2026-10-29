import { Column, DeltaChip } from "@/components/brand";
import { dur, pct, usd } from "@/lib/format";
import type { Takeaway } from "@/lib/stats";
import type { Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Metric = { key: "pass_at_1" | "cost_per_solved" | "median_seconds"; name: string; units: string; format: (x: number | null) => string; delta?: string; max?: number };

// The brand's head-to-head: Baseten's bar is always Green, the comparison always Blue.
const GREEN = "#19E76E", BLUE = "#3DA6FF";

/**
 * Baseten's open model against the closed comparison, one row per metric in the brand's head-to-head
 * form: the metric and its pink delta chip on the left, the Baseten bar directly above the
 * comparison bar on the right. A solve rate is drawn out of 100%; the others are scaled within the metric.
 */
export function HeadToHead({ t, S }: { t: Takeaway; S: Record<string, Summary> }) {
  if (!t.open || !t.closed) return null;
  const metrics: Metric[] = [
    { key: "pass_at_1", name: "Solve rate", units: "% of attempts · higher is better", format: (x) => pct(x), delta: t.solve?.text, max: 1 },
    { key: "cost_per_solved", name: "Cost per solved task", units: "USD · lower is better", format: usd, delta: t.cost?.text },
    { key: "median_seconds", name: "Time per task", units: "Median per attempt · lower is better", format: dur, delta: t.time?.text },
  ];
  const sides = [{ m: t.open, fill: GREEN }, { m: t.closed, fill: BLUE }];
  return (
    <Column
      heading="Head to head"
      aside={
        <span className="label-mono flex items-center gap-4 text-muted-foreground">
          <span className="inline-flex items-center gap-2"><span aria-hidden className="size-2.5" style={{ background: GREEN }} />Open, on Baseten</span>
          <span className="inline-flex items-center gap-2"><span aria-hidden className="size-2.5" style={{ background: BLUE }} />Closed</span>
        </span>
      }
    >
      <div>
        {metrics.map((metric) => {
          const values = sides.map((s) => S[s.m.key]?.[metric.key] ?? null);
          const max = metric.max ?? (Math.max(...values.map((v) => v ?? 0)) || 1);
          return (
            <div key={metric.key} className="grid items-center gap-x-8 gap-y-3 border-t border-rule py-6 first:border-t-0 first:pt-2 md:grid-cols-[300px_minmax(0,1fr)]">
              <div>
                <h3 className="text-[20px] leading-7 font-normal">{metric.name}</h3>
                <div className="label-mono mt-0.5 text-muted-foreground">{metric.units}</div>
                {metric.delta && <DeltaChip className="mt-3">{metric.delta}</DeltaChip>}
              </div>
              <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-x-4">
                {sides.map((s, i) => {
                  const v = values[i];
                  const w = v == null ? 0 : Math.max(0.5, (v / max) * 100);
                  const inside = w >= 22;
                  return (
                    <div key={s.m.key} className="contents">
                      <div className="label-mono truncate text-right text-foreground" title={s.m.label}>{s.m.label}</div>
                      <div className="relative h-10 bg-surface">
                        {v == null ? (
                          <div className="placeholder-cell flex h-full items-center px-3 label-mono text-muted-foreground">Not measured</div>
                        ) : (
                          <div className="relative h-full origin-left animate-grow" style={{ width: `${w}%`, background: s.fill, animationDelay: `${i * 80}ms` }}>
                            <span className={cn("num absolute top-1/2 -translate-y-1/2 font-mono text-[13px] whitespace-nowrap", inside ? "right-3 text-black" : "left-full ml-2 text-foreground")}>
                              {metric.format(v)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="label-mono border-t border-rule pt-3 text-[10.5px] text-muted-foreground">Solve rate out of 100%; cost and time scaled within each metric</div>
    </Column>
  );
}
