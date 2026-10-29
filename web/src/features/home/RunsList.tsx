import { ChevronRightIcon, LockIcon } from "lucide-react";
import { isActive, PhaseBadge, Swatch } from "@/components/brand";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { plural, usd, when } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import { ordered, palette } from "@/lib/models";
import type { Run } from "@/lib/types";

/** Every run, newest first: what it compared, how far it got and the headline numbers. A table on
 * a wide screen, a list of blocks on a phone. */
export function RunsList({ runs, go }: { runs: Run[]; go: (r: Route) => void }) {
  return (
    <div className="bg-surface shadow-[inset_0_0_0_1px_var(--frame)]">
      <Table className="max-sm:hidden">
        <THead>
          <TR>
            <TH className="pl-4">Run</TH>
            <TH>Status</TH>
            <TH className="w-[46%]">Solved · cost per solved task</TH>
            <TH>Started</TH>
            <TH className="w-10"><span className="sr-only">Open</span></TH>
          </TR>
        </THead>
        <TBody>
          {runs.map((r) => {
            const open = () => go({ page: "run", id: r.id });
            return (
              <TR
                key={r.id}
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => { if (e.key === "Enter") open(); }}
                className="group cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-offset-[-2px]"
              >
                <TD className="pl-4"><Title run={r} /></TD>
                <TD><Status run={r} /></TD>
                <TD><Results run={r} /></TD>
                <TD className="text-[13px] whitespace-nowrap text-muted-foreground">{when(r.started)}</TD>
                <TD><ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" /></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <ul className="sm:hidden" aria-label="Runs">
        {runs.map((r) => (
          <li key={r.id} className="border-b border-frame last:border-0">
            <a href={href({ page: "run", id: r.id })} className="grid gap-3 px-4 py-4 active:bg-muted">
              <span className="flex items-start justify-between gap-3">
                <Title run={r} link={false} />
                <Status run={r} />
              </span>
              <Results run={r} />
              <span className="label-mono text-muted-foreground">{when(r.started)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The run's name, a lock when only its owner sees it, and how big it was. */
function Title({ run, link = true }: { run: Run; link?: boolean }) {
  const name = (
    <>
      {run.title}
      {run.private && <LockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Private: only you see this run" />}
    </>
  );
  return (
    <span className="grid min-w-0 gap-0.5">
      {link
        ? <a href={href({ page: "run", id: run.id })} onClick={(e) => e.preventDefault()} className="flex items-center gap-1.5 text-[15px] font-medium">{name}</a>
        : <span className="flex items-center gap-1.5 text-[15px] font-medium">{name}</span>}
      <span className="label-mono text-[10.5px] text-muted-foreground">
        {[run.tasks ? plural(run.tasks, "PR") : null, run.models.length > 2 ? `${run.models.length} models` : null,
          run.judged === false ? "Tests only" : null].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

/** A chip only when the run isn't simply done: live, stopped or failed. */
function Status({ run }: { run: Run }) {
  return run.phase === "done" ? <span className="text-[13px] text-muted-foreground">Done</span> : <PhaseBadge phase={run.phase} />;
}

/** What each model solved, with its cost per solved task; or how far a live run has got. */
function Results({ run }: { run: Run }) {
  const colors = palette(run.models);
  const results = ordered(run.models).filter((m) => run.summary[m.key]?.valid);
  if (!results.length) {
    const p = run.progress;
    if (isActive(run.phase) && p.total) {
      return (
        <span className="grid gap-1.5 text-[13px]">
          <span className="num">{p.done} of {p.total} attempts finished</span>
          <span className="h-1.5 bg-node" aria-hidden>
            <span className="block h-full bg-baseten-2 transition-[width] duration-700 dark:bg-baseten" style={{ width: `${(100 * p.done) / p.total}%` }} />
          </span>
        </span>
      );
    }
    // A run that failed or stopped says why, in its own row.
    return <span className="line-clamp-2 text-[13px] text-muted-foreground">{run.phase === "done" ? "No results" : run.detail || "Starting"}</span>;
  }
  return (
    <span className="grid gap-1.5">
      {results.map((m) => {
        const s = run.summary[m.key];
        return (
          <span key={m.key} className="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2"><Swatch swatch={colors[m.key]} /><span className="truncate">{m.label}</span></span>
            <span className="num whitespace-nowrap"><b className="font-medium">{s.tasks_solved ?? s.solved} solved</b> <span className="text-muted-foreground">· {usd(s.cost_per_solved)} per solved task</span></span>
          </span>
        );
      })}
    </span>
  );
}
