import { ChevronRightIcon } from "lucide-react";
import { isActive, PhaseBadge, Swatch } from "@/components/brand";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { pct, usd, when } from "@/lib/format";
import { href, type Route } from "@/lib/hooks";
import { ordered, palette } from "@/lib/models";
import type { Run } from "@/lib/types";

/** Every run, newest first: what it compared, how far it got and the headline numbers. */
export function RunsList({ runs, go }: { runs: Run[]; go: (r: Route) => void }) {
  return (
    <div className="bg-surface shadow-[inset_0_0_0_1px_var(--frame)]">
      <Table>
        <THead>
          <TR>
            <TH className="pl-4">Run</TH>
            <TH>Status</TH>
            <TH className="w-[42%]">Solve rate · cost per solved task</TH>
            <TH>Started</TH>
            <TH className="w-10"><span className="sr-only">Open</span></TH>
          </TR>
        </THead>
        <TBody>
          {runs.map((r) => {
            const colors = palette(r.models);
            const results = ordered(r.models).filter((m) => r.summary[m.key]?.valid);
            const open = () => go({ page: "run", id: r.id });
            return (
              <TR
                key={r.id}
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => { if (e.key === "Enter") open(); }}
                className="group cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-offset-[-2px]"
              >
                <TD className="pl-4">
                  <a href={href({ page: "run", id: r.id })} onClick={(e) => e.preventDefault()} className="block text-[15px] font-medium">{r.title}</a>
                  <div className="label-mono mt-0.5 text-[10.5px] text-muted-foreground">
                    {[r.tasks ? `${r.tasks} PRs` : null, r.models.length > 2 ? `${r.models.length} models` : r.models.map((m) => m.label).join(" vs "),
                      r.judged === false ? "Tests only" : null].filter(Boolean).join(" · ")}
                  </div>
                </TD>
                <TD><PhaseBadge phase={r.phase} /></TD>
                <TD>
                  {results.length ? (
                    <div className="grid gap-1.5">
                      {results.map((m) => {
                        const s = r.summary[m.key];
                        return (
                          <div key={m.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px]">
                            <span className="flex min-w-0 items-center gap-2"><Swatch swatch={colors[m.key]} /><span className="truncate">{m.label}</span></span>
                            <span className="h-2 bg-node" aria-hidden>
                              <span className="block h-full" style={{ width: `${100 * (s.pass_at_1 ?? 0)}%`, background: colors[m.key].fill }} />
                            </span>
                            <span className="num whitespace-nowrap"><b className="font-medium">{pct(s.pass_at_1)}</b> <span className="text-muted-foreground">· {usd(s.cost_per_solved)}</span></span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-[13px] text-muted-foreground">
                      {isActive(r.phase) && r.progress.total ? `${r.progress.done} of ${r.progress.total} attempts finished` : "No results yet"}
                    </span>
                  )}
                </TD>
                <TD className="text-[13px] whitespace-nowrap text-muted-foreground">{when(r.started)}</TD>
                <TD><ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" /></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
