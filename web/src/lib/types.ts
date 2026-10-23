// Shapes of what `pr-eval serve` returns (/api/state) and what report.py writes (report.json).

export type Kind = "open" | "closed";

export interface Model {
  key: string;
  label: string;
  kind?: Kind | null;
  provider?: string;
}

// ---------- /api/state ----------

export interface CatalogModel extends Model {
  missing?: string | null;
  default?: boolean;
  cost_per_attempt?: number;
  seconds_per_attempt?: number;
}

export interface Checks {
  blaxel: boolean;
  blaxel_problem?: string | null;
  bl_cli: boolean;
  gh: boolean;
  image: boolean;
  judge: { model: string; effort?: string | null; env: string; ok: boolean; problem?: string | null };
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
  judge?: string | null;
}

export interface BoardRow {
  id: string;
  repo: string;
  pr: number | string;
  title: string;
  language: string;
  url?: string;
  lines?: number;
  check: { stage: CheckStage; why?: string; at?: string };
  cells: Cell[];
}

export interface Board {
  rows: BoardRow[];
  sandboxes: number;
  concurrency?: number | null;
}

export interface RunSummary {
  pass_at_1: number | null;
  solved: number;
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
  board?: Board;
}

export interface AppState {
  checks: Checks;
  models: CatalogModel[];
  runs: Run[];
  sample: { tasks: number; repos: number };
  quick: { tasks: number; repos: number };
  default_limit: number;
  max_limit: number;
  busy: boolean;
}

export interface RepoInfo {
  repo?: string;
  language?: string;
  private?: boolean;
  defaults?: boolean;
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

export interface Trial {
  trial: string;
  task_id: string;
  model: string;
  attempt: number;
  outcome: Outcome;
  invalid_reason?: string | null;
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
  judge?: { verdict?: string; reason?: string; error?: string } | null;
  patch?: string | null;
  verifier_tail?: string | null;
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
    tasks?: string[];
    harness_version?: string;
    judge?: { model?: string; effort?: string } | null;
    note?: string | null;
    request?: { quick?: boolean; repos?: string[] } | null;
  };
  models: Model[];
  summary: Record<string, Summary>;
  slices: Slice[];
  timing?: Timing;
  tasks: Task[];
  trials: Trial[];
  complete: boolean;
}
