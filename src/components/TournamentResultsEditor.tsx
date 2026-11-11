"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { positionsFromGross } from "@/lib/tournament-positions";

type Row = {
  playerId: string;
  name: string;
  gross: string;
  position: string;
};

/**
 * Enter final standings for a tournament.
 *
 * Starts from the field — the people who said they were playing — because
 * typing a roster twice is how the two lists drift apart.
 */
export function TournamentResultsEditor({
  tournamentId,
  field,
  completed,
  onSaved,
}: {
  tournamentId: string;
  field: readonly { playerId: string; name: string }[];
  completed: boolean;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [markComplete, setMarkComplete] = useState(!completed);

  const load = useCallback(async () => {
    const [existing, players] = await Promise.all([
      supabase
        .from("tournament_results")
        .select("*")
        .eq("tournament_id", tournamentId),
      supabase.from("profiles").select("id, full_name").order("full_name"),
    ]);

    const nameOf = new Map((players.data ?? []).map((p) => [p.id, p.full_name]));
    const saved = new Map(
      (existing.data ?? []).map((r) => [r.player_id, r]),
    );

    // The field, plus anyone with a saved result who has since left it.
    const ids = [
      ...new Set([
        ...field.map((f) => f.playerId),
        ...(existing.data ?? []).map((r) => r.player_id),
      ]),
    ];

    setRows(
      ids.map((id) => {
        const row = saved.get(id);

        return {
          playerId: id,
          name: nameOf.get(id) ?? "Unknown",
          gross: row?.gross != null ? String(row.gross) : "",
          position: row?.position != null ? String(row.position) : "",
        };
      }),
    );
  }, [supabase, tournamentId, field]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const set = (playerId: string, key: "gross" | "position", value: string) =>
    setRows(
      (current) =>
        current?.map((r) =>
          r.playerId === playerId ? { ...r, [key]: value } : r,
        ) ?? null,
    );

  const autoPosition = () => {
    if (!rows) return;

    const positions = positionsFromGross(
      rows.map((r) => ({
        playerId: r.playerId,
        gross: r.gross === "" ? null : Number(r.gross),
      })),
    );

    setRows(
      rows.map((r) => ({
        ...r,
        position: positions[r.playerId] ? String(positions[r.playerId]) : "",
      })),
    );
  };

  const save = async () => {
    if (!rows) return;

    setBusy(true);
    setNotice(null);

    // Only rows with a position are results; the rest are people who entered
    // and did not finish, and storing them as position 0 would rank them first.
    const toSave = rows.filter((r) => r.position !== "");

    const { error: deleteError } = await supabase
      .from("tournament_results")
      .delete()
      .eq("tournament_id", tournamentId);

    if (deleteError) {
      setBusy(false);
      setNotice(deleteError.message);
      return;
    }

    if (toSave.length > 0) {
      const { error } = await supabase.from("tournament_results").insert(
        toSave.map((r) => ({
          tournament_id: tournamentId,
          player_id: r.playerId,
          position: Number(r.position),
          gross: r.gross === "" ? null : Number(r.gross),
        })),
      );

      if (error) {
        setBusy(false);
        setNotice(error.message);
        return;
      }
    }

    if (markComplete) {
      const { error } = await supabase
        .from("tournaments")
        .update({ completed_at: new Date().toISOString() })
        .eq("id", tournamentId);

      if (error) {
        setBusy(false);
        setNotice(error.message);
        return;
      }
    }

    setBusy(false);
    onSaved();
  };

  if (rows === null) {
    return <p className="font-mono text-xs text-ink-soft">Loading…</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="font-mono text-xs text-ink-soft">
        Nobody has entered yet, so there is nothing to score.
      </p>
    );
  }

  return (
    <div className="border border-forest bg-card p-4">
      {notice && (
        <p role="alert" className="mb-2 font-mono text-xs text-clay">
          {notice}
        </p>
      )}

      <div className="mb-2 grid grid-cols-[1fr_4rem_4rem] gap-2">
        <span className="meta">Player</span>
        <span className="meta text-right">Gross</span>
        <span className="meta text-right">Pos</span>
      </div>

      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.playerId}
            className="grid grid-cols-[1fr_4rem_4rem] items-center gap-2"
          >
            <span className="min-w-0 truncate font-display text-[0.95rem]">
              {row.name}
            </span>
            <input
              type="number"
              inputMode="numeric"
              value={row.gross}
              onChange={(e) => set(row.playerId, "gross", e.target.value)}
              className="min-h-11 w-full border border-hairline bg-cream px-2 text-center font-mono text-sm tabular-nums"
            />
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={row.position}
              onChange={(e) => set(row.playerId, "position", e.target.value)}
              className="min-h-11 w-full border border-hairline bg-cream px-2 text-center font-mono text-sm tabular-nums"
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={autoPosition}
        className="mt-3 min-h-11 w-full border border-hairline px-4 font-mono text-xs tracking-wider uppercase hover:border-forest"
      >
        Position from gross
      </button>

      <label className="mt-3 flex items-center gap-2 font-mono text-xs">
        <input
          type="checkbox"
          checked={markComplete}
          onChange={(e) => setMarkComplete(e.target.checked)}
          className="accent-forest"
        />
        Mark this tournament complete
      </label>

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="mt-3 min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save results"}
      </button>

      <p className="mt-2 font-mono text-xs text-ink-soft">
        A player with no position is treated as not having finished, and is left
        out of the standings.
      </p>
    </div>
  );
}
