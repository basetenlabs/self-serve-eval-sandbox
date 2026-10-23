import { Column, DeltaChip } from "@/components/brand";
import { dur, pct, usd } from "@/lib/format";
import type { Takeaway } from "@/lib/stats";
import type { Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Metric = { key: "pass_at_1" | "cost_per_solved" | "median_seconds"; name: string; units: string; format: (x: number | null) => string; delta?: string };

/**
 * Baseten's open model against the closed comparison, one section per metric, in the brand's
 * head-to-head form: the Baseten bar directly above the comparison bar, scaled within the metric,
 * one pink delta chip each.
 */
export function HeadToHead({ t, S }: { t: Takeaway; S: Record<string, Summary> }) {
  if (!t.open || !t.closed) return null;
  const metrics: Metric[] = [
    { key: "pass_at_1", name: "Solve rate", units: "% of attempts · higher is better", format: (x) => pct(x), delta: t.solve?.text },
    { key: "cost_per_solved", name: "Cost per solved task", units: "USD · lower is better", format: usd, delta: t.cost?.text },
    { key: "median_seconds", name: "Time per task", units: "Median per attempt · lower is better", format: dur, delta: t.time?.text },
  ];
  // The brand's head-to-head: Baseten's bar is always Green, the comparison always Blue.
  const sides = [{ m: t.open, fill: "#19E76E", ink: "#000" }, { m: t.closed, fill: "#3DA6FF", ink: "#000" }];
  return (
    <Column heading="Head to head" aside={<span className="label-mono text-muted-foreground">Baseten ▪ comparison</span>}>
      <div className="grid gap-0">
        {metrics.map((metric) => {
          const values = sides.map((s) => S[s.m.key]?.[metric.key] ?? null);
          const max = Math.max(...values.map((v) => v ?? 0)) || 1;
          return (
            <div key={metric.key} className="grid gap-x-4 border-t border-rule pt-5 pb-7 first:border-t-0 first:pt-1 md:grid-cols-[200px_minmax(0,1fr)]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 md:col-span-2 md:mb-4">
                <h3 className="text-[20px] leading-7 font-normal">{metric.name}</h3>
                <span className="label-mono text-muted-foreground">{metric.units}</span>
              </div>
              {sides.map((s, i) => {
                const v = values[i];
                const w = v == null ? 0 : Math.max(0.5, (v / max) * 100);
                const inside = w >= 22;
                return (
                  <div key={s.m.key} className="contents">
                    <div className="label-mono mt-3 truncate text-foreground md:mt-0 md:self-center md:text-right">{s.m.label}</div>
                    <div className="relative h-10 bg-surface">
                      {v == null ? (
                        <div className="placeholder-cell flex h-full items-center px-3 label-mono text-muted-foreground">Not measured</div>
                      ) : (
                        <div className="relative h-full origin-left animate-grow" style={{ width: `${w}%`, background: s.fill, animationDelay: `${i * 80}ms` }}>
                          <span
                            className={cn("num absolute top-1/2 -translate-y-1/2 font-mono text-[12px] whitespace-nowrap", inside ? "right-3" : "left-full ml-2 text-foreground")}
                            style={inside ? { color: s.ink } : undefined}
                          >
                            {metric.format(v)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="hidden md:block" />
              {metric.delta && (
                <div className="mt-3">
                  <DeltaChip>{metric.delta}</DeltaChip>
                  <span className="ml-3 text-[13px] text-muted-foreground">{sides[0].m.label} vs {sides[1].m.label}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="label-mono border-t border-rule pt-3 text-[10.5px] text-muted-foreground">Bars scaled within each metric</div>
    </Column>
  );
}
