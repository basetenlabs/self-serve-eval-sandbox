import * as React from "react";
import { Column, Empty, Surface, Tag } from "@/components/brand";
import { Cross } from "@/components/brand/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <Surface>
      <Tag>Admin</Tag>
      <h1 className="ev-title mt-6">Who can sign in</h1>
      <p className="mt-4 max-w-[66ch] text-[16px] leading-[1.4] text-body">
        A Blaxel account with a verified email gets in when it is on one of these lists. Changes apply at once:
        someone you remove is signed out on their next request. Everyone sees only their own runs; admins see every run.
      </p>
      {invite && access && !access.emails.includes(invite.toLowerCase()) && !access.admins.includes(invite.toLowerCase()) && (
        <div role="status" className="bt-notice info mt-8 block max-w-[66ch]">
          <code className="ev-code">{invite}</code> asked for access. Their address is filled in under Invited people: press Add to let them in.
        </div>
      )}
      <div className="mt-12">
        {error ? <Empty title="Not available">{error}</Empty>
          : !access ? <div className="bt-skeleton h-64" aria-busy />
            : (
              <div className="grid gap-12 lg:grid-cols-3 lg:gap-3">
                {LISTS.map((list) => <List key={list.key} list={list} access={access} onChange={setAccess} prefill={list.key === "emails" ? invite : undefined} />)}
              </div>
            )}
      </div>
    </Surface>
  );
}

function List({ list, access, onChange, prefill }: {
  list: (typeof LISTS)[number]; access: Access; onChange: (a: Access) => void; prefill?: string;
}) {
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
      setProblem(remove ? `Couldn't remove ${entry}. ${res.error}` : res.error);
      return false;
    }
    onChange(res);
    return true;
  };

  return (
    <Column heading={list.title} aside={<span className="label-xs text-muted-foreground">{plural(entries.length, list.key === "domains" ? "domain" : "address", list.key === "domains" ? "domains" : "addresses")}</span>}>
      <div className="grid content-start gap-4">
      <p className="ev-small">{list.text}</p>
      <form
        className="flex gap-3"
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
      {problem && <p role="alert" className="bt-notice error">{problem}</p>}
      {entries.length ? (
        <ul className="border-t border-lightGrey2">
          {entries.map((entry) => {
            const last = list.key === "admins" && entries.length === 1;
            return (
              <li key={entry} className="flex min-h-11 items-center justify-between gap-3 border-b border-lightGrey2 py-1 pl-0 text-[14px]">
                <span className="min-w-0 truncate font-mono text-[14px]">
                  {list.key === "domains" ? `@${entry}` : entry}
                  {entry === access.you && <span className="bt-badge ml-2">You</span>}
                </span>
                <button
                  type="button"
                  className="ev-icon-button disabled:cursor-default disabled:opacity-40"
                  disabled={busy || last}
                  title={last ? "The last admin can't be removed" : undefined}
                  aria-label={`Remove ${entry}`}
                  onClick={() => {
                    if (entry === access.you && list.key === "admins" && !confirm("Remove yourself as an admin? You'll lose this page.")) return;
                    void change(entry, true);
                  }}
                >
                  <Cross />
                </button>
              </li>
            );
          })}
        </ul>
      ) : <div className="bt-empty">None yet</div>}
      </div>
    </Column>
  );
}
