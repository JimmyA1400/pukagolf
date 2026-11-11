"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, ConfirmButton, Field, inputClass } from "@/components/admin/parts";
import { formatUsPhone } from "@/lib/phone";
import { createClient } from "@/lib/supabase/client";

type Account = {
  id: string;
  full_name: string;
  phone: string | null;
  is_guest: boolean;
  created_at: string;
};

type Notice = { tone: "ok" | "error"; text: string };

/**
 * Every account on the site, for the two things only the platform admin may
 * do to one: merge a duplicate into the real one, and delete an account. A
 * person can belong to several clubs, so neither is a club's to decide.
 */
export function PlatformAccounts() {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, phone, is_guest, created_at")
      .order("full_name");

    if (error) setNotice({ tone: "error", text: error.message });
    setAccounts((data ?? []) as Account[]);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = async (action: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setNotice(null);
    const { error } = await action();
    if (error) {
      setNotice({ tone: "error", text: error.message });
      return false;
    }
    setNotice({ tone: "ok", text: done });
    await load();
    return true;
  };

  if (!accounts) return <p className="font-mono text-xs text-ink-soft">Loading accounts…</p>;

  const needle = search.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const shown = accounts.filter(
    (a) =>
      !needle ||
      a.full_name.toLowerCase().includes(needle) ||
      (digits.length >= 3 && (a.phone ?? "").includes(digits)),
  );

  return (
    <div className="space-y-3">
      <Field label="Find an account" hint={`${accounts.length} in all. Search by name or phone.`}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} className={inputClass} />
      </Field>

      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.tone === "error" ? "border-clay text-clay" : "border-forest text-forest"
          }`}
        >
          {notice.text}
        </p>
      )}

      <ul className="border border-hairline bg-card px-4">
        {shown.slice(0, 50).map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            others={accounts.filter((a) => a.id !== account.id)}
            onMerge={(keep) =>
              run(
                () => supabase.rpc("owner_merge_players", { in_keep: keep.id, in_remove: account.id }),
                `Merged ${account.full_name} into ${keep.full_name}.`,
              )
            }
            onDelete={() =>
              run(
                () => supabase.rpc("owner_remove_player", { in_profile_id: account.id }),
                `Deleted ${account.full_name}'s account.`,
              )
            }
          />
        ))}
        {shown.length > 50 && (
          <li className="py-3 font-mono text-xs text-ink-soft">
            {shown.length - 50} more. Narrow the search to see them.
          </li>
        )}
      </ul>
    </div>
  );
}

function AccountRow({
  account,
  others,
  onMerge,
  onDelete,
}: {
  account: Account;
  others: Account[];
  onMerge: (keep: Account) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [keepId, setKeepId] = useState("");
  const keep = others.find((a) => a.id === keepId) ?? null;

  return (
    <li className="border-b border-dashed border-hairline py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-base font-bold">
          {account.full_name}
          {account.is_guest && <Badge>Guest</Badge>}
        </span>
        <span className="font-mono text-xs text-ink-soft">
          {account.phone ? formatUsPhone(account.phone) : "no number"} · joined{" "}
          {account.created_at.slice(0, 10)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
        {keep ? (
          <ConfirmButton
            label={`Merge into ${keep.full_name}`}
            confirmLabel="Merge for good"
            warning={`${account.full_name}'s scores, groups and clubs move to ${keep.full_name}, and this account is deleted.`}
            onConfirm={async () => {
              const ok = await onMerge(keep);
              if (ok) setKeepId("");
            }}
          />
        ) : (
          <select
            value=""
            onChange={(e) => setKeepId(e.target.value)}
            aria-label={`Merge ${account.full_name} into another account`}
            className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
          >
            <option value="">Merge into…</option>
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </select>
        )}

        <ConfirmButton
          label="Delete account"
          confirmLabel="Delete for good"
          warning={`Deletes ${account.full_name}'s account in every club. Their scores go with it.`}
          onConfirm={onDelete}
        />
      </div>
    </li>
  );
}
