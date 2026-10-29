import { AlertCircleIcon, CheckIcon, ChevronRightIcon, ExternalLinkIcon, GitPullRequestIcon, LoaderIcon, StarIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import * as React from "react";
import { Column } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Kbd, Label } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { post, repoInfo, samePull, useFavorites } from "@/lib/api";
import { dur, money, plural, usd } from "@/lib/format";
import { parsePasted, pullCount } from "@/lib/github";
import { type Route, useFocusCount, useStored } from "@/lib/hooks";
import { isOpen } from "@/lib/models";
import type { Again, AppState, CatalogModel, Favorite, PullList, RepoInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GitHubAccount } from "./GitHubAccount";
import { type OnFavorite, PastedPulls, PullChooser, SavedPulls } from "./PullPicker";

type Source = "quick" | "repo" | "suite";
type Pick = "latest" | "choose";
const COMMANDS = "pr-eval-again-commands"; // a run's install and test commands, handed to the next form once
type Commands = { setup: string; test: string };
const LIMITS = [5, 10, 20, 40];
const QUICK_MINUTES = 8; // every quick-sample attempt starts at once; the slowest attempt sets the end
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Start a run: which pull requests, which models, then a plan with cost and time before Start. */
export function NewRun({ state, go, hurry, aside }: { state: AppState; go: (r: Route) => void; hurry: () => void; aside?: React.ReactNode }) {
  const toast = useToast();
  const [stored, setSource] = useStored<string>("pr-eval-source", "quick");
  const source: Source = stored === "repo" || stored === "suite" ? stored : "quick";
  const [text, setText] = useStored("pr-eval-pulls", "");
  const [handed] = React.useState(takeCommands);
  React.useEffect(() => { try { sessionStorage.removeItem(COMMANDS); } catch { /* private window */ } }, []);
  const [pick, setPick] = useStored<Pick>("pr-eval-pick", "latest");
  const [limit, setLimit] = React.useState(state.default_limit);
  const [chosen, setChosen] = React.useState<number[]>([]);
  const [checked, setChecked] = React.useState<Record<string, PullList | null>>({});
  const [setup, setSetup] = React.useState(handed.setup);
  const [test, setTest] = React.useState(handed.test);
  const [info, setInfo] = React.useState<RepoInfo | null>(null);
  const [looking, setLooking] = React.useState(false);
  const usable = state.models.filter((m) => !m.missing);
  const defaults = usable.filter((m) => m.default).map((m) => m.key);
  const [storedModels, setStoredModels] = useStored<string[] | null>("pr-eval-models", null);
  const chosenModels = (storedModels ?? defaults).filter((k) => usable.some((m) => m.key === k));
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const form = React.useRef<HTMLFormElement>(null);
  const [favorites, save] = useFavorites(state.favorites);
  const onFavorite: OnFavorite = (pull, saved) => {
    void save(pull, saved).then((problem) => problem && toast("Couldn't save it", { body: problem, tone: "danger" }));
  };
  const github = state.github.login; // a GitHub sign-in can open private repositories, so look again
  // The eval suite: every starred pull request, from any repository, less the ones unticked for this run.
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const suite = favorites.slice(0, state.max_limit);
  const inSuite = (f: Favorite) => !skipped.includes(`${f.repo.toLowerCase()}#${f.number}`);
  const suitePulls = suite.filter(inSuite).reduce<Record<string, number[]>>((acc, f) => {
    const repo = Object.keys(acc).find((r) => r.toLowerCase() === f.repo.toLowerCase()) ?? f.repo; // GitHub names ignore case
    return { ...acc, [repo]: [...(acc[repo] ?? []), f.number] };
  }, {});
  const pickSuite = (f: Favorite, on: boolean) => {
    const key = `${f.repo.toLowerCase()}#${f.number}`;
    setSkipped(on ? skipped.filter((k) => k !== key) : [...skipped, key]);
  };

  // What was typed: one repository to take PRs from, or links to exact pull requests.
  const pasted = React.useMemo(() => parsePasted(text), [text]);
  const pastedRepos = Object.keys(pasted.pulls);
  const mode = source === "quick" ? "quick" : source === "suite" ? "suite" : pastedRepos.length ? "pasted" : pasted.repos.length === 1 ? "repo" : pasted.repos.length ? "many" : "empty";
  const repo = mode === "repo" ? pasted.repos[0] : null;

  // The install and test commands last started with each repository come back with it.
  const [kept, setKept] = useStored<Record<string, Commands>>("pr-eval-commands", {});
  const commandsFor = (repo ?? (mode === "pasted" && pastedRepos.length === 1 ? pastedRepos[0] : "")).toLowerCase();
  const first = React.useRef(true);
  React.useEffect(() => {
    const handedNow = first.current && !!(handed.setup || handed.test);
    first.current = false;
    const k = commandsFor && kept[commandsFor];
    if (k && !handedNow) { setSetup(k.setup); setTest(k.test); }
  }, [commandsFor]);

  // Look the repository up as it's typed: language, whether it has default commands, access. If it
  // couldn't be read, look again on coming back to this tab (say, from adding it to the GitHub App).
  const refocused = useFocusCount(!!info?.install);
  React.useEffect(() => {
    setInfo(null);
    setChosen([]);
    if (!repo) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLooking(true);
      repoInfo(repo, abort.signal)
        .then(setInfo)
        .catch(() => {})
        .finally(() => !abort.signal.aborted && setLooking(false));
    }, 450);
    return () => { abort.abort(); window.clearTimeout(timer); setLooking(false); };
  }, [repo, github, refocused]);

  // Pasted PRs that can't be tasks (not merged, no tests) stay out of the run.
  const pastedPulls = Object.fromEntries(pastedRepos
    .map((r) => [r, pasted.pulls[r].filter((n) => !checked[r]?.prs?.find((p) => p.number === n)?.why)] as const)
    .filter(([, list]) => list.length));
  const checking = mode === "pasted" && pastedRepos.some((r) => !checked[r]);
  const lookups = mode === "pasted" ? pastedRepos.flatMap((r) => checked[r] ?? []) : info ? [info] : [];
  const lookupError = lookups.find((l) => l.error)?.error;
  const needsCommands = lookups.find((l) => l.repo && !l.error && l.defaults === false);
  const prs = mode === "quick" ? state.quick.tasks : mode === "suite" ? pullCount(suitePulls) : mode === "pasted" ? pullCount(pastedPulls)
    : mode === "repo" && !info?.error ? (pick === "choose" ? chosen.length : limit) : 0;

  // Price from a run over the same repositories when there is one: a large repository costs far more per attempt.
  const scope = mode === "quick" ? "quick"
    : (mode === "suite" ? Object.keys(suitePulls) : mode === "pasted" ? Object.keys(pastedPulls) : repo ? [repo] : [])
      .map((r) => r.toLowerCase()).sort().join(",");
  const catalog = state.models.map((m) => ({ ...m, ...m.by_scope?.[scope] }));
  const models = catalog.filter((m) => chosenModels.includes(m.key));
  const attempts = prs * models.length;
  const priced = models.length > 0 && models.every((m) => m.cost_per_attempt != null);
  const cost = priced ? models.reduce((s, m) => s + m.cost_per_attempt! * prs, 0) : null;
  const slowest = Math.max(0, ...models.map((m) => m.seconds_per_attempt ?? 0));
  // A run takes at least its slowest attempt, however many go at once.
  const minutes = mode === "quick" ? QUICK_MINUTES : Math.max(1, Math.round(Math.max(slowest, (slowest * attempts) / 4) / 60));
  const commandsGiven = !!(setup.trim() && test.trim());
  const left = state.spend ? Math.max(0, state.spend.cap - state.spend.spent) : null;
  const over = left != null && cost != null && prs > 0 && cost > left;
  const blocked = !!state.blocked || over || !models.length || !prs || checking || !!lookupError || (!!needsCommands && !commandsGiven)
    || (mode === "pasted" && commandsGiven && Object.keys(pastedPulls).length > 1);

  const hint = state.blocked ? state.blocked
    : over ? `This run would cost about ${usd(cost)}, and you have ${usd(left)} left of your ${usd(state.spend!.cap)} for the last 24 hours. Choose fewer pull requests or models.`
    : !models.length ? "Choose at least one model."
    : checking ? "Checking the pull requests on GitHub."
    : lookupError ? "Pick a repository the page can read."
    : needsCommands && !commandsGiven ? `Give the install and test commands for ${needsCommands.language}.`
    : !prs ? (mode === "repo" && pick === "choose" ? "Choose at least one pull request."
      : mode === "suite" ? "Star or tick at least one pull request." : "Name a repository or paste pull request links.")
    : "Runs keep going if you close this page.";

  const toggleModel = (key: string, on: boolean) => {
    setError(null);
    setStoredModels(on ? [...chosenModels, key] : chosenModels.filter((k) => k !== key));
  };

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    if (blocked || starting) return;
    setError(null);
    setStarting(true);
    const which = mode === "quick" ? { quick: true }
      : mode === "suite" ? { pulls: suitePulls }
      : mode === "pasted" ? { pulls: pastedPulls }
        : pick === "choose" ? { pulls: { [repo!]: chosen } } : { repo, limit };
    const res = await post("/api/runs", { ...which, models: chosenModels, ...(mode === "suite" ? {} : { setup, test }) });
    setStarting(false);
    if (res.error || !res.id) {
      setError(res.error ?? "The run didn't start.");
      return;
    }
    if (commandsFor && mode !== "suite" && (setup.trim() || test.trim())) setKept({ ...kept, [commandsFor]: { setup, test } });
    toast("Run started", { body: `${attempts} attempts on ${plural(prs, "pull request")}.` });
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

  const removePull = (r: string, n: number) =>
    setText(text.split(/[\s,]+/).filter((t) => {
      const one = Object.entries(parsePasted(t).pulls);
      return !(one.length === 1 && one[0][1].length === 1 && samePull({ repo: one[0][0], number: one[0][1][0] }, { repo: r, number: n }));
    }).join("\n"));
  const inBox = (f: Favorite) => Object.entries(pasted.pulls).some(([r, list]) => list.some((n) => samePull({ repo: r, number: n }, f)));
  const pickSaved = (f: Favorite, on: boolean) => {
    if (!on) return removePull(f.repo, f.number);
    const kept = mode === "pasted" ? text.trim() : ""; // a repository name gives way to exact pull requests
    setText(`${kept ? `${kept}\n` : ""}https://github.com/${f.repo}/pull/${f.number}`);
  };
  const savedHere = repo ? favorites.filter((f) => f.repo.toLowerCase() === repo.toLowerCase()).length : 0;

  return (
    <form ref={form} onSubmit={start} onInput={() => setError(null)} aria-label="New run"
      className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-0">
      <div className="grid min-w-0 grid-cols-1 content-start gap-10 lg:pr-8">
        <Column heading="1. Pull requests" aside={<span className="label-mono text-muted-foreground">Merged, with tests</span>}>
          <RadioGroup.Root value={source} onValueChange={(v) => setSource(v)} className="grid gap-1 sm:grid-cols-3" aria-label="Pull requests">
            <SourceTile value="quick" title="Quick sample" figure={plural(state.quick.tasks, "PR")} tag="Fast"
              text={`${state.quick.repos} open-source repos, every attempt at once. About ${QUICK_MINUTES} minutes.`} />
            <SourceTile value="repo" title="Your pull requests" figure="Any repo"
              text="Paste pull request links, or pick from a repository's latest merges." />
            <SourceTile value="suite" title="Your eval suite" figure={plural(favorites.length, "PR")}
              text="Every pull request you starred, from any repository. Run it again when a new model comes out." />
          </RadioGroup.Root>

          {source === "suite" && (
            <div className="mt-4 grid animate-enter grid-cols-1 gap-4 bg-surface p-4 shadow-[inset_0_0_0_1px_var(--frame)]">
              <div className="-mx-4 -mt-4 border-b border-rule px-4 py-2.5">
                <GitHubAccount github={state.github} checks={state.checks} onChange={hurry} />
              </div>
              {favorites.length ? (
                <>
                  <SavedPulls favorites={suite} picked={inSuite} onPick={pickSuite} onFavorite={onFavorite} />
                  <p className="text-[13px] text-muted-foreground">
                    {favorites.length > suite.length ? `The newest ${suite.length} run; unstar some to make room for others. ` : ""}
                    Star more under <b className="font-medium text-foreground">Your pull requests</b>. Repositories that aren't Go or Python need their own install and test commands: run those from there.
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Nothing starred yet. Under <b className="font-medium text-foreground">Your pull requests</b>, star the pull requests that stand for your team's work.
                  They gather here, from any repository, so the next model gets the same test in one click.
                </p>
              )}
            </div>
          )}

          {source === "repo" && (
            <div className="mt-4 grid animate-enter grid-cols-1 gap-5 bg-surface p-4 shadow-[inset_0_0_0_1px_var(--frame)]">
              <div className="-mx-4 -mt-4 border-b border-rule px-4 py-2.5">
                <GitHubAccount github={state.github} checks={state.checks} onChange={hurry} />
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                <Label htmlFor="pulls">Repository or pull request links</Label>
                <div className="relative">
                  <GitPullRequestIcon className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
                  <textarea
                    id="pulls" value={text} onChange={(e) => setText(e.target.value)} rows={1} autoComplete="off" spellCheck={false}
                    placeholder="owner/repo, or paste links to pull requests"
                    aria-invalid={mode === "many" || !!lookupError} aria-describedby="pulls-status"
                    className={cn(
                      "block max-h-48 min-h-10 w-full resize-none bg-surface py-2.5 pr-3 pl-9 font-mono text-[13px] leading-5 [field-sizing:content]",
                      "shadow-[inset_0_0_0_1px_var(--rule)] outline-none transition-shadow placeholder:text-muted-foreground/80 hover:shadow-[inset_0_0_0_1px_var(--line)]",
                      "focus-visible:shadow-[inset_0_0_0_1px_var(--foreground)] aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]",
                    )}
                  />
                </div>
                <SourceStatus id="pulls-status" mode={mode} info={info} looking={looking} pasted={pasted} pastedRepos={pastedRepos} signIn={state.github.sign_in} />
              </div>

              {(mode === "empty" || mode === "pasted") && (
                <SavedPulls favorites={mode === "pasted" ? favorites.filter((f) => !inBox(f)) : favorites} picked={inBox} onPick={pickSaved} onFavorite={onFavorite} />
              )}

              {/* Only once the lookup has read the repository, so a private one doesn't flash a chooser. */}
              {mode === "repo" && !!info?.repo && (
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                    <Segmented label="Which" value={pick} onChange={(v) => setPick(v as Pick)}
                      options={[{ value: "latest", label: "Latest merged" }, { value: "choose", label: "Choose" }]} />
                    {pick === "latest" && (
                      <Segmented label="How many" value={String(limit)} onChange={(v) => setLimit(Number(v))}
                        options={LIMITS.map((n) => ({ value: String(n), label: String(n) }))} />
                    )}
                    {pick === "latest" && savedHere > 0 && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setPick("choose")}>
                        <StarIcon className="fill-current" /> {savedHere} saved here: choose
                      </Button>
                    )}
                  </div>
                  {pick === "choose" && (
                    <PullChooser key={`${repo}|${github ?? ""}`} repo={repo!} chosen={chosen} onChange={setChosen} max={state.max_limit}
                      favorites={favorites} onFavorite={onFavorite} />
                  )}
                </div>
              )}

              {mode === "pasted" && (
                <PastedPulls key={github ?? ""} pulls={pasted.pulls} onChecked={(r, list) => setChecked((c) => (c[r] === list ? c : { ...c, [r]: list }))} onRemove={removePull}
                  favorites={favorites} onFavorite={onFavorite} />
              )}

              {(mode === "repo" || mode === "pasted") && (
                <details className="group" open={!!needsCommands}>
                  <summary className="label-mono flex cursor-pointer list-none flex-wrap items-center gap-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                    Install and test commands {needsCommands ? <Badge variant="warn">Needed for {needsCommands.language}</Badge> : <span className="normal-case tracking-normal">(optional for Go and Python)</span>}
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
                  {mode === "pasted" && Object.keys(pastedPulls).length > 1 && (
                    <p className="mt-2 text-[12.5px] text-muted-foreground">Commands apply to one repository: paste pull requests from one at a time to use them.</p>
                  )}
                </details>
              )}
            </div>
          )}
        </Column>

        <Column heading="2. Models" aside={<span className="label-mono text-muted-foreground">{models.length} chosen</span>}>
          <ModelPicker models={catalog} chosen={chosenModels} onToggle={toggleModel} />
        </Column>

      </div>

      <div className="min-w-0 lg:border-l lg:border-dashed lg:border-rule lg:pl-8">
        <div className="grid gap-10 lg:sticky lg:top-20">
          <Column heading="3. Start" aside={attempts > 0 && <span className="label-mono text-muted-foreground">{plural(attempts, "attempt")}</span>}>
            <div className="grid grid-cols-2 bg-surface shadow-[inset_0_0_0_1px_var(--frame)]">
              <PlanStat label="Estimated cost" value={cost == null || !prs ? "–" : `≈ ${usd(cost)}`}
                tip={priced ? "From each model's cost per attempt in its most recent run on these repositories, or else its most recent run."
                  : "No earlier run to estimate from yet."} />
              <PlanStat label="Estimated time" value={models.length && prs ? `≈ ${minutes} min` : "–"}
                tip={slowest ? `Slowest model takes about ${dur(slowest)} per attempt.` : undefined} />
            </div>
            <dl className="mt-4 grid gap-2 text-[14px]">
              <PlanRow label="Pull requests">{prs || "–"}</PlanRow>
              <PlanRow label="Models">
                {models.length ? [...models.filter(isOpen), ...models.filter((m) => !isOpen(m))].map((m) => (
                  <span key={m.key} className="flex min-w-0 items-center justify-end gap-2">
                    <span aria-hidden className={cn("size-2.5 shrink-0", isOpen(m) ? "bg-baseten" : "bg-rival")} />
                    <span className="truncate">{m.label}</span>
                  </span>
                )) : "–"}
              </PlanRow>
              <PlanRow label="Sandboxes at once" tip="Each attempt uses its own sandbox for the agent, then a fresh one for the hidden tests.">
                {!attempts ? "–" : mode === "quick" ? attempts * 2 : "≤ 16"}
              </PlanRow>
              {state.spend && (
                <PlanRow label="Last 24 hours" tip="What your runs started in the last 24 hours cost, out of your limit.">
                  <span>{money(state.spend.spent)} <span className="text-muted-foreground">of {money(state.spend.cap)}</span></span>
                </PlanRow>
              )}
            </dl>
            {error && (
              <div role="alert" className="mt-4 flex animate-enter items-start gap-2 bg-danger-surface px-3 py-2.5 text-[14px]">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-[#AC0EB2] dark:text-[#FFA9FD]" />
                <span>{error}</span>
              </div>
            )}
            <Button type="submit" size="lg" disabled={!!blocked || starting} className="group mt-5 w-full">
              {starting ? <LoaderIcon className="animate-spin" /> : null}
              {starting ? "Starting" : "Start run"}
              {!starting && <ChevronRightIcon className="transition-transform group-hover:translate-x-0.5" />}
              <Kbd className="ml-1 hidden sm:inline-flex">{MAC ? "⌘" : "Ctrl"} ↵</Kbd>
            </Button>
            <p className="mt-3 text-[13px] leading-snug text-muted-foreground" aria-live="polite">{hint}</p>
          </Column>
          {aside}
        </div>
      </div>
    </form>
  );
}

