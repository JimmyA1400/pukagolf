"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Score } from "./leaderboard";
import {
  addPending,
  addPendingTeam,
  drainQueue,
  hasWaited,
  readPending,
  type DrainResult,
  type PendingScore,
} from "./score-queue";
import type { CoursePars } from "./scorecard";
import type { Assignment, ScoringMode } from "./scoring-rules";
import { useClub } from "./club";
import { createClient } from "./supabase/client";
import type { Profile, Round } from "./supabase/types";

export type LiveRound = {
  round: Round;
  course: {
    id: string | null;
    name: string;
    holeCount: number;
    /** 10 for a back-nine week; scores keep the real hole numbers. */
    startHole: number;
    latitude: number | null;
    longitude: number | null;
    locationName: string | null;
    attribution: string | null;
  };
  players: Profile[];
  pars: CoursePars;
  /** Hole rows as stored, so the admin can correct par and stroke index. */
  holes: {
    hole: number;
    par: number;
    strokeIndex: number | null;
    yards: number | null;
    /** Yardage per tee colour, e.g. { white: 350 }. */
    yardages: Record<string, number>;
  }[];
  /** Rating and slope per tee, for the tee dropdown. */
  tees: {
    tee: string;
    courseRating: number | null;
    slope: number | null;
    statedYardage: number | null;
  }[];
  scores: Score[];
  assignments: Assignment[];
  /** Group membership, used for the skins pot and the tee sheet. */
  groups: {
    id: string;
    teeAt: string;
    /** How many this tee time holds: 3 for a threesome, not 4 with a gap. */
    seats: number;
    playerIds: string[];
    /** The tee each player played, where recorded, for net scoring. */
    playedTees: Record<string, string>;
  }[];
  settings: RoundSettings;
  feed: FeedPost[];
  /** Who enters scores in this league. */
  scoringMode: ScoringMode;
  /** The pad stops a hole at double par: the league's pick-up rule (0058). */
  doubleParCap: boolean;
  /** Cards signed off, or locked by an admin. A final week locks every card. */
  lockedPlayerIds: string[];
  /** Each card's own lock: signed by the group or locked by an admin, and by whom. */
  cardLocks: Record<string, { how: "signed" | "admin"; by: string | null; at?: string | null }>;
  /**
   * Cards the player kept themselves: every hole on them was entered by the
   * player whose card it is. Normal under Self Scoring; anywhere else it
   * means nobody else attested it, and the page says so.
   */
  selfKept: string[];
  /** A club admin, or staff the admin has let fix scores. */
  canFixScores: boolean;
  /** Players this week with no login, who can't keep anybody's card. */
  noLogin: string[];
  /** The week is in a season its league has closed. */
  seasonClosed: boolean;
};

/** One line of a card's history, as card_history() returns it. */
export type CardHistoryEntry = {
  at: string;
  action: string;
  entity: "score" | "card";
  by: string;
  hole: number | null;
  strokes: number | null;
  from: number | null;
  to: number | null;
  /** Why a signed-off card, or one in a closed season, was changed. */
  reason?: string | null;
  /** The card's state when it was changed: "signed_off" or "season_closed". */
  cardWas?: string | null;
  /** When the hole was entered on the phone, for one that waited for signal (0057). */
  phoneAt?: string | null;
};

export type RoundSettings = {
  skins_enabled: boolean;
  skins_stake: number;
  temp_f: number | null;
  wind: string | null;
  greens: string | null;
  sunset: string | null;
};

export type FeedPost = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  /**
   * Age at load time. Computed here rather than while rendering — reading the
   * clock during render is impure, and every realtime event reloads anyway.
   */
  ageMinutes: number;
};

/**
 * One entry per tee colour, keeping the longest.
 *
 * A course is rated separately per gender, so the same physical tee appears
 * twice; showing both would put "Blue" in the dropdown two times.
 */
function dedupeTees(
  rows: readonly {
    tee_key: string;
    tee_color: string | null;
    course_rating: number | null;
    slope: number | null;
    yardage: number | null;
  }[],
): LiveRound["tees"] {
  const best = new Map<string, LiveRound["tees"][number]>();

  for (const row of rows) {
    const tee = (row.tee_color ?? row.tee_key).toLowerCase();
    const existing = best.get(tee);

    if (!existing || (row.yardage ?? 0) > (existing.statedYardage ?? 0)) {
      best.set(tee, {
        tee,
        courseRating: row.course_rating,
        slope: row.slope,
        statedYardage: row.yardage,
      });
    }
  }

  return [...best.values()];
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: LiveRound; viewer: Profile };

