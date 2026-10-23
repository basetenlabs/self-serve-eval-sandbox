// What people paste to name pull requests: a repository, or links to pull requests.
// The server parses them again (app.parse_repo, tasks.parse_pull); this only shapes the form.

const PULL = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\/pulls?\/|#)(\d+)(?:[/?#].*)?$/;
const REPO = /^(?:(?:https?:\/\/|git@)?(?:www\.)?github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

export interface Pasted {
  /** Exact pull requests, by repository, in the order they were pasted. */
  pulls: Record<string, number[]>;
  /** Repositories named without a pull request. */
  repos: string[];
  /** Anything that is neither. */
  unknown: string[];
}

export function parsePasted(text: string): Pasted {
  const out: Pasted = { pulls: {}, repos: [], unknown: [] };
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const pull = PULL.exec(token);
    if (pull) {
      const list = (out.pulls[pull[1]] ??= []);
      if (!list.includes(Number(pull[2]))) list.push(Number(pull[2]));
      continue;
    }
    const repo = REPO.exec(token);
    if (repo && !out.repos.includes(repo[1])) out.repos.push(repo[1]);
    else if (!repo) out.unknown.push(token);
  }
  return out;
}

export const pullCount = (pulls: Record<string, number[]>) => Object.values(pulls).reduce((n, l) => n + l.length, 0);
