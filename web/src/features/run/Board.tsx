import type * as React from "react";
import { Swatch } from "@/components/brand";
import { External } from "@/components/brand/icons";
import { Tip } from "@/components/ui/tooltip";
import { clock, secondsSince, usd } from "@/lib/format";
import type { Swatch as SwatchT } from "@/lib/models";
import { CHECK, failReason, isFinal, isLive, STAGE, STEPS, stepIndex, type Tone } from "@/lib/stages";
import type { BoardRow, Cell, Model, Run } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Fills for each step, as system tiles.
 * The agent codes on its model's Light step and a solve fills the model's Base step; hidden tests are Dark Grey 1;
 * the judges are gold, the outside world. */
export function toneStyle(tone: Tone, swatch?: SwatchT): { className: string; style?: React.CSSProperties } {
  switch (tone) {
    case "boot": return { className: "ev-tone boot live" };
    case "setup": return { className: "ev-tone setup live" };
    case "check": return { className: "ev-tone setup live" };
    case "agent": return { className: "ev-tone live", style: { background: swatch?.tint, color: "var(--color-black)" } };
    case "tests": return { className: "ev-tone tests live" };
    case "judge": return { className: "ev-tone judge live" };
    case "solved": return { className: "ev-tone", style: { background: swatch?.fill, color: swatch?.ink } };
    case "failed": return { className: "ev-tone failed" };
    case "invalid": return { className: "ev-tone invalid" };
    default: return { className: "ev-tone idle" };
  }
}

/** Every PR against every model: each cell is one attempt, live while it runs. A table on wide
 * screens; on a phone, one card per PR with its attempts stacked. */
