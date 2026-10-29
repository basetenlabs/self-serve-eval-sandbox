import { SearchIcon } from "lucide-react";
import * as React from "react";
import { Column, Swatch } from "@/components/brand";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tip } from "@/components/ui/tooltip";
import type { Swatch as SwatchT } from "@/lib/models";
import type { Model, Report, Task, Trial } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TaskSheet } from "./TaskSheet";

export type TrialsFor = (taskId: string, model: string) => Trial[];

/** Each task's attempts by model, in attempt order. */
export function useTrialsFor(report: Report): TrialsFor {
  const byTask = React.useMemo(() => {
    const map = new Map<string, Trial[]>();
    for (const t of report.trials) {
      const k = `${t.task_id}|${t.model}`;
      map.set(k, [...(map.get(k) ?? []), t].sort((a, b) => a.attempt - b.attempt));
    }
    return map;
  }, [report.trials]);
  return React.useCallback((taskId, model) => byTask.get(`${taskId}|${model}`) ?? [], [byTask]);
}

export function taskState(t: Task, models: Model[], trialsFor: TrialsFor) {
  const tried = models.map((m) => trialsFor(t.id, m.key));
  const solvedBy = tried.filter((ts) => ts.some((r) => r.outcome === "solved")).length;
  const ran = tried.filter((ts) => ts.some((r) => r.outcome !== "invalid")).length;
  return {
    split: solvedBy > 0 && solvedBy < ran,
    unsolved: ran > 0 && solvedBy === 0,
    invalid: tried.some((ts) => ts.some((r) => r.outcome === "invalid")),
  };
}

const SHOW = [
  { value: "split", label: "Models disagree" },
  { value: "unsolved", label: "Nobody solved" },
  { value: "invalid", label: "Has attempts not scored" },
];

/** Every task and how each model's attempts went; a task opens its attempts, diffs and verdicts.
 * The open task is the page's to keep (in its address) when it passes `onOpen`. */
