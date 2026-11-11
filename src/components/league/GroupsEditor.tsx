"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getGame } from "@/lib/games";
import { cardKeeper, type ScoringMode } from "@/lib/scoring-rules";
import { parseHandicapInput } from "@/lib/handicap-index";
import { groupSizes } from "@/lib/league-groups";
import { createClient } from "@/lib/supabase/client";
import { formatTimeOfDay } from "@/lib/usePlayer";
import { useClub } from "@/lib/club";
import { clubClock, clubHHMM, clubInstant } from "@/lib/club-time";
import { teeGaps } from "@/lib/teetimes";

type RsvpAnswer = "in" | "out" | "undecided";

type GroupPlayer = {
  id: string;
  name: string;
  position: number;
  keptBy: string | null;
  isGuest?: boolean;
};

/** `seats` is how many the tee time holds: 3 for a threesome, not 4 with a gap. */
type Group = { id: string; teeAt: string; seats: number; players: GroupPlayer[] };

type Other = {
  id: string;
  name: string;
  rsvp: RsvpAnswer | null;
  preferredTeeTime: string | null;
  isGuest?: boolean;
};

/** The league's tee time defaults, from league_settings. */
type TeeDefaults = { firstTee: string; interval: number };

type Week = {
  round: {
    id: string;
    name: string;
    playedOn: string;
    status: "setup" | "live" | "final";
    rsvpLockAt: string | null;
    /** What the week is played for; in a team game each group is a side. */
    game: string;
    hasScores: boolean;
  };
  groups: Group[];
  others: Other[];
  rsvp: { in: number; out: number; undecided: number; noAnswer: number };
};

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "denied"; message: string }
  | { status: "ready"; week: Week; defaults: TeeDefaults; keeping: Keeping };

/** What "Card kept by" is worked out from: the same things the pad uses. */
type Keeping = {
  mode: ScoringMode;
  /** Who is given whose card, by player id. */
  assignments: { scorerId: string; scoredId: string }[];
  /** Players this week with no login. */
  noLogin: string[];
};

type RpcResult = { data: unknown; error: { message: string } | null };

const ANSWER_LABEL: Record<RsvpAnswer | "none", string> = {
  in: "In",
  out: "Out",
  undecided: "Maybe",
  none: "No answer",
};

/**
 * Groups and tee times for this week, for an admin.
 *
 * Every change is one database function that also rebuilds the scoring ring
 * of each group it touches, so who keeps whose card is always right. "This
 * week" is the latest week by date, the same one the league page shows.
 */
