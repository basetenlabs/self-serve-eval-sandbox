import * as React from "react";
import { BasetenLogo, Spacer, Surface } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReportHeader, Results, Tasks } from "@/features/report/ReportView";
import { useMotion } from "@/lib/motion";
import type { Report } from "@/lib/types";

/** A run's report as one shareable page: it works from disk, offline, with the data inside it. */
export function ReportApp({ report }: { report: Report }) {
  // A PR opened from the head-to-head and one opened in the tasks table share one sheet.
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const served = location.protocol.startsWith("http"); // opened through pr-eval serve, not from disk
  const page = React.useRef<HTMLDivElement>(null);
  useMotion(page); // the skill's markup hooks
  return (
    <TooltipProvider>
        <div className="bt-page ev-shell" ref={page}>
          <header className="bt-appbar">
            <span className="logo"><BasetenLogo /></span>
            <nav aria-label="Pages">
              {served ? <a href="/#/">Self-Serve Model Eval Sandbox</a> : <span className="text-[14px] text-faint">Self-Serve Model Eval Sandbox</span>}
              <a href="#" aria-current="page" className="crumb">Report</a>
            </nav>
            {served && (
              <div className="end">
                <Button asChild variant="outline">
                  <a href={`/#/runs/${encodeURIComponent(report.run.run_id)}`}>Open the run</a>
                </Button>
              </div>
            )}
          </header>
          <main className="ev-main">
            <Surface>
              <ReportHeader report={report} />
            </Surface>
            <Spacer />
            <Surface>
              <Results report={report} onOpen={setTaskId} />
            </Surface>
            <Spacer />
            <Surface>
              <Tasks report={report} openId={taskId} onOpen={setTaskId} />
            </Surface>
          </main>
          <footer className="bt-footnote ev-foot">
            <span>Self-Serve Model Eval Sandbox</span>
            <span className="max-sm:hidden">Generated {new Date(report.generated_at).toLocaleString()}. The data is in report.json next to this file.</span>
          </footer>
        </div>
    </TooltipProvider>
  );
}
