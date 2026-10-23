import { AlertCircleIcon, CheckIcon, ChevronRightIcon, GitBranchIcon, LoaderIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import * as React from "react";
import { Column } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Kbd, Label } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { post, repoInfo } from "@/lib/api";
import { dur, usd } from "@/lib/format";
import { type Route, useStored } from "@/lib/hooks";
import { isOpen } from "@/lib/models";
import type { AppState, CatalogModel, RepoInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

type Source = "quick" | "sample" | "repo";
const LIMITS = [5, 10, 20, 40];
const QUICK_MINUTES = 5; // every quick-sample attempt starts at once; a few minutes end to end
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Start a run: which pull requests, which models, then a plan with cost and time before Start. */
export function NewRun({ state, go, hurry }: { state: AppState; go: (r: Route) => void; hurry: () => void }) {
  const toast = useToast();
  const [source, setSource] = useStored<Source>("pr-eval-source", "quick");
  const [limit, setLimit] = React.useState(state.default_limit);
  const [repo, setRepo] = useStored("pr-eval-repo", "");
  const [setup, setSetup] = React.useState("");
  const [test, setTest] = React.useState("");
  const [info, setInfo] = React.useState<RepoInfo | null>(null);
  const [looking, setLooking] = React.useState(false);
  const usable = state.models.filter((m) => !m.missing);
  const defaults = usable.filter((m) => m.default).map((m) => m.key);
  const [stored, setStored] = useStored<string[] | null>("pr-eval-models", null);
  const chosen = (stored ?? defaults).filter((k) => usable.some((m) => m.key === k));
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const form = React.useRef<HTMLFormElement>(null);

  // Look the repository up as it's typed: language, whether it has default commands, access.
  React.useEffect(() => {
    setInfo(null);
    if (source !== "repo" || !repo.trim()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLooking(true);
      repoInfo(repo.trim(), abort.signal)
        .then(setInfo)
        .catch(() => {})
        .finally(() => !abort.signal.aborted && setLooking(false));
    }, 450);
    return () => { abort.abort(); window.clearTimeout(timer); setLooking(false); };
  }, [repo, source]);

  const prs = source === "quick" ? state.quick.tasks : limit;
  const models = state.models.filter((m) => chosen.includes(m.key));
  const attempts = prs * models.length;
  const priced = models.length > 0 && models.every((m) => m.cost_per_attempt != null);
  const cost = priced ? models.reduce((s, m) => s + m.cost_per_attempt! * prs, 0) : null;
  const slowest = Math.max(0, ...models.map((m) => m.seconds_per_attempt ?? 0));
  const minutes = source === "quick" ? QUICK_MINUTES : Math.max(5, Math.round((slowest * attempts) / 4 / 60 / 5) * 5);
  const needsCommands = source === "repo" && info?.repo && !info.defaults && !info.error;
  const blocked = state.busy || !models.length || (source === "repo" && (!repo.trim() || !!info?.error || (needsCommands && !(setup.trim() && test.trim()))));

  const toggle = (key: string, on: boolean) => {
    setError(null);
    setStored(on ? [...chosen, key] : chosen.filter((k) => k !== key));
  };

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    if (blocked || starting) return;
    setError(null);
    setStarting(true);
    const res = await post("/api/runs", {
      quick: source === "quick", sample: source === "sample", repo, limit, models: chosen, setup, test,
    });
    setStarting(false);
    if (res.error || !res.id) {
      setError(res.error ?? "The run didn't start.");
      return;
    }
    toast("Run started", { body: `${attempts} attempts on ${prs} pull requests.` });
    hurry();
    go({ page: "run", id: res.id });
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.current?.requestSubmit(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <form ref={form} onSubmit={start} onInput={() => setError(null)} className="grid gap-10" aria-label="New run">
      <Column heading="1. Pull requests" aside={<span className="label-mono text-muted-foreground">Merged, with tests</span>}>
        <RadioGroup.Root value={source} onValueChange={(v) => setSource(v as Source)} className="grid gap-1 sm:grid-cols-3" aria-label="Pull requests">
          <SourceTile value="quick" title="Quick sample" figure={`${state.quick.tasks} PRs`} tag="Fast"
            text={`${state.quick.repos} repos, every attempt at once. About ${QUICK_MINUTES} minutes.`} />
          <SourceTile value="sample" title="Full sample" figure={`${state.sample.tasks} PRs`}
            text={`${state.sample.repos} open-source repos in Go, TypeScript and Python.`} />
          <SourceTile value="repo" title="Your repository" figure="Any repo" text="Recent merged PRs from a GitHub repository." />
        </RadioGroup.Root>

        {source !== "quick" && (
          <div className="mt-4 grid animate-enter gap-4 bg-surface p-4 shadow-[inset_0_0_0_1px_var(--frame)] sm:grid-cols-[1fr_auto]">
            {source === "repo" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="repo">GitHub repository</Label>
                <div className="relative">
                  <GitBranchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or a GitHub link"
                    className="pl-9 font-mono text-[13px]" autoComplete="off" spellCheck={false} aria-invalid={!!info?.error} aria-describedby="repo-status" />
                </div>
                <RepoStatus id="repo-status" info={info} looking={looking} />
              </div>
            ) : <div className="self-center text-[14px] text-muted-foreground">Pull requests are spread across the sample's repositories.</div>}
            <div className="grid content-start gap-1.5">
              <Label>How many</Label>
              <div className="flex gap-0.5 bg-node p-0.5" role="radiogroup" aria-label="How many pull requests">
                {LIMITS.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={limit === n} onClick={() => setLimit(n)}
                    className={cn("h-9 min-w-11 px-3 font-mono text-[12px] transition-colors", limit === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {source === "repo" && (
              <details className="group sm:col-span-2" open={!!needsCommands}>
                <summary className="label-mono flex cursor-pointer list-none items-center gap-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                  Install and test commands {needsCommands ? <Badge variant="warn">Needed for {info?.language}</Badge> : <span className="normal-case tracking-normal">(optional for Go and Python)</span>}
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="setup">Install</Label>
                    <Input id="setup" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm ci" className="font-mono text-[13px]" spellCheck={false} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="test">Run the PR's tests</Label>
                    <Input id="test" value={test} onChange={(e) => setTest(e.target.value)} placeholder="npx vitest run {test_files}" className="font-mono text-[13px]" spellCheck={false} />
                  </div>
                </div>
              </details>
            )}
          </div>
        )}
      </Column>

      <Column heading="2. Models" aside={<span className="label-mono text-muted-foreground">{models.length} chosen</span>}>
        <ModelPicker models={state.models} chosen={chosen} onToggle={toggle} />
      </Column>

      <Column heading="3. Start">
        <div className="grid grid-cols-2 bg-surface shadow-[inset_0_0_0_1px_var(--frame)] sm:grid-cols-5">
          <PlanStat label="Pull requests" value={prs} />
          <PlanStat label="Attempts" value={attempts} />
          <PlanStat label="Sandboxes at once" value={source === "quick" ? attempts * 2 : "≤ 8"}
            tip="Each attempt uses its own sandbox for the agent, then a fresh one for the hidden tests." />
          <PlanStat label="Estimated cost" value={cost == null ? "–" : `≈ ${usd(cost)}`}
            tip={priced ? "From each model's cost per attempt in its most recent run." : "No earlier run to estimate from yet."} />
          <PlanStat label="Estimated time" value={models.length ? `≈ ${minutes} min` : "–"}
            tip={slowest ? `Slowest model takes about ${dur(slowest)} per attempt.` : undefined} />
        </div>
        {error && (
          <div role="alert" className="mt-3 flex animate-enter items-start gap-2 bg-danger-surface px-3 py-2.5 text-[14px]">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-[#AC0EB2] dark:text-[#FFA9FD]" />
            <span>{error}</span>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" disabled={!!blocked || starting} className="group min-w-48">
            {starting ? <LoaderIcon className="animate-spin" /> : null}
            {starting ? "Starting" : "Start run"}
            {!starting && <ChevronRightIcon className="transition-transform group-hover:translate-x-0.5" />}
            <Kbd className="ml-1 hidden sm:inline-flex">{MAC ? "⌘" : "Ctrl"} ↵</Kbd>
          </Button>
          <span className="text-[13px] text-muted-foreground">
            {state.busy ? "A run is going. You can start another when it finishes."
              : !models.length ? "Choose at least one model."
                : "Runs keep going if you close this page. Sandboxes are deleted as each attempt ends."}
          </span>
        </div>
      </Column>
    </form>
  );
}

function SourceTile({ value, title, figure, text, tag }: { value: Source; title: string; figure: string; text: string; tag?: string }) {
  return (
    <RadioGroup.Item
      value={value}
      className={cn(
        "group relative flex min-h-[132px] flex-col items-start bg-node p-4 text-left transition-[background-color,box-shadow] duration-150 outline-none",
        "hover:bg-node-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "data-[state=checked]:bg-surface data-[state=checked]:shadow-[inset_0_0_0_1px_var(--foreground)]",
      )}
    >
      <span className="flex h-5 w-full items-center justify-between">
        <span className="label-mono text-foreground">{title}</span>
        {tag && <Badge variant="solid" className="group-data-[state=unchecked]:bg-foreground/80">{tag}</Badge>}
      </span>
      <span className="num mt-3 text-[26px] leading-8 tracking-[-0.02em]">{figure}</span>
      <span className="mt-1 text-[13px] leading-snug text-muted-foreground">{text}</span>
      <span aria-hidden className="absolute top-0 left-0 h-0.5 w-0 bg-foreground transition-[width] duration-300 group-data-[state=checked]:w-full" />
    </RadioGroup.Item>
  );
}

function RepoStatus({ id, info, looking }: { id: string; info: RepoInfo | null; looking: boolean }) {
  let body: React.ReactNode = <span className="text-muted-foreground">Public repositories work everywhere; private ones need your own GitHub login.</span>;
  if (looking) body = <span className="inline-flex items-center gap-1.5 text-muted-foreground"><LoaderIcon className="size-3.5 animate-spin" /> Looking it up</span>;
  else if (info?.error) body = <span className="text-[#AC0EB2] dark:text-[#FFA9FD]">{info.error}</span>;
  else if (info?.repo) body = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <CheckIcon className="size-3.5" />
      <span className="font-mono text-[12px]">{info.repo}</span>
      <Badge>{info.language}</Badge>
      {info.private && <Badge variant="warn">Private</Badge>}
      <span className="text-muted-foreground">{info.defaults ? "Ready: it has default commands." : "Give its install and test commands below."}</span>
    </span>
  );
  return <div id={id} className="min-h-5 text-[13px]" aria-live="polite">{body}</div>;
}

function ModelPicker({ models, chosen, onToggle }: { models: CatalogModel[]; chosen: string[]; onToggle: (k: string, on: boolean) => void }) {
  const groups = [
    { title: "Open models · served on Baseten", list: models.filter(isOpen) },
    { title: "Closed models · the comparison", list: models.filter((m) => !isOpen(m)) },
  ].filter((g) => g.list.length);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="label-mono mb-2 text-muted-foreground">{g.title}</div>
          <div className="grid gap-1">
            {g.list.map((m) => {
              const on = chosen.includes(m.key);
              const row = (
                <label
                  key={m.key}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 transition-[background-color,box-shadow] duration-150",
                    on ? "bg-surface shadow-[inset_0_0_0_1px_var(--foreground)]" : "bg-node hover:bg-node-2",
                    m.missing && "cursor-not-allowed opacity-50 hover:bg-node",
                  )}
                >
                  <Checkbox checked={on} disabled={!!m.missing} onCheckedChange={(v) => onToggle(m.key, v === true)} aria-label={m.label} />
                  <span aria-hidden className={cn("size-3 shrink-0", isOpen(m) ? "bg-[#19E76E]" : "bg-[#3DA6FF]")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{m.label}</span>
                    <span className="label-mono block text-[10.5px] text-muted-foreground">
                      {m.missing ? "Needs its API key"
                        : [m.cost_per_attempt != null ? `${usd(m.cost_per_attempt)} / try` : "No price yet",
                           m.seconds_per_attempt != null ? `${dur(m.seconds_per_attempt)} / try` : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              );
              return m.missing ? <Tip key={m.key} content={m.missing}>{row}</Tip> : row;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanStat({ label, value, tip }: { label: string; value: React.ReactNode; tip?: string }) {
  const body = (
    <div className="border-frame px-4 py-3 not-last:border-r max-sm:odd:border-r max-sm:[&:nth-child(-n+4)]:border-b">
      <div className="label-mono text-[10.5px] text-muted-foreground">{label}</div>
      <div className="num mt-1 text-[22px] leading-7 tracking-[-0.01em]">{value}</div>
    </div>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}