export function GroupsEditor() {
  const { club, href, league } = useClub();
  // Tee times are set and shown on the club's clock, whatever the phone's.
  const zone = club.timeZone;
  const leagueId = league?.id ?? null;
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!leagueId) {
      setState({ status: "empty" });
      return;
    }

    const { data: latest } = await supabase
      .from("rounds")
      .select("id")
      .eq("league_id", leagueId)
      .order("played_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest) {
      setState({ status: "empty" });
      return;
    }

    const [{ data, error }, settings, rules, noLogin, teeTimes] = await Promise.all([
      supabase.rpc("admin_week_groups", { in_round_id: latest.id }),
      supabase
        .from("league_rules")
        .select("first_tee_time, tee_interval_minutes")
        .eq("league_id", leagueId)
        .maybeSingle(),
      supabase.from("league_rules").select("scoring_mode").eq("league_id", leagueId).maybeSingle(),
      supabase.rpc("round_players_without_login", { in_round_id: latest.id }),
      supabase.from("tee_times").select("id").eq("round_id", latest.id),
    ]);
    const teeIds = (teeTimes.data ?? []).map((t) => t.id);
    const { data: assignments } = await supabase
      .from("scorer_assignments")
      .select("scorer_player_id, scored_player_id")
      .in("tee_time_id", teeIds.length ? teeIds : ["-"]);

    if (error) {
      setState({ status: "denied", message: error.message });
      return;
    }

    setState({
      status: "ready",
      week: data as unknown as Week,
      defaults: {
        firstTee: (settings.data?.first_tee_time ?? "08:00").slice(0, 5),
        interval: settings.data?.tee_interval_minutes ?? 10,
      },
      keeping: {
        mode: rules.data?.scoring_mode ?? "partner",
        assignments: (assignments ?? []).map((a) => ({
          scorerId: a.scorer_player_id,
          scoredId: a.scored_player_id,
        })),
        noLogin: Array.isArray(noLogin.data) ? (noLogin.data as string[]) : [],
      },
    });
  }, [supabase, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => PromiseLike<RpcResult>, success: string) => {
      setBusy(true);
      setNotice(null);
      const { error } = await action();
      setBusy(false);

      if (error) {
        setNotice({ ok: false, text: error.message });
        return false;
      }

      setNotice({ ok: true, text: success });
      await load();
      return true;
    },
    [load],
  );

  if (state.status === "loading") return <Centered>Loading…</Centered>;

  if (state.status === "empty") {
    return <Centered>No weeks yet. Start one from the admin page.</Centered>;
  }

  if (state.status === "denied") {
    return (
      <Centered>
        <p>{state.message}</p>
        <Link href={href("/league")} className="mt-3 underline">
          Back to the league
        </Link>
      </Centered>
    );
  }

  const { week, defaults, keeping } = state;
  const { round, groups, others, rsvp } = week;
  const unplacedIn = others.filter((o) => o.rsvp === "in");

  const place = (playerId: string, name: string, teeTimeId: string | null) => {
    const from = groups.findIndex((g) => g.players.some((p) => p.id === playerId));
    const to = groups.findIndex((g) => g.id === teeTimeId);
    return run(
      () =>
        supabase.rpc("admin_place_player", {
          in_round_id: round.id,
          in_player_id: playerId,
          in_tee_time_id: teeTimeId,
        }),
      !teeTimeId
        ? `${name} is out of this week.`
        : from === -1
          ? `${name} is in Group ${to + 1}. Its cards are reassigned.`
          : `${name} moved to Group ${to + 1}. Both groups' cards are reassigned.`,
    );
  };

  const setTime = (group: Group, hhmm: string) =>
    run(
      () =>
        supabase.rpc("admin_set_group_time", {
          in_tee_time_id: group.id,
          in_tee_at: clubInstant(round.playedOn, hhmm, zone),
        }),
      `Tee time changed to ${clubClock(clubInstant(round.playedOn, hhmm, zone), zone)}.`,
    );

  const addGroup = () => {
    const last = groups.at(-1);
    const hhmm = last ? addMinutes(clubHHMM(last.teeAt, zone), 10) : "08:00";

    return run(
      () =>
        supabase.rpc("admin_add_group", {
          in_round_id: round.id,
          in_tee_at: clubInstant(round.playedOn, hhmm, zone),
        }),
      `Added a group at ${clubClock(clubInstant(round.playedOn, hhmm, zone), zone)}.`,
    );
  };

  const setSeats = (group: Group, seats: number) =>
    run(
      () =>
        supabase.rpc("admin_set_group_seats", {
          in_tee_time_id: group.id,
          in_seats: seats,
        }),
      `That tee time now holds ${seats}.`,
    );

  const deleteGroup = (group: Group) =>
    run(
      () => supabase.rpc("admin_delete_group", { in_tee_time_id: group.id }),
      "Group removed.",
    );

  const build = (firstTee: string, interval: number, size: number) =>
    run(
      () =>
        supabase.rpc("admin_build_week_from_rsvps", {
          in_round_id: round.id,
          in_first_tee: clubInstant(round.playedOn, firstTee, zone),
          in_interval_minutes: interval,
          in_group_size: size,
        }),
      "Groups built from RSVPs. RSVPs are now locked for this week.",
    );

  const retime = (firstTee: string, interval: number) =>
    run(
      () =>
        supabase.rpc("admin_retime_groups", {
          in_round_id: round.id,
          in_first_tee: clubInstant(round.playedOn, firstTee, zone),
          in_interval_minutes: interval,
        }),
      `Groups re-timed from ${clubClock(clubInstant(round.playedOn, firstTee, zone), zone)}, ${interval} minutes apart.`,
    );

  const saveDefaults = (firstTee: string, interval: number) =>
    run(
      () =>
        supabase.rpc("admin_set_tee_defaults", {
          in_league_id: leagueId as string,
          in_first_tee: firstTee,
          in_interval: interval,
        }),
      `Re-timed, and the league default is now ${clubClock(clubInstant(round.playedOn, firstTee, zone), zone)}, every ${interval} minutes.`,
    );

  const addGuest = (name: string, handicap: number | null, teeTimeId: string) =>
    run(
      () =>
        supabase.rpc("admin_add_guest", {
          in_round_id: round.id,
          in_tee_time_id: teeTimeId,
          in_name: name,
          in_handicap: handicap,
        }),
      `${name} is in as a guest. Their group's cards are reassigned.`,
    );

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-5 sm:p-8">
      <header>
        <Link href={href("/league")} className="font-mono text-xs underline">
          ← The league
        </Link>
        <p className="meta mt-2">Admin</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Groups &amp; tee times
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {round.name} · {round.playedOn} ·{" "}
          {round.status === "setup" ? "setting up" : round.status}
        </p>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          RSVPs: {rsvp.in} in · {rsvp.out} out · {rsvp.undecided} maybe ·{" "}
          {rsvp.noAnswer} no answer ·{" "}
          {round.rsvpLockAt ? "locked" : "open"}
        </p>
      </header>

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.ok ? "border-forest text-forest" : "border-clay text-clay"
          }`}
        >
          {notice.text}
        </p>
      )}

      {getGame(round.game).team && (
        <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs">
          This week is {getGame(round.game).label.toLowerCase()}: each tee time
          plays as one side, so who sits where decides the teams.
        </p>
      )}

      {/* Once the groups are set by hand and nobody has answered, there is
          nothing to build from: the prompt only gets in the way. */}
      {(groups.length === 0 || rsvp.in > 0) && (
        <Section title="Build from RSVPs">
          <BuildFromRsvps
            key={round.id}
            inCount={rsvp.in}
            existingGroups={groups.length}
            hasScores={round.hasScores}
            defaultFirstTee={groups[0] ? clubHHMM(groups[0].teeAt, zone) : defaults.firstTee}
            defaultInterval={defaults.interval}
            busy={busy}
            onBuild={build}
          />
        </Section>
      )}

      <Section title="Groups" aside={`${groups.length}`}>
        {groups.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            No groups yet. Build them from RSVPs, or add one and place players
            by hand.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((group, index) => (
              <GroupCard
                key={group.id}
                group={group}
                index={index}
                groups={groups}
                keeping={keeping}
                busy={busy}
                onTime={(hhmm) => setTime(group, hhmm)}
                onSeats={(seats) => setSeats(group, seats)}
                onMove={(player, to) => place(player.id, player.name, to)}
                onDelete={() => deleteGroup(group)}
              />
            ))}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => void addGroup()}
          className="mt-3 min-h-11 border border-hairline bg-card px-4 font-mono text-xs tracking-wider uppercase hover:border-forest disabled:opacity-40"
        >
          Add a group
        </button>

        {groups.length > 0 && (
          <>
            <Retime
              key={`retime-${round.id}-${groups[0].teeAt}`}
              firstTee={clubHHMM(groups[0].teeAt, zone)}
              defaultInterval={defaults.interval}
              busy={busy}
              onRetime={retime}
              onSaveDefaults={saveDefaults}
            />
            <AddGuest key={`guest-${round.id}`} groups={groups} busy={busy} onAdd={addGuest} />
          </>
        )}
      </Section>

      <Section
        title="Not in a group"
        aside={
          unplacedIn.length > 0
            ? `${unplacedIn.length} said they're in`
            : `${others.length}`
        }
      >
        {others.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            Everyone in the league is in a group.
          </p>
        ) : (
          <ul className="border border-hairline bg-card px-4">
            {others.map((other) => (
              <li
                key={other.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-hairline py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-display text-base font-bold">
                    {other.name}
                    {other.isGuest ? <GuestBadge /> : <AnswerBadge answer={other.rsvp} />}
                  </p>
                  {other.preferredTeeTime && (
                    <p className="font-mono text-xs text-ink-soft">
                      Prefers {formatTimeOfDay(other.preferredTeeTime)}
                    </p>
                  )}
                </div>

                {groups.length > 0 && (
                  <select
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      if (e.target.value) {
                        void place(other.id, other.name, e.target.value);
                      }
                    }}
                    aria-label={`Put ${other.name} in a group`}
                    className="min-h-10 border border-hairline bg-cream px-2 font-mono text-xs"
                  >
                    <option value="">Put in…</option>
                    {groups.map((g, i) => (
                      <option
                        key={g.id}
                        value={g.id}
                        disabled={g.players.length >= g.seats}
                      >
                        Group {i + 1} · {clubClock(g.teeAt, zone)}
                        {g.players.length >= g.seats ? " (full)" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}

function BuildFromRsvps({
  inCount,
  existingGroups,
  hasScores,
  defaultFirstTee,
  defaultInterval,
  busy,
  onBuild,
}: {
  inCount: number;
  existingGroups: number;
  hasScores: boolean;
  defaultFirstTee: string;
  defaultInterval: number;
  busy: boolean;
  onBuild: (firstTee: string, interval: number, size: number) => Promise<boolean>;
}) {
  const [firstTee, setFirstTee] = useState(defaultFirstTee);
  const [interval, setInterval] = useState(defaultInterval);
  const [size, setSize] = useState(4);
  const [confirming, setConfirming] = useState(false);

  const sizes = groupSizes(inCount, size);

  if (hasScores) {
    return (
      <p className="font-mono text-xs text-ink-soft">
        This week already has scores, so its groups can&apos;t be rebuilt. Move
        players one at a time below instead.
      </p>
    );
  }

  return (
    <div className="space-y-3 border border-hairline bg-card p-4">
      <p className="font-mono text-xs text-ink-soft">
        Seats everyone who said they&apos;re in, earliest requested tee time
        first, in groups as even as possible and never a group of one. Building
        locks RSVPs for this week.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="First tee time">
          <input
            type="time"
            value={firstTee}
            onChange={(e) => setFirstTee(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Minutes apart">
          <select
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className={inputClass}
          >
            {gaps(defaultInterval).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Per group">
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className={inputClass}
          >
            {[4, 3, 2].map((n) => (
              <option key={n} value={n}>
                Up to {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="font-mono text-xs">
        {sizes.length === 0
          ? `${inCount === 1 ? "Only one player has" : "Nobody has"} said they're in yet.`
          : `${inCount} in → ${sizes.length} ${sizes.length === 1 ? "group" : "groups"}: ${sizes.join(" · ")}`}
      </p>

      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-clay">
            Replaces the {existingGroups} {existingGroups === 1 ? "group" : "groups"} already set.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              await onBuild(firstTee, interval, size);
              setConfirming(false);
            }}
            className="font-mono text-xs font-bold text-clay underline disabled:opacity-40"
          >
            Rebuild them
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="font-mono text-xs text-ink-soft underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || sizes.length === 0 || !firstTee}
          onClick={() => {
            if (existingGroups > 0) setConfirming(true);
            else void onBuild(firstTee, interval, size);
          }}
          className="min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          Build groups
        </button>
      )}
    </div>
  );
}

function GroupCard({
  group,
  index,
  groups,
  keeping,
  busy,
  onTime,
  onSeats,
  onMove,
  onDelete,
}: {
  group: Group;
  index: number;
  groups: Group[];
  keeping: Keeping;
  busy: boolean;
  onTime: (hhmm: string) => Promise<boolean>;
  onSeats: (seats: number) => Promise<boolean>;
  onMove: (player: GroupPlayer, to: string | null) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const zone = useClub().club.timeZone;
  const [time, setTime] = useState(clubHHMM(group.teeAt, zone));

  return (
    <article className="border border-hairline bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-lg font-bold">Group {index + 1}</p>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            onBlur={() => {
              if (time && time !== clubHHMM(group.teeAt, zone)) void onTime(time);
            }}
            aria-label={`Tee time for group ${index + 1}`}
            className="min-h-10 border border-hairline bg-cream px-2 font-mono text-sm"
          />
          <select
            value={group.seats}
            disabled={busy}
            onChange={(e) => void onSeats(Number(e.target.value))}
            aria-label={`How many group ${index + 1} holds`}
            className="min-h-10 border border-hairline bg-cream px-2 font-mono text-xs disabled:opacity-40"
          >
            {[2, 3, 4].map((n) => (
              <option key={n} value={n} disabled={n < group.players.length}>
                Holds {n}
              </option>
            ))}
          </select>
          <span className="meta">
            {group.players.length}/{group.seats}
          </span>
        </div>
      </div>

      {group.players.length === 1 && (
        <p className="mt-2 font-mono text-xs text-clay">
          A group of one has nobody to keep their card. Move someone in, or
          move this player to another group.
        </p>
      )}

      {group.players.length === 0 ? (
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="font-mono text-xs text-ink-soft">Empty.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onDelete()}
            className="font-mono text-xs text-clay underline disabled:opacity-40"
          >
            Remove group
          </button>
        </div>
      ) : (
        <ul className="mt-2">
          {group.players.map((player) => (
            <li
              key={player.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-hairline py-2"
            >
              <div className="min-w-0">
                <p className="font-display text-base">
                  {player.name}
                  {player.isGuest && <GuestBadge />}
                </p>
                <p className="font-mono text-xs text-ink-soft">
                  {keeperLine(player.id, group, keeping)}
                </p>
              </div>

              <select
                value={group.id}
                disabled={busy}
                onChange={(e) =>
                  void onMove(player, e.target.value === "out" ? null : e.target.value)
                }
                aria-label={`Move ${player.name}`}
                className="min-h-10 border border-hairline bg-cream px-2 font-mono text-xs"
              >
                {groups.map((g, i) => (
                  <option
                    key={g.id}
                    value={g.id}
                    disabled={g.id !== group.id && g.players.length >= g.seats}
                  >
                    Group {i + 1} · {clubClock(g.teeAt, zone)}
                    {g.id !== group.id && g.players.length >= g.seats ? " (full)" : ""}
                  </option>
                ))}
                <option value="out">Out of this week</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Respace this week's groups from a first tee time, in their current order.
 * Optionally saved as the league default for later weeks.
 */
function Retime({
  firstTee: current,
  defaultInterval,
  busy,
  onRetime,
  onSaveDefaults,
}: {
  firstTee: string;
  defaultInterval: number;
  busy: boolean;
  onRetime: (firstTee: string, interval: number) => Promise<boolean>;
  onSaveDefaults: (firstTee: string, interval: number) => Promise<boolean>;
}) {
  const [firstTee, setFirstTee] = useState(current);
  const [interval, setGap] = useState(defaultInterval);
  const [asDefault, setAsDefault] = useState(false);

  return (
    <div className="mt-4 space-y-3 border border-hairline bg-card p-4">
      <p className="meta">Re-time the groups</p>
      <p className="font-mono text-xs text-ink-soft">
        Keeps the groups in their order and spaces them out from the first tee
        time.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First tee time">
          <input
            type="time"
            value={firstTee}
            onChange={(e) => setFirstTee(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Minutes apart">
          <select
            value={interval}
            onChange={(e) => setGap(Number(e.target.value))}
            className={inputClass}
          >
            {gaps(defaultInterval).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <label className="flex items-center gap-2 font-mono text-xs">
        <input
          type="checkbox"
          checked={asDefault}
          onChange={(e) => setAsDefault(e.target.checked)}
          className="accent-forest"
        />
        Make this the league default too
      </label>

      <button
        type="button"
        disabled={busy || !firstTee}
        onClick={async () => {
          const moved = await onRetime(firstTee, interval);
          if (moved && asDefault) await onSaveDefaults(firstTee, interval);
        }}
        className="min-h-11 w-full border border-forest px-4 font-mono text-xs tracking-wider text-forest uppercase disabled:opacity-40"
      >
        Re-time groups
      </button>
    </div>
  );
}

/** Someone without an account, seated for this week. */
function AddGuest({
  groups,
  busy,
  onAdd,
}: {
  groups: Group[];
  busy: boolean;
  onAdd: (name: string, handicap: number | null, teeTimeId: string) => Promise<boolean>;
}) {
  const zone = useClub().club.timeZone;
  const open = groups.filter((g) => g.players.length < 4);
  const [name, setName] = useState("");
  const [handicap, setHandicap] = useState("");
  const [teeTimeId, setTeeTimeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const target = open.find((g) => g.id === teeTimeId) ?? open[0] ?? null;

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        if (name.trim().length < 2) return setError("Give the guest a name.");
        if (!target) return setError("Every group is full. Add a group first.");

        let index: number | null = null;
        if (handicap.trim()) {
          const parsed = parseHandicapInput(handicap);
          if (!parsed.ok) return setError(parsed.reason);
          index = parsed.value;
        }

        setError(null);
        const added = await onAdd(name.trim(), index, target.id);
        if (added) {
          setName("");
          setHandicap("");
        }
      }}
      className="mt-4 space-y-3 border border-hairline bg-card p-4"
    >
      <p className="meta">Add a guest</p>
      <p className="font-mono text-xs text-ink-soft">
        For someone playing without an account. Their card is kept by their
        group like anyone else&apos;s. A guest who&apos;s played before is in
        &ldquo;Not in a group&rdquo; below.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="First and last"
            className={inputClass}
          />
        </Field>
        <Field label="Handicap (optional)">
          <input
            value={handicap}
            onChange={(e) => setHandicap(e.target.value)}
            placeholder="12.4 or +1.4"
            className={inputClass}
          />
        </Field>
        <Field label="Group">
          <select
            value={target?.id ?? ""}
            onChange={(e) => setTeeTimeId(e.target.value)}
            className={inputClass}
          >
            {open.length === 0 && <option value="">All groups are full</option>}
            {groups.map((g, i) =>
              g.players.length < 4 ? (
                <option key={g.id} value={g.id}>
                  Group {i + 1} · {clubClock(g.teeAt, zone)}
                </option>
              ) : null,
            )}
          </select>
        </Field>
      </div>

      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 w-full border border-forest px-4 font-mono text-xs tracking-wider text-forest uppercase disabled:opacity-40"
      >
        Add guest
      </button>
    </form>
  );
}

function GuestBadge() {
  return (
    <span className="ml-2 border border-hairline px-1.5 py-0.5 align-middle font-mono text-[0.65rem] font-normal tracking-wider text-ink-soft uppercase">
      Guest
    </span>
  );
}

/** The usual gaps between groups, plus whatever the league's default is. */
const gaps = teeGaps;

function AnswerBadge({ answer }: { answer: RsvpAnswer | null }) {
  const key = answer ?? "none";

  return (
    <span
      className={`ml-2 border px-1.5 py-0.5 align-middle font-mono text-[0.65rem] font-normal tracking-wider uppercase ${
        answer === "in"
          ? "border-forest text-forest"
          : answer === "out"
            ? "border-clay text-clay"
            : "border-hairline text-ink-soft"
      }`}
    >
      {ANSWER_LABEL[key]}
    </span>
  );
}

/** A clock time some minutes on, "08:00" + 10 = "08:10". */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">{title}</h2>
        {aside && <span className="meta">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const inputClass =
  "min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}

/**
 * Who keeps one card this week, in words, by the rule the pad goes by: the
 * league's way of scoring, and who in the group can sign in.
 */
function keeperLine(playerId: string, group: Group, keeping: Keeping): string {
  const nameOf = (id: string) => group.players.find((p) => p.id === id)?.name ?? "another player";
  const keeper = cardKeeper(playerId, {
    mode: keeping.mode,
    assignments: keeping.assignments,
    group: group.players.map((p) => p.id),
    noLogin: keeping.noLogin,
  });

  switch (keeper.kind) {
    case "player":
      // Team Card Scoring, and the only one in the group with a login.
      return keeper.id === playerId
        ? "Keeps the group’s cards: nobody else in it has a login"
        : `Card kept by ${nameOf(keeper.id)}`;
    case "self":
      return keeping.mode === "partner"
        ? "Keeps their own card: their partner has no login"
        : "Keeps their own card";
    case "group":
      return "Card kept by anyone in the group";
    case "pro_shop":
      return "No login, so nobody keeps this card: the pro shop enters it from the paper card";
    case "nobody":
      return "Nobody keeps this card";
  }
}
