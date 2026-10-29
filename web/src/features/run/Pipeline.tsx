import { CheckIcon } from "lucide-react";
import { isActive, LiveDot } from "@/components/brand";
import { pipeline } from "@/lib/stages";
import type { Run } from "@/lib/types";
import { cn } from "@/lib/utils";

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
    <ol className="grid gap-x-1 sm:grid-cols-3 sm:gap-y-4 lg:grid-cols-5" aria-label="Run steps">
      {steps.map((s, i) => (
        <li
          key={s.key}
          aria-current={s.state === "now" ? "step" : undefined}
          className={cn(
            "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 transition-colors duration-500 sm:block sm:pt-3 sm:pb-4",
            s.state === "todo" ? "border-t border-dashed border-line" : "border-t border-column-rule",
            s.state === "now" && "bg-node",
          )}
        >
          <div className="flex items-center gap-2 sm:justify-between">
            <span className={cn("label-mono", s.state === "todo" ? "text-muted-foreground" : "text-foreground")}>
              {String(i + 1).padStart(2, "0")} · {s.title}
            </span>
            {s.state === "done" ? (
              <span className="grid size-4 place-items-center bg-primary text-primary-foreground" aria-label="Done"><CheckIcon className="size-3" strokeWidth={3} /></span>
            ) : s.state === "now" ? <LiveDot className="size-2" /> : null}
          </div>
          <div className="mt-1.5 text-[13px] leading-snug text-muted-foreground max-sm:hidden">{s.what}</div>
          <div className={cn("num text-[15px] leading-6 sm:mt-3 sm:text-[18px]", s.state === "todo" && !s.count && "text-muted-foreground")}>
            {s.count ?? (s.state === "todo" && (active || run.phase === "done") ? "Not yet" : "–")}
          </div>
        </li>
      ))}
    </ol>
  );
}
