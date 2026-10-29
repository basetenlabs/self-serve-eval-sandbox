import { AlertCircleIcon, CircleSlashIcon, ExternalLinkIcon, SearchIcon, StarIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { samePull, usePulls } from "@/lib/api";
import { ago, plural } from "@/lib/format";
import { match } from "@/lib/fuzzy";
import type { Favorite, PullList, PullRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const NEWEST = 10; // "Select newest" takes this many that can be tasks
const PAGE = 30, MOST = 90; // latest merges listed at first and per "Show more", and at most
const SEARCH_MS = 400; // GitHub is searched once typing pauses this long

/** Save a pull request for later, or forget it. */
export type OnFavorite = (pull: { repo: string; number: number; title?: string }, saved: boolean) => void;
type Group = { label: string; rows: PullRow[]; hits?: Map<number, number[]> };

/** A repository's merged pull requests to tick: your saved ones first, then the latest, newest first.
 * The search box finds any of them by number, title or author, and asks GitHub for the rest. */
export function PullChooser({ repo, chosen, onChange, max, favorites, onFavorite }: {
  repo: string; chosen: number[]; onChange: (n: number[]) => void; max: number; favorites: Favorite[]; onFavorite: OnFavorite;
}) {
  const [listed, setListed] = React.useState({ repo, count: PAGE });
  const count = listed.repo === repo ? listed.count : PAGE; // another repository starts from one page
  const [query, setQuery] = React.useState("");
  const [words, setWords] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setWords(query.trim().length >= 2 ? query.trim() : ""), SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  React.useEffect(() => { setQuery(""); setWords(""); }, [repo]);

  const savedHere = favorites.filter((f) => f.repo.toLowerCase() === repo.toLowerCase()).map((f) => f.number);
  const { list: latest, shown: list, loading } = usePulls(repo, undefined, count);
  const saved = usePulls(savedHere.length ? repo : null, savedHere);
  const found = usePulls(words ? repo : null, undefined, undefined, words);

  // Every row seen for this repository, so a ticked one stays on screen after the search that found it.
  const seen = React.useRef({ repo, rows: new Map<number, PullRow>() });
  if (seen.current.repo !== repo) seen.current = { repo, rows: new Map() };
  for (const r of [...(list?.prs ?? []), ...(saved.list?.prs ?? []), ...(found.list?.prs ?? [])]) seen.current.rows.set(r.number, r);

  const rows = list?.prs ?? [];
  const more = !!latest && rows.length >= count && count < MOST; // a full page: there may be older ones
  const fit = rows.filter((r) => !r.why);
  const isSaved = (n: number) => savedHere.includes(n);
  const toggle = (n: number, on: boolean) =>
    onChange(on ? [...chosen, n].slice(0, max) : chosen.filter((c) => c !== n));

  const needle = query.trim();
  const groups: Group[] = [];
  if (needle) {
    const scored = [...seen.current.rows.values()].map((r) => ({ r, m: match(needle, r) })).filter((x) => x.m)
      .sort((a, b) => b.m!.score + (isSaved(b.r.number) ? 5 : 0) - a.m!.score - (isSaved(a.r.number) ? 5 : 0));
    const local = new Set(scored.map((x) => x.r.number));
    groups.push({ label: "Matches", rows: scored.map((x) => x.r), hits: new Map(scored.map((x) => [x.r.number, x.m!.hits])) });
    groups.push({ label: "Also found by GitHub", rows: (found.list?.prs ?? []).filter((r) => !local.has(r.number)) });
  } else {
    const savedRows = savedHere.map((n) => seen.current.rows.get(n)).filter((r): r is PullRow => !!r);
    const shownAlready = new Set([...savedHere, ...rows.map((r) => r.number)]);
    const chosenElsewhere = chosen.filter((n) => !shownAlready.has(n)).map((n) => seen.current.rows.get(n)).filter((r): r is PullRow => !!r);
    if (savedRows.length) groups.push({ label: "Saved", rows: savedRows });
    if (chosenElsewhere.length) groups.push({ label: "Chosen", rows: chosenElsewhere });
    groups.push({ label: groups.length ? "Latest merges" : "", rows: rows.filter((r) => !isSaved(r.number)) });
  }
  const searching = !!needle && (words !== (needle.length >= 2 ? needle : "") || found.loading);
  const matches = groups.reduce((n, g) => n + g.rows.length, 0);
  const firstUsable = groups.flatMap((g) => g.rows).find((r) => !r.why && !chosen.includes(r.number));
  const newest = fit.filter((r) => !r.maintenance).slice(0, NEWEST).map((r) => r.number);
  const tookNewest = newest.length > 0 && newest.length === chosen.length && newest.every((n) => chosen.includes(n));
  const reading = loading && !rows.length;

  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-3 left-3 size-3.5 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoComplete="off"
          placeholder="Find by number, title or author" aria-label={`Find a pull request in ${repo}`}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
            if (e.key === "Enter") { e.preventDefault(); if (firstUsable) toggle(firstUsable.number, true); } // tick the best match
          }}
          className="h-10 pl-8 text-[14px]" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label-mono num inline-flex items-center gap-2 text-muted-foreground" aria-live="polite">
          {needle ? (searching ? "Searching GitHub too" : `${plural(matches, "match", "matches")} · ${chosen.length} chosen`)
            : reading ? <><span aria-hidden className="size-1.5 animate-pulse-dot bg-foreground" /> Reading the latest merges from GitHub</>
            : list?.error ? "Couldn't list them"
            : chosen.length ? <><span className="text-foreground">{chosen.length} chosen</span>{chosen.length >= max ? ` · the most one run takes` : ` · ${plural(fit.length, "usable PR")} listed`}</>
            : `Tick the ones to run · ${plural(fit.length, "usable PR")} listed`}
        </span>
        <span className="flex gap-1">
          {chosen.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>Clear</Button>}
          {!needle && (
            <Button type="button" size="sm" variant={chosen.length ? "ghost" : "outline"} disabled={!newest.length || tookNewest}
              onClick={() => onChange(newest)}>
              {reading ? `Newest ${NEWEST}` : tookNewest ? `Newest ${newest.length} chosen` : `Choose newest ${newest.length || NEWEST}`}
            </Button>
          )}
        </span>
      </div>
      {list?.error ? <Problem install={list.install}>{list.error}</Problem> : (
        <ul className="max-h-[420px] overflow-y-auto bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-label={`${repo} pull requests`} aria-busy={loading || searching}>
          {!list && !needle ? Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} at={i} />) : groups.map((g) => (
            <React.Fragment key={g.label || "all"}>
              {g.label && g.rows.length > 0 && (
                <li className="label-mono sticky top-0 z-[1] flex items-center gap-1.5 border-b border-rule bg-surface/95 px-3 py-1.5 text-[10.5px] text-muted-foreground backdrop-blur-sm">
                  {g.label === "Saved" && <StarIcon className="size-3 fill-current" />}{g.label} <span className="opacity-60">{g.rows.length}</span>
                </li>
              )}
              {g.rows.map((r) => (
                <PullItem key={r.number} row={r} hits={g.hits?.get(r.number)}
                  chosen={chosen.includes(r.number)}
                  control={
                    <Checkbox checked={chosen.includes(r.number)} disabled={!!r.why || (!chosen.includes(r.number) && chosen.length >= max)}
                      onCheckedChange={(v) => toggle(r.number, v === true)} aria-label={`#${r.number} ${r.title}`} />
                  }
                  trailing={r.why ? <span className="size-7 shrink-0" /> : <Star saved={isSaved(r.number)} number={r.number} onClick={() => onFavorite({ repo, number: r.number, title: r.title }, !isSaved(r.number))} />} />
              ))}
            </React.Fragment>
          ))}
          {needle && !searching && !matches && (
            <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">No merged pull request matches “{needle}”.</li>
          )}
          {!needle && list && !rows.length && !savedHere.length && (
            <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">No merged pull requests yet.</li>
          )}
          {(searching || (!needle && list && loading)) && Array.from({ length: needle ? 2 : 3 }, (_, i) => <SkeletonRow key={`more-${i}`} at={i + 1} />)}
          {more && !needle && (
            <li className="px-3 py-2">
              <Button type="button" size="sm" variant="ghost" className="w-full" onClick={() => setListed({ repo, count: count + PAGE })}>
                Show {PAGE} older merges
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Your saved pull requests from every repository, to add to the box with one tick. */
export function SavedPulls({ favorites, picked, onPick, onFavorite }: {
  favorites: Favorite[]; picked: (f: Favorite) => boolean; onPick: (f: Favorite, on: boolean) => void; onFavorite: OnFavorite;
}) {
  const [all, setAll] = React.useState(false);
  const shown = all ? favorites : favorites.slice(0, 6);
  if (!favorites.length) return null;
  return (
    <div className="grid grid-cols-1 gap-2">
      <span className="label-mono flex items-center gap-1.5 text-muted-foreground"><StarIcon className="size-3 fill-current" /> Saved pull requests <span className="opacity-60">{favorites.length}</span></span>
      <ul className="bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-label="Saved pull requests">
        {shown.map((f) => (
          <li key={`${f.repo}#${f.number}`} className="border-rule not-last:border-b">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-node/60">
              <Checkbox checked={picked(f)} onCheckedChange={(v) => onPick(f, v === true)} aria-label={`${f.repo} #${f.number} ${f.title}`} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="num shrink-0 text-[13px] text-muted-foreground">#{f.number}</span>
                  <span className="truncate text-[14px]">{f.title || "Untitled"}</span>
                </span>
                <span className="block truncate text-[12px] text-muted-foreground">{f.repo} · saved {ago(f.saved_at)}</span>
              </span>
              <Star saved number={f.number} onClick={() => onFavorite(f, false)} />
            </label>
          </li>
        ))}
      </ul>
      {favorites.length > shown.length && (
        <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => setAll(true)}>Show all {favorites.length}</Button>
      )}
    </div>
  );
}

function Star({ saved, number, onClick }: { saved: boolean; number: number; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={saved} aria-label={saved ? `Forget #${number}` : `Save #${number} for later`} title={saved ? "Saved: click to forget" : "Save for later"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={cn("grid size-7 shrink-0 place-items-center transition-colors hover:bg-node",
        saved ? "text-[#E8A000] dark:text-[#FFBE4D]" : "text-muted-foreground/60 hover:text-foreground")}>
      <StarIcon className={cn("size-3.5", saved && "fill-current")} />
    </button>
  );
}

/** Pasted pull requests, checked against GitHub: each can be a task, or says why not. */
export function PastedPulls({ pulls, onChecked, onRemove, favorites, onFavorite }: {
  pulls: Record<string, number[]>;
  onChecked: (repo: string, list: PullList | null) => void;
  onRemove: (repo: string, n: number) => void;
  favorites: Favorite[];
  onFavorite: OnFavorite;
}) {
  return (
    <div className="grid grid-cols-1 gap-4">
      {Object.entries(pulls).map(([repo, numbers]) => (
        <PastedRepo key={repo} repo={repo} numbers={numbers} onChecked={onChecked} onRemove={onRemove} favorites={favorites} onFavorite={onFavorite} />
      ))}
    </div>
  );
}

function PastedRepo({ repo, numbers, onChecked, onRemove, favorites, onFavorite }: {
  repo: string; numbers: number[];
  onChecked: (repo: string, list: PullList | null) => void;
  onRemove: (repo: string, n: number) => void;
  favorites: Favorite[];
  onFavorite: OnFavorite;
}) {
  const { list, loading } = usePulls(repo, numbers);
  const report = React.useRef(onChecked);
  report.current = onChecked;
  React.useEffect(() => { report.current(repo, list); }, [repo, list]);
  React.useEffect(() => () => report.current(repo, null), [repo]);
  const rows = new Map((list?.prs ?? []).map((r) => [r.number, r]));
  const usable = numbers.filter((n) => rows.get(n) && !rows.get(n)!.why).length;
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{repo}</span>
        <span className="label-mono text-muted-foreground">
          {loading ? "Checking with GitHub" : list?.error ? "" : usable === numbers.length ? `All ${numbers.length} usable` : `${usable} of ${numbers.length} usable`}
          {list?.language && !list.error ? ` · ${list.language}` : ""}
        </span>
      </div>
      {list?.error ? <Problem install={list.install}>{list.error}</Problem> : (
        <ul className="bg-surface shadow-[inset_0_0_0_1px_var(--rule)]" aria-busy={loading}>
          {numbers.map((n) => {
            const row = rows.get(n);
            const remove = (
              <button type="button" onClick={() => onRemove(repo, n)} aria-label={`Remove #${n}`}
                className="grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-node hover:text-foreground">
                <XIcon className="size-3.5" />
              </button>
            );
            const isSaved = favorites.some((f) => samePull(f, { repo, number: n }));
            const star = <Star saved={isSaved} number={n} onClick={() => onFavorite({ repo, number: n, title: row?.title }, !isSaved)} />;
            return row ? <PullItem key={n} row={row} trailing={<>{row.why ? <span className="size-7 shrink-0" /> : star}{remove}</>} />
              : <SkeletonRow key={n} at={n} number={n} trailing={remove} />;
          })}
        </ul>
      )}
    </div>
  );
}

function PullItem({ row, control, trailing, hits, chosen }: { row: PullRow; control?: React.ReactNode; trailing?: React.ReactNode; hits?: number[]; chosen?: boolean }) {
  const Row = control && !row.why ? "label" : "div";
  return (
    <li className="border-rule not-last:border-b">
      <Row className={cn("flex items-center gap-3 px-3 transition-colors",
        row.why ? "min-h-12 py-1.5 text-muted-foreground" : "min-h-14 py-2",
        control && !row.why && "cursor-pointer hover:bg-node/60",
        chosen && "bg-muted shadow-[inset_2px_0_0_var(--foreground)]")}>
        {control && row.why ? <CircleSlashIcon aria-label="Can't be a task" className="size-[18px] shrink-0 p-px text-line" /> : control}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="num shrink-0 text-[13px] text-muted-foreground">#{row.number}</span>
            <span className={cn("truncate", row.why ? "text-[13px]" : "text-[14px] text-foreground")}>{hits?.length ? <Marked text={row.title} hits={hits} /> : row.title || "Untitled"}</span>
          </span>
          <span className="num mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground">
            {row.why ? (
              <span className="inline-flex items-center gap-1.5">{!control && <CircleSlashIcon className="size-3" />}Can't be a task: {row.why}</span>
            ) : (
              <>
                {[row.author, row.merged_at && `merged ${ago(row.merged_at)}`, plural(row.files, "file"), `${row.lines.toLocaleString()} lines`, plural(row.tests, "test file")]
                  .filter(Boolean).map((part, i) => <span key={i}>{i > 0 && <span aria-hidden className="mr-1.5 opacity-50">·</span>}{part}</span>)}
                {row.maintenance && <Badge variant="outline" className="ml-1">Upkeep</Badge>}
              </>
            )}
          </span>
        </span>
        <a href={row.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open #${row.number} on GitHub`} title="Open on GitHub"
          className="grid size-7 shrink-0 place-items-center text-muted-foreground/70 transition-colors hover:bg-node hover:text-foreground">
          <ExternalLinkIcon className="size-3.5" />
        </a>
        {trailing}
      </Row>
    </li>
  );
}

/** The title with the letters the search matched in bold. */
function Marked({ text, hits }: { text: string; hits: number[] }) {
  const on = new Set(hits);
  const parts: { bold: boolean; text: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const bold = on.has(i);
    if (parts.length && parts[parts.length - 1].bold === bold) parts[parts.length - 1].text += text[i];
    else parts.push({ bold, text: text[i] });
  }
  return <>{parts.map((p, i) => p.bold ? <mark key={i} className="bg-transparent font-semibold text-foreground underline decoration-foreground/40 underline-offset-2">{p.text}</mark> : p.text)}</>;
}

const TITLE_WIDTHS = ["w-[70%]", "w-[44%]", "w-[58%]", "w-[36%]", "w-[64%]", "w-[50%]"];

function SkeletonRow({ number, trailing, at = 0 }: { number?: number; trailing?: React.ReactNode; at?: number }) {
  return (
    <li aria-hidden className="flex min-h-14 items-center gap-3 border-rule px-3 py-2 not-last:border-b">
      {number == null && <span className="size-[18px] shrink-0 shadow-[inset_0_0_0_1px_var(--rule)]" />}
      <span className="grid min-w-0 flex-1 gap-2">
        <span className="flex items-center gap-2">
          {number != null ? <span className="num text-[13px] text-muted-foreground">#{number}</span> : <span className="h-3 w-9 shrink-0 bg-node" />}
          <span className={cn("stripes h-3 animate-stripe bg-node", TITLE_WIDTHS[at % TITLE_WIDTHS.length])} />
        </span>
        <span className="h-2.5 w-[38%] max-w-64 bg-node" />
      </span>
      {trailing}
    </li>
  );
}

function Problem({ children, install }: { children: React.ReactNode; install?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 bg-danger-surface px-3 py-2.5 text-[13px]">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-[#AC0EB2] dark:text-[#FFA9FD]" />
      <span className="min-w-0 flex-1">{children}</span>
      {install && (
        <Button asChild size="sm">
          <a href={install} target="_blank" rel="noreferrer">Add it on GitHub <ExternalLinkIcon /></a>
        </Button>
      )}
    </div>
  );
}
