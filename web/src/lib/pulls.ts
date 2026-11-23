import type { PullRow } from "./types";

/** What a pull request is, from its title: a security change, a fix, a feature, or something else. */
export type Kind = "security" | "fix" | "feature" | "other";
export const KIND_LABEL: Record<Kind, string> = { security: "Security", fix: "Fix", feature: "Feature", other: "Other" };

const SECURITY = /^(sec|security)(\(.*?\))?!?:|\b(security|secure|insecure|vulnerab\w*|cve-\d+|ghsa-[\w-]+|xss|csrf|ssrf|redos|injection|traversal|spoof\w*|sanitiz\w*|exploit\w*|auth[nz]?|authenticat\w*|authoriz\w*|permissions?|privileges?|secrets?|credentials?|cors|csp|untrusted|unsafe|escap(e|es|ed|ing))\b/i;
const FIX_PREFIX = /^(fix|bugfix|hotfix|revert)(\(.*?\))?!?:/i;
const FEATURE_PREFIX = /^feat(ure)?(\(.*?\))?!?:/i;
const FIX = /\b(fix(es|ed|ing)?|bugs?|crash(es|ing)?|regressions?|broken|wrong|incorrect(ly)?|handle[sd]?|prevent(s|ed)?|avoid(s|ed)?|ensure[sd]?|preserve[sd]?|honou?r(s|ed)?|respect(s|ed)?|must not|do not|don't|no longer|missing|leak(s|ed)?|panic(s|ked)?|races?|deadlock|overflow|nil|null|typo|properly|correct(ly)?)\b/i;
const FEATURE = /\b(add(s|ed)?|support(s)?|implement(s|ed)?|introduce(s|d)?|new|allow(s)?|enable(s)?|expose[sd]?|options?|configurable)\b/i;

/** Security words win; then a conventional-commit prefix (fix:, feat:); then the words in the title. */
export function kindOf(title: string): Kind {
  if (SECURITY.test(title)) return "security";
  if (FIX_PREFIX.test(title)) return "fix";
  if (FEATURE_PREFIX.test(title)) return "feature";
  return FIX.test(title) ? "fix" : FEATURE.test(title) ? "feature" : "other";
}

// Smaller changes are the ones a model can finish in one attempt: the mix takes them first.
const EASY_LINES = 300;

/** Up to `n` pull requests that can be tasks, newest first: security changes, fixes and features taken in turn,
 *  small ones (up to EASY_LINES lines) before big ones, and anything else only to fill what is left. */
export function mix(rows: PullRow[], n: number): number[] {
  const usable = rows.filter((r) => !r.why && !r.maintenance);
  const small = (r: PullRow) => r.lines <= EASY_LINES;
  const of = (k: Kind, size: boolean) => usable.filter((r) => kindOf(r.title) === k && small(r) === size);
  const main: Kind[] = ["security", "fix", "feature"];
  const tiers = [main.map((k) => of(k, true)), [of("other", true)], main.map((k) => of(k, false)), [of("other", false)]];
  const out: number[] = [];
  for (const queues of tiers) {
    while (out.length < n && queues.some((q) => q.length)) {
      for (const q of queues) {
        const next = q.shift();
        if (next && out.length < n) out.push(next.number);
      }
    }
  }
  return out;
}

/** "3 security, 4 fixes, 3 features": what a set of pull requests is made of. */
export function mixLabel(rows: PullRow[], chosen: number[]): string {
  const counts: Record<Kind, number> = { security: 0, fix: 0, feature: 0, other: 0 };
  for (const n of chosen) {
    const r = rows.find((x) => x.number === n);
    if (r) counts[kindOf(r.title)]++;
  }
  const words: [Kind, string, string][] = [["security", "security", "security"], ["fix", "fix", "fixes"], ["feature", "feature", "features"], ["other", "other", "other"]];
  return words.filter(([k]) => counts[k]).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`).join(", ");
}
