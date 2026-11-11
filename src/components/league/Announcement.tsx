"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";

/** Which announcement this phone has hidden, by the time it was posted. */
const HIDDEN_KEY = "pukagolf:announcement-hidden";

/**
 * The league's announcement: a rain delay, a course change, a reminder.
 *
 * Any admin posts it, from the league page or /admin. A player can hide it on
 * their phone, and a new one shows again because it's hidden by the time it
 * was posted. `manage` is the /admin version: always the editor, never a
 * banner.
 */
export function Announcement({
  canEdit,
  manage = false,
}: {
  canEdit: boolean;
  manage?: boolean;
}) {
  const leagueId = useClub().league?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const [current, setCurrent] = useState<{ text: string | null; at: string | null } | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let hiddenAt: string | null = null;
    try {
      hiddenAt = localStorage.getItem(HIDDEN_KEY);
    } catch {
      // Blocked storage: it just can't be hidden.
    }

    // This league's announcement: each league posts its own.
    const { data } = await supabase
      .from("league_rules")
      .select("announcement, announcement_at")
      .eq("league_id", leagueId)
      .maybeSingle();

    setHidden(hiddenAt);
    setCurrent({ text: data?.announcement ?? null, at: data?.announcement_at ?? null });
  }, [supabase, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = async (text: string | null) => {
    setBusy(true);
    const { error: refused } = await supabase.rpc("admin_set_announcement", { in_league_id: leagueId, in_text: text });
    setBusy(false);

    if (refused) {
      setError(refused.message);
      return;
    }

    setError(null);
    setEditing(false);
    await load();
  };

  const hide = (at: string) => {
    try {
      localStorage.setItem(HIDDEN_KEY, at);
    } catch {
      // As above.
    }
    setHidden(at);
  };

  if (!current) return null;

  const { text, at } = current;
  const posted = at
    ? new Date(at).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const startEditing = () => {
    setDraft(text ?? "");
    setError(null);
    setEditing(true);
  };

  const editor = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft);
      }}
      className="space-y-2"
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={500}
        rows={3}
        aria-label="Announcement"
        placeholder="Rain delay: first tee moved to 9:30."
        className="w-full border border-hairline bg-cream px-3 py-2 font-mono text-sm focus:outline-2 focus:outline-forest"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="min-h-10 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Posting…" : "Post"}
        </button>
        {text && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className="font-mono text-xs text-clay underline disabled:opacity-40"
          >
            Take it down
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="font-mono text-xs text-ink-soft underline"
        >
          Cancel
        </button>
        <span className="font-mono text-xs text-ink-soft">{draft.length}/500</span>
      </div>
      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}
    </form>
  );

  if (manage) {
    return (
      <div className="space-y-2 border border-hairline bg-card px-4 py-3">
        <p className="font-display text-base font-bold">Announcement</p>
        <p className="font-mono text-xs break-words text-ink-soft">
          {text
            ? `Posted ${posted}: “${text}”`
            : "Nothing posted. An announcement shows at the top of the league page for everyone."}
        </p>
        {editing ? (
          editor
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="font-mono text-xs text-forest underline"
          >
            {text ? "Change it" : "Post one"}
          </button>
        )}
      </div>
    );
  }

  if (editing) {
    return <section className="border-2 border-clay bg-card px-4 py-3">{editor}</section>;
  }

  if (!text || !at) {
    return canEdit ? (
      <button
        type="button"
        onClick={startEditing}
        className="font-mono text-xs text-forest underline"
      >
        Post an announcement
      </button>
    ) : null;
  }

  if (hidden === at) {
    return canEdit ? (
      <button
        type="button"
        onClick={() => setHidden(null)}
        className="font-mono text-xs text-ink-soft underline"
      >
        Show the announcement
      </button>
    ) : null;
  }

  return (
    <section
      aria-label="Announcement"
      className="flex items-start justify-between gap-3 border-2 border-clay bg-card px-4 py-3"
    >
      <div className="min-w-0">
        <p className="font-mono text-[0.6875rem] tracking-[0.08em] text-clay uppercase">
          Announcement · {posted}
        </p>
        <p className="mt-1 font-display text-base font-bold break-words whitespace-pre-line">
          {text}
        </p>
        {canEdit && (
          <button
            type="button"
            onClick={startEditing}
            className="mt-1 font-mono text-xs text-forest underline"
          >
            Edit
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Hide this announcement"
        onClick={() => hide(at)}
        className="min-h-9 min-w-9 shrink-0 font-mono text-lg leading-none text-ink-soft"
      >
        ×
      </button>
    </section>
  );
}
