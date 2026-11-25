import { Column, LiveDot } from "@/components/brand";
import { cap, clock, plural, secondsSince } from "@/lib/format";
import { setupCount } from "@/lib/stages";
import type { SetupProgress, SetupTry } from "@/lib/types";

/** Who proposed a try's commands, in a few words. */
export const proposer = (by: string) =>
  by === "default" ? "Its default commands" : by === "guess" ? "A guess from its files" : `${by}'s commands`;

/** How a try went, in a few words. */
export function outcome(t: SetupTry): string {
  if (!t.step) return "Trying";
  if (t.step === "passed") return "✓ Passed";
  if (t.step === "setup") return "✕ Install failed";
  if (t.step === "apply") return "✕ The PR didn't apply";
  if (t.step === "tests") return "✕ Tests failed";
  return "✕ Sandbox failed";
}

/**
 * Working out a repository's install and test commands, try by try: what a run with no saved
 * commands does before any pull request is checked, and why the board waits. A run that stopped
 * here keeps the list, so its tries say what didn't work.
 */
export function Setup({ setup, now, live }: { setup: SetupProgress; now: number; live: boolean }) {
  const failed = setup.state === "failed";
  const last = setup.tries.at(-1);
  const running = live && !!last && !last.step;
  const end = live ? now : new Date(setup.finished_at ?? setup.started_at).getTime();
  return (
    <Column
      heading={failed ? "Setup failed" : "Setup"}
      aside={
        <span className="label-xs text-muted-foreground">
          {failed ? plural(setup.tries.length, "try", "tries") : setupCount(setup)} · {clock(secondsSince(setup.started_at, end))}
        </span>
      }
      aria-live="polite"
    >
      <p className="max-w-[70ch] text-[16px] leading-snug text-black">
        {failed ? "Couldn't work out how to install and test " : "Working out how to install and test "}
        <span className="ev-code text-[14px]">{setup.repo}</span>, on #{setup.pr}.
      </p>
      <p className="mt-2 max-w-[70ch] text-[14px] text-muted-foreground">
        {failed
          ? "Each try installed the repository in a fresh sandbox and ran one pull request's tests. Give the install and test commands on the form and run again."
          : `This repository has no saved commands, so the run works them out before checking any pull request. Each try installs it in a fresh sandbox and runs one pull request's tests. Unusual stacks take a few tries, up to ${setup.of}; the board starts as soon as one passes, and later runs on this repository skip this step.`}
      </p>
      <ol className="mt-6 grid border-t border-lightGrey2" aria-label="Setup tries">
        {setup.tries.map((t) => <Try key={t.n} t={t} now={now} live={live} />)}
        {live && !running && setup.now && (
          <li className="flex items-baseline gap-3 border-b border-lightGrey2 py-3 text-[14px] text-body">
            <LiveDot className="-translate-y-0.5" />
            <span className="min-w-0 break-words">{cap(setup.now)}</span>
          </li>
        )}
      </ol>
    </Column>
  );
}

function Try({ t, now, live }: { t: SetupTry; now: number; live: boolean }) {
  const seconds = t.seconds ?? (live ? secondsSince(t.started_at, now) : null);
  return (
    <li className="grid gap-1 border-b border-lightGrey2 py-3 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-4">
      <span className="label-xs pt-1 text-black">Try {t.n}</span>
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
          <span className="inline-flex items-center gap-2 text-black">{!t.step && live && <LiveDot />}{outcome(t)}</span>
          <span className="text-muted-foreground">{proposer(t.by)}</span>
          {seconds != null && <span className="num font-mono text-[12px] text-muted-foreground">{clock(seconds)}</span>}
        </div>
        <code className="ev-code break-all text-muted-foreground">{t.setup}</code>
        {t.error && <span className="break-words text-[13px] text-body">{t.error}</span>}
      </div>
    </li>
  );
}
