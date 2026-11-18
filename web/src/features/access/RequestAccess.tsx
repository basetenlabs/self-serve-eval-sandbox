import * as React from "react";
import { Column } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";

const URL = "/api/access-requests";
type Request = { id: string; target: string; reason?: string; requestedAt?: string; decidedAt?: string; decidedBy?: string; decisionMethod?: "direct" | "worker"; status: "pending" | "approved" | "denied" };
const statuses = { pending: ["Pending", "gold"], approved: ["Approved", "green"], denied: ["Denied", "pink"] };

export function RequestAccess({ invite }: { invite?: string }) {
  const [target, setTarget] = React.useState(invite ?? "");
  const [reason, setReason] = React.useState("");
  const [requests, setRequests] = React.useState<Request[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState("");
  const [loadError, setLoadError] = React.useState("");
  const revision = React.useRef(0);
  React.useEffect(() => {
    const abort = new AbortController();
    let timer: number;
    const refresh = async () => {
      const before = revision.current;
      try {
        const res = await fetch(URL, { cache: "no-store", signal: abort.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Requests could not be loaded.");
        if (!abort.signal.aborted && before === revision.current) {
          setRequests(body.requests);
          setEnabled(body.enabled);
          setLoaded(true);
          setLoadError("");
        }
      } catch (e) {
        if (!abort.signal.aborted) setLoadError(e instanceof Error ? e.message : "Requests could not be loaded.");
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(refresh, 15_000);
      }
    };
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-2">
      <Column heading="New request">
        <form className="grid content-start gap-4" onSubmit={async e => {
          e.preventDefault();
          setBusy(true);
          setProblem("");
          try {
            const row = await post<Request & { error?: string }>(URL, { target, reason });
            if (row.error) throw new Error(row.error);
            revision.current++;
            setRequests(rows => [row, ...rows.filter(r => r.id !== row.id)]);
            setTarget("");
            setReason("");
          } catch (e) { setProblem(e instanceof Error ? e.message : "The request could not be submitted."); }
          finally { setBusy(false); }
        }}>
          <label className="grid gap-2"><span className="label-xs">Email or domain</span>
            <Input value={target} onChange={e => setTarget(e.target.value)} placeholder="name@example.com or example.com" required maxLength={254} spellCheck={false} />
          </label>
          <label className="grid gap-2"><span className="label-xs">Reason for access</span>
            <textarea className="bt-input min-h-20" value={reason} onChange={e => setReason(e.target.value)} required maxLength={500} rows={2} />
          </label>
          <div><Button type="submit" disabled={!enabled || busy || !target.trim() || !reason.trim()}>{busy ? "Submitting…" : "Submit request"}</Button></div>
          {loaded && !enabled && <p className="ev-small">Access requests are not set up yet.</p>}
          {problem && <p role="alert" className="bt-notice error">{problem}</p>}
        </form>
      </Column>
      <Column heading="Your access history">
        {loadError && <p role="alert" className="bt-notice error">{loadError}</p>}
        {!loaded && !loadError && <p className="ev-small">Loading requests…</p>}
        {loaded && !requests.length && <p className="ev-small">No access requests yet.</p>}
        <ul aria-live="polite">{requests.map(r => {
          const when = r.decidedAt ?? r.requestedAt;
          return (
            <li key={r.id} className="grid gap-1 border-b border-lightGrey2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all">{r.target}</span>
                <span className={`bt-badge ${statuses[r.status][1]}`}>{statuses[r.status][0]}</span>
              </div>
              {r.reason && <span className="ev-small break-words">{r.reason}</span>}
              {r.decidedBy && <span className="ev-small break-words">{r.decisionMethod === "direct" ? "Added directly by" : "Reviewed via the approval worker by"} {r.decidedBy}</span>}
              {when && <time className="ev-small" dateTime={when}>{new Date(when).toLocaleString()}</time>}
            </li>
          );
        })}</ul>
      </Column>
    </div>
  );
}