export function Board({ run, models, colors, now, onOpen }: { run: Run; models: Model[]; colors: Record<string, SwatchT>; now: number; onOpen?: (taskId: string) => void }) {
  const b = run.board!;
  const active = run.phase === "collecting" || run.phase === "checking" || run.phase === "running";
  const judged = run.judged !== false;
  // PRs that failed the check sink to the bottom, so the attempts stay together at the top.
  const rows = [...b.rows].sort((x, y) => Number(x.check.stage === "left-out") - Number(y.check.stage === "left-out"));
  const cell = (row: BoardRow, m: Model) => {
    const c = row.cells.find((x) => x.model === m.key);
    if (!c) return <div className="ev-tone idle h-12" />;
    const body = <AttemptCell c={c} swatch={colors[c.model]} now={now} judged={judged} />;
    return onOpen && isFinal(c) ? (
      <button type="button" onClick={() => onOpen(row.id)} aria-label={`${row.repo}#${row.pr}, ${m.label}: open the attempt`}
        className="ev-cell-button">
        {body}
      </button>
    ) : body;
  };
  return (
    <>
      <div className="ev-board overflow-x-auto max-md:hidden">
        <table className="w-full table-fixed border-collapse" style={{ minWidth: 300 + 132 + models.length * 156 }}>
          <colgroup>
            <col />
            <col className="w-[132px]" />
            {models.map((m) => <col key={m.key} className="w-[156px]" />)}
          </colgroup>
          <thead>
            <tr>
              <th>Pull request</th>
              <th>Check</th>
              {models.map((m) => (
                <th key={m.key}>
                  <span className="flex min-w-0 items-center gap-2 leading-tight text-black" title={m.label}><Swatch swatch={colors[m.key]} /><span className="line-clamp-2">{m.label}</span></span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-out={row.check.stage === "left-out" || undefined}>
                <td className="pr"><PullTitle row={row} /></td>
                <td><CheckCell row={row} now={now} active={active} /></td>
                {models.map((m) => <td key={m.key}>{cell(row, m)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="ev-board-cards md:hidden" aria-label="Board">
        {rows.map((row) => (
          <li key={row.id} data-out={row.check.stage === "left-out" || undefined}>
            <PullTitle row={row} />
            {row.check.stage !== "passed" && <CheckCell row={row} now={now} active={active} />}
            <div className="grid grid-cols-2 gap-1">
              {models.map((m) => (
                <div key={m.key} className="min-w-0">
                  <div className="label-xs mb-1 flex min-w-0 items-center gap-1.5 text-muted-foreground"><Swatch swatch={colors[m.key]} size={8} /><span className="truncate">{m.label}</span></div>
                  {cell(row, m)}
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function PullTitle({ row }: { row: BoardRow }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[14px]" title={row.title}>{row.title || `#${row.pr}`}</div>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
        {row.language && <span className="bt-badge">{langShort(row.language)}</span>}
        {row.url ? (
          <a href={row.url} target="_blank" rel="noopener" className="inline-flex min-w-0 items-center gap-1 hover:text-black">
            <span className="truncate">{row.repo}#{row.pr}</span><External />
          </a>
        ) : <span className="truncate">{row.repo}#{row.pr}</span>}
        {row.lines ? <span className="shrink-0">±{row.lines}</span> : null}
      </div>
    </div>
  );
}

function CheckCell({ row, now, active }: { row: BoardRow; now: number; active: boolean }) {
  const info = CHECK[row.check.stage] ?? { label: row.check.stage, tone: "idle" as Tone };
  const live = info.tone === "check";
  const passed = row.check.stage === "passed";
  const { className, style } = live ? toneStyle("check") : passed ? { className: "ev-tone failed text-black", style: undefined } : toneStyle("idle");
  const body = (
    <div className={cn("flex h-12 flex-col justify-center px-2.5", className)} style={style}>
      <div className="flex items-center justify-between gap-2">
        <span className="label-xs truncate">{passed ? "✓ " : ""}{info.label}</span>
        {live && active && row.check.at && <span className="num font-mono text-[12px]">{clock(secondsSince(row.check.at, now))}</span>}
      </div>
      {row.check.why && <div className="mt-0.5 truncate text-[12px]" title={row.check.why}>{row.check.why}</div>}
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
      <div className="mt-1.5 flex gap-[2px]" aria-hidden>
        {Array.from({ length: steps }, (_, i) => (
          <i key={i} className={cn("h-[2px] flex-1 bg-current", i < step ? "" : i === step ? "opacity-60" : "opacity-20")} />
        ))}
      </div>
    );
  } else if (c.stage === "solved" || c.stage === "failed") {
    const line = [c.seconds != null ? clock(c.seconds) : null, c.cost != null ? usd(c.cost) : null].filter(Boolean).join(" · ");
    sub = <div className="mt-0.5 truncate font-mono text-[12px]" title={line}>{line}</div>;
  } else if (c.stage === "invalid") {
    sub = <div className="mt-0.5 truncate text-[12px]" title={c.reason || undefined}>{c.reason || "infrastructure"}</div>;
  }
  const glyph = c.stage === "solved" ? "✓ " : c.stage === "failed" ? "✕ " : c.stage === "invalid" ? "! " : "";
  const cell = (
    <div key={c.stage} className={cn("flex h-12 animate-fade flex-col justify-center px-2.5", className)} style={style}>
      <div className="flex items-center justify-between gap-2">
        <span className="label-xs truncate">{glyph}{failReason(c) ?? info.label}</span>
        {live && c.started_at && <span className="num font-mono text-[12px]">{clock(secondsSince(c.started_at, now))}</span>}
      </div>
      {sub}
    </div>
  );
  return c.stage === "invalid" ? <Tip content="Lost to setup, sandbox or provider trouble, not the model. Resume runs it again.">{cell}</Tip> : cell;
}

const langShort = (l: string) => (l === "TypeScript" ? "TS" : l === "Python" ? "PY" : l === "Go" ? "GO" : l.slice(0, 3).toUpperCase());

/** The stage key, for the legend under the board. */
export function BoardLegend({ judged }: { judged: boolean }) {
  const items: [Tone, string][] = [["boot", "Boot sandboxes"], ["setup", "Install deps"], ["agent", "Agent codes"], ["tests", "Hidden tests"], ...(judged ? [["judge", "Judges"] as [Tone, string]] : [])];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Each attempt's steps">
      {items.map(([tone, label], i) => {
        const { className, style } = toneStyle(tone, { fill: "var(--color-green)", ink: "var(--color-black)", tint: "var(--color-lightGreen)" });
        return (
          <span key={tone} className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className={cn("size-3.5", className)} style={style} />
            {label}
            {i < items.length - 1 && <span aria-hidden className="ml-3 text-darkGrey3">→</span>}
          </span>
        );
      })}
    </div>
  );
}
