import { AlertCircleIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { usePulls } from "@/lib/api";
import { ago, plural } from "@/lib/format";
import type { PullList, PullRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const NEWEST = 10; // "Select newest" takes this many that can be tasks

/** A repository's latest merged pull requests to tick, newest first; ones that can't be tasks say why. */
export function PullChooser({ repo, chosen, onChange, max }: { repo: string; chosen: number[]; onChange: (n: number[]) => void; max: number }) {
  const { list, loading } = usePulls(repo);
  const rows = list?.prs ?? [];
  const fit = rows.filter((r) => !r.why);
  const toggle = (n: number, on: boolean) =>
    onChange(on ? [...chosen, n].slice(0, max) : chosen.filter((c) => c !== n));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-mono text-muted-foreground" aria-live="polite">
          {loading ? "Reading the latest merges" : list?.error ? "Couldn't list them" : `${chosen.length} of ${plural(fit.length, "usable PR")} chosen`}
        </span>
        <span className="flex gap-1">
          <Button type="button" size="sm" variant="ghost" disabled={!fit.length}
            onClick={() => onChange(fit.filter((r) => !r.maintenance).slice(0, NEWEST).map((r) => r.number))}>
            Newest {NEWEST}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!chosen.length} onClick={() => onChange([])}>Clear</Button>
        </span>
      </div>
      {list?.error ? <Problem>{list.error}</Problem> : (
        <ul className="max-h-[380px] overflow-y-auto bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-label={`${repo} pull requests`} aria-busy={loading}>
          {loading ? Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)
            : rows.length ? rows.map((r) => (
              <PullItem key={r.number} row={r} control={
                <Checkbox checked={chosen.includes(r.number)} disabled={!!r.why || (!chosen.includes(r.number) && chosen.length >= max)}
                  onCheckedChange={(v) => toggle(r.number, v === true)} aria-label={`#${r.number} ${r.title}`} />
              } />
            )) : <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">No merged pull requests yet.</li>}
        </ul>
      )}
    </div>
  );
}

/** Pasted pull requests, checked against GitHub: each can be a task, or says why not. */
export function PastedPulls({ pulls, onChecked, onRemove }: {
  pulls: Record<string, number[]>;
  onChecked: (repo: string, list: PullList | null) => void;
  onRemove: (repo: string, n: number) => void;
}) {
  return (
    <div className="grid gap-4">
      {Object.entries(pulls).map(([repo, numbers]) => (
        <PastedRepo key={repo} repo={repo} numbers={numbers} onChecked={onChecked} onRemove={onRemove} />
      ))}
    </div>
  );
}

function PastedRepo({ repo, numbers, onChecked, onRemove }: {
  repo: string; numbers: number[];
  onChecked: (repo: string, list: PullList | null) => void;
  onRemove: (repo: string, n: number) => void;
}) {
  const { list, loading } = usePulls(repo, numbers);
  const report = React.useRef(onChecked);
  report.current = onChecked;
  React.useEffect(() => { report.current(repo, list); }, [repo, list]);
  React.useEffect(() => () => report.current(repo, null), [repo]);
  const rows = new Map((list?.prs ?? []).map((r) => [r.number, r]));
  const usable = numbers.filter((n) => rows.get(n) && !rows.get(n)!.why).length;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[12px]">{repo}</span>
        <span className="label-mono text-muted-foreground">
          {loading ? "Checking" : list?.error ? "" : usable === numbers.length ? `All ${numbers.length} usable` : `${usable} of ${numbers.length} usable`}
          {list?.language && !list.error ? ` · ${list.language}` : ""}
        </span>
      </div>
      {list?.error ? <Problem>{list.error}</Problem> : (
        <ul className="bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-busy={loading}>
          {numbers.map((n) => {
            const row = rows.get(n);
            const remove = (
              <button type="button" onClick={() => onRemove(repo, n)} aria-label={`Remove #${n}`}
                className="grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-node hover:text-foreground">
                <XIcon className="size-3.5" />
              </button>
            );
            return row ? <PullItem key={n} row={row} trailing={remove} />
              : <SkeletonRow key={n} number={n} trailing={remove} />;
          })}
        </ul>
      )}
    </div>
  );
}

function PullItem({ row, control, trailing }: { row: PullRow; control?: React.ReactNode; trailing?: React.ReactNode }) {
  const Row = control ? "label" : "div";
  return (
    <li className="border-rule not-last:border-b">
      <Row className={cn("flex min-h-14 items-center gap-3 px-3 py-2", control && !row.why && "cursor-pointer hover:bg-node/60", row.why && "text-muted-foreground")}>
        {control}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[12px] text-muted-foreground">#{row.number}</span>
            <span className={cn("truncate text-[14px]", !row.why && "text-foreground")}>{row.title || "Untitled"}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
            {row.why ? (
              <span className="inline-flex items-center gap-1 text-[#AC0EB2] dark:text-[#FFA9FD]">
                <AlertCircleIcon className="size-3" /> Can't be a task: {row.why}
              </span>
            ) : (
              <>
                {row.author && <span>{row.author}</span>}
                {row.merged_at && <span>merged {ago(row.merged_at)}</span>}
                <span className="font-mono">{plural(row.files, "file")} · {row.lines.toLocaleString()} lines · {plural(row.tests, "test file")}</span>
                {row.maintenance && <Badge variant="outline">Upkeep</Badge>}
              </>
            )}
          </span>
        </span>
        <a href={row.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open #${row.number} on GitHub`}
          className="grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-node hover:text-foreground">
          <ExternalLinkIcon className="size-3.5" />
        </a>
        {trailing}
      </Row>
    </li>
  );
}

function SkeletonRow({ number, trailing }: { number?: number; trailing?: React.ReactNode }) {
  return (
    <li className="flex min-h-14 items-center gap-3 border-rule px-3 py-2 not-last:border-b">
      {number == null && <span className="size-[18px] shrink-0 bg-node" />}
      <span className="grid min-w-0 flex-1 gap-1.5">
        <span className="flex items-center gap-2">
          {number != null && <span className="font-mono text-[12px] text-muted-foreground">#{number}</span>}
          <span className="stripes h-3 w-2/3 max-w-80" />
        </span>
        <span className="stripes h-2.5 w-1/3 max-w-48" />
      </span>
      {trailing}
    </li>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 bg-danger-surface px-3 py-2.5 text-[13px]">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-[#AC0EB2] dark:text-[#FFA9FD]" />
      <span>{children}</span>
    </div>
  );
}
