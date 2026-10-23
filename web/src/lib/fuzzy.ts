// Fuzzy finding over pull requests already on the page: "ctx bind" finds "Context binding",
// "4203" or "#42" finds #4203. A word's letters must fall in order inside one word of the
// title, from its start. GitHub's own search (usePulls `words`) covers the rest.

export interface Match {
  score: number;
  /** Positions in the title to highlight. */
  hits: number[];
}

/** How well `query` matches a pull request, or null if one of its words doesn't. */
export function match(query: string, pull: { number: number; title: string; author?: string | null }): Match | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const title = pull.title.toLowerCase();
  const author = (pull.author ?? "").toLowerCase();
  let score = 0;
  const hits: number[] = [];
  for (const raw of words) {
    const digits = /^#?(\d+)$/.exec(raw);
    if (digits && String(pull.number).startsWith(digits[1])) { score += 100 + digits[1].length * 10; continue; }
    const word = raw.replace(/^#/, "");
    if (!word) continue;
    const at = title.indexOf(word);
    if (at >= 0) {
      score += 20 + word.length * 2 + (at === 0 || /\W/.test(title[at - 1]) ? 10 : 0);
      for (let i = 0; i < word.length; i++) hits.push(at + i);
      continue;
    }
    if (author.startsWith(word)) { score += 15; continue; }
    const loose = abbreviation(word, title);
    if (!loose) return null;
    score += loose.score;
    hits.push(...loose.hits);
  }
  return { score, hits };
}

/** `word` as an abbreviation of one word in `text` ("ctx" in "context"): its first letter starts
 * that word and the rest follow in order within it. The tightest such word wins. */
function abbreviation(word: string, text: string): Match | null {
  let best: Match | null = null;
  for (const w of text.matchAll(/[a-z0-9]+/g)) {
    if (w[0][0] !== word[0]) continue;
    const hits = [w.index];
    for (let i = 1, from = 1; i < word.length; i++, from++) {
      from = w[0].indexOf(word[i], from);
      if (from < 0) break;
      hits.push(w.index + from);
    }
    if (hits.length < word.length) continue;
    const score = 8 + word.length * 2 - (hits[hits.length - 1] - hits[0] - word.length + 1) * 0.5;
    if (!best || score > best.score) best = { score, hits };
  }
  return best;
}
