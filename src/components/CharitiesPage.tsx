"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useClub } from "@/lib/club";

type CharityEvent = {
  id: string;
  name: string;
  playedOn: string;
  raised: number;
};

type Charity = {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  website: string | null;
  active: boolean;
  seasonTotal: number;
  allTimeTotal: number;
  events: CharityEvent[];
};

const money = (value: number) =>
  `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function CharitiesPage() {
  const { href, club } = useClub();
  const clubId = club.id;
  const supabase = useMemo(() => createClient(), []);
  const [charities, setCharities] = useState<Charity[] | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [editing, setEditing] = useState<Partial<Charity> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setSignedOut(true);
      return;
    }

    const [profile, totals] = await Promise.all([
      supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle(),
      supabase.rpc("charity_totals", { in_club_id: clubId }),
    ]);

    setIsAdmin(profile.data?.is_admin ?? false);
    setCharities(totals.data as unknown as Charity[]);
  }, [supabase, clubId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (signedOut) {
    return (
      <Centered>
        <p>Sign in to see where the money goes.</p>
        <Link href="/sign-in" className="mt-3 underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  if (charities === null) return <Centered>Loading…</Centered>;

  const visible = isAdmin ? charities : charities.filter((c) => c.active);
  const seasonTotal = visible.reduce((sum, c) => sum + Number(c.seasonTotal), 0);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="meta">PukaGolf</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Charities
          </h1>
          <p className="mt-1 font-mono text-xs text-ink-soft">
            Every entry fee and side pot the league collects goes somewhere.
            Here is where.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setEditing({ name: "", active: true })}
            className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
          >
            Add charity
          </button>
        )}
      </header>

      {seasonTotal > 0 && (
        <div className="border border-hairline bg-card px-5 py-4">
          <p className="meta">Raised this season</p>
          <p className="font-display text-4xl font-bold text-forest">
            {money(seasonTotal)}
          </p>
        </div>
      )}

      {notice && (
        <p
          role="alert"
          className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
        >
          {notice}
        </p>
      )}

      {editing && (
        <CharityForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const { error } = draft.id
              ? await supabase
                  .from("charities")
                  .update(toRow(draft))
                  .eq("id", draft.id)
              : await supabase.from("charities").insert({ ...toRow(draft), club_id: clubId });

            if (error) return error.message;

            setEditing(null);
            await load();
            return null;
          }}
        />
      )}

      {visible.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No charities listed yet.
        </p>
      ) : (
        <div className="space-y-4">
          {visible.map((charity) => (
            <article
              key={charity.id}
              className="border border-hairline bg-card px-5 py-4"
            >
              <div className="flex items-start gap-4">
                {charity.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={charity.logoUrl}
                    alt=""
                    className="h-14 w-14 shrink-0 object-contain"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-xl font-bold">
                    {charity.name}
                    {!charity.active && (
                      <span className="ml-2 font-mono text-xs font-normal text-ink-soft">
                        hidden
                      </span>
                    )}
                  </h2>

                  {charity.description && (
                    <p className="mt-1 font-display text-[0.95rem]">
                      {charity.description}
                    </p>
                  )}

                  {charity.website && (
                    <a
                      href={charity.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block font-mono text-xs underline"
                    >
                      Visit their site ↗
                    </a>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  <p className="font-display text-2xl font-bold text-forest">
                    {money(charity.seasonTotal)}
                  </p>
                  <p className="meta">This season</p>
                  {Number(charity.allTimeTotal) >
                    Number(charity.seasonTotal) && (
                    <p className="mt-1 font-mono text-xs text-ink-soft">
                      {money(charity.allTimeTotal)} all time
                    </p>
                  )}
                </div>
              </div>

              {charity.events.length > 0 && (
                <div className="mt-3 border-t border-dashed border-hairline pt-2">
                  {charity.events.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-baseline justify-between gap-3 py-1.5"
                    >
                      <Link
                        href={href(`/tournaments/${event.id}`)}
                        className="font-display text-[0.95rem] hover:underline"
                      >
                        {event.name}
                        <span className="ml-2 font-mono text-xs text-ink-soft">
                          {event.playedOn}
                        </span>
                      </Link>
                      <span className="shrink-0 font-mono text-sm font-bold tabular-nums">
                        {money(event.raised)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {isAdmin && (
                <div className="mt-3 flex gap-4 border-t border-dashed border-hairline pt-2">
                  <button
                    type="button"
                    onClick={() => setEditing(charity)}
                    className="font-mono text-xs text-ink-soft underline"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const { error } = await supabase
                        .from("charities")
                        .update({ active: !charity.active })
                        .eq("id", charity.id);

                      setNotice(error?.message ?? null);
                      if (!error) await load();
                    }}
                    className="font-mono text-xs text-ink-soft underline"
                  >
                    {charity.active ? "Hide" : "Show"}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {isAdmin && (
        <p className="font-mono text-xs text-ink-soft">
          Amounts come from each tournament&apos;s own figure — set them on the
          tournament, not here, so the total always matches the events under it.
        </p>
      )}
    </main>
  );
}

function toRow(draft: Partial<Charity>) {
  return {
    name: draft.name?.trim(),
    description: draft.description || null,
    logo_url: draft.logoUrl || null,
    website: draft.website || null,
    active: draft.active ?? true,
  };
}

function CharityForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Partial<Charity>;
  onSave: (draft: Partial<Charity>) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Charity>(key: K, value: Charity[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        if (!draft.name?.trim()) return setError("Give the charity a name.");

        // The column only accepts https, so say so here rather than letting
        // the database refuse with a constraint name.
        for (const [label, url] of [
          ["Logo URL", draft.logoUrl],
          ["Website", draft.website],
        ] as const) {
          if (url && !url.startsWith("https://")) {
            return setError(`${label} must start with https://`);
          }
        }

        setBusy(true);
        const refusal = await onSave(draft);
        setBusy(false);
        setError(refusal);
      }}
      className="space-y-3 border border-forest bg-card p-4"
    >
      <p className="meta">{initial.id ? "Edit charity" : "Add charity"}</p>

      <Field label="Name">
        <input
          value={draft.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="Description">
        <textarea
          value={draft.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          className={`${inputClass} min-h-20 py-2`}
        />
      </Field>

      <Field label="Logo URL">
        <input
          value={draft.logoUrl ?? ""}
          onChange={(e) => set("logoUrl", e.target.value)}
          placeholder="https://…"
          className={inputClass}
        />
      </Field>

      <Field label="Website">
        <input
          value={draft.website ?? ""}
          onChange={(e) => set("website", e.target.value)}
          placeholder="https://…"
          className={inputClass}
        />
      </Field>

      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="min-h-12 flex-1 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-12 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const inputClass =
  "min-h-12 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
