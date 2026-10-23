import { CheckIcon } from "lucide-react";
import { LiveDot } from "@/components/brand";
import { pipeline } from "@/lib/stages";
import type { Run } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The run's five steps as brand columns. Done and current steps carry the solid rule; steps not
 * reached yet are dashed. The current step gets the Light Grey 2 "now" column behind it.
 */
export function Pipeline({ run }: { run: Run }) {
  const steps = pipeline(run);
  return (
    <ol className="grid grid-cols-2 gap-x-1 gap-y-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Run steps">
      {steps.map((s, i) => (
        <li
          key={s.key}
          aria-current={s.state === "now" ? "step" : undefined}
          className={cn(
            "relative px-3 pt-3 pb-4 transition-colors duration-500",
            s.state === "todo" ? "border-t border-dashed border-line" : "border-t border-column-rule",
            s.state === "now" && "bg-node",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={cn("label-mono", s.state === "todo" ? "text-muted-foreground" : "text-foreground")}>
              {String(i + 1).padStart(2, "0")} · {s.title}
            </span>
            {s.state === "done" ? (
              <span className="grid size-4 place-items-center bg-primary text-primary-foreground" aria-label="Done"><CheckIcon className="size-3" strokeWidth={3} /></span>
            ) : s.state === "now" ? <LiveDot className="size-2" /> : null}
          </div>
          <div className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{s.what}</div>
          <div className={cn("num mt-3 text-[18px] leading-6", s.state === "todo" && !s.count && "text-muted-foreground")}>
            {s.count ?? (s.state === "todo" ? "Not yet" : "–")}
          </div>
        </li>
      ))}
    </ol>
  );
}