/**
 * Loads the current round and keeps it live.
 *
 * Reads go through RLS, so this only ever sees what the signed-in player is
 * allowed to see. Writes are attempted optimistically and reconciled against
 * what the database actually accepted — the policies and triggers, not this
 * hook, decide what sticks.
 */
export function useLiveRound(weekId: string | null = null) {
  const supabase = useMemo(() => createClient(), []);
  const { club, league } = useClub();
  const isClubAdmin = club.role === "admin";
  const leagueId = league?.id ?? null;
  const clubId = club.id;
  const [state, setState] = useState<State>({ status: "loading" });

  // Loads overlap: a change made here reloads, and so does the realtime
  // signal the same change sends. Only the latest load is shown, so one that
  // started before the change and finished after it can't put the old card
  // back on screen (a fixed total once read 50 after it had become 49).
  const loadSeq = useRef(0);
  // The newest load whose answer is on screen.
  const [shownSeq, setShownSeq] = useState(0);

  const loadNow = useCallback(async () => {
    const seq = ++loadSeq.current;
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setState({ status: "error", message: "Not signed in." });
      return;
    }

    const { data: viewer } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (!leagueId) {
      setState({ status: "error", message: "This club has no league yet." });
      return;
    }

    // The league's most recent week wins. With more than one league, "the
    // latest week" has to mean this league's, or one league's page would
    // show another's. A past week asked for by the admin page, to fix one
    // card in it, is that week, if it is this league's.
    const latestWeek = () =>
      supabase
        .from("rounds")
        .select("*")
        .eq("league_id", leagueId)
        .order("played_on", { ascending: false })
        .limit(1)
        .maybeSingle();
    const asked = weekId
      ? await supabase.from("rounds").select("*").eq("league_id", leagueId).eq("id", weekId).maybeSingle()
      : null;
    const { data: round, error: roundError } = asked?.data ? asked : await latestWeek();

    if (roundError || !round || !viewer) {
      setState({
        status: "error",
        message: roundError?.message ?? "No round has been set up yet.",
      });
      return;
    }

    const [teeTimes, membership, scores, courseHoles, course, courseTees] =
      await Promise.all([
        supabase.from("tee_times").select("*").eq("round_id", round.id),
        supabase.from("tee_time_players").select("*").eq("round_id", round.id),
        supabase.from("scores").select("*").eq("round_id", round.id),
        round.course_id
          ? supabase
              .from("course_holes")
              .select("*")
              .eq("course_id", round.course_id)
          : Promise.resolve({ data: [] }),
        round.course_id
          ? supabase
              .from("courses")
              .select("*")
              .eq("id", round.course_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        round.course_id
          ? supabase
              .from("course_tees")
              .select("*")
              .eq("course_id", round.course_id)
          : Promise.resolve({ data: [] }),
      ]);

    const playerIds = (membership.data ?? []).map((m) => m.player_id);
    const { data: current } = await supabase
      .from("profiles")
      .select("*")
      .in("id", playerIds.length ? playerIds : ["-"]);

    // A final week is shown on the handicaps it was settled on, the same ones
    // the standings rank it by, not on whatever index each player has today.
    let players = current;
    if (round.status === "final" && current) {
      const { data: frozen } = await supabase
        .from("round_handicaps")
        .select("player_id, handicap_index")
        .eq("round_id", round.id);
      const then = new Map((frozen ?? []).map((f) => [f.player_id, f.handicap_index]));
      players = current.map((p) =>
        then.has(p.id) ? { ...p, handicap_index: then.get(p.id) ?? null } : p,
      );
    }

    const teeTimeIds = (teeTimes.data ?? []).map((t) => t.id);
    const { data: assignments } = await supabase
      .from("scorer_assignments")
      .select("*")
      .in("tee_time_id", teeTimeIds.length ? teeTimeIds : ["-"]);

    const [settings, feed, rules, locks, fixer, noLogin, closed, cap] = await Promise.all([
      supabase
        .from("round_settings")
        .select("*")
        .eq("round_id", round.id)
        .maybeSingle(),
      supabase
        .from("feed_posts")
        .select("*")
        .eq("round_id", round.id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("league_rules")
        .select("scoring_mode")
        .eq("league_id", leagueId)
        .maybeSingle(),
      supabase
        .from("card_locks")
        .select("player_id, how, locked_by, locked_at")
        .eq("round_id", round.id),
      supabase.rpc("can_fix_scores", { in_club_id: clubId }),
      supabase.rpc("round_players_without_login", { in_round_id: round.id }),
      supabase
        .from("seasons")
        .select("year")
        .eq("league_id", leagueId)
        .eq("year", Number(round.played_on.slice(0, 4))),
      supabase.from("league_rules").select("double_par_cap").eq("league_id", leagueId).maybeSingle(),
    ]);

    const groups = (teeTimes.data ?? [])
      .map((teeTime) => ({
        id: teeTime.id,
        teeAt: teeTime.tee_at,
        seats: teeTime.seats ?? 4,
        playerIds: (membership.data ?? [])
          .filter((m) => m.tee_time_id === teeTime.id)
          .sort((a, b) => a.position - b.position)
          .map((m) => m.player_id),
        playedTees: Object.fromEntries(
          (membership.data ?? [])
            .filter((m) => m.tee_time_id === teeTime.id && m.played_tee)
            .map((m) => [m.player_id, m.played_tee as string]),
        ),
      }))
      .sort((a, b) => a.teeAt.localeCompare(b.teeAt));

    if (seq !== loadSeq.current) return;
    setShownSeq(seq);

    setState({
      status: "ready",
      viewer,
      data: {
        round,
        course: {
          id: round.course_id,
          name: course.data?.name ?? "Course",
          holeCount: round.hole_count,
          startHole: round.start_hole ?? 1,
          latitude: course.data?.latitude ?? null,
          longitude: course.data?.longitude ?? null,
          locationName: course.data?.location_name ?? null,
          attribution: course.data?.attribution ?? null,
        },
        players: players ?? [],
        pars: Object.fromEntries(
          (courseHoles.data ?? []).map((h) => [h.hole, h.par]),
        ),
        holes: [...(courseHoles.data ?? [])]
          .sort((a, b) => a.hole - b.hole)
          .map((h) => ({
            hole: h.hole,
            par: h.par,
            strokeIndex: h.handicap_index ?? null,
            yards: null,
            yardages: (h.yardages ?? {}) as Record<string, number>,
          })),
        tees: dedupeTees(courseTees.data ?? []),
        scores: (scores.data ?? []).map((s) => ({
          playerId: s.player_id,
          hole: s.hole,
          strokes: s.strokes,
        })),
        assignments: (assignments ?? []).map((a) => ({
          scorerId: a.scorer_player_id,
          scoredId: a.scored_player_id,
        })),
        groups,
        settings: settings.data ?? {
          skins_enabled: true,
          skins_stake: 0,
          temp_f: null,
          wind: null,
          greens: null,
          sunset: null,
        },
        scoringMode: rules.data?.scoring_mode ?? "partner",
        // Read apart: a database from before 0058 has no such column, and
        // asking for it with the mode would lose the mode too.
        doubleParCap: cap.data?.double_par_cap !== false,
        lockedPlayerIds:
          round.status === "final"
            ? playerIds
            : (locks.data ?? []).map((l) => l.player_id),
        cardLocks: Object.fromEntries(
          (locks.data ?? []).map((l) => [
            l.player_id,
            {
              how: l.how === "admin" ? "admin" : "signed",
              by: l.locked_by ?? null,
              at: l.locked_at ?? null,
            },
          ]),
        ),
        selfKept: selfKeptCards(scores.data ?? []),
        canFixScores: fixer.data === true,
        noLogin: Array.isArray(noLogin.data) ? (noLogin.data as string[]) : [],
        seasonClosed: (closed.data ?? []).length > 0,
        feed: (feed.data ?? []).map((post) => ({
          ...post,
          ageMinutes: Math.max(
            0,
            Math.round(
              (Date.now() - new Date(post.created_at).getTime()) / 60000,
            ),
          ),
        })),
      },
    });
  }, [supabase, leagueId, clubId, weekId]);

  // One load at a time, and at most one more waiting behind it for every
  // call made meanwhile. Started on every save, a load a third of a second
  // was overtaken by the next before it could answer, so for half a minute
  // of fast Team Card saves nothing new reached the screen and the pad kept
  // redrawing under the finger.
  const running = useRef<Promise<void> | null>(null);
  const waiting = useRef<Promise<void> | null>(null);
  const again = useRef<() => Promise<void>>(() => Promise.resolve());
  const load = useCallback((): Promise<void> => {
    if (!running.current) {
      const now = loadNow().finally(() => {
        running.current = null;
      });
      running.current = now;
      return now;
    }
    waiting.current ??= running.current.then(() => {
      waiting.current = null;
      return again.current();
    });
    return waiting.current;
  }, [loadNow]);
  useEffect(() => {
    again.current = load;
    // A different week or league starts afresh rather than waiting its turn.
    running.current = null;
    waiting.current = null;
  }, [load]);

  useEffect(() => {
    // load() is async: the setState happens after an await, not during this
    // effect body. Fetching on mount is exactly what this effect is for.
    void load();
  }, [load]);

  const roundId = state.status === "ready" ? state.data.round.id : null;

  // Live updates: any score or reassignment anywhere in the round refetches.
  // Coarse, but a round is small and it can't drift out of step.
  //
  // Keyed on the round id alone. Depending on the whole state object would tear
  // the channel down and rebuild it on every reload — including the reloads
  // this subscription itself triggers.
  useEffect(() => {
    if (!roundId) return;

    const channel = supabase
      .channel(`round:${roundId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "scores",
          filter: `round_id=eq.${roundId}`,
        },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scorer_assignments" },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "round_settings" },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "feed_posts" },
        () => void load(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "card_locks",
          filter: `round_id=eq.${roundId}`,
        },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, load, roundId]);

  // Scores waiting on this phone for a signal (see score-queue.ts).
  const [pending, setPending] = useState<PendingScore[]>([]);
  // Scores that have gone up but aren't in a loaded card yet, each with the
  // load that will have them: the first one started after they landed.
  const [landed, setLanded] = useState<(PendingScore & { seenFrom: number })[]>([]);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const sending = useRef(false);

  // The round as last loaded, for naming players in a refusal without making
  // every send depend on (and re-create with) each reload.
  const latest = useRef<LiveRound | null>(null);
  useEffect(() => {
    latest.current = state.status === "ready" ? state.data : null;
  }, [state]);

  /**
   * Send whatever is waiting (see drainQueue in score-queue.ts). Returns the
   * scores that didn't go up and why, as one message, or null.
   */
  const sendPending = useCallback(async (): Promise<string | null> => {
    if (!roundId || sending.current) return null;

    sending.current = true;
    let result: DrainResult = { sent: 0, landed: [], problems: [], waiting: false };

    try {
      result = await drainQueue(roundId, {
        // Given up on after a while: a request that hangs in a weak spot
        // would otherwise hold every score behind it until the phone gave up.
        send: async (item) => {
          if (item.teeTimeId) {
            const { error, status } = await supabase
              .rpc("enter_team_score", {
                in_round_id: roundId,
                in_tee_time_id: item.teeTimeId,
                in_hole: item.hole,
                in_strokes: item.strokes,
              })
              .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS));
            return { error, status };
          }

          const upsert = (phoneAt: string | null, strokes = item.strokes) =>
            supabase
              .from("scores")
              .upsert(
                {
                  round_id: roundId,
                  player_id: item.playerId,
                  hole: item.hole,
                  strokes,
                  entered_by: item.enteredBy,
                  ...(phoneAt ? { entered_on_phone_at: phoneAt } : {}),
                },
                { onConflict: "round_id,player_id,hole" },
              )
              .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS));

          // A hole that waited for signal says when it was really entered.
          const phoneAt = enteredOnPhone(item);
          let { error, status } = await upsert(phoneAt);
          // A database from before 0057 has no column for it: send it plain.
          if (error && phoneAt && /entered_on_phone_at/.test(error.message)) {
            ({ error, status } = await upsert(null));
          }
          return { error, status };
        },
        current: async (item) => {
          const { data, error } = await supabase
            .from("scores")
            .select("strokes, entered_by")
            .eq("round_id", roundId)
            .eq("player_id", item.playerId)
            .eq("hole", item.hole)
            // Its own tries are the queue's: the client's, 1s, 2s and 4s
            // apart on a 503, held "That try failed" back 7 seconds.
            .retry(false)
            .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS));
          if (error) return "no-signal";
          const row = (data ?? [])[0] as { strokes: number; entered_by: string | null } | undefined;
          return row ? { strokes: row.strokes, enteredBy: row.entered_by } : null;
        },
        online: () => navigator.onLine,
        refused: (item, error) => refusalLine(latest.current, item, error, isClubAdmin),
        overtaken: (item, theirs) =>
          `${whose(latest.current, item)} hole ${item.hole}: someone else has since entered ${theirs}, so your ${item.strokes} wasn't sent. Check the card.`,
        // Held on screen until a load that started after they landed is
        // shown, so the hole never goes blank between the queue and the
        // reload. Set the moment each lands, in the same tick as the queue:
        // waiting for the whole pass let a hole entered meanwhile redraw the
        // card without them, and show the old number.
        landed: (items) => {
          const seenFrom = loadSeq.current + 1;
          setLanded((now) => [...now, ...items.map((item) => ({ ...item, seenFrom }))]);
          setPending(readPending(roundId));
        },
      });
    } finally {
      sending.current = false;
      setPending(readPending(roundId));
    }

    if (result.sent > 0 || result.problems.length > 0) await load();
    return result.problems.length > 0 ? result.problems.join(" ") : null;
  }, [supabase, roundId, load, isClubAdmin]);

  /**
   * Returns a refusal message, or null when the score was accepted — or is
   * waiting on this phone for a signal, which the page shows separately.
   */
  const submitScore = useCallback(
    async (targetId: string, hole: number, strokes: number) => {
      if (state.status !== "ready") return "Round not loaded.";

      setQueueNotice(null);
      setPending(
        addPending(state.data.round.id, {
          playerId: targetId,
          hole,
          strokes,
          enteredBy: state.viewer.id,
        }),
      );

      return sendPending();
    },
    [state, sendPending],
  );

  /**
   * A scramble hole: one number for the whole tee time.
   *
   * Queued per card like any other score, so it shows on everyone's straight
   * away and survives a dead spot, and sent as one call.
   */
  const submitTeamScore = useCallback(
    async (teeTimeId: string, hole: number, strokes: number) => {
      if (state.status !== "ready") return "Round not loaded.";

      const group = state.data.groups.find((g) => g.id === teeTimeId);
      if (!group) return "That group isn't in this week.";

      setQueueNotice(null);
      setPending(
        addPendingTeam(state.data.round.id, {
          teeTimeId,
          playerIds: group.playerIds,
          hole,
          strokes,
          enteredBy: state.viewer.id,
        }),
      );

      return sendPending();
    },
    [state, sendPending],
  );

  /** The group signs its cards. Returns a refusal, or null. */
  const signOffGroup = useCallback(
    async (teeTimeId: string) => {
      if (readPending(roundId ?? "").length > 0) {
        return "Some holes haven't gone up yet. Sign once they're sent, so the cards you sign are the ones the pro shop has.";
      }
      const { error } = await supabase.rpc("sign_off_group", { in_tee_time_id: teeTimeId });
      if (error) return plainError(error, "The cards weren't signed");
      // Signed the moment the database says so; the reload, which reads the
      // whole week, catches up behind it instead of holding "Signing…" up.
      setState((now) => {
        if (now.status !== "ready") return now;
        const group = now.data.groups.find((g) => g.id === teeTimeId);
        if (!group) return now;
        const at = new Date().toISOString();
        const cardLocks = { ...now.data.cardLocks };
        for (const id of group.playerIds) {
          cardLocks[id] ??= { how: "signed", by: now.viewer.id, at };
        }
        return {
          ...now,
          data: {
            ...now.data,
            cardLocks,
            lockedPlayerIds: [...new Set([...now.data.lockedPlayerIds, ...group.playerIds])],
          },
        };
      });
      void load();
      return null;
    },
    [supabase, load, roundId],
  );

  /**
   * A club admin takes back a group's sign-off: every card the group signed,
   * the admin's own included. Returns a refusal, or null.
   */
  const takeBackSignOff = useCallback(
    async (playerId: string, reason?: string) => {
      if (state.status !== "ready") return "Round not loaded.";
      const { error } = await supabase.rpc("admin_take_back_sign_off", {
        in_round_id: state.data.round.id,
        in_player_id: playerId,
        // Only a final week takes one (0058); a database from before has no
        // argument for it.
        ...(reason ? { in_reason: reason } : {}),
      });
      if (error) return plainError(error, "The sign-off wasn't taken back");
      // Off the cards the moment the database says so, as a sign-off goes
      // on: the card said "Signed off" until a reload in a final week.
      setState((now) => {
        if (now.status !== "ready") return now;
        const group = now.data.groups.find((g) => g.playerIds.includes(playerId));
        const freed = (group?.playerIds ?? [playerId]).filter(
          (id) => now.data.cardLocks[id]?.how === "signed",
        );
        const cardLocks = { ...now.data.cardLocks };
        for (const id of freed) delete cardLocks[id];
        return {
          ...now,
          data: {
            ...now.data,
            cardLocks,
            // A final week keeps every card locked; only the sign-off goes.
            lockedPlayerIds:
              now.data.round.status === "final"
                ? now.data.lockedPlayerIds
                : now.data.lockedPlayerIds.filter((id) => !freed.includes(id)),
          },
        };
      });
      void load();
      return null;
    },
    [supabase, state, load],
  );

  /** A club admin locks or unlocks one card. Returns a refusal, or null. */
  const setCardLock = useCallback(
    async (playerId: string, locked: boolean) => {
      if (state.status !== "ready") return "Round not loaded.";
      const { error } = await supabase.rpc("admin_set_card_lock", {
        in_round_id: state.data.round.id,
        in_player_id: playerId,
        in_locked: locked,
      });
      if (error) return plainError(error, "The card wasn't changed");
      await load();
      return null;
    },
    [supabase, state, load],
  );

  /**
   * A club admin changes a signed-off card, or one in a closed season, and
   * says why. Straight to the database rather than the phone's queue: it is a
   * pro shop job, and the reason has to arrive with the score.
   */
  const fixSignedScore = useCallback(
    async (playerId: string, hole: number, strokes: number, reason: string) => {
      if (state.status !== "ready") return "Round not loaded.";
      const { error } = await supabase.rpc("admin_fix_signed_score", {
        in_round_id: state.data.round.id,
        in_player_id: playerId,
        in_hole: hole,
        in_strokes: strokes,
        in_reason: reason,
      });
      if (error) return plainError(error, `Hole ${hole} wasn't changed`);
      await load();
      return null;
    },
    [supabase, state, load],
  );

  /** Every change to one card, oldest first, for a club admin. */
  const cardHistory = useCallback(
    async (playerId: string): Promise<CardHistoryEntry[] | string> => {
      if (state.status !== "ready") return "Round not loaded.";
      const { data, error } = await supabase.rpc("card_history", {
        in_round_id: state.data.round.id,
        in_player_id: playerId,
      });
      if (error) return plainError(error, "The history didn't load");
      return (data as CardHistoryEntry[] | null) ?? [];
    },
    [supabase, state],
  );

  // Whatever was left from last time (the page closed with no signal) goes
  // now; after that, when the connection comes back, and every few seconds
  // while anything is still waiting.
  useEffect(() => {
    if (!roundId) return;

    const retry = () =>
      void sendPending().then((refusal) => {
        if (refusal) setQueueNotice(refusal);
      });

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(readPending(roundId));
    retry();

    // A phone put back in a pocket and taken out again often has signal by then.
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };

    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    // With signal but no answer, nothing says when PukaGolf is back, so it's
    // asked often: every 15 seconds left scores 13.5s late after it was. With
    // no signal the "online" event says when, and the slow tick is a backstop.
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (readPending(roundId).length === 0) return;
      if (navigator.onLine || ticks % SLOW_EVERY === 0) retry();
    }, RETRY_EVERY_MS);

    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [roundId, sendPending]);

  const updateSettings = useCallback(
    async (patch: Partial<RoundSettings>) => {
      if (state.status !== "ready") return "Round not loaded.";

      const { error } = await supabase
        .from("round_settings")
        .update(patch)
        .eq("round_id", state.data.round.id);

      if (error) {
        return error.code === "42501"
          ? "Only an admin can change this."
          : error.message;
      }

      await load();
      return null;
    },
    [supabase, state, load],
  );

  const postToFeed = useCallback(
    async (body: string) => {
      if (state.status !== "ready") return "Round not loaded.";

      const { error } = await supabase.from("feed_posts").insert({
        round_id: state.data.round.id,
        // The policy also checks this, so a spoofed author is rejected.
        author_id: state.viewer.id,
        body,
      });

      if (error) return error.message;

      await load();
      return null;
    },
    [supabase, state, load],
  );

  const deletePost = useCallback(
    async (id: string) => {
      if (state.status !== "ready") return "Round not loaded.";

      const { error } = await supabase.from("feed_posts").delete().eq("id", id);

      if (error) {
        return error.code === "42501"
          ? "You can only delete your own posts."
          : error.message;
      }

      await load();
      return null;
    },
    [supabase, state, load],
  );

  /**
   * Import a real course and point this round at it.
   *
   * One action brings pars, stroke indexes, yardages, tee ratings and the
   * coordinates the weather panel needs — replacing hand-entered pars and a
   * separately searched location.
   */
  const importCourse = useCallback(
    async (externalId: string) => {
      if (state.status !== "ready") return "Round not loaded.";

      const detail = await fetch(`/api/courses/${externalId}`);
      const payload = await detail.json();

      if (!detail.ok) return payload.error ?? "Could not load that course.";
      if (payload.holes.length === 0) {
        return "That course has no hole data, so it can't be scored yet.";
      }

      // Into this club: each club keeps its own copy of a course.
      const { data: courseId, error } = await supabase.rpc("import_course", {
        payload,
        in_club_id: clubId,
      });

      if (error) {
        return error.code === "42501"
          ? "Only an admin can import a course."
          : error.message;
      }

      // Repoint the round, and match its hole count to the course's.
      const { error: roundError } = await supabase
        .from("rounds")
        .update({ course_id: courseId, hole_count: payload.hole_count })
        .eq("id", state.data.round.id);

      if (roundError) return roundError.message;

      await load();

      // Not a failure — the course imported. But the source's hole data is
      // community-maintained and sometimes contradicts itself, and scoring
      // against wrong pars makes every to-par figure wrong, so it is surfaced
      // rather than left to be discovered mid-round.
      return payload.parMismatch ?? null;
    },
    [supabase, state, load, clubId],
  );

  /** Where the course is, so conditions can be fetched for it. */
  const updateCourseLocation = useCallback(
    async (place: {
      latitude: number;
      longitude: number;
      timezone: string;
      label: string;
    }) => {
      if (state.status !== "ready") return "Round not loaded.";

      const courseId = state.data.course.id;
      if (!courseId) return "This round has no course attached.";

      const { error } = await supabase
        .from("courses")
        .update({
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone,
          location_name: place.label,
        })
        .eq("id", courseId);

      if (error) {
        return error.code === "42501"
          ? "Only an admin can set the course location."
          : error.message;
      }

      await load();
      return null;
    },
    [supabase, state, load],
  );

  // Once a load from after they landed is on screen, they're in it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanded((now) => (now.some((i) => i.seenFrom <= shownSeq) ? now.filter((i) => i.seenFrom > shownSeq) : now));
  }, [shownSeq]);

  // What the cards show on top of the saved scores: what's still waiting,
  // and what has landed but isn't in a loaded card yet.
  const showing = useMemo(
    () => [...landed.filter((item) => item.seenFrom > shownSeq), ...pending],
    [landed, pending, shownSeq],
  );

  return {
    state,
    showing,
    submitScore,
    submitTeamScore,
    signOffGroup,
    takeBackSignOff,
    setCardLock,
    fixSignedScore,
    cardHistory,
    updateSettings,
    updateCourseLocation,
    importCourse,
    postToFeed,
    deletePost,
    reload: load,
    pending,
    sendPending,
    queueNotice,
  };
}

