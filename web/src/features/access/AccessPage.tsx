import * as React from "react";
import { Column, Empty, Surface, Tag } from "@/components/brand";
import { Cross } from "@/components/brand/icons";
import { Confirm } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { RequestAccess } from "./RequestAccess";
import { day, plural } from "@/lib/format";

// Hosted only: the sign-in server in front of the page answers /api/admin/access, checks that you are
// an admin on every request, checks each entry with the sign-in's rules and writes the list.
const URL = "/api/admin/access";

type ListName = "admins" | "emails" | "domains";
type Access = { admins: string[]; emails: string[]; domains: string[]; you: string; canGrantDirectly: boolean; visitors: { since: string; counts: Record<string, number> }; error?: string };

const LISTS: { key: ListName; title: string; text: string; placeholder: string }[] = [
  { key: "admins", title: "Admins", text: "Internal staff who manage access and can see every run. The last admin must stay.", placeholder: "name@company.com" },
  { key: "emails", title: "Invited people", text: "One address each, at any domain, including Gmail and other public mail.", placeholder: "name@partner.com" },
  { key: "domains", title: "Whole domains", text: "Everyone with a verified address at exactly this domain, never its subdomains. Public mail domains aren't allowed.", placeholder: "company.com" },
];

/** Who may sign in to the hosted page: admins, invited addresses and whole domains. Changes apply at once. */
export function AccessPage({ invite, admin, canRequest }: { invite?: string; admin: boolean; canRequest: boolean | null }) {
  const [access, setAccess] = React.useState<Access | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!admin) return;
    fetch(URL, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Access;
        if (res.ok) setAccess(body);
        else setError(body.error ?? `The page answered ${res.status}.`);
      })
      .catch(() => setError("The access list didn't load. Reload to try again."));
  }, [admin]);

  return (
    <Surface>
      <Tag>Access</Tag>
      <h1 className="ev-title mt-6">Request access</h1>
      {canRequest === true ? <>
        <p className="mt-4 max-w-[66ch] text-[16px] leading-[1.4] text-body">Request access for one verified email or everyone at a company domain. They can sign in once the request is approved.</p>
        <RequestAccess invite={invite} />
      </> : canRequest === false && <p className="ev-small mt-4">Only internal staff can request access.</p>}
      {admin && <div className="mt-12">
        <h2 className="h5 mb-4">Who can sign in</h2>
        <p className="ev-small mb-4">Baseten and Blaxel teammates see each other's runs. Guests see their own runs. Admins see all runs.</p>
        {access?.canGrantDirectly && <p className="ev-small mb-4">If approvals are unavailable, you can add an email or domain directly. Access takes effect immediately.</p>}
        {error ? <Empty title="Not available">{error}</Empty>
          : !access ? <div className="bt-skeleton h-64" aria-busy />
            : (
              <div className="grid gap-12 lg:grid-cols-3 lg:gap-3">
                {LISTS.map((list) => <List key={list.key} list={list} access={access} onChange={setAccess} />)}
              </div>
            )}
      </div>}
    </Surface>
  );
}

function removalDescription(list: ListName, entry: string, access: Access) {
  if (list === "domains") {
    const people = access.visitors.counts[entry];
    return <>Since {day(access.visitors.since)}, {plural(people, "person", "people")} from <strong className="break-all font-medium">@{entry}</strong> {people === 1 ? "has" : "have"} signed in. People who rely on this domain lose access on their next request.</>;
  }
  const effect = list === "emails"
    ? "They lose access on their next request unless another entry allows them."
    : entry === access.you ? "You will lose access to this admin page." : "They will lose access to this admin page.";
  return <><strong className="break-all font-medium">{entry}</strong> will be removed from {list === "emails" ? "Invited people" : "Admins"}. {effect}</>;
}

function List({ list, access, onChange }: {
  list: (typeof LISTS)[number]; access: Access; onChange: (a: Access) => void;
}) {
  const [value, setValue] = React.useState("");
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
      {(list.key === "admins" || access.canGrantDirectly) && <form
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
          spellCheck={false}
        />
        <Button type="submit" variant="outline" disabled={busy || !value.trim()}>{list.key === "admins" ? "Add" : "Add directly"}</Button>
      </form>}
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
                <Confirm
                  title={list.key === "domains" ? "Remove this domain?" : list.key === "admins" ? "Remove this admin?" : "Remove this person?"}
                  description={removalDescription(list.key, entry, access)}
                  action={list.key === "domains" ? "Remove domain" : list.key === "admins" ? "Remove admin" : "Remove person"}
                  onConfirm={() => { void change(entry, true); }}
                  trigger={
                    <button
                      type="button"
                      className="ev-icon-button disabled:cursor-default disabled:opacity-40"
                      disabled={busy || last}
                      title={last ? "The last admin can't be removed" : undefined}
                      aria-label={`Remove ${entry}`}
                    >
                      <Cross />
                    </button>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : <div className="bt-empty">None yet</div>}
      </div>
    </Column>
  );
}
