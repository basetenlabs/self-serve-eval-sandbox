import { ArrowLeftIcon, MoonIcon, SunIcon } from "lucide-react";
import * as React from "react";
import { BasetenLogo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toast";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { ReportHeader, Results, Tasks } from "@/features/report/ReportView";
import { useTheme } from "@/lib/hooks";
import type { Report } from "@/lib/types";

/** A run's report as one shareable page: it works from disk, offline, with the data inside it. */
export function ReportApp({ report }: { report: Report }) {
  const [theme, toggleTheme] = useTheme();
  // A PR opened from the head-to-head and one opened in the tasks table share one sheet.
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const served = location.protocol.startsWith("http"); // opened through pr-eval serve, not from disk
  return (
    <TooltipProvider>
      <Toaster>
        <div className="min-h-screen">
          <header className="sticky top-0 z-30 border-b border-dashed border-rule bg-background/85 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-4 px-4 sm:px-6 md:guide-x md:px-8">
              <BasetenLogo className="h-[22px] w-auto" />
              <span className="h-5 w-px bg-rule" aria-hidden />
              <span className="label-mono text-[12px] whitespace-nowrap">Eval Sandbox</span>
              <span className="label-mono hidden truncate text-muted-foreground sm:inline">▪ Report ▪ {report.run.run_id}</span>
              <div className="ml-auto flex items-center gap-2">
                {served && (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/#/runs/${encodeURIComponent(report.run.run_id)}`}><ArrowLeftIcon className="size-3.5" />All runs</a>
                  </Button>
                )}
                <Tip content={theme === "dark" ? "Light theme" : "Dark theme"}>
                  <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
                    {theme === "dark" ? <SunIcon /> : <MoonIcon />}
                  </Button>
                </Tip>
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-[1320px] md:guide-x">
            <section className="px-4 pt-12 pb-10 sm:px-6 md:px-8">
              <ReportHeader report={report} />
            </section>
            <section className="border-t border-dashed border-rule px-4 py-12 sm:px-6 md:px-8">
              <Results report={report} onOpen={setTaskId} />
            </section>
            <section className="border-t border-dashed border-rule px-4 py-12 sm:px-6 md:px-8">
              <Tasks report={report} openId={taskId} onOpen={setTaskId} />
            </section>
          </main>
          <footer className="border-t border-dashed border-rule">
            <div className="mx-auto flex max-w-[1320px] flex-wrap justify-between gap-3 px-4 py-6 sm:px-6 md:guide-x md:px-8">
              <span className="label-mono text-muted-foreground">Baseten ▪ Eval Sandbox</span>
              <span className="label-mono text-muted-foreground">
                Generated {new Date(report.generated_at).toLocaleString()} ▪ data in report.json next to this file
              </span>
            </div>
          </footer>
        </div>
      </Toaster>
    </TooltipProvider>
  );
}
