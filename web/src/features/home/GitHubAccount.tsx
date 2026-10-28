import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import type { Checks, GitHubAccount as Account } from "@/lib/types";
import { cn } from "@/lib/utils";

type Device = { user_code: string; verification_uri: string; interval: number };
type Poll = { pending?: boolean; interval?: number; login?: string | null; error?: string };

/** Whose GitHub reads your repositories. Hosted, you sign in with GitHub's device code; locally, the `gh` CLI's login. */
export function GitHubAccount({ github, checks, onChange }: { github: Account; checks: Checks; onChange: () => void }) {
  const toast = useToast();
  const [device, setDevice] = React.useState<Device | null>(github.device ?? null); // a reload picks the code back up
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const report = React.useRef(onChange);
  report.current = onChange;

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
        if (res.error) setError(res.error);
        else { toast("Signed in with GitHub", { body: res.login ? `as @${res.login}` : undefined }); report.current(); }
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
    if (res.error || !res.user_code) setError(res.error ?? "GitHub didn't start a sign-in.");
    else setDevice(res);
  }

  async function signOut() {
    await post("/api/github/sign-out");
    report.current();
  }

  const copy = () => {
    if (!device) return;
    void navigator.clipboard?.writeText(device.user_code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
  };

  let body: React.ReactNode;
  if (!github.sign_in) {
    body = checks.gh_login
      ? <span><b className="font-medium">@{checks.gh_login}</b> <span className="text-muted-foreground">through the GitHub CLI on this machine</span></span>
      : <span className="text-muted-foreground">The GitHub CLI here isn't signed in. Run <code className="font-mono text-[12px] text-foreground">gh auth login</code> to read private repositories.</span>;
  } else if (github.login) {
    body = (
      <>
        <span className="min-w-0 flex-1"><b className="font-medium">@{github.login}</b> <span className="text-muted-foreground">· your private repositories and runs stay yours</span></span>
        {github.install && (
          <Button asChild size="sm" variant="ghost">
            <a href={github.install} target="_blank" rel="noreferrer">Choose repositories <ExternalLinkIcon /></a>
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
      </>
    );
  } else if (device) {
    body = (
      <span className="grid min-w-0 flex-1 gap-2">
        <span className="text-muted-foreground">Enter this code on GitHub, then approve Baseten Eval Sandbox.</span>
        <span className="flex flex-wrap items-center gap-2">
          <output aria-label="Sign-in code" className="bg-node px-2.5 py-1 font-mono text-[18px] tracking-[0.18em] select-all">{device.user_code}</output>
          <Button type="button" size="sm" variant="ghost" onClick={copy} aria-label="Copy the code">
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
          </Button>
          <Button asChild size="sm">
            <a href={device.verification_uri} target="_blank" rel="noreferrer" onClick={copy}>Open GitHub <ExternalLinkIcon /></a>
          </Button>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground" aria-live="polite">
            <LoaderIcon className="size-3.5 animate-spin" /> Waiting for you to approve
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDevice(null)}>Cancel</Button>
        </span>
      </span>
    );
  } else {
    body = (
      <>
        <span className="min-w-0 flex-1 text-muted-foreground">Sign in to pick from your private repositories. Public ones work without it.</span>
        <Button type="button" size="sm" onClick={signIn} disabled={busy}>
          {busy ? <LoaderIcon className="animate-spin" /> : <GitHubMark />} Sign in with GitHub
        </Button>
      </>
    );
  }
  return (
    <div className="grid gap-2">
      <div className={cn("flex min-h-9 flex-wrap gap-x-3 gap-y-2 text-[13px]", device ? "items-start" : "items-center")}>
        <GitHubMark className={cn("size-4 shrink-0", device && "mt-0.5")} />
        {body}
      </div>
      {error && <p role="alert" className="text-[12.5px] text-[#AC0EB2] dark:text-[#FFA9FD]">{error}</p>}
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
