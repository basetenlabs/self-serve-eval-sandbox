// Shapes of what `pr-eval serve` returns (/api/state) and what report.py writes (report.json).

export type Kind = "open" | "closed";

export interface Model {
  key: string;
  label: string;
  kind?: Kind | null;
  provider?: string;
  /** Who makes a closed model, as the page says who serves it: "Anthropic". */
  maker?: string | null;
  /** The exact id its API serves, e.g. deepseek-ai/DeepSeek-V4.1-Flash-1017. */
  model?: string | null;
}

// ---------- /api/state ----------

export interface CatalogModel extends Model {
  missing?: string | null;
  default?: boolean;
  /** Per attempt, counting the tries an attempt is likely to take (AppState.tries at most). */
  cost_per_attempt?: number;
  seconds_per_attempt?: number;
  tries_per_attempt?: number;
  /** The same, from the most recent run over each set of repositories ("o/a,o/b", lower case) or "quick". */
  by_scope?: Record<string, { cost_per_attempt: number; seconds_per_attempt: number; tries_per_attempt?: number }>;
}

export interface Checks {
  /** The Baseten key can create the sandboxes attempts run in; if not, why. */
  sandboxes: boolean;
  sandboxes_problem?: string | null;
  gh: boolean;
  /** Whose GitHub login the `gh` CLI on this machine uses. */
  gh_login?: string | null;
  image: boolean;
}

export type Phase = "collecting" | "checking" | "running" | "judging" | "reporting" | "done" | "stopped" | "failed" | string;

export type CheckStage = "sandboxes" | "setup" | "base" | "reference" | "passed" | "left-out" | "queued" | "stopped";
export type LiveStage = "sandboxes" | "setup" | "agent" | "tests" | "judge";
export type CellStage = LiveStage | "solved" | "failed" | "invalid" | "queued" | "waiting" | "not-run" | "left-out";

export interface Cell {
  model: string;
  attempt: number;
  stage: CellStage;
  at?: string;
  started_at?: string;
  reason?: string | null;
  seconds?: number | null;
  cost?: number | null;
  diff?: { files: number; added: number; removed: number } | null;
  tests_passed?: boolean | null;
  /** The judges' review beside the tests, which alone decide solved: "pass", "fail", or "error" when they gave
   * none, with its reason. Missing when no judge was asked. */
  judge?: "pass" | "fail" | "error" | string | null;
  judge_reason?: string | null;
  /** The try this is, from the second on: live, the one running; finished, the last. */
  try?: number;
}

export interface BoardRow {
  id: string;
  repo: string;
  pr: number | string;
  title: string;
  language: string;
  url?: string;
  lines?: number;
  /** By changed lines: small (up to 100), medium (up to 400) or large. */
  size?: "small" | "medium" | "large";
  check: { stage: CheckStage; why?: string; at?: string };
  cells: Cell[];
}

export interface Board {
  rows: BoardRow[];
  sandboxes: number;
  concurrency?: number | null;
  /** Hosted: the places every run's attempts share, how many are taken and how many attempts wait for one. */
  shared?: { held: number; waiting: number; limit: number } | null;
}

export interface RunSummary {
  pass_at_1: number | null;
  solved: number;
  /** Tasks solved at least once; missing from runs listed before it was added. */
  tasks_solved?: number | null;
  valid: number;
  cost_per_solved: number | null;
  invalid: number;
}

export interface Run {
  id: string;
  title: string;
  started: string | null;
  tasks: number;
  active_at: string;
  models: Model[];
  phase: Phase;
  detail: string;
  note?: string | null;
  judged?: boolean;
  progress: { done: number; total: number };
  checking: { done: number; total: number };
  left_out: { id: string; pr: string; why: string }[];
  summary: Record<string, RunSummary>;
  report: string | null;
  log?: string | null;
  lost: number;
  resumable: boolean;
  /** On a private repository. */
  private?: boolean;
  read_only?: boolean;
  /** The starter, shown to teammates and admins. */
  owner?: string | null;
  /** What Run again puts back in the form; null when it can't. */
  again?: Again | null;
  board?: Board;
  /** "commands" while the run works out how to install and test a repository. */
  step?: string | null;
  /** The install and test commands each named repository ran with. */
  commands?: Record<string, CommandsUsed>;
}

