"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Entry, FormatId } from "./formats";
import { createClient } from "./supabase/client";

export type EventPlayer = { id: string; name: string; position: number };
export type EventTeam = {
  id: string;
  name: string | null;
  position: number;
  memberIds: string[];
};
export type EventHole = {
  hole: number;
  par: number;
  strokeIndex: number | null;
  /** Yardage per tee colour, e.g. { white: 350 }. Empty when unknown. */
  yardages: Record<string, number>;
};

export type EventTeeTime = {
  id: string;
  /** Already formatted, e.g. "8:10a". */
  teeAt: string;
  position: number;
  teamIds: string[];
};

export type EventSummary = {
  id: string;
  name: string;
  played_on: string;
  format: FormatId;
  hole_count: number;
  /** Null when the organiser named a place instead of picking a real course. */
  course_id: string | null;
  course_name: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Some outings play skins, some don't; the stake is whatever was agreed. */
  skins_enabled: boolean;
  skins_stake: number;
};

export type EventState = {
  event: EventSummary;
  players: EventPlayer[];
  teams: EventTeam[];
  scores: Entry[];
  holes: EventHole[];
  teeTimes: EventTeeTime[];
  /** Rating and slope per tee, which belong to the tee not the course. */
  tees: {
    tee: string;
    courseRating: number | null;
    slope: number | null;
    statedYardage: number | null;
  }[];
};

type Status =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: EventState };

/** Remembers which player this device is, so nobody re-picks on every refresh. */
const identityKey = (token: string) => `golf.event.${token}.player`;

export function readIdentity(token: string): string | null {
  try {
    return localStorage.getItem(identityKey(token));
  } catch {
    // Private browsing, or storage blocked. Falls back to picking each visit.
    return null;
  }
}

export function writeIdentity(token: string, playerId: string | null): void {
  try {
    if (playerId === null) localStorage.removeItem(identityKey(token));
    else localStorage.setItem(identityKey(token), playerId);
  } catch {
    // Not being able to remember is survivable; failing to score is not.
  }
}

/**
 * Loads an event by its share token and keeps it live.
 *
 * There is no login here. The token is the credential, and it never leaves the
 * URL — every call goes through `event_state` / `event_score_submit`, which are
 * the only things an anonymous caller is allowed to run.
 */
export function useEvent(token: string) {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<Status>({ status: "loading" });

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("event_state", { token });

    if (error) {
      setState({
        status: "error",
        message:
          error.code === "P0002" || /no event found/i.test(error.message)
            ? "That link doesn't match an event. Check it with whoever sent it."
            : error.message,
      });
      return;
    }

    setState({ status: "ready", data: data as unknown as EventState });
  }, [supabase, token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const eventId = state.status === "ready" ? state.data.event.id : null;

  // Everyone on the link sees scores as they land.
  useEffect(() => {
    if (!eventId) return;

    const channel = supabase
      .channel(`event:${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "event_scores",
          filter: `event_id=eq.${eventId}`,
        },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, eventId, load]);

  /** Returns a refusal message, or null when the score was accepted. */
  const submit = useCallback(
    async (
      teamId: string,
      playerId: string | null,
      hole: number,
      strokes: number,
      enteredBy: string,
    ) => {
      const { data, error } = await supabase.rpc("event_score_submit", {
        token,
        in_team_id: teamId,
        in_player_id: playerId,
        in_hole: hole,
        in_strokes: strokes,
        in_entered_by: enteredBy,
      });

      if (error) return error.message;

      // The function hands back fresh state, so there is no second round trip.
      setState({ status: "ready", data: data as unknown as EventState });
      return null;
    },
    [supabase, token],
  );

  return { state, submit, reload: load };
}
