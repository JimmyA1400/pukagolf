"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { draftTeams, type FieldPlayer } from "./formats/field";
import { useClub } from "./club";
import { createClient } from "./supabase/client";

export type RosterEntry = {
  /** The event_players row. Scores are keyed with this, not the profile. */
  id: string;
  /** Null for a guest: a name on the sheet with no account behind it. */
  profileId: string | null;
  name: string;
  position: number;
  status: "in" | "out" | "undecided" | null;
  isGuest: boolean;
  handicapIndex: number | null;
  preferredTee: string | null;
  /**
   * The rated set they played. Without it the round has no differential, so
   * it shows on their profile but never reaches their index.
   */
  playedTee: string | null;
};

export type LeagueEvent = {
  id: string;
  name: string;
  playedOn: string;
  formatId: string;
  teamSize: number;
  holeCount: number;
  startHole: number;
  isSimulator: boolean;
  countsForStandings: boolean;
  courseId: string | null;
  courseName: string | null;
  skinsEnabled: boolean;
  skinsStake: number;
};

export type EventTeam = {
  id: string;
  name: string | null;
  position: number;
  memberIds: string[];
};

export type EventTeeTime = {
  id: string;
  teeAt: string;
  position: number;
  teamIds: string[];
};

export type LeagueEventData = {
  event: LeagueEvent;
  roster: RosterEntry[];
  teams: EventTeam[];
  teeTimes: EventTeeTime[];
  scores: { teamId: string; playerId: string | null; hole: number; strokes: number }[];
  pars: Record<string, number>;
  strokeIndexes: Record<string, number>;
  tees: { tee: string; courseRating: number | null; slope: number | null; yardage: number | null }[];
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: LeagueEventData; viewerId: string; isAdmin: boolean };

/**
 * One league event, and the admin actions on it.
 *
 * The draft is worked out here, by the same engine a league week uses, and
 * only the answer is sent. There is no second snake draft in the database —
 * see the note at the top of 0041_league_events.sql.
 */
export function useLeagueEvent(eventId: string) {
  const isAdmin = useClub().club.role === "admin";
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setState({ status: "error", message: "Sign in to see this event." });
      return;
    }

    const { data, error } = await supabase.rpc("league_event", { in_event_id: eventId });

    if (error) {
      setState({ status: "error", message: error.message });
      return;
    }

    setState({
      status: "ready",
      data: data as unknown as LeagueEventData,
      viewerId: user.id,
      // An admin of the event's club: the page is inside it.
      isAdmin,
    });
  }, [supabase, eventId, isAdmin]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** Runs an action and reloads, returning a refusal message or null. */
  const run = useCallback(
    async (call: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await call;
      if (error) return error.message;

      await load();
      return null;
    },
    [load],
  );

  const invite = useCallback(
    (profileIds: string[]) =>
      run(supabase.rpc("admin_event_invite", { in_event_id: eventId, in_profile_ids: profileIds })),
    [run, supabase, eventId],
  );

  const addGuest = useCallback(
    (name: string, handicap: number | null) =>
      run(
        supabase.rpc("admin_event_add_guest", {
          in_event_id: eventId,
          in_name: name,
          in_handicap: handicap,
        }),
      ),
    [run, supabase, eventId],
  );

  const removePlayer = useCallback(
    (playerId: string) =>
      run(
        supabase.rpc("admin_event_remove_player", {
          in_event_id: eventId,
          in_player_id: playerId,
        }),
      ),
    [run, supabase, eventId],
  );

  const setAnswer = useCallback(
    (playerId: string | null, status: "in" | "out" | "undecided") =>
      run(
        supabase.rpc("event_rsvp", {
          in_event_id: eventId,
          in_status: status,
          in_player_id: playerId,
        }),
      ),
    [run, supabase, eventId],
  );

  const setTee = useCallback(
    (playerId: string, tee: string | null) =>
      run(
        supabase.rpc("admin_event_set_tee", {
          in_event_id: eventId,
          in_player_id: playerId,
          in_tee: tee,
        }),
      ),
    [run, supabase, eventId],
  );

  const setFormat = useCallback(
    (formatId: string, teamSize: number) =>
      run(
        supabase.rpc("admin_event_set_format", {
          in_event_id: eventId,
          in_format_id: formatId,
          in_team_size: teamSize,
        }),
      ),
    [run, supabase, eventId],
  );

  const setFlags = useCallback(
    (flags: { counts?: boolean; simulator?: boolean }) =>
      run(
        supabase.rpc("admin_event_set_flags", {
          in_event_id: eventId,
          in_counts: flags.counts ?? null,
          in_simulator: flags.simulator ?? null,
        }),
      ),
    [run, supabase, eventId],
  );

  /**
   * Draft the players who said they're in, and save the result.
   *
   * Only "in" and a guest are seated. Someone who hasn't answered is not put
   * on a side by a button press — that is the admin deciding for them.
   */
  const buildTeams = useCallback(async () => {
    if (state.status !== "ready") return "Event not loaded.";

    const playing: FieldPlayer[] = state.data.roster
      .filter((r) => r.status === "in" || r.isGuest)
      .map((r) => ({ id: r.id, name: r.name, handicapIndex: r.handicapIndex }));

    const { teams } = draftTeams(playing, state.data.event.teamSize);

    return run(
      supabase.rpc("admin_event_set_teams", {
        in_event_id: eventId,
        in_teams: teams.map((t) => t.players.map((p) => p.id)),
      }),
    );
  }, [state, run, supabase, eventId]);

  /** Move a player onto another side, keeping every other side as it is. */
  const movePlayer = useCallback(
    async (playerId: string, toTeamId: string | null) => {
      if (state.status !== "ready") return "Event not loaded.";

      const sides = state.data.teams.map((t) => ({
        id: t.id,
        memberIds: t.memberIds.filter((id) => id !== playerId),
      }));
      const target = sides.find((s) => s.id === toTeamId);
      if (target) target.memberIds.push(playerId);

      return run(
        supabase.rpc("admin_event_set_teams", {
          in_event_id: eventId,
          in_teams: sides.filter((s) => s.memberIds.length > 0).map((s) => s.memberIds),
        }),
      );
    },
    [state, run, supabase, eventId],
  );

  /**
   * Trade two players' places.
   *
   * Tap one, tap another: they change places. A swap rather than two moves
   * because two moves pass through a state where one side is a man short and
   * the other a man over, and each of them is a write — if the second failed
   * the sides would be left wrong. This sends the finished arrangement.
   *
   * Either player may be a leftover, sitting on no side at all, in which case
   * this is the move that seats them and benches the other.
   */
  const swapPlayers = useCallback(
    async (a: string, b: string) => {
      if (state.status !== "ready") return "Event not loaded.";
      if (a === b) return null;

      const sides = state.data.teams.map((t) => ({
        id: t.id,
        memberIds: t.memberIds.map((id) => (id === a ? b : id === b ? a : id)),
      }));

      return run(
        supabase.rpc("admin_event_set_teams", {
          in_event_id: eventId,
          in_teams: sides.filter((s) => s.memberIds.length > 0).map((s) => s.memberIds),
        }),
      );
    },
    [state, run, supabase, eventId],
  );

  return {
    state,
    reload: load,
    invite,
    addGuest,
    removePlayer,
    setAnswer,
    setTee,
    setFormat,
    setFlags,
    buildTeams,
    movePlayer,
    swapPlayers,
  };
}