/** A repository's install and test commands in a run, and where they came from. */
export interface CommandsUsed {
  setup: string;
  test: string;
  /** given on the form or the command line; saved from an earlier run; the default; or worked out at the start. */
  source: "given" | "saved" | "default" | "worked out";
  proven_on?: { pr: number; commit?: string | null } | null;
  tries?: number;
  cost_usd?: number | null;
  model?: string | null;
}

/** A run's pull requests, models and commands, to start the same run again. */
export interface Again {
  quick?: boolean;
  pulls?: Record<string, number[]>;
  setup?: string | null;
  test?: string | null;
  models: string[];
  /** The LLM judges switch as the run had it; missing on Run again links from before the switch. */
  judges?: boolean;
}

/** The LLM judges switch, as the server works it out from the keys it has (pipeline.judges_offer). */
export interface JudgesOffer {
  /** Some judge has a key here; off and disabled otherwise. */
  on: boolean;
  judges: string[];
  /** Who writes the final verdict; null when the judges left decide together. */
  chair?: string | null;
  left_out: string[];
  /** One short line: who reviews, or why none can. */
  note: string;
  /** The judges' review of one attempt, in USD. */
  cost_per_attempt: number;
}

export interface AppState {
  checks: Checks;
  models: CatalogModel[];
  runs: Run[];
  /** `ready`: its tasks are collected, so it starts without reading GitHub. */
  quick: { tasks: number; repos: number; names?: string[]; ready?: boolean; at_once?: number; sizes?: Partial<Record<"small" | "medium" | "large", number>> };
  /** Tries per attempt a run started here gets: a try the model fails runs again, up to this many. */
  tries?: number;
  /** The LLM judges switch; missing from a server from before it. */
  judges?: JudgesOffer;
  max_limit: number;
  pr_size?: { lines: number; pasted_lines: number; files: number };
  /** Some run is going, anyone's: the page polls faster. */
  busy: boolean;
  /** Why you can't start a run now: your run is going, the most runs are, or a spending limit is reached. */
  blocked?: string | null;
  /** What your runs spent on models in the last 24 hours, and your limit, when there is one. */
  spend?: { spent: number; cap: number } | null;
  github: GitHubAccess;
  /** Hosted, where people open the page (hosted/deploy.py's PR_EVAL_PUBLIC_ORIGIN, else its preview address). */
  origin?: string | null;
  favorites: Favorite[];
  /** Hosted: you are an admin, so you see every run and the Access page. */
  admin?: boolean;
}

/** Who reads GitHub. Hosted, the page reads public repositories only, with its own token, and nobody signs in
 * with GitHub; locally the `gh` CLI's login reads. */
export interface GitHubAccess {
  hosted: boolean;
  /** The page has its own token for public repositories. Hosted without one, only the quick sample runs. */
  public?: boolean;
}

/** A pull request saved for later, newest first. */
export interface Favorite {
  repo: string;
  number: number;
  title: string;
  saved_at: string;
}

export interface RepoInfo {
  repo?: string;
  language?: string;
  private?: boolean;
  defaults?: boolean;
  /** Commands an earlier run worked out for it. */
  commands?: { setup: string; test: string; at?: string } | null;
  error?: string;
}

/** A pull request to pick, from /api/prs; `why` says why it can't be a task. */
export interface PullRow {
  number: number;
  title: string;
  url: string;
  merged_at?: string | null;
  author?: string | null;
  files: number;
  lines: number;
  tests: number;
  why?: string | null;
  maintenance?: boolean;
}

export interface PullList extends RepoInfo {
  prs?: PullRow[];
}

// ---------- /api/trace ----------

export type TraceStep =
  | { kind: "thinking" | "text"; text: string; nested?: boolean }
  | { kind: "tool"; tool: string; title: string; detail?: string | null; output?: string; error?: boolean; at?: number; nested?: boolean };

export interface Trace {
  steps: TraceStep[];
  hidden_thinking: number;
  dropped: number;
  tool_calls: number;
  tool_errors: number;
  finished?: { turns?: number | null; seconds?: number | null; error?: boolean; subtype?: string } | null;
  error?: string;
}

// ---------- report.json ----------

export interface Timing {
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
  total_working_seconds: number | null;
  timed_attempts: number;
  attempts: number;
}

