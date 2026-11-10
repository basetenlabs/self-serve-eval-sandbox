import { isActive, LiveDot } from "@/components/brand";
import { Tick } from "@/components/brand/icons";
import { pipeline } from "@/lib/stages";
import type { Run } from "@/lib/types";

/**
 * The run's five steps as brand columns. Done and current steps carry the solid rule; steps not
 * reached yet are dashed. The current step gets the Light Grey 2 "now" column behind it. On a phone
 * each step is one line: its name and its count.
 */
export function Pipeline({ run }: { run: Run }) {
  const steps = pipeline(run);
  // A run that failed or stopped won't reach its remaining steps, so they read "–", not "Not yet".
  const active = isActive(run.phase);
  return (
    <ol className="ev-pipeline" aria-label="Run steps">
      {steps.map((s, i) => (
        <li key={s.key} data-state={s.state} aria-current={s.state === "now" ? "step" : undefined}>
          <div className="head">
            <span className="flex items-center gap-2"><span className="bt-numeral">{String(i + 1).padStart(2, "0")}</span>{s.title}</span>
            {s.state === "done" ? <span className="tick" aria-label="Done"><Tick /></span> : s.state === "now" ? <LiveDot /> : null}
          </div>
          <div className="what">{s.what}</div>
          <div className="count">{s.count ?? (s.state === "todo" && (active || run.phase === "done") ? "Not yet" : "–")}</div>
        </li>
      ))}
    </ol>
  );
}