/** How long one send may take before it counts as no signal. */
const SEND_TIMEOUT_MS = 20_000;

/** How often waiting scores are tried again while the phone has signal. */
const RETRY_EVERY_MS = 4_000;
/** With no signal, every this many of those: about every 16 seconds. */
const SLOW_EVERY = 4;

/** "Riley's" for a card, "Your group's" for a scramble hole. */
function whose(data: LiveRound | null, item: PendingScore): string {
  if (item.teeTimeId) return "Your group's";
  const name = data?.players.find((p) => p.id === item.playerId)?.full_name;
  return name ? `${name}'s` : "A player's";
}

/**
 * A score the database turned down, in words a golfer can act on. RLS refusals
 * arrive as a policy violation rather than a readable message, so the usual
 * causes are put back into words here.
 */
export function refusalLine(
  data: LiveRound | null,
  item: PendingScore,
  error: { code?: string; message: string; hint?: string },
  /** The phone is a club admin's. */
  admin = false,
): string {
  const what = `${whose(data, item)} hole ${item.hole} (${item.strokes}) wasn't saved:`;
  const lock = data?.cardLocks[item.playerId];

  // The database's own words, since 0056: locked, by whom and when. Truer
  // than this phone's copy of the card, which may predate the lock.
  if (error.hint === "card_locked" || error.message.startsWith("The card is locked")) {
    const words = lockedInWords(error.message);
    // "Ask a club admin", said to a club admin about their own card, which no
    // admin changes for themselves: say what they can do instead.
    if (admin && item.playerId === item.enteredBy) {
      // Without its last full stop, as a sentence follows: "3:02 AM.." had two.
      const why = words.replace(/\s*Only a club admin can change it now\.?$/, "").replace(/\.+$/, "");
      return /signed off/.test(why) && data?.round.status !== "final" && !data?.seasonClosed
        ? `${what} ${why}. It's your own card: take back the group's sign-off in "Fix any card", then score it again.`
        : `${what} ${why}. It's your own card, so another club admin changes it, with a reason.`;
    }
    return `${what} ${words}`;
  }

  if (data?.round.status === "final") {
    return `${what} the week is final. Ask the pro shop staff to change it.`;
  }
  if (data?.seasonClosed) {
    return `${what} the season is closed. Ask the pro shop staff to change it.`;
  }
  if (lock || data?.lockedPlayerIds.includes(item.playerId)) {
    return `${what} ${lock?.how === "admin" ? "the pro shop has locked that card" : "that card has been signed off"}. Ask the pro shop staff to change it.`;
  }
  if (error.code === "42501") {
    return `${what} you aren't allowed to enter a score for this player.`;
  }

  return `${what} ${error.message}`;
}

