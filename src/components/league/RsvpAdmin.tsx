"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel } from "./Panels";
import { RsvpControl, type RsvpStatus } from "@/components/RsvpControl";
import { createClient } from "@/lib/supabase/client";

type Row = {
  playerId: string;
  name: string;
  status: RsvpStatus | null;
};

/**
 * Who is playing, for the admin.
 *
 * Shows every league member rather than only those who answered — the players
 * who have said nothing are the ones worth chasing, and a list of replies alone
 * hides them.
 */
export function RsvpAdmin({ roundId }: { roundId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [players, rsvps] = await Promise.all([
      supabase.from("profiles").select("id, full_name").order("full_name"),
      supabase.from("round_rsvps").select("*").eq("round_id", roundId),
    ]);

    const statusFor = new Map(
      (rsvps.data ?? []).map((r) => [r.player_id, r.status as RsvpStatus]),
    );

    setRows(
      (players.data ?? []).map((p) => ({
        playerId: p.id,
        name: p.full_name,
        status: statusFor.get(p.id) ?? null,
      })),
    );
  }, [supabase, roundId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const override = async (playerId: string, status: RsvpStatus) => {
    const { error } = await supabase.rpc("set_rsvp", {
      in_round_id: roundId,
      in_status: status,
      in_player_id: playerId,
    });

    setNotice(error?.message ?? null);
    if (!error) await load();
  };

  const counts = {
    in: rows?.filter((r) => r.status === "in").length ?? 0,
    out: rows?.filter((r) => r.status === "out").length ?? 0,
    undecided: rows?.filter((r) => r.status === "undecided").length ?? 0,
    silent: rows?.filter((r) => r.status === null).length ?? 0,
  };

  return (
    <Panel
      icon="📋"
      title="Who's playing"
      subtitle={
        rows
          ? `${counts.in} in · ${counts.out} out · ${counts.undecided} undecided · ${counts.silent} no reply`
          : "Loading…"
      }
    >
      {notice && (
        <p role="alert" className="mb-2 font-mono text-xs text-clay">
          {notice}
        </p>
      )}

      {rows?.map((row) => (
        <div
          key={row.playerId}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-hairline py-2.5 last:border-0"
        >
          <span className="font-display text-[0.95rem]">
            {row.name}
            {row.status === null && (
              <span className="ml-2 font-mono text-xs text-ink-soft">
                no reply
              </span>
            )}
          </span>

          <div className="w-full sm:w-64">
            {/* No lock passed: the admin can change an answer at any time,
                which is the whole point of an override. */}
            <RsvpControl
              value={row.status}
              onChange={(status) => void override(row.playerId, status)}
            />
          </div>
        </div>
      ))}
    </Panel>
  );
}
