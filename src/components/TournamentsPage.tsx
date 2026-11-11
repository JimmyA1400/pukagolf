"use client";

import Link from "next/link";
import { useState } from "react";

import { RsvpControl } from "@/components/RsvpControl";
import { FORMATS, getFormat } from "@/lib/formats";
import {
  useTournaments,
  type Tournament,
  type CharityOption,
  type TournamentWithField,
} from "@/lib/useTournaments";
import { useClub } from "@/lib/club";

const today = () => new Date().toISOString().slice(0, 10);

export function TournamentsPage() {
  const { href } = useClub();
  const { state, notice, setRsvp, save, remove } = useTournaments();
  const [editing, setEditing] = useState<Partial<Tournament> | null>(null);

  if (state.status === "loading") return <Centered>Loading…</Centered>;

  if (state.status === "signed-out") {
    return (
      <Centered>
        <p>Sign in to see the schedule.</p>
        <Link href="/sign-in" className="mt-3 underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  const { tournaments, isAdmin } = state;

  // "Upcoming" is about results, not the calendar: a tournament played
  // yesterday whose results aren't in is still outstanding.
  const upcoming = tournaments.filter((t) => t.completed_at === null);
  const past = tournaments
    .filter((t) => t.completed_at !== null)
    .sort((a, b) => b.played_on.localeCompare(a.played_on));

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-5 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="meta">PukaGolf</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Tournaments
          </h1>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() =>
              setEditing({ name: "", played_on: today(), entry_fee: 0 })
            }
            className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
          >
            New tournament
          </button>
        )}
      </header>

      {notice && (
        <p
          role="alert"
          className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
        >
          {notice}
        </p>
      )}

      {editing && (
        <TournamentForm
          initial={editing}
          charities={state.charities}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const refusal = await save(draft);
            if (!refusal) setEditing(null);

            return refusal;
          }}
        />
      )}

      <section>
        <h2 className="section-head mb-3 pb-2 text-xl">Upcoming</h2>

        {upcoming.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            Nothing on the calendar yet.
          </p>
        ) : (
          <div className="space-y-3">
            {upcoming.map((t) => (
              <TournamentCard
                key={t.id}
                tournament={t}
                isAdmin={isAdmin}
                onRsvp={(status) => void setRsvp(t.id, status)}
                onEdit={() => setEditing(t)}
                onDelete={() => void remove(t.id)}
              />
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="section-head mb-3 pb-2 text-xl">Past events</h2>
          <div className="space-y-2">
            {past.map((t) => (
              <Link
                key={t.id}
                href={href(`/tournaments/${t.id}`)}
                className="flex min-h-14 items-center justify-between gap-3 border border-hairline bg-card px-4 py-3 hover:border-forest"
              >
                <span className="min-w-0">
                  <span className="block truncate font-display text-[0.95rem] font-semibold">
                    {t.name}
                  </span>
                  <span className="block font-mono text-xs text-ink-soft">
                    {t.played_on}
                    {t.course_name && ` · ${t.course_name}`}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-ink-soft">
                  Results →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

export function TournamentCard({
  tournament,
  isAdmin,
  onRsvp,
  onEdit,
  onDelete,
}: {
  tournament: TournamentWithField;
  isAdmin: boolean;
  onRsvp: (status: "in" | "out" | "undecided") => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { href } = useClub();
  const t = tournament;
  const full = t.spotsRemaining === 0 && t.myStatus !== "in";

  return (
    <div className="border border-hairline bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={href(`/tournaments/${t.id}`)}
            className="font-display text-lg font-bold hover:underline"
          >
            {t.name}
          </Link>
          <p className="font-mono text-xs text-ink-soft">
            {t.played_on}
            {t.course_name && ` · ${t.course_name}`} ·{" "}
            {getFormat(t.format).label}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="font-display text-lg font-bold">
            {t.entry_fee > 0 ? `$${Number(t.entry_fee).toFixed(0)}` : "Free"}
          </p>
          <p className="font-mono text-xs text-ink-soft">
            {t.field_limit === null
              ? `${t.field.length} entered`
              : `${t.field.length}/${t.field_limit} · ${t.spotsRemaining} left`}
          </p>
        </div>
      </div>

      {t.description && (
        <p className="mt-2 font-mono text-xs text-ink-soft">{t.description}</p>
      )}

      {Number(t.raised) > 0 && (
        <p className="mt-2 font-mono text-xs">
          <Link href={href("/charities")} className="text-forest hover:underline">
            ${Number(t.raised).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}{" "}
            raised for charity
          </Link>
        </p>
      )}

      <div className="mt-3">
        <RsvpControl
          value={t.myStatus}
          lockedAt={t.rsvp_lock_at}
          disabled={full}
          onChange={onRsvp}
        />
        {full && (
          <p className="mt-1.5 font-mono text-xs text-clay">
            The field is full.
          </p>
        )}
      </div>

      {isAdmin && (onEdit || onDelete) && (
        <div className="mt-3 flex gap-4 border-t border-dashed border-hairline pt-2">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="font-mono text-xs text-ink-soft underline"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={() => {
                // Deleting takes the field and results with it, so it asks.
                if (confirm(`Delete "${t.name}"? This cannot be undone.`)) {
                  onDelete();
                }
              }}
              className="font-mono text-xs text-clay underline"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TournamentForm({
  initial,
  charities,
  onSave,
  onCancel,
}: {
  initial: Partial<Tournament>;
  charities: readonly CharityOption[];
  onSave: (
    draft: Partial<Tournament> & { name: string; played_on: string },
  ) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Tournament>(key: K, value: Tournament[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        if (!draft.name?.trim()) return setError("Give it a name.");
        if (!draft.played_on) return setError("Pick a date.");

        setBusy(true);
        const refusal = await onSave({
          ...draft,
          name: draft.name.trim(),
          played_on: draft.played_on,
        });
        setBusy(false);
        setError(refusal);
      }}
      className="space-y-3 border border-forest bg-card p-4"
    >
      <p className="meta">{initial.id ? "Edit tournament" : "New tournament"}</p>

      <Field label="Name">
        <input
          value={draft.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          className={inputClass}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date">
          <input
            type="date"
            value={draft.played_on ?? ""}
            onChange={(e) => set("played_on", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Course">
          <input
            value={draft.course_name ?? ""}
            onChange={(e) => set("course_name", e.target.value)}
            placeholder="Course name"
            className={inputClass}
          />
        </Field>

        <Field label="Entry fee ($)">
          <input
            type="number"
            min={0}
            value={draft.entry_fee ?? 0}
            onChange={(e) => set("entry_fee", Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Field limit">
          <input
            type="number"
            min={1}
            value={draft.field_limit ?? ""}
            onChange={(e) =>
              set(
                "field_limit",
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            placeholder="No limit"
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Format">
        <select
          value={draft.format ?? "solo"}
          onChange={(e) => set("format", e.target.value as Tournament["format"])}
          className={inputClass}
        >
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Charity">
          <select
            value={draft.charity_id ?? ""}
            onChange={(e) => set("charity_id", e.target.value || null)}
            className={inputClass}
          >
            <option value="">None</option>
            {charities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Raised ($)">
          <input
            type="number"
            min={0}
            value={draft.raised ?? 0}
            onChange={(e) => set("raised", Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={draft.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          className={`${inputClass} min-h-20 py-2`}
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