/**
 * The database's lock refusal, said once: "The card is locked: signed off by
 * Greg, ..." reads as "the card was signed off by Greg, ...", and "The card
 * is locked: the week is marked final." as "the week is marked final."
 */
export function lockedInWords(message: string): string {
  const rest = message.replace(/^The card is locked:\s*/, "");
  if (rest === message) return lowerFirstLetter(message);
  return /^(signed off|locked) by /.test(rest) ? `the card was ${rest}` : lowerFirstLetter(rest);
}

function lowerFirstLetter(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Players with a score on their card, every one of them entered by themselves. */
export function selfKeptCards(
  scores: readonly { player_id: string; entered_by: string | null }[],
): string[] {
  const own = new Map<string, boolean>();
  for (const s of scores) {
    own.set(s.player_id, (own.get(s.player_id) ?? true) && s.entered_by === s.player_id);
  }
  return [...own].filter(([, mine]) => mine).map(([id]) => id);
}

/**
 * A refusal in words, or, when the phone simply had no signal, that instead
 * of the browser's "TypeError: Failed to fetch".
 */
export function plainError(error: { message: string }, what: string): string {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return `${what}: no signal. Try again when you have signal.`;
  }
  // The phone has signal, but nothing answered: PukaGolf itself is down.
  if (/Failed to fetch|NetworkError|Load failed|network request failed|aborted|timed? ?out/i.test(error.message)) {
    return `${what}: can't reach PukaGolf right now. Try again in a minute.`;
  }
  return error.message;
}

/**
 * When a waiting hole was entered, for the card's history: for one entered
 * with no signal or held because PukaGolf didn't answer, a correction as much
 * as a first entry, and for one that sat on the phone a while. A hole that
 * went up at once was entered when it arrived. The history marks a hole that
 * has this time as entered offline.
 */
export function enteredOnPhone(item: PendingScore, now: number = Date.now()): string | null {
  if (!item.enteredAt) return null;
  if (!hasWaited(item) && now - item.enteredAt < PHONE_TIME_AFTER_MS) return null;
  return new Date(item.enteredAt).toISOString();
}

/** How long a hole waits on the phone before its history says when it was entered. */
const PHONE_TIME_AFTER_MS = 60_000;
