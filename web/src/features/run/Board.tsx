import { ArrowUpRightIcon } from "lucide-react";
import type * as React from "react";
import { Swatch } from "@/components/brand";
import { Tip } from "@/components/ui/tooltip";
import { clock, secondsSince, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import { CHECK, failReason, isLive, STAGE, STEPS, stepIndex, type Tone } from "@/lib/stages";
import type { BoardRow, Cell, Model, Run } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Fills for each live step. The agent's step takes the model's own colour; the judge is gold, the outside world. */
export function toneStyle(tone: Tone, swatch?: SwatchT): { className: string; style?: React.CSSProperties } {
  switch (tone) {
    case "boot": return { className: "bg-node stripes animate-stripe text-foreground" };
    case "setup": return { className: "bg-node-2 stripes animate-stripe text-foreground" };
    case "check": return { className: "bg-node-2 stripes animate-stripe text-foreground" };
    case "agent": return { className: "stripes animate-stripe", style: { background: swatch?.fill, color: swatch?.ink } };
    case "tests": return { className: "bg-[#575D56] text-white stripes animate-stripe dark:bg-[#A2AE9D] dark:text-black" };
    case "judge": return { className: "bg-[#FFBE4D] text-black stripes animate-stripe" };
    case "solved": return { className: "", style: { background: swatch?.fill, color: swatch?.ink } };
    case "failed": return { className: "bg-node text-muted-foreground" };
    case "invalid": return { className: "bg-[#FFEDC4] text-[#2E261E] dark:bg-[#2E261E] dark:text-[#FFBE4D]" };
    default: return { className: "placeholder-cell text-muted-foreground" };
  }
}

/** Every PR against every model: each cell is one attempt, live while it runs. */
export function Board({ run, models, colors, now }: { run: Run; models: Model[]; colors: Record<string, SwatchT>; now: number }) {
  const b = run.board!;
  const active = run.phase === "collecting" || run.phase === "checking" || run.phase === "running";
  return (
    <div className="overflow-x-auto bg-surface shadow-[inset_0_0_0_1px_var(--frame)]">
      <table className="w-full table-fixed border-collapse" style={{ minWidth: 300 + 132 + models.length * 156 }}>
        <colgroup>
          <col />
          <col className="w-[132px]" />
          {models.map((m) => <col key={m.key} className="w-[156px]" />)}
        </colgroup>
        <thead>
          <tr className="border-b border-rule">
            <th className="label-mono h-10 px-3 text-left font-normal text-muted-foreground">Pull request</th>
            <th className="label-mono h-10 px-1 text-left font-normal text-muted-foreground">Check</th>
            {models.map((m) => (
              <th key={m.key} className="h-10 px-1 text-left font-normal">
                <span className="label-mono flex min-w-0 items-center gap-2 text-foreground"><Swatch swatch={colors[m.key]} /><span className="truncate">{m.label}</span></span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((row) => {
            const out = row.check.stage === "left-out";
            const cells = models.map((m) => row.cells.find((c) => c.model === m.key));
            return (
              <tr key={row.id} className={cn("border-b border-frame last:border-0", out && "opacity-55")}>
                <td className="px-3 py-2">
                  <div className="truncate text-[14px] font-medium" title={row.title}>{row.title || `#${row.pr}`}</div>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                    {row.language && <span className="rounded-chip bg-node px-1 text-[10px] uppercase text-foreground">{langShort(row.language)}</span>}
                    {row.url ? (
                      <a href={row.url} target="_blank" rel="noopener" className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline">
                        {row.repo}#{row.pr}<ArrowUpRightIcon className="size-3" />
                      </a>
                    ) : <span>{row.repo}#{row.pr}</span>}
                    {row.lines ? <span>±{row.lines}</span> : null}
                  </div>
                </td>
                <td className="px-1 py-1.5"><CheckCell row={row} now={now} active={active} /></td>
                {cells.map((c, i) => (
                  <td key={models[i].key} className="px-1 py-1.5">
                    {c ? <AttemptCell c={c} swatch={colors[c.model]} now={now} judged={run.judged !== false} /> : <div className="placeholder-cell h-12" />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CheckCell({ row, now, active }: { row: BoardRow; now: number; active: boolean }) {
  const info = CHECK[row.check.stage] ?? { label: row.check.stage, tone: "idle" as Tone };
  const live = info.tone === "check";
  const passed = row.check.stage === "passed";
  const { className, style } = live ? toneStyle("check") : passed ? { className: "bg-node text-foreground", style: undefined } : toneStyle("idle");
  const body = (
    <div className={cn("flex h-12 flex-col justify-center px-2.5", className)} style={style}>
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono truncate text-[10.5px]">{passed ? "✓ " : ""}{info.label}</span>
        {live && active && row.check.at && <span className="num font-mono text-[11px]">{clock(secondsSince(row.check.at, now))}</span>}
      </div>
      {row.check.why && <div className="mt-0.5 truncate text-[11px] opacity-80">{row.check.why}</div>}
    </div>
  );
  return row.check.why ? <Tip content={row.check.why}>{body}</Tip> : body;
}

function AttemptCell({ c, swatch, now, judged }: { c: Cell; swatch?: SwatchT; now: number; judged: boolean }) {
  const info = STAGE[c.stage] ?? { label: c.stage, tone: "idle" as Tone };
  const live = isLive(c.stage);
  const step = stepIndex(c.stage);
  const { className, style } = toneStyle(info.tone, swatch);
  const steps = judged ? STEPS.length : STEPS.length - 1;
  let sub: React.ReactNode = null;
  if (live) {
    sub = (
      <div className="mt-1.5 flex gap-0.5" aria-hidden>
        {Array.from({ length: steps }, (_, i) => (
          <i key={i} className={cn("h-[3px] flex-1 bg-current", i < step ? "opacity-90" : i === step ? "animate-pulse-dot opacity-90" : "opacity-20")} />
        ))}
      </div>
    );
  } else if (c.stage === "solved" || c.stage === "failed") {
    sub = <div className="mt-0.5 truncate font-mono text-[11px] opacity-80">{[failReason(c), c.seconds != null ? clock(c.seconds) : null, c.cost != null ? usd(c.cost) : null].filter(Boolean).join(" · ")}</div>;
  } else if (c.stage === "invalid") {
    sub = <div className="mt-0.5 truncate text-[11px] opacity-80">{c.reason || "infrastructure"}</div>;
  }
  const glyph = c.stage === "solved" ? "✓ " : c.stage === "failed" ? "✕ " : c.stage === "invalid" ? "! " : "";
  const cell = (
    <div key={c.stage} className={cn("flex h-12 animate-fade flex-col justify-center px-2.5", className)} style={style}>
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono truncate text-[10.5px]">{glyph}{info.label}</span>
        {live && c.started_at && <span className="num font-mono text-[11px]">{clock(secondsSince(c.started_at, now))}</span>}
      </div>
      {sub}
    </div>
  );
  return c.stage === "invalid" ? <Tip content="Lost to setup, sandbox or provider trouble, not the model. Resume runs it again.">{cell}</Tip> : cell;
}

const langShort = (l: string) => (l === "TypeScript" ? "TS" : l === "Python" ? "PY" : l === "Go" ? "GO" : l.slice(0, 3).toUpperCase());

/** The stage key, for the legend under the board. */
export function BoardLegend({ judged }: { judged: boolean }) {
  const items: [Tone, string][] = [["boot", "Boot sandboxes"], ["setup", "Install deps"], ["agent", "Agent codes"], ["tests", "Hidden tests"], ...(judged ? [["judge", "Judge"] as [Tone, string]] : [])];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Each attempt's steps">
      {items.map(([tone, label], i) => {
        const { className, style } = toneStyle(tone, { fill: "#19E76E", ink: "#000", tint: "#D7FACE" });
        return (
          <span key={tone} className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className={cn("size-3.5", className)} style={style} />
            {label}
            {i < items.length - 1 && <span aria-hidden className="ml-3 text-line">→</span>}
          </span>
        );
      })}
    </div>
  );
}
