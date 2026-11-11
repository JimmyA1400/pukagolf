"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { RsvpControl, type RsvpStatus } from "@/components/RsvpControl";
import { createClient } from "@/lib/supabase/client";

/**
 * "Are you playing?" at the top of the league page, while a week's groups
 * aren't set yet.
 *
 * Players could always answer from their profile, but a week built from
 * RSVPs only works if people answer, and the league page is where they look.
 * Once the groups are built the lock closes and this becomes read-only.
 */
export function WeekRsvp({
  roundId,
  roundName,
  playedOn,
}: {
  roundId: string;
  roundName: string;
  playedOn: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [mine, setMine] = useState<RsvpStatus | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [inCount, setInCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const [round, answers] = await Promise.all([
      supabase.from("rounds").select("rsvp_lock_at").eq("id", roundId).maybeSingle(),
      supabase.from("round_rsvps").select("player_id, status").eq("round_id", roundId),
    ]);

    const rows = answers.data ?? [];

    setLockedAt(round.data?.rsvp_lock_at ?? null);
    setMine(
      (rows.find((r) => r.player_id === user?.id)?.status as RsvpStatus) ?? null,
    );
    setInCount(rows.filter((r) => r.status === "in").length);
  }, [supabase, roundId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const answer = async (status: RsvpStatus) => {
    const { error } = await supabase.rpc("set_rsvp", {
      in_round_id: roundId,
      in_status: status,
    });

    setNotice(error?.message ?? null);
    if (!error) await load();
  };

  // Noon, so the date can't slip a day in any US time zone.
  const day = new Date(`${playedOn}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <section className="border-2 border-forest bg-card px-4 py-4">
      <p className="meta">{day}</p>
      <h2 className="font-display text-xl font-bold">
        Are you playing {roundName}?
      </h2>
      <p className="mt-1 font-mono text-xs text-ink-soft">
        The groups are made from these answers.
        {inCount !== null && ` ${inCount} in so far.`}
      </p>

      <div className="mt-3">
        <RsvpControl
          value={mine}
          lockedAt={lockedAt}
          onChange={(status) => void answer(status)}
        />
      </div>

      {notice && (
        <p role="alert" className="mt-2 font-mono text-xs text-clay">
          {notice}
        </p>
      )}
    </section>
  );
}
