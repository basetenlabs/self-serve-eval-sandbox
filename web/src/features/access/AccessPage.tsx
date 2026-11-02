import { XIcon } from "lucide-react";
import * as React from "react";
import { Empty, Eyebrow } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import { plural } from "@/lib/format";

// Hosted only: the sign-in server in front of the page answers /api/admin/access, checks that you are
// an admin on every request, checks each entry with the sign-in's rules and writes the list.
const URL = "/api/admin/access";

type ListName = "admins" | "emails" | "domains";
type Access = { admins: string[]; emails: string[]; domains: string[]; you: string; error?: string };

const LISTS: { key: ListName; title: string; text: string; placeholder: string }[] = [
  { key: "admins", title: "Admins", text: "Can sign in, see every run and change this page. The last admin can't be removed.", placeholder: "name@company.com" },
  { key: "emails", title: "Invited people", text: "One address each, at any domain, including Gmail and other public mail.", placeholder: "name@partner.com" },
  { key: "domains", title: "Whole domains", text: "Everyone with a verified address at exactly this domain, never its subdomains. Public mail domains aren't allowed.", placeholder: "company.com" },
];

/** Who may sign in to the hosted page: admins, invited addresses and whole domains. Changes apply at once. */
export function AccessPage({ invite }: { invite?: string }) {
  const [access, setAccess] = React.useState<Access | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch(URL, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Access;
        if (res.ok) setAccess(body);
        else setError(body.error ?? `The page answered ${res.status}.`);
      })
      .catch(() => setError("The access list didn't load. Reload to try again."));
  }, []);

  return (
    <section className="px-4 py-10 sm:px-6 md:px-8">
      <Eyebrow parts={["Admin", "Sign-in"]} />
      <h1 className="mt-4 text-[32px] leading-tight tracking-[-0.03em]">Who can sign in</h1>
      <p className="mt-3 max-w-[66ch] text-[15px] leading-relaxed text-muted-foreground">
        A Blaxel account with a verified email gets in when it is on one of these lists. Changes apply at once:
        someone you remove is signed out on their next request. Everyone sees only their own runs; admins see every run.
      </p>
      {invite && access && !access.emails.includes(invite.toLowerCase()) && !access.admins.includes(invite.toLowerCase()) && (
        <div role="status" className="mt-8 max-w-[66ch] bg-surface px-4 py-3 text-[14px] shadow-[inset_2px_0_0_var(--foreground)]">
          <span className="font-mono text-[13px]">{invite}</span> asked for access. Their address is filled in under Invited people: press Add to let them in.
        </div>
      )}
      <div className="mt-10">
        {error ? <Empty title="Not available">{error}</Empty>
          : !access ? <div className="h-64 animate-pulse bg-node" aria-busy />
            : (
              <div className="grid gap-10 lg:grid-cols-3 lg:gap-8">
                {LISTS.map((list) => <List key={list.key} list={list} access={access} onChange={setAccess} prefill={list.key === "emails" ? invite : undefined} />)}
              </div>
            )}
      </div>
    </section>
  );
}

function List({ list, access, onChange, prefill }: {
  list: (typeof LISTS)[number]; access: Access; onChange: (a: Access) => void; prefill?: string;
}) {
  const toast = useToast();
  // A request's link fills in the invite list only while that address isn't on it yet.
  const [value, setValue] = React.useState(() => prefill && !access[list.key].includes(prefill.toLowerCase()) ? prefill : "");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const entries = access[list.key];

  const change = async (entry: string, remove: boolean) => {
    setBusy(true);
    setProblem(null);
    const res = await post<Access>(URL, { list: list.key, value: entry, remove });
    setBusy(false);
    if (res.error) {
      if (remove) toast("Couldn't remove it", { body: res.error, tone: "danger" });
      else setProblem(res.error);
      return false;
    }
    onChange(res);
    return true;
  };

  return (
    <div className="column-rule grid content-start gap-4 pt-2.5">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="label-mono text-foreground">{list.title}</h2>
          <span className="label-mono text-muted-foreground">{plural(entries.length, list.key === "domains" ? "domain" : "address", list.key === "domains" ? "domains" : "addresses")}</span>
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{list.text}</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (value.trim() && await change(value.trim(), false)) setValue("");
        }}
      >
        <Input
          value={value}
          onChange={(e) => { setValue(e.target.value); setProblem(null); }}
          placeholder={list.placeholder}
          aria-label={`Add to ${list.title.toLowerCase()}`}
          aria-invalid={!!problem}
          autoComplete="off"
          autoFocus={!!prefill && value === prefill}
          spellCheck={false}
        />
        <Button type="submit" variant="outline" disabled={busy || !value.trim()}>Add</Button>
      </form>
      {problem && <p role="alert" className="text-[12.5px] text-[#AC0EB2] dark:text-[#FFA9FD]">{problem}</p>}
      {entries.length ? (
        <ul className="bg-surface shadow-[inset_0_0_0_1px_var(--frame)]">
          {entries.map((entry) => {
            const last = list.key === "admins" && entries.length === 1;
            return (
              <li key={entry} className="flex items-center justify-between gap-3 border-b border-frame py-1.5 pr-1.5 pl-3 text-[14px] last:border-0">
                <span className="min-w-0 truncate font-mono text-[13px]">
                  {list.key === "domains" ? `@${entry}` : entry}
                  {entry === access.you && <span className="label-mono ml-2 text-muted-foreground">You</span>}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || last}
                  title={last ? "The last admin can't be removed" : undefined}
                  aria-label={`Remove ${entry}`}
                  onClick={() => {
                    if (entry === access.you && list.key === "admins" && !confirm("Remove yourself as an admin? You'll lose this page.")) return;
                    void change(entry, true);
                  }}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : <div className="placeholder-cell px-3 py-4 text-[13px] text-muted-foreground">None yet</div>}
    </div>
  );
}
