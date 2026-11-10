import { RadioGroup } from "radix-ui";
import * as React from "react";
import { Column } from "@/components/brand";
import { Chevron, External } from "@/components/brand/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Kbd, Label } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { post, repoInfo, samePull, useFavorites } from "@/lib/api";
import { dur, money, plural, usd } from "@/lib/format";
import { parsePasted, pullCount } from "@/lib/github";
import { type Route, useFocusCount, useStored } from "@/lib/hooks";
import { isOpen } from "@/lib/models";
import type { Again, AppState, CatalogModel, Favorite, PullList, RepoInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GitHubAccount, GitHubMark } from "./GitHubAccount";
import { type OnFavorite, PastedPulls, PullChooser, SavedPulls } from "./PullPicker";
import { Readiness } from "./Readiness";

type Source = "quick" | "repo" | "suite";
type Pick = "latest" | "choose";
const COMMANDS = "pr-eval-again-commands"; // a run's install and test commands, handed to the next form once
type Commands = { setup: string; test: string };
const LIMITS = [5, 10, 20, 40];
const QUICK_MINUTES = 35; // every quick-sample attempt starts at once; the slowest attempt sets the end
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Start a run: which pull requests, which models, then a plan with cost and time before Start. */
export function NewRun({ state, go, hurry }: { state: AppState; go: (r: Route) => void; hurry: () => void }) {
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
  const gitHubSignIn = React.useRef<{ signIn: () => void }>(null);
  const signedOut = state.github.sign_in && !state.github.login;
  const publicOpen = !!state.github.public; // the page reads public repositories itself: sign-in is for private ones
  // The Environment panel's sign-in: the quick sample may not show the GitHub box, so open Your pull requests first.
  const [signInNext, setSignInNext] = React.useState(false);
  React.useEffect(() => {
    if (signInNext && gitHubSignIn.current) { setSignInNext(false); gitHubSignIn.current.signIn(); }
  }, [signInNext, source]);
  const signInFromAside = () => {
    if (gitHubSignIn.current) gitHubSignIn.current.signIn();
    else { setSource("repo"); setSignInNext(true); }
  };
  const [favorites, save] = useFavorites(state.favorites);
  const [saveProblem, setSaveProblem] = React.useState<string | null>(null);
  const onFavorite: OnFavorite = (pull, saved) => {
    setSaveProblem(null);
    void save(pull, saved).then((problem) => problem && setSaveProblem(`Couldn't save it. ${problem}`));
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
  const scope = (mode === "quick" ? state.quick.names ?? []
    : mode === "suite" ? Object.keys(suitePulls) : mode === "pasted" ? Object.keys(pastedPulls) : repo ? [repo] : [])
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
  // The quick sample's tasks are already collected, so it runs without GitHub, and public repositories need no
  // sign-in when the page reads them itself: GitHub sign-in is for private repositories.
  const needsGitHub = signedOut && !publicOpen && !(mode === "quick" && state.quick.ready);
  const blocked = !!state.blocked || needsGitHub || over || !models.length || !prs || checking || !!lookupError || (!!needsCommands && !commandsGiven)
    || (mode === "pasted" && commandsGiven && Object.keys(pastedPulls).length > 1);

  const hint = state.blocked ? state.blocked
    : needsGitHub ? "Sign in with GitHub to start a run: the eval reads repositories, public ones too, with your own GitHub login."
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
    <form ref={form} onSubmit={start} onInput={() => setError(null)} aria-label="New run" className="layout-grid !p-0 gap-y-12">
      <div className="bt-main grid min-w-0 grid-cols-1 content-start gap-12">
        <Column heading={<Step n="01">Pull requests</Step>} aside={<span className="label-mono text-muted-foreground">Merged, with tests</span>}>
          <RadioGroup.Root value={source} onValueChange={(v) => setSource(v)} className="ev-sources" aria-label="Pull requests">
            <SourceTile value="quick" title="Quick sample" figure={plural(state.quick.tasks, "PR")} tag="No sign-in"
              text={`Real fixes from ${state.quick.names?.join(", ") || plural(state.quick.repos, "open-source repo")}, every attempt at once. About ${QUICK_MINUTES} minutes.`} />
            <SourceTile value="repo" title="Your pull requests" figure="Any repo"
              text={signedOut && !publicOpen ? "Sign in with GitHub, then paste pull request links or pick from a repository's latest merges."
                : "Paste pull request links, or pick from a repository's latest merges."} />
            <SourceTile value="suite" title="Your eval suite" figure={plural(favorites.length, "PR")}
              text="Every pull request you starred, from any repository. Run it again when a new model comes out." />
          </RadioGroup.Root>
          {saveProblem && <div role="alert" className="bt-notice error mt-3">{saveProblem}</div>}

          {source === "quick" && state.github.sign_in && (!state.quick.ready || !!state.github.login) && (
            <div className="ev-panel animate-enter">
              <GitHubAccount ref={gitHubSignIn} github={state.github} checks={state.checks} onChange={hurry} />
            </div>
          )}

          {source === "suite" && (
            <div className="ev-panel animate-enter">
              <div className="ev-panel-head">
                <GitHubAccount ref={gitHubSignIn} github={state.github} checks={state.checks} onChange={hurry} />
              </div>
              {favorites.length ? (
                <>
                  <SavedPulls favorites={suite} picked={inSuite} onPick={pickSuite} onFavorite={onFavorite} />
                  <p className="ev-small">
                    {favorites.length > suite.length ? `The newest ${suite.length} run; unstar some to make room for others. ` : ""}
                    Star more under <b className="text-black">Your pull requests</b>. Repositories that aren't Go or Python need their own install and test commands: run those from there.
                  </p>
                </>
              ) : (
                <p className="ev-small">
                  Nothing starred yet. Under <b className="text-black">Your pull requests</b>, star the pull requests that stand for your team's work.
                  They gather here, from any repository, so the next model gets the same test in one click.
                </p>
              )}
            </div>
          )}

          {source === "repo" && (
            <div className="ev-panel animate-enter">
              <div className="ev-panel-head">
                <GitHubAccount ref={gitHubSignIn} github={state.github} checks={state.checks} onChange={hurry} />
              </div>
              <div className="bt-field gap-2">
                <Label htmlFor="pulls">Repository or pull request links</Label>
                <textarea
                  id="pulls" value={text} onChange={(e) => setText(e.target.value)} rows={1} autoComplete="off" spellCheck={false}
                  placeholder="owner/repo, or paste links to pull requests"
                  aria-invalid={mode === "many" || !!lookupError} aria-describedby="pulls-status"
                  className="bt-input ev-pulls"
                />
                <SourceStatus id="pulls-status" mode={mode} info={info} looking={looking} pasted={pasted} pastedRepos={pastedRepos} signIn={state.github.sign_in} publicOpen={publicOpen}
                  onSignIn={signedOut ? () => gitHubSignIn.current?.signIn() : undefined} />
              </div>

              {(mode === "empty" || mode === "pasted") && (
                <SavedPulls favorites={mode === "pasted" ? favorites.filter((f) => !inBox(f)) : favorites} picked={inBox} onPick={pickSaved} onFavorite={onFavorite} />
              )}

              {/* Only once the lookup has read the repository, so a private one doesn't flash a chooser. */}
              {mode === "repo" && !!info?.repo && !info.error && (
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                    <Segmented label="Which" value={pick} onChange={(v) => setPick(v as Pick)}
                      options={[{ value: "latest", label: "Latest merged" }, { value: "choose", label: "Choose" }]} />
                    {pick === "latest" && (
                      <Segmented label="How many" value={String(limit)} onChange={(v) => setLimit(Number(v))}
                        options={LIMITS.map((n) => ({ value: String(n), label: String(n) }))} />
                    )}
                    {pick === "latest" && savedHere > 0 && (
                      <Button variant="ghost" onClick={() => setPick("choose")}>{savedHere} saved here: choose</Button>
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
                <details className="ev-details" open={!!needsCommands}>
                  <summary>
                    <Chevron />
                    Install and test commands {needsCommands ? <Badge variant="warn">Needed for {needsCommands.language}</Badge> : <span className="text-muted-foreground">(optional for Go and Python)</span>}
                  </summary>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="bt-field gap-2">
                      <Label htmlFor="setup">Install</Label>
                      <Input id="setup" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm ci" className="ev-code-input" spellCheck={false} />
                    </div>
                    <div className="bt-field gap-2">
                      <Label htmlFor="test">Run the PR's tests</Label>
                      <Input id="test" value={test} onChange={(e) => setTest(e.target.value)} placeholder="npx vitest run {test_files}" className="ev-code-input" spellCheck={false} />
                    </div>
                  </div>
                  {mode === "pasted" && Object.keys(pastedPulls).length > 1 && (
                    <p className="ev-small mt-2">Commands apply to one repository: paste pull requests from one at a time to use them.</p>
                  )}
                </details>
              )}
            </div>
          )}
        </Column>

        <Column heading={<Step n="02">Models</Step>} aside={<span className="label-mono text-muted-foreground">{models.length} chosen</span>}>
          <ModelPicker models={catalog} chosen={chosenModels} onToggle={toggleModel} />
        </Column>
      </div>

      <div className="bt-aside">
        <div className="grid gap-12 lg:sticky lg:top-3">
          <Column heading={<Step n="03">Start</Step>} aside={attempts > 0 && <span className="label-mono text-muted-foreground">{plural(attempts, "attempt")}</span>}>
            <div className="ev-plan">
              <div className="ev-plan-stats">
                <PlanStat label="Estimated cost" value={cost == null || !prs ? "–" : `≈ ${usd(cost)}`}
                  tip={priced ? "From each model's cost per attempt in its most recent run on these repositories, or else its most recent run."
                    : "No earlier run to estimate from yet."} />
                <PlanStat label="Estimated time" value={models.length && prs ? `≈ ${minutes} min` : "–"}
                  tip={slowest ? `Slowest model takes about ${dur(slowest)} per attempt.` : undefined} />
              </div>
              <dl className="bt-kv ev-plan-rows">
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
                  <PlanRow label="Last 24 hours" tip="What your runs spent on models in the last 24 hours, judges included, out of your limit.">
                    <span>{money(state.spend.spent)} <span className="text-muted-foreground">of {money(state.spend.cap)}</span></span>
                  </PlanRow>
                )}
              </dl>
              {error && <div role="alert" className="bt-notice error animate-enter">{error}</div>}
              {needsGitHub && !state.blocked ? (
                <Button full chevron onClick={() => gitHubSignIn.current?.signIn()}>
                  <GitHubMark className="size-3.5" /> Sign in with GitHub to start
                </Button>
              ) : (
                <Button type="submit" full chevron={!starting} disabled={!!blocked || starting}>
                  {starting ? "Starting" : "Start run"}
                  <Kbd className="max-sm:hidden">{MAC ? "⌘" : "Ctrl"} ↵</Kbd>
                </Button>
              )}
              <p className="ev-small" aria-live="polite">{hint}</p>
            </div>
          </Column>
          <Readiness state={state} onSignIn={signedOut ? signInFromAside : undefined} />
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

/** A column heading with its step number in the site's mono index square. */
function Step({ n, children }: { n: string; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-3"><span className="bt-numeral">{n}</span>{children}</span>;
}

function SourceTile({ value, title, figure, text, tag }: { value: Source; title: string; figure: string; text: string; tag?: string }) {
  return (
    <RadioGroup.Item value={value} className="bt-lift pink ev-source">
      <span>
        <span className="top">
          <span className="label-mono">{title}</span>
          {tag && <Badge variant="solid">{tag}</Badge>}
        </span>
        <span className="figure">{figure}</span>
        <span className="text">{text}</span>
      </span>
    </RadioGroup.Item>
  );
}
/** What the box understood: a repository and whether it's ready, or how many pull requests. A problem is a line in
 * Black after a Dark Pink square: the page never colours its words. */
function SourceStatus({ id, mode, info, looking, pasted, pastedRepos, signIn, publicOpen, onSignIn }: {
  id: string; mode: string; info: RepoInfo | null; looking: boolean; pasted: ReturnType<typeof parsePasted>; pastedRepos: string[]; signIn: boolean;
  publicOpen: boolean; onSignIn?: () => void;
}) {
  const Bad = ({ children }: { children: React.ReactNode }) => <span className="inline-flex items-baseline gap-2"><span aria-hidden className="ev-dot bad" />{children}</span>;
  const Ok = () => <span aria-hidden className="ev-dot" />;
  let body: React.ReactNode = <span className="text-muted-foreground">A repository takes its latest merged PRs, or the ones you choose.{signIn ? "" : " Private ones work when your GitHub login can read them."}</span>;
  if (mode === "many") body = <Bad>One repository at a time, or paste links to pull requests.</Bad>;
  else if (mode === "pasted") {
    const n = pullCount(pasted.pulls);
    body = (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Ok />
        {plural(n, "pull request")}{pastedRepos.length > 1 ? ` from ${pastedRepos.length} repositories` : ` from ${pastedRepos[0]}`}
        {(pasted.unknown.length > 0 || pasted.repos.length > 0) && (
          <span className="text-muted-foreground">· ignoring {[...pasted.repos, ...pasted.unknown].slice(0, 3).join(", ")}{pasted.repos.length + pasted.unknown.length > 3 ? "…" : ""}</span>
        )}
      </span>
    );
  } else if (mode === "repo") {
    if (looking) body = <span className="inline-flex items-center gap-2 text-muted-foreground"><span aria-hidden className="ev-dot live" /> Looking it up</span>;
    // Signed out, the page reads no repository: say so, with the sign-in right here.
    else if (info?.error && info.repo && onSignIn) body = (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Bad>{publicOpen ? <>Can't read <code className="ev-code">{info.repo}</code>. If it's private, sign in with GitHub.</>
          : <>Sign in with GitHub so the eval can read <code className="ev-code">{info.repo}</code>.</>}</Bad>
        <Button variant="outline" onClick={onSignIn}><GitHubMark className="size-3.5" />Sign in with GitHub</Button>
      </span>
    );
    else if (info?.error) body = (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
        <Bad>{info.error}</Bad>
        {info.install && <a className="bt-link" href={info.install} target="_blank" rel="noreferrer">Add it on GitHub <External /></a>}
      </span>
    );
    else if (info?.repo) body = (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Ok />
        <code className="ev-code">{info.repo}</code>
        <Badge>{info.language}</Badge>
        {info.private && <Badge variant="warn">Private</Badge>}
        <span className="text-muted-foreground">{info.defaults ? "Ready: it has default commands." : "Give its install and test commands below."}</span>
      </span>
    );
  } else if (pasted.unknown.length) body = <Bad>Not a repository or pull request: {pasted.unknown[0]}</Bad>;
  return <div id={id} className="min-h-5 text-[14px]" aria-live="polite">{body}</div>;
}

function Segmented({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="bt-field w-auto gap-2">
      <span className="label-xs text-muted-foreground">{label}</span>
      <div className="bt-toolbar ev-chips" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cn("bt-chip", value === o.value && "active")}
            onClick={() => onChange(o.value)}>{o.label}</button>
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
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-3">
      {groups.map((g) => (
        <div key={g.title} className="min-w-0">
          <div className="label-xs mb-2 text-muted-foreground">{g.title}</div>
          <ul className="ev-models">
            {g.list.map((m) => {
              const on = chosen.includes(m.key);
              const row = (
                <label data-on={on || undefined} data-off={m.missing ? true : undefined}>
                  <Checkbox checked={on} disabled={!!m.missing} onCheckedChange={(v) => onToggle(m.key, v === true)} aria-label={m.label} />
                  <span aria-hidden className={cn("size-2.5 shrink-0", isOpen(m) ? "bg-baseten" : "bg-rival")} />
                  <span className="min-w-0 flex-1">
                    <span className="name">{m.label}</span>
                    {m.model && <span className="id">{m.model}</span>}
                  </span>
                  <span className="price">
                    {m.missing ? "Needs its API key"
                      : [m.cost_per_attempt != null ? usd(m.cost_per_attempt) : "No price yet",
                         m.seconds_per_attempt != null ? dur(m.seconds_per_attempt) : null].filter(Boolean).join(" · ")}
                  </span>
                </label>
              );
              return <li key={m.key}>{m.missing ? <Tip content={m.missing}>{row}</Tip> : row}</li>;
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PlanStat({ label, value, tip }: { label: string; value: React.ReactNode; tip?: string }) {
  const body = (
    <div className="ev-plan-stat">
      <div className="label-xs text-muted-foreground">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}

/** One line of the plan: a mono label on the left, its value on the right. */
function PlanRow({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  const dt = <dt>{label}</dt>;
  return (
    <>
      {tip ? <Tip content={tip}>{dt}</Tip> : dt}
      <dd className="grid min-w-0 justify-items-end gap-1 text-right">{children}</dd>
    </>
  );
}
