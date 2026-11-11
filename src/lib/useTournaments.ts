"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { FormatId } from "./formats";
import { useClub } from "./club";
import { createClient } from "./supabase/client";
import type { RsvpStatus } from "@/components/RsvpControl";

export type Tournament = {
  id: string;
  charity_id: string | null;
  name: string;
  description: string | null;
  played_on: string;
  course_id: string | null;
  course_name: string | null;
  format: FormatId;
  entry_fee: number;
  field_limit: number | null;
  rsvp_lock_at: string | null;
  completed_at: string | null;
  raised: number;
};

export type TournamentWithField = Tournament & {
  /** Everyone who has said they're in. */
  field: { playerId: string; name: string }[];
  myStatus: RsvpStatus | null;
  /** Null when there is no cap. */
  spotsRemaining: number | null;
};

export type CharityOption = { id: string; name: string };

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | {
      status: "ready";
      tournaments: TournamentWithField[];
      isAdmin: boolean;
      charities: CharityOption[];
    };

export function useTournaments() {
  const clubId = useClub().club.id;
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setState({ status: "signed-out" });
      return;
    }

    const [profile, tournaments, rsvps, players, charities] = await Promise.all([
      supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle(),
      supabase.from("tournaments").select("*").eq("club_id", clubId).order("played_on"),
      supabase.from("tournament_rsvps").select("*"),
      supabase.from("profiles").select("id, full_name"),
      supabase
        .from("charities")
        .select("id, name")
        .eq("club_id", clubId)
        .eq("active", true)
        .order("name"),
    ]);

    const nameOf = new Map(
      (players.data ?? []).map((p) => [p.id, p.full_name]),
    );

    setState({
      status: "ready",
      isAdmin: profile.data?.is_admin ?? false,
      charities: (charities.data ?? []) as CharityOption[],
      tournaments: (tournaments.data ?? []).map((t) => {
        const mine = (rsvps.data ?? []).filter((r) => r.tournament_id === t.id);
        const field = mine
          .filter((r) => r.status === "in")
          .map((r) => ({
            playerId: r.player_id,
            name: nameOf.get(r.player_id) ?? "Unknown",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        return {
          ...(t as Tournament),
          field,
          myStatus:
            (mine.find((r) => r.player_id === user.id)?.status as RsvpStatus) ??
            null,
          spotsRemaining:
            t.field_limit === null
              ? null
              : Math.max(0, t.field_limit - field.length),
        };
      }),
    });
  }, [supabase, clubId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const setRsvp = useCallback(
    async (tournamentId: string, status: RsvpStatus) => {
      const { error } = await supabase.rpc("set_tournament_rsvp", {
        in_tournament_id: tournamentId,
        in_status: status,
      });

      setNotice(error?.message ?? null);
      if (!error) await load();

      return error?.message ?? null;
    },
    [supabase, load],
  );

  const save = useCallback(
    async (tournament: Partial<Tournament> & { name: string; played_on: string }) => {
      const { error } = tournament.id
        ? await supabase
            .from("tournaments")
            .update(tournament)
            .eq("id", tournament.id)
        : await supabase.from("tournaments").insert({ ...tournament, club_id: clubId });

      if (error) return error.message;

      await load();
      return null;
    },
    [supabase, load, clubId],
  );

  const remove = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("tournaments").delete().eq("id", id);

      if (error) return error.message;

      await load();
      return null;
    },
    [supabase, load],
  );

  return { state, notice, setRsvp, save, remove, reload: load };
}