export interface Summary {
  attempts: number;
  valid: number;
  invalid: number;
  timing?: Timing;
  solved: number;
  pass_at_1: number | null;
  tasks: number;
  tasks_solved: number;
  cost_usd: number | null;
  cost_per_attempt: number | null;
  cost_per_solved: number | null;
  median_seconds: number | null;
  median_seconds_with_waits?: number | null;
  rate_limited_attempts?: number;
  median_turns: number | null;
  mean_output_tokens: number | null;
  mean_input_tokens: number | null;
  agent_timeouts: number;
  rebuilt_cost_attempts?: number;
  partial_cost_attempts?: number;
  judge_disagreements: number;
  /** Tries over the valid attempts, and how many attempts each try solved ([on try 1, on try 2, ...]). */
  tries?: number;
  cost_per_try?: number | null;
  solved_on?: number[];
}

export interface Task {
  id: string;
  repo: string;
  pr?: number;
  url?: string;
  title: string;
  language?: string;
  size?: string;
  lines_changed?: number;
  files_changed?: number;
  merged_at?: string;
  instruction?: string;
  reference_patch?: string | null;
  test_scope?: string | null;
}

export type Outcome = "solved" | "failed" | "invalid";

/** A try of an attempt that its model failed before the last one, in brief. */
export interface EarlierTry {
  try: number;
  outcome: "failed";
  started_at?: string | null;
  finished_at?: string | null;
  agent?: Trial["agent"];
  diff?: Trial["diff"];
  tests?: { passed?: boolean | null; summary?: string | null } | null;
  judge?: { verdict?: string; reason?: string } | null;
}

export interface Trial {
  trial: string;
  task_id: string;
  model: string;
  attempt: number;
  /** Set when the attempt took more than one try: the last one's number, and the ones before it. */
  try?: number;
  earlier_tries?: EarlierTry[];
  outcome: Outcome;
  invalid_reason?: string | null;
  /** Not scored: the step it failed at, why in one sentence, and the end of the log that shows it. */
  step?: string | null;
  cause?: string | null;
  log?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  agent?: {
    seconds?: number | null;
    working_seconds?: number | null;
    api_retries?: number | null;
    rate_limited_retries?: number | null;
    retry_wait_seconds?: number | null;
    timed_out?: boolean | null;
    num_turns?: number | null;
    tool_calls?: Record<string, number> | null;
    tokens?: { input?: number; output?: number; cached_input?: number; cache_write?: number } | null;
    cost_usd?: number | null;
    cost_source?: string | null;
    final_message?: string | null;
  } | null;
  diff?: { files: number; added: number; removed: number } | null;
  tests?: { passed?: boolean; summary?: string; set_aside?: string[] } | null;
  judge?: (Vote & { panel?: Vote[]; chair?: Vote | null }) | null;
  patch?: string | null;
  verifier_tail?: string | null;
}

/** One judge's verdict on an attempt, or the panel's final one. */
export interface Vote {
  label?: string;
  verdict?: string;
  reason?: string;
  /** What it found wrong, listed before its verdict; missing from reviews written before. */
  problems?: string[];
  error?: string;
}

export interface Slice {
  dimension: string;
  value: string;
  tasks: number;
  models: Record<string, Summary>;
}

export interface Report {
  generated_at: string;
  run: {
    run_id: string;
    created_at: string;
    attempts: number;
    /** Tries per attempt; missing on runs from before tries, which had one. */
    tries?: number;
    tasks?: string[];
    /** "pi", or "claude-code" (every run from before Pi). */
    harness?: string;
    harness_version?: string;
    /** `review`: the judges only review, beside the tests. Without it (runs from before), solved also needed their pass. */
    judge?: { model?: string; effort?: string; label?: string; panel?: { label: string }[]; chair?: { label: string } | null; review?: boolean } | null;
    note?: string | null;
    status?: { phase?: string; detail?: string } | null;
    request?: { quick?: boolean; repos?: string[]; pulls?: Record<string, number[]> } | null;
    commands?: Record<string, CommandsUsed>;
  };
  models: Model[];
  summary: Record<string, Summary>;
  slices: Slice[];
  timing?: Timing;
  tasks: Task[];
  trials: Trial[];
  complete: boolean;
}