export function TasksTable({ report, ranked, colors, openId: given, onOpen }: {
  report: Report; ranked: Model[]; colors: Record<string, SwatchT>; openId?: string | null; onOpen?: (id: string | null) => void;
}) {
  const [q, setQ] = React.useState("");
  const [lang, setLang] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [show, setShow] = React.useState("");
  const [ownId, setOwnId] = React.useState<string | null>(null);
  const openId = onOpen ? given ?? null : ownId;
  const setOpenId = onOpen ?? setOwnId;
  const tasks = report.tasks;
  const trialsFor = useTrialsFor(report);
  const languages = [...new Set(tasks.map((t) => t.language).filter(Boolean) as string[])].sort();
  const repos = [...new Set(tasks.map((t) => t.repo))].sort();
  const needle = q.trim().toLowerCase();
  const rows = tasks.filter((t) =>
    (!lang || t.language === lang) && (!repo || t.repo === repo) &&
    (!needle || `${t.title} ${t.repo} ${t.pr ?? ""}`.toLowerCase().includes(needle)) &&
    (!show || taskState(t, ranked, trialsFor)[show as "split" | "unsolved" | "invalid"]));
  const attempts = report.run.attempts || 1;
  const current = openId ? tasks.find((t) => t.id === openId) ?? null : null;

  return (
    <Column heading="Tasks" aside={<span className="label-mono text-muted-foreground">{rows.length} of {tasks.length}</span>}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, repo or PR" className="h-9 pl-9" aria-label="Search tasks" type="search" />
        </div>
        {languages.length > 1 && <Select label="Language" value={lang} onValueChange={setLang} allLabel="All languages" options={languages.map((l) => ({ value: l, label: l }))} />}
        {repos.length > 1 && <Select label="Repository" value={repo} onValueChange={setRepo} allLabel="All repositories" options={repos.map((r) => ({ value: r, label: r }))} className="max-w-64" />}
        <Select label="Show" value={show} onValueChange={setShow} allLabel="All tasks" options={SHOW} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Pip outcome="solved" fill={colors[ranked[0]?.key]?.fill} ink={colors[ranked[0]?.key]?.ink} small />Solved, in the model's colour</span>
        <span className="inline-flex items-center gap-1.5"><Pip outcome="failed" small />Not solved</span>
        <span className="inline-flex items-center gap-1.5"><Pip outcome="invalid" small />Not scored: setup, sandbox or provider trouble</span>
        <span className="inline-flex items-center gap-1.5"><Pip small />Not run yet</span>
      </div>
      <ul className="grid gap-px bg-frame shadow-[0_0_0_1px_var(--frame)] md:hidden" aria-label="Tasks">
        {rows.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpenId(t.id)} className="grid w-full gap-2 bg-surface p-3 text-left active:bg-muted">
              <span className="min-w-0">
                <span className="line-clamp-2 text-[14px] font-medium">{t.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted-foreground">
                  {t.repo} #{t.pr ?? ""}{t.language ? ` · ${t.language}` : ""}{t.size ? ` · ${t.lines_changed} lines` : ""}
                </span>
              </span>
              <span className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {ranked.map((m) => {
                  const ts = trialsFor(t.id, m.key);
                  return (
                    <span key={m.key} className="flex min-w-0 items-center gap-2">
                      <span className="flex shrink-0 gap-0.5">
                        {ts.map((r) => <Pip key={r.attempt} outcome={r.outcome} fill={colors[m.key]?.fill} ink={colors[m.key]?.ink} small />)}
                        {Array.from({ length: Math.max(0, attempts - ts.length) }, (_, k) => <Pip key={`p${k}`} small />)}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">{m.label}</span>
                    </span>
                  );
                })}
              </span>
            </button>
          </li>
        ))}
        {!rows.length && <li className="bg-surface py-10 text-center text-[14px] text-muted-foreground">No tasks match these filters.</li>}
      </ul>
      <div className="bg-surface shadow-[inset_0_0_0_1px_var(--frame)] max-md:hidden">
        <Table>
          <THead>
            <TR>
              <TH className="pl-4">Task</TH>
              <TH>Language</TH>
              <TH>Size</TH>
              {ranked.map((m) => {
                const s = report.summary[m.key];
                return (
                  <TH key={m.key} className="h-auto py-2 align-bottom">
                    <span className="flex items-center gap-2 text-foreground"><Swatch swatch={colors[m.key]} />{m.label}</span>
                    <span className="num mt-0.5 block font-sans text-[12px] tracking-normal normal-case">{s ? `${s.solved}/${s.valid} solved` : "Not run yet"}</span>
                  </TH>
                );
              })}
            </TR>
          </THead>
          <TBody>
            {rows.map((t) => (
              <TR
                key={t.id}
                tabIndex={0}
                onClick={() => setOpenId(t.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(t.id); } }}
                className="cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-offset-[-2px]"
              >
                <TD className="max-w-[360px] pl-4">
                  <div className="truncate font-medium" title={t.title}>{t.title}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{t.repo} #{t.pr ?? ""}</div>
                </TD>
                <TD><span className="label-mono text-[10.5px] text-muted-foreground">{t.language || "–"}</span></TD>
                <TD className="whitespace-nowrap text-[13px] text-muted-foreground">{t.size ? `${t.size} · ${t.lines_changed} lines` : "–"}</TD>
                {ranked.map((m) => {
                  const ts = trialsFor(t.id, m.key);
                  return (
                    <TD key={m.key}>
                      <div className="flex gap-0.5">
                        {ts.map((r) => (
                          <Tip key={r.attempt} content={`Attempt ${r.attempt}: ${r.outcome === "invalid" ? `not scored${r.invalid_reason ? ` (${r.invalid_reason})` : ""}` : r.outcome === "solved" ? "solved" : "not solved"}`}>
                            <span><Pip outcome={r.outcome} fill={colors[m.key]?.fill} ink={colors[m.key]?.ink} /></span>
                          </Tip>
                        ))}
                        {Array.from({ length: Math.max(0, attempts - ts.length) }, (_, k) => <Pip key={`p${k}`} />)}
                      </div>
                    </TD>
                  );
                })}
              </TR>
            ))}
            {!rows.length && (
              <TR><TD colSpan={3 + ranked.length} className="py-10 text-center text-muted-foreground">No tasks match these filters.</TD></TR>
            )}
          </TBody>
        </Table>
      </div>
      <TaskSheet task={current} report={report} ranked={ranked} colors={colors} trialsFor={trialsFor} onClose={() => setOpenId(null)} />
    </Column>
  );
}

const GLYPH = { solved: "✓", failed: "✕", invalid: "!" } as const;

export function Pip({ outcome, fill, ink, small }: { outcome?: keyof typeof GLYPH; fill?: string; ink?: string; small?: boolean }) {
  return (
    <span
      aria-label={outcome ?? "not run"}
      className={cn(
        "grid shrink-0 place-items-center font-mono leading-none",
        small ? "size-4 text-[10px]" : "size-6 text-[12px]",
        !outcome && "placeholder-cell",
        outcome === "failed" && "bg-node text-muted-foreground",
        outcome === "invalid" && "bg-[#FFEDC4] text-[#D5700B] dark:bg-[#2E261E] dark:text-[#FFBE4D]",
      )}
      style={outcome === "solved" ? { background: fill ?? "var(--baseten)", color: ink ?? "#000" } : undefined}
    >
      {outcome ? GLYPH[outcome] : ""}
    </span>
  );
}
