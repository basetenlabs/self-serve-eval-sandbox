import { ChevronRightIcon, LoaderIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTrace } from "@/lib/api";
import { clock, dur, plural } from "@/lib/format";
import type { Trace, TraceStep } from "@/lib/types";
import { cn } from "@/lib/utils";

type Show = "all" | "tool" | "text" | "thinking" | "error";
type Tool = Extract<TraceStep, { kind: "tool" }>;
const isTool = (s: TraceStep): s is Tool => s.kind === "tool";

/** What the agent did, step by step: each tool call with its result, and what it said and thought. */
export function TraceView({ runId, trial, active }: { runId: string; trial: string; active: boolean }) {
  // A report opened from disk has no page server behind it to ask.
  const local = location.protocol === "file:";
  const trace = useTrace(runId, trial, active && !local);
  if (local) return <Note>Open this run in Eval Sandbox to read the agent's trace.</Note>;
  if (!trace) return <Note><LoaderIcon className="mr-2 inline size-3.5 animate-spin" />Reading the trace</Note>;
  if (trace.error) return <Note>{trace.error}</Note>;
  return <Steps trace={trace} />;
}

function Steps({ trace }: { trace: Trace }) {
  const [show, setShow] = React.useState<Show>("all");
  const [query, setQuery] = React.useState("");
  const [opened, setOpened] = React.useState<Set<number>>(() => new Set());
  const [expandAll, setExpandAll] = React.useState(false);
  const counts = {
    all: trace.steps.length,
    tool: trace.tool_calls,
    text: trace.steps.filter((s) => s.kind === "text").length,
    thinking: trace.steps.filter((s) => s.kind === "thinking").length,
    error: trace.tool_errors,
  };
  const needle = query.trim().toLowerCase();
  const shown = trace.steps.map((s, i) => [s, i] as const).filter(([s]) =>
    (show === "all" || (show === "error" ? isTool(s) && s.error : s.kind === show))
    && (!needle || (isTool(s) ? [s.tool, s.title, s.detail, s.output] : [s.text]).some((t) => t?.toLowerCase().includes(needle))));
  const toggle = (i: number) => setOpened((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const f = trace.finished;
  const filters: [Show, string][] = [["all", "All"], ["tool", "Tool calls"], ["text", "Said"], ["thinking", "Thinking"], ["error", "Errors"]];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-muted-foreground">
        <span>{plural(trace.tool_calls, "tool call")}</span>
        <span className={cn(trace.tool_errors > 0 && "text-[#AC0EB2] dark:text-[#FFA9FD]")}>{plural(trace.tool_errors, "error")}</span>
        {f?.turns != null && <span>{plural(f.turns, "turn")}</span>}
        {f?.seconds != null && <span>{dur(f.seconds)}</span>}
        <span>{!f ? "Stopped before it finished" : f.error ? `Ended with an error${f.subtype && f.subtype !== "success" ? ` (${f.subtype.replaceAll("_", " ")})` : ""}` : "Finished"}</span>
      </div>
      {trace.hidden_thinking > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          This model keeps its thinking private: {plural(trace.hidden_thinking, "thought")} left no text in the log.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-0.5 bg-node p-0.5" role="radiogroup" aria-label="Show">
          {filters.filter(([k]) => k === "all" || counts[k] > 0).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={show === k} onClick={() => setShow(k)}
              className={cn("h-8 px-2.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors",
                show === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {label} <span className="opacity-60">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in trace" aria-label="Find in trace"
            className="h-9 pl-8 font-mono text-[12.5px]" spellCheck={false} />
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setExpandAll(!expandAll); setOpened(new Set()); }}>
          {expandAll ? "Collapse all" : "Expand all"}
        </Button>
      </div>
      <ol className="max-h-[640px] overflow-y-auto bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-label="Trace">
        {shown.length ? shown.map(([s, i]) => (
          <Step key={i} step={s} open={expandAll !== opened.has(i)} onToggle={() => toggle(i)} />
        )) : <li className="px-4 py-8 text-center text-[13px] text-muted-foreground">Nothing matches.</li>}
        {trace.dropped > 0 && show === "all" && !needle && (
          <li className="placeholder-cell m-2 px-4 py-3 text-center text-[12.5px] text-muted-foreground">
            {plural(trace.dropped, "later step")} not shown: the trace keeps the first {trace.steps.length}.
          </li>
        )}
      </ol>
    </div>
  );
}

function Step({ step: s, open, onToggle }: { step: TraceStep; open: boolean; onToggle: () => void }) {
  const gutter = <span className="w-11 shrink-0 pt-px text-right font-mono text-[11px] text-muted-foreground tabular-nums">{isTool(s) && s.at != null ? clock(s.at) : ""}</span>;
  const row = "flex gap-3 border-rule px-3 py-2 not-last:border-b";
  const nested = s.nested && "pl-7";
  if (!isTool(s)) {
    const thinking = s.kind === "thinking";
    const long = s.text.length > 280 || s.text.split("\n").length > 4;
    return (
      <li className={cn(row, nested)}>
        {gutter}
        <div className="min-w-0 flex-1">
          <span className="label-mono text-[10.5px] text-muted-foreground">{thinking ? "Thought" : "Said"}</span>
          <p className={cn("mt-0.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words",
            thinking && "text-muted-foreground italic", long && !open && "line-clamp-4")}>{s.text}</p>
          {long && (
            <button type="button" onClick={onToggle} className="label-mono mt-1 text-[10.5px] text-muted-foreground hover:text-foreground">
              {open ? "Less" : "More"}
            </button>
          )}
        </div>
      </li>
    );
  }
  const more = !!(s.detail || s.output);
  return (
    <li className={cn(row, nested, s.error && "shadow-[inset_2px_0_0_#AC0EB2] dark:shadow-[inset_2px_0_0_#FFA9FD]")}>
      {gutter}
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onToggle} disabled={!more} aria-expanded={more ? open : undefined}
          className="group flex w-full min-w-0 items-start gap-2 text-left disabled:cursor-default">
          <span className={cn("mt-px inline-flex h-5 shrink-0 items-center rounded-chip px-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em]",
            s.error ? "bg-danger-surface text-[#AC0EB2] dark:text-[#FFA9FD]" : "bg-node text-foreground")}>{s.tool || "tool"}</span>
          <span className={cn("min-w-0 flex-1 font-mono text-[12.5px] leading-5", open ? "break-all whitespace-pre-wrap" : "truncate")}>{s.title || " "}</span>
          {more && <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground", open && "rotate-90")} />}
        </button>
        {open && more && (
          <div className="mt-2 grid animate-fade grid-cols-[minmax(0,1fr)] gap-1.5">
            {s.detail && <Block label={s.tool === "Edit" || s.tool === "MultiEdit" ? "Change" : "Input"} text={s.detail} diff={s.tool === "Edit" || s.tool === "MultiEdit"} />}
            {s.output != null && <Block label={s.error ? "Error" : "Output"} text={s.output || "(no output)"} error={s.error} />}
          </div>
        )}
      </div>
    </li>
  );
}

function Block({ label, text, diff, error }: { label: string; text: string; diff?: boolean; error?: boolean }) {
  return (
    <div>
      <div className="label-mono mb-1 text-[10px] text-muted-foreground">{label}</div>
      <pre className={cn("max-h-72 overflow-auto py-1.5 font-mono text-[11.5px] leading-[1.55]", error ? "bg-danger-surface" : "bg-code")}>
        {text.split("\n").map((line, i) => (
          <span key={i} className={cn("block min-w-max px-3",
            diff && line.startsWith("+ ") && "bg-diff-add", diff && line.startsWith("- ") && "bg-diff-del")}>{line || " "}</span>
        ))}
      </pre>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="placeholder-cell px-4 py-6 text-center text-[13px] text-muted-foreground">{children}</div>;
}
