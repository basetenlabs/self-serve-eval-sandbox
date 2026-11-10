import * as React from "react";
import { BasetenLogo, LiveDot } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { href, type Route } from "@/lib/hooks";
import type { AppState } from "@/lib/types";

/** The page frame: the app bar on the texture, the page's White surfaces, and a one-line footer. */
export function Shell({ state, route, go, offline, children }: {
  state: AppState | null;
  route: Route;
  go: (r: Route) => void;
  offline: boolean;
  children: React.ReactNode;
}) {
  const live = state?.runs.find((r) => ["collecting", "checking", "running"].includes(r.phase));
  const sandboxes = live?.board?.sandboxes ?? 0;
  const run = route.page === "run" ? state?.runs.find((r) => r.id === route.id) : undefined;
  const home = (e: React.MouseEvent) => { e.preventDefault(); go({ page: "home" }); };

  return (
    <div className="bt-page ev-shell">
      <header className="bt-appbar">
        <a href="#/" onClick={home} className="logo" aria-label="Eval Sandbox home"><BasetenLogo /></a>
        <nav aria-label="Pages">
          <a href="#/" onClick={home} aria-current={route.page === "home" ? "page" : undefined}>Eval Sandbox</a>
          {route.page === "run" && (
            <a href={href({ page: "run", id: route.id })} aria-current="page" className="crumb">{run?.title ?? route.id}</a>
          )}
          {state?.admin && (
            <Tip content="Who can sign in: admins, invited people and whole domains">
              <a href={href({ page: "access" })} aria-current={route.page === "access" ? "page" : undefined}>Access</a>
            </Tip>
          )}
        </nav>
        <div className="end">
          {offline ? (
            <Badge variant="danger"><span aria-hidden className="ev-dot bad" />Page server unreachable</Badge>
          ) : live && !(route.page === "run" && route.id === live.id) ? (
            <a href={href({ page: "run", id: live.id })} className="bt-badge green no-underline max-sm:hidden">
              <LiveDot /> Run in progress{sandboxes > 0 && <span>· {sandboxes} sandboxes</span>}
            </a>
          ) : null}
          <SignOut />
        </div>
      </header>
      <main className="ev-main">{children}</main>
      <footer className="bt-footnote ev-foot">
        <span>Baseten Eval Sandbox</span>
        {state && !state.github.sign_in && <span className="max-sm:hidden">Also from a terminal: <code>pr-eval run --quick</code></span>}
      </footer>
    </div>
  );
}

type SignIn = {
  getSession(options: { redirect: boolean }): Promise<{ user: { email: string } } | null>;
  signOut(): Promise<void>;
  watchSession(): void;
};
// Served by the sign-in in front of the hosted page; locally there is none, and no Sign out.
const SIGN_IN = "/auth/client.js";

/** The hosted page's Sign out. It also sends the page to sign in again the moment the session ends. */
function SignOut() {
  const [signIn, setSignIn] = React.useState<{ client: SignIn; email: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    import(/* @vite-ignore */ SIGN_IN).then(async (client: SignIn) => {
      const session = await client.getSession({ redirect: false });
      if (!session) return;
      setSignIn({ client, email: session.user.email });
      client.watchSession();
    }).catch(() => {});
  }, []);
  if (!signIn) return null;
  return (
    <Tip content={error ?? `Signed in as ${signIn.email}`}>
      <Button variant="outline" onClick={() => signIn.client.signOut().catch((e: Error) => setError(e.message))}>
        Sign out
      </Button>
    </Tip>
  );
}
