"use client";

import { useCallback, useMemo, useState } from "react";

import { describeAuditEntry, foldRepeats, type ClubAuditEntry } from "@/lib/audit-words";
import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";

const PAGE = 50;

/**
 * The club's own audit log, for its admins: every score change, lock,
 * sign-off, member and league change made in this club, newest first.
 *
 * Loads only when opened: it holds every score ever entered, so it is the
 * largest thing the admin page could fetch. Entries from other clubs never
 * reach it; the database filters by club (club_audit_log, 0054).
 */
export function ClubAuditLog() {
  const supabase = useMemo(() => createClient(), []);
  const { club } = useClub();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ClubAuditEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Score entries are most of the log; edits and the rest are what get looked up.
  const [changesOnly, setChangesOnly] = useState(true);

  const load = useCallback(
    async (before: string | null) => {
      setBusy(true);
      const { data, error: failed } = await supabase.rpc("club_audit_log", {
        in_club_id: club.id,
        in_limit: PAGE,
        in_before: before,
      });
      setBusy(false);

      if (failed) {
        setError(failed.message);
        return;
      }

      const page = (data ?? []) as unknown as ClubAuditEntry[];
      setEntries((current) => (before ? [...(current ?? []), ...page] : page));
      setMore(page.length === PAGE);
    },
    [supabase, club.id],
  );

  const shown = foldRepeats(
    (entries ?? []).filter((e) => !changesOnly || !(e.entity === "score" && e.action === "insert")),
  );

  return (
    <section>
      <div className="section-head mb-3 flex flex-wrap items-baseline justify-between gap-2 pb-2">
        <h2 className="text-xl">Audit log</h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (!open && entries === null) void load(null);
            setOpen(!open);
          }}
          className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {!open ? (
        <p className="meta">Every score change, lock, sign-off and member change in {club.name}</p>
      ) : (
        <>
          <label className="mb-3 flex items-center gap-2 font-mono text-xs">
            <input
              type="checkbox"
              checked={changesOnly}
              onChange={(e) => setChangesOnly(e.target.checked)}
              className="h-5 w-5 accent-forest"
            />
            Leave out scores as they were first entered
          </label>

          {error && (
            <p role="alert" className="font-mono text-xs text-clay">
              {error}
            </p>
          )}

          {entries === null ? (
            <p className="font-mono text-xs text-ink-soft">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="font-mono text-xs text-ink-soft">Nothing recorded here yet.</p>
          ) : (
            <ul className="border border-hairline bg-card px-4">
              {shown.map((entry) => (
                <li key={entry.id} className="border-b border-dashed border-hairline py-2 last:border-b-0">
                  <p className="font-mono text-xs text-ink-soft">
                    {when(entry.at)}
                    {entry.week && ` · ${entry.week}`}
                  </p>
                  <p className="text-[0.95rem] break-words">
                    <span className="font-display font-bold">{entry.actor}</span>{" "}
                    {describeAuditEntry(entry)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {entries && more && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(entries[entries.length - 1]?.at ?? null)}
              className="mt-3 inline-flex min-h-11 items-center font-mono text-xs text-forest underline disabled:opacity-40"
            >
              {busy ? "Loading…" : "Load older"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** "Nov 4, 6:12 PM". */
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
