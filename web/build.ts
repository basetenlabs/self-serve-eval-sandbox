// The page and the report ship as two self-contained HTML files inside the Python package, so
// `pr-eval serve` needs no Node. Each carries a hash of the sources it was built from; the Python
// tests recompute it, so a change under web/ that wasn't rebuilt fails them.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const WEB = path.dirname(new URL(import.meta.url).pathname);
export const SOURCES = ["src", "index.html", "report.html", "vite.config.ts", "build.ts", "package-lock.json"];

function files(entry: string): string[] {
  const full = path.join(WEB, entry);
  if (statSync(full).isFile()) return [entry];
  return readdirSync(full).flatMap((name) => files(path.join(entry, name)));
}

/** sha256 over each source file's path and bytes, in sorted path order (same as the Python test). */
export function sourceHash(): string {
  const hash = createHash("sha256");
  for (const file of SOURCES.flatMap(files).map((f) => f.split(path.sep).join("/")).sort()) {
    hash.update(file).update("\0").update(readFileSync(path.join(WEB, file))).update("\0");
  }
  return hash.digest("hex");
}