/** Put a run's pull requests, models and commands in the form; it reads them when it next mounts. */
export function fillAgain(again: Again) {
  const links = Object.entries(again.pulls ?? {}).flatMap(([repo, numbers]) => numbers.map((n) => `https://github.com/${repo}/pull/${n}`));
  try {
    localStorage.setItem("pr-eval-source", JSON.stringify(again.quick ? "quick" : "repo"));
    if (!again.quick) localStorage.setItem("pr-eval-pulls", JSON.stringify(links.join("\n")));
    localStorage.setItem("pr-eval-models", JSON.stringify(again.models));
    sessionStorage.setItem(COMMANDS, JSON.stringify({ setup: again.setup ?? "", test: again.test ?? "" }));
  } catch { /* private window: the form stays as it was */ }
}

function takeCommands(): Commands {
  try {
    const got = JSON.parse(sessionStorage.getItem(COMMANDS) ?? "{}");
    return { setup: String(got.setup ?? ""), test: String(got.test ?? "") };
  } catch {
    return { setup: "", test: "" };
  }
}

function SourceTile({ value, title, figure, text, tag }: { value: Source; title: string; figure: string; text: string; tag?: string }) {
  return (
    <RadioGroup.Item
      value={value}
      className={cn(
        "group relative flex min-h-[104px] flex-col items-start bg-node p-4 text-left sm:min-h-[132px] transition-[background-color,box-shadow] duration-150 outline-none",
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

/** What the box understood: a repository and whether it's ready, or how many pull requests. */
function SourceStatus({ id, mode, info, looking, pasted, pastedRepos, signIn }: {
  id: string; mode: string; info: RepoInfo | null; looking: boolean; pasted: ReturnType<typeof parsePasted>; pastedRepos: string[]; signIn: boolean;
}) {
  const danger = "text-[#AC0EB2] dark:text-[#FFA9FD]";
  let body: React.ReactNode = <span className="text-muted-foreground">A repository takes its latest merged PRs, or the ones you choose.{signIn ? "" : " Private ones work when your GitHub login can read them."}</span>;
  if (mode === "many") body = <span className={danger}>One repository at a time, or paste links to pull requests.</span>;
  else if (mode === "pasted") {
    const n = pullCount(pasted.pulls);
    body = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <CheckIcon className="size-3.5" />
        {plural(n, "pull request")}{pastedRepos.length > 1 ? ` from ${pastedRepos.length} repositories` : ` from ${pastedRepos[0]}`}
        {(pasted.unknown.length > 0 || pasted.repos.length > 0) && (
          <span className="text-muted-foreground">· ignoring {[...pasted.repos, ...pasted.unknown].slice(0, 3).join(", ")}{pasted.repos.length + pasted.unknown.length > 3 ? "…" : ""}</span>
        )}
      </span>
    );
  } else if (mode === "repo") {
    if (looking) body = <span className="inline-flex items-center gap-1.5 text-muted-foreground"><LoaderIcon className="size-3.5 animate-spin" /> Looking it up</span>;
    else if (info?.error) body = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className={danger}>{info.error}</span>
        {info.install && <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={info.install} target="_blank" rel="noreferrer">Add it on GitHub <ExternalLinkIcon className="size-3.5" /></a>}
      </span>
    );
    else if (info?.repo) body = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <CheckIcon className="size-3.5" />
        <span className="font-mono text-[12px]">{info.repo}</span>
        <Badge>{info.language}</Badge>
        {info.private && <Badge variant="warn">Private</Badge>}
        <span className="text-muted-foreground">{info.defaults ? "Ready: it has default commands." : "Give its install and test commands below."}</span>
      </span>
    );
  } else if (pasted.unknown.length) body = <span className={danger}>Not a repository or pull request: {pasted.unknown[0]}</span>;
  return <div id={id} className="min-h-5 text-[13px]" aria-live="polite">{body}</div>;
}

function Segmented({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="grid content-start gap-1.5">
      <span className="label-mono text-muted-foreground">{label}</span>
      <div className="flex gap-0.5 bg-node p-0.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
            className={cn("h-9 min-w-11 px-3 font-mono text-[12px] uppercase tracking-[0.04em] transition-colors",
              value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelPicker({ models, chosen, onToggle }: { models: CatalogModel[]; chosen: string[]; onToggle: (k: string, on: boolean) => void }) {
  const groups = [
    { title: "Open models · served on Baseten", list: models.filter(isOpen) },
    { title: "Closed models · the comparison", list: models.filter((m) => !isOpen(m)) },
  ].filter((g) => g.list.length);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {groups.map((g) => (
        <div key={g.title} className="min-w-0">
          <div className="label-mono mb-2 text-muted-foreground">{g.title}</div>
          <div className="grid grid-cols-1 gap-1">
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
                    {m.model && <span className="block truncate font-mono text-[11.5px] text-muted-foreground">{m.model}</span>}
                    <span className="label-mono block text-[10.5px] text-muted-foreground">
                      {m.missing ? "Needs its API key"
                        : [m.cost_per_attempt != null ? usd(m.cost_per_attempt) : "No price yet",
                           m.seconds_per_attempt != null ? dur(m.seconds_per_attempt) : null].filter(Boolean).join(" · ")
                          + (m.cost_per_attempt != null || m.seconds_per_attempt != null ? " per attempt" : "")}
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
    <div className="border-frame px-4 py-3 first:border-r">
      <div className="label-mono text-[10.5px] text-muted-foreground">{label}</div>
      <div className="num mt-1 text-[26px] leading-8 tracking-[-0.02em]">{value}</div>
    </div>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}

/** One line of the plan: a mono label on the left, its value on the right. */
function PlanRow({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  const row = (
    <div className="flex items-start justify-between gap-4 border-b border-frame pb-2">
      <dt className="label-mono shrink-0 pt-0.5 text-muted-foreground">{label}</dt>
      <dd className="num grid min-w-0 gap-1 text-right">{children}</dd>
    </div>
  );
  return tip ? <Tip content={tip}>{row}</Tip> : row;
}
