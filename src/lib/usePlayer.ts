"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { localToday } from "./final-week";
import { createClient } from "./supabase/client";

export type PlayerProfile = {
  id: string;
  full_name: string;
  phone: string | null;
  handicap_index: number | null;
  preferred_tee_time: string | null;
  preferred_tee: string | null;
  is_admin: boolean;
};

export type UpcomingRound = {
  id: string;
  name: string;
  played_on: string;
  rsvp_lock_at: string | null;
  league_id?: string | null;
  /** The league it's a week of, named from the clubs the player is in. */
  league?: string | null;
  /** Distinct tee times on this round, for the preferred-time dropdown. */
  teeTimes: string[];
  myStatus: "in" | "out" | "undecided" | null;
  /**
   * The player's tee time, for a week whose groups are out with them in one.
   * No RSVP then: the pro shop has already put them on the tee sheet.
   */
  onSheetAt?: string | null;
};

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "ready"; profile: PlayerProfile; rounds: UpcomingRound[] };

/** "08:10:00" -> "8:10a", matching how tee times read elsewhere. */
export function formatTimeOfDay(value: string | null): string {
  if (!value) return "";

  const [rawHour, minute] = value.split(":");
  const hour24 = Number(rawHour);
  const suffix = hour24 < 12 ? "a" : "p";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${minute}${suffix}`;
}

/**
 * The tee times a player can say they prefer: every half hour from 6:00 AM to
 * 6:30 PM, the way a pro shop takes a request, plus whatever they chose
 * before if it isn't one of those. Not this week's tee times, which change
 * week to week (and were once 1:26 AM on a test club).
 */
export function preferredTeeTimeChoices(current: string | null = null): string[] {
  const slots: string[] = [];
  for (let minutes = 6 * 60; minutes <= 18 * 60 + 30; minutes += 30) {
    slots.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`);
  }
  const saved = current ? current.slice(0, 5) + ":00" : null;
  if (saved && !slots.includes(saved)) slots.push(saved);

  return slots.sort();
}

/**
 * The signed-in player and the rounds they can still answer for.
 *
 * Tee sets are no longer read here: a preference is one of the five categories
 * in `tee-preference`, resolved per course rather than chosen from a list of
 * every tee name in the database.
 */
export function usePlayer() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setState({ status: "signed-out" });
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) {
      setState({ status: "signed-out" });
      return;
    }

    // Today onwards, in this phone's own day (not UTC's, which turns over at
    // 7 or 8 in the evening on the east coast): a round already played can't
    // be answered for. Nor can one already being played: it isn't upcoming.
    const today = localToday();
    const [rounds, myRsvps] = await Promise.all([
      supabase
        .from("rounds")
        .select("id, name, played_on, rsvp_lock_at, league_id")
        .gte("played_on", today)
        .eq("status", "setup")
        .order("played_on"),
      supabase.from("round_rsvps").select("*").eq("player_id", user.id),
    ]);

    // Weeks already under way with their groups out, the player in one: a
    // copied week is live from the start, and isn't "nothing scheduled".
    const { data: liveWeeks } = await supabase
      .from("rounds")
      .select("id, name, played_on, rsvp_lock_at, league_id")
      .gte("played_on", today)
      .eq("status", "live")
      .order("played_on");
    const liveIds = (liveWeeks ?? []).map((r) => r.id);
    const { data: seats } = await supabase
      .from("tee_time_players")
      .select("round_id, tee_time_id")
      .eq("player_id", user.id)
      .in("round_id", liveIds.length ? liveIds : ["-"]);
    // A card already signed is done with: the week isn't upcoming for them.
    const { data: signed } = await supabase
      .from("card_locks")
      .select("round_id")
      .eq("player_id", user.id)
      .in("round_id", liveIds.length ? liveIds : ["-"]);
    const signedIds = new Set((signed ?? []).map((l) => l.round_id));
    const seatIds = (seats ?? []).map((s) => s.tee_time_id);
    const { data: seatTimes } = await supabase
      .from("tee_times")
      .select("id, tee_at")
      .in("id", seatIds.length ? seatIds : ["-"]);
    const onSheet = (liveWeeks ?? []).flatMap((round) => {
      if (signedIds.has(round.id)) return [];
      const seat = (seats ?? []).find((s) => s.round_id === round.id);
      if (!seat) return [];
      const teeAt = (seatTimes ?? []).find((t) => t.id === seat.tee_time_id)?.tee_at ?? null;
      return [{ ...round, teeTimes: [], myStatus: null, onSheetAt: teeAt }];
    });

    // The league names, from the clubs the player is in: a player in two
    // leagues can't tell "Week 5" from "Week 5" otherwise.
    const { data: myClubs } = await supabase.rpc("my_clubs");
    const leagueNames = new Map(
      ((myClubs as { leagues?: { id: string; name: string }[] }[] | null) ?? []).flatMap((c) =>
        (c.leagues ?? []).map((l) => [l.id, l.name] as const),
      ),
    );
    const leagueOf = (id: string | null | undefined) => (id && leagueNames.get(id)) || null;

    const roundIds = (rounds.data ?? []).map((r) => r.id);
    const { data: teeTimes } = await supabase
      .from("tee_times")
      .select("round_id, tee_at")
      .in("round_id", roundIds.length ? roundIds : ["-"]);

    const statusFor = new Map(
      (myRsvps.data ?? []).map((r) => [r.round_id, r.status]),
    );

    setState({
      status: "ready",
      profile: profile as PlayerProfile,
      rounds: [
        ...onSheet.map((round) => ({ ...round, league: leagueOf(round.league_id) })),
        ...(rounds.data ?? []).map((round) => ({
        ...round,
        league: leagueOf(round.league_id),
        teeTimes: [
          ...new Set(
            (teeTimes ?? [])
              .filter((t) => t.round_id === round.id)
              .map((t) => new Date(t.tee_at).toTimeString().slice(0, 8)),
          ),
        ].sort(),
        myStatus: statusFor.get(round.id) ?? null,
        })),
      ].sort((a, b) => a.played_on.localeCompare(b.played_on)),
    });
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** Returns a refusal message, or null on success. */
  const saveDetails = useCallback(
    async (details: {
      fullName: string;
      phone: string | null;
      handicapIndex: number | null;
      preferredTeeTime: string | null;
      preferredTee: string | null;
    }) => {
      const { error } = await supabase.rpc("save_player_details", {
        in_full_name: details.fullName,
        in_phone: details.phone,
        in_handicap_index: details.handicapIndex,
        in_preferred_tee_time: details.preferredTeeTime,
        in_preferred_tee: details.preferredTee,
      });

      if (error) return error.message;

      await load();
      return null;
    },
    [supabase, load],
  );

  const setRsvp = useCallback(
    async (roundId: string, status: "in" | "out" | "undecided") => {
      const { error } = await supabase.rpc("set_rsvp", {
        in_round_id: roundId,
        in_status: status,
      });

      if (error) return error.message;

      await load();
      return null;
    },
    [supabase, load],
  );

  return { state, saveDetails, setRsvp, reload: load };
}
