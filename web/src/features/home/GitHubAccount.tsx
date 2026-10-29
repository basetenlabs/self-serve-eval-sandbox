import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import type { Checks, GitHubAccount as Account } from "@/lib/types";
import { cn } from "@/lib/utils";

type Device = { user_code: string; verification_uri: string; interval: number };
type Poll = { pending?: boolean; interval?: number; login?: string | null; error?: string };

const link = "font-medium underline decoration-rule underline-offset-4 transition-colors hover:decoration-foreground";

/** Whose GitHub reads your repositories. Hosted, you sign in with GitHub's device code; locally, the `gh` CLI's login. */
export function GitHubAccount({ github, checks, onChange }: { github: Account; checks: Checks; onChange: () => void }) {
  const toast = useToast();
  const [device, setDevice] = React.useState<Device | null>(github.device ?? null); // a reload picks the code back up
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [opened, setOpened] = React.useState(false);
  const [approved, setApproved] = React.useState<string | null>(null); // shown until the page's state catches up
  const report = React.useRef(onChange);
  report.current = onChange;
  React.useEffect(() => { if (github.login) setApproved(null); }, [github.login]);

  // While the code is up, ask the page whether GitHub has approved it, as often as GitHub allows.
  React.useEffect(() => {
    if (!device) return;
    let timer: number | undefined;
    let live = true;
    const ask = (seconds: number) => {
      timer = window.setTimeout(async () => {
        const res = await post<Poll>("/api/github/poll");
        if (!live) return;
        if (res.pending) return ask(res.interval ?? seconds);
        setDevice(null);
        setOpened(false);
        if (res.error) setError(res.error);
        else {
          setApproved(res.login ?? "");
          toast("Signed in with GitHub", { body: res.login ? `as @${res.login}` : undefined });
          report.current();
        }
      }, seconds * 1000);
    };
    ask(device.interval);
    return () => { live = false; window.clearTimeout(timer); };
  }, [device, toast]);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await post<Device & { error?: string }>("/api/github/device");
    setBusy(false);
    if (res.error || !res.user_code) setError(res.error ?? "GitHub didn't start a sign-in. Try again.");
    else setDevice(res);
  }

  async function signOut() {
    setApproved(null);
    await post("/api/github/sign-out");
    report.current();
  }

  function cancel() {
    setDevice(null);
    setOpened(false);
    void post("/api/github/sign-out"); // drops the waiting code too, so a reload doesn't bring it back
  }

  const copy = () => {
    if (!device) return;
    void navigator.clipboard?.writeText(device.user_code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
  };

  const login = github.login ?? (github.sign_in && !device ? approved : null);
  let body: React.ReactNode;
  if (!github.sign_in) {
    body = checks.gh_login
      ? <span className="min-w-0 flex-1"><b className="font-medium">@{checks.gh_login}</b> <span className="text-muted-foreground">· through the GitHub CLI on this machine</span></span>
      : <span className="min-w-0 flex-1 text-muted-foreground">The GitHub CLI here isn't signed in. Run <code className="font-mono text-[12px] text-foreground">gh auth login</code> to read private repositories.</span>;
  } else if (login !== null) {
    body = (
      <>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
          <CheckIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            Signed in{login ? <> as <b className="font-medium">@{login}</b></> : ""}
            <span className="text-muted-foreground"> · your private repositories and their runs stay yours</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-4">
          {github.install && (
            <a className={cn(link, "inline-flex items-center gap-1")} href={github.install} target="_blank" rel="noreferrer">
              Repository access <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
          <button type="button" className={cn(link, "text-muted-foreground hover:text-foreground")} onClick={signOut}>Sign out</button>
        </span>
      </>
    );
  } else if (device) {
    body = (
      <span className="grid min-w-0 flex-1 gap-3">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-medium">Enter this code on GitHub</span>
          <button type="button" className={cn(link, "text-[12.5px] font-normal text-muted-foreground hover:text-foreground")} onClick={cancel}>Cancel</button>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <output aria-label="Sign-in code" className="num bg-node px-3 py-1 font-mono text-[24px] leading-8 font-medium tracking-[0.16em] select-all">{device.user_code}</output>
          <Button type="button" variant="outline" className="h-10" onClick={copy} aria-label="Copy the code">
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
          </Button>
          <Button asChild className="h-10">
            <a href={device.verification_uri} target="_blank" rel="noreferrer" onClick={() => { copy(); setOpened(true); }}>Open GitHub <ExternalLinkIcon /></a>
          </Button>
        </span>
        <ol className="label-mono flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
          {["Open GitHub", "Paste the code", "Approve Baseten Eval Sandbox"].map((step, i) => (
            <li key={step} className={cn("inline-flex items-center gap-1.5", i === (opened ? 1 : 0) && "text-foreground")}>
              {opened && i === 0 ? <CheckIcon className="size-3" /> : `${String(i + 1).padStart(2, "0")} ·`} {step}
            </li>
          ))}
        </ol>
        <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground" aria-live="polite">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse-dot bg-foreground" />
          {opened ? "Code copied. Paste it on GitHub and approve; this page signs you in by itself." : "Waiting for you to approve on GitHub."}
        </span>
      </span>
    );
  } else {
    body = (
      <>
        <span className="min-w-0 flex-1">
          Private repository? <span className="text-muted-foreground">Sign in so the page can read it. Public ones work without it.</span>
        </span>
        <Button type="button" size="sm" variant="outline" onClick={signIn} disabled={busy}>
          {busy ? <LoaderIcon className="animate-spin" /> : <GitHubMark />} {busy ? "Asking GitHub" : "Sign in with GitHub"}
        </Button>
      </>
    );
  }
  return (
    <div className="grid gap-2">
      <div className={cn("flex min-h-9 flex-wrap gap-x-3 gap-y-2 text-[13px]", device ? "items-start py-1" : "items-center")}>
        <GitHubMark className={cn("size-4 shrink-0", device && "mt-0.5")} />
        {body}
      </div>
      {error && <p role="alert" className="pl-7 text-[12.5px] text-[#AC0EB2] dark:text-[#FFA9FD]">{error}</p>}
    </div>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
