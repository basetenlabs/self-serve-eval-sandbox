import { ChevronDownIcon, CopyIcon } from "lucide-react";
import * as React from "react";
import { Column, Swatch } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { compact, dur, elapsed, pct, usd } from "@/lib/format";
import { isOpen, type Swatch as SwatchT } from "@/lib/models";
import { wilson } from "@/lib/stats";
import type { Model, Report, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { benchMarkdown } from "./markdown";

/** Every model, best first, with the three numbers that decide it and the rest one click away. */
export function Leaderboard({ report, ranked, colors }: { report: Report; ranked: Model[]; colors: Record<string, SwatchT> }) {
  const S = report.summary;
  const toast = useToast();
  const scored = ranked.filter((m) => S[m.key]?.valid);
  // A metric's leader gets "Best" only when it leads alone: a tie marks nobody.
  const lead = (value: (s: Summary) => number | null, higher: boolean) => {
    const vals = scored.map((m) => value(S[m.key])).filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    const top = higher ? Math.max(...vals) : Math.min(...vals);
    return vals.filter((v) => v === top).length === 1 ? top : null;
  };
  const best = {
    rate: lead((s) => (s.valid ? s.pass_at_1 : null), true),
    cost: lead((s) => s.cost_per_solved, false),
    time: lead((s) => s.median_seconds, false),
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(benchMarkdown(report, ranked));
      toast("Copied as Markdown");
    } catch {
      toast("Copy failed", { body: "Select the table instead.", tone: "danger" });
    }
  };
  return (
    <Column
      heading="All models"
      aside={<Button variant="outline" size="sm" onClick={copy}><CopyIcon className="size-3.5" />Copy as Markdown</Button>}
    >
      <div className="hidden grid-cols-[2.5rem_minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_2rem] gap-4 border-b border-rule px-3 pb-2 md:grid">
        {["#", "Model", "Solve rate ↑", "Cost per solved ↓", "Time per task ↓", "Total wall clock"].map((h) => (
          <span key={h} className="label-mono text-[10.5px] text-muted-foreground">{h}</span>
        ))}
      </div>
      <ol>
        {ranked.map((m, i) => (
          <Row key={m.key} m={m} rank={i + 1} s={S[m.key]} swatch={colors[m.key]} judged={!!report.run.judge}
            leads={{
              rate: best.rate != null && !!S[m.key]?.valid && S[m.key].pass_at_1 === best.rate,
              cost: best.cost != null && S[m.key]?.cost_per_solved === best.cost,
              time: best.time != null && S[m.key]?.median_seconds === best.time,
            }} />
        ))}
      </ol>
    </Column>
  );
}

const GRID = "md:grid-cols-[2.5rem_minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_2rem]";

function Row({ m, rank, s, swatch, leads, judged }: {
  m: Model; rank: number; s: Summary | undefined; swatch?: SwatchT; leads: { rate?: boolean; cost?: boolean; time?: boolean }; judged: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  if (!s) return null;
  const ci = wilson(s.solved, s.valid);
  const t = s.timing;
  return (
    <li className={cn("border-b border-frame", open && "bg-muted")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("grid w-full grid-cols-[2.5rem_minmax(0,1fr)_2rem] items-center gap-x-4 gap-y-3 px-3 py-4 text-left transition-colors hover:bg-muted", GRID)}
      >
        <span className="num font-mono text-[13px] text-muted-foreground">{String(rank).padStart(2, "0")}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2.5">
            <Swatch swatch={swatch} size={12} />
            <span className="truncate text-[17px] font-medium">{m.label}</span>
          </span>
          {m.model && <span className="mt-1 block truncate font-mono text-[11.5px] text-muted-foreground">{m.model}</span>}
          <span className="label-mono mt-1 block text-[10.5px] text-muted-foreground">{isOpen(m) ? "Open · served on Baseten" : "Closed · comparison"}</span>
        </span>
        <ChevronDownIcon className={cn("size-4 justify-self-end text-muted-foreground transition-transform md:order-last", open && "rotate-180")} />
        <Figure label="Solve rate" lead={leads.rate} value={pct(s.pass_at_1)} note={`${s.solved} / ${s.valid} attempts`}
          bar={s.pass_at_1 ?? 0} fill={swatch?.fill} />
        <Figure label="Cost per solved" lead={leads.cost} value={usd(s.cost_per_solved)} note={`${usd(s.cost_per_attempt)} per attempt`} />
        <Figure label="Time per task" lead={leads.time} value={dur(s.median_seconds)} note="Median, agent time" />
        <Figure label="Total wall clock" value={elapsed(t?.elapsed_seconds)} note={`${t && t.timed_attempts < s.attempts ? "≥ " : ""}${elapsed(t?.total_working_seconds)} agent time`} />
      </button>
      {open && (
        // Each detail sits under the figure it explains.
        <div className={cn("grid animate-enter grid-cols-2 gap-x-4 gap-y-4 border-t border-frame px-3 pt-4 pb-5", GRID)}>
          <span className="hidden md:block" />
          <span className="hidden md:block" />
          <Details items={[["95% range", ci ? `${pct(ci[0])}–${pct(ci[1])}` : "–"], ["Solved at least once", `${s.tasks_solved} / ${s.tasks} tasks`]]} />
          <Details items={[["Total cost", usd(s.cost_usd)], ["Tokens per attempt", `${compact(s.mean_input_tokens)} in / ${compact(s.mean_output_tokens)} out`]]} />
          <Details items={[["Median turns", s.median_turns == null ? "–" : String(Math.round(s.median_turns))], ["Hit the time limit", String(s.agent_timeouts || 0)]]} />
          <Details items={[["Not scored (infrastructure)", String(s.invalid || 0)], ...(judged ? [["Passed tests, judges said no", String(s.judge_disagreements || 0)] as const] : [])]} />
        </div>
      )}
    </li>
  );
}

function Figure({ label, value, note, lead, bar, fill }: { label: string; value: string; note: string; lead?: boolean; bar?: number; fill?: string }) {
  return (
    <span className="col-span-1 min-w-0 max-md:col-start-2 max-md:col-end-3">
      <span className="label-mono block text-[10.5px] text-muted-foreground md:hidden">{label}</span>
      <span className="flex items-center gap-2">
        <span className="num text-[24px] leading-8 tracking-[-0.02em]">{value}</span>
        {lead && <Badge variant="solid" className="px-1 text-[9.5px]">Best</Badge>}
      </span>
      {bar != null && (
        <span className="mt-1 block h-1 w-full max-w-36 bg-node" aria-hidden>
          <span className="block h-full animate-grow" style={{ width: `${bar * 100}%`, background: fill }} />
        </span>
      )}
      <span className="mt-1 block text-[12px] text-muted-foreground">{note}</span>
    </span>
  );
}

function Details({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid content-start gap-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="label-mono text-[10.5px] text-muted-foreground">{k}</dt>
          <dd className="num mt-0.5 text-[15px]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
