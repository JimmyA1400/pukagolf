"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { Exports } from "@/components/admin/Exports";
import { ConfirmButton, Field, inputClass, Section } from "@/components/admin/parts";
import { LeagueRules } from "@/components/admin/LeagueRules";
import { SeasonControl } from "@/components/admin/SeasonControl";
import { LeagueSettings } from "@/components/LeagueSettings";
import { formatHandicapIndex, parseHandicapInput } from "@/lib/handicap-index";
import { GAMES, getGame, type GameId } from "@/lib/games";
import { holesLabel } from "@/lib/holes";
import { nextLeagueDate, nextWeekName, usualWeekday, weekdayPlural } from "@/lib/league-week";
import { formatUsPhone, toE164 } from "@/lib/phone";
import { SAMPLE_EVENT_TOKEN } from "@/lib/sample-event";
import { createClient } from "@/lib/supabase/client";
import { CoursePicker } from "@/components/league/CourseSetup";
import { PUKAGOLF_SLUG } from "@/lib/club-paths";
import { useClub } from "@/lib/club";
import {
  finalQuestion,
  finalWarnings,
  localToday,
  openCards,
  unfinishedCards,
  type OpenCard,
} from "@/lib/final-week";

type RoundStatus = "setup" | "live" | "final";

type Round = {
  id: string;
  name: string;
  playedOn: string;
  status: RoundStatus;
  courseName: string | null;
  holeCount: number;
  scoreCount: number;
  playerCount: number;
  feedCount: number;
  skinsEnabled: boolean | null;
  skinsStake: number | null;
};

type Player = {
  id: string;
  name: string;
  isAdmin: boolean;
  isOwner: boolean;
  contact: string | null;
  joined: string;
  handicapIndex: number | null;
  inCurrentRound: boolean;
  roundsPlayed: number;
};

type Overview = {
  currentRoundId: string | null;
  rounds: Round[];
  players: Player[];
  demo: { id: string; name: string; scoreCount: number } | null;
};

/**
 * A week whose last "Clear scores" can still be undone: `count` holes that
 * are still empty, `kept` scored again since, which keep their new score
 * (0060; a database before it leaves `kept` and `keptUntil` out).
 */
export type Restorable = {
  roundId: string;
  count: number;
  kept?: number;
  clearedAt: string;
  keptUntil?: string;
};

type State =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      overview: Overview;
      restorable: Restorable[];
      /** This week's cards signed off or locked: clearing its scores opens them. */
      lockedCards: number;
      /** Signed-off or locked cards in each week, by week. */
      lockedByWeek: Record<string, number>;
      /** Whether each week counts for the standings (false: rained out). */
      counts: Record<string, boolean>;
      /** Each week's first hole: 10 for a back-nine week. */
      starts: Record<string, number>;
      /** What each week is played for. See src/lib/games.ts. */
      games: Record<string, string>;
      /** Which weeks were played indoors. */
      sims: Record<string, boolean>;
    };

type Notice = { tone: "ok" | "error"; text: string };

/** What a Supabase RPC resolves to, as far as this page cares. */
type RpcResult = { data: unknown; error: { message: string } | null };

const STATUS_LABEL: Record<RoundStatus, string> = {
  setup: "Setting up",
  live: "Live",
  final: "Final",
};

/**
 * The owner's control room for the weekly league.
 *
 * The first check only decides what to draw. The lock is in the database:
 * every action here is an owner_* function that refuses anyone but the owner.
 */
export function LeagueAdmin() {
  const { href, club, league } = useClub();
  const leagueId = league?.id ?? null;
  const isPukaGolf = club.slug === PUKAGOLF_SLUG;
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  // Bumped after every change made here, so panels with their own data reload.
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    if (!leagueId) return;

    const { data, error } = await supabase.rpc("owner_league_overview", { in_league_id: leagueId });

    if (error || !data) {
      setState({ status: "error", message: error?.message ?? "This league couldn't be loaded." });
      return;
    }

    const overview = data as unknown as Overview;
    const [restorable, counted, locks] = await Promise.all([
      supabase.rpc("owner_restorable_scores"),
      supabase
        .from("rounds")
        .select("id, counts_for_standings, start_hole, game, is_simulator")
        .eq("league_id", leagueId),
      overview.rounds.length > 0
        ? supabase
            .from("card_locks")
            .select("round_id, player_id")
            .in("round_id", overview.rounds.map((r) => r.id))
        : Promise.resolve({ data: [] as { round_id: string; player_id: string }[] }),
    ]);
    const lockedByWeek: Record<string, number> = {};
    for (const lock of locks.data ?? []) lockedByWeek[lock.round_id] = (lockedByWeek[lock.round_id] ?? 0) + 1;

    setState({
      status: "ready",
      overview,
      lockedCards: overview.currentRoundId ? (lockedByWeek[overview.currentRoundId] ?? 0) : 0,
      lockedByWeek,
      restorable: (restorable.data ?? []) as Restorable[],
      counts: Object.fromEntries(
        (counted.data ?? []).map((r) => [r.id, r.counts_for_standings ?? true]),
      ),
      starts: Object.fromEntries((counted.data ?? []).map((r) => [r.id, r.start_hole ?? 1])),
      games: Object.fromEntries((counted.data ?? []).map((r) => [r.id, r.game ?? "stroke"])),
      sims: Object.fromEntries(
        (counted.data ?? []).map((r) => [r.id, r.is_simulator ?? false]),
      ),
    });
  }, [supabase, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** Run an owner action, say what happened, and redraw from the database. */
  const run = useCallback(
    async (
      action: () => PromiseLike<RpcResult>,
      success: (data: unknown) => string,
    ) => {
      setNotice(null);
      const { data, error } = await action();

      if (error) {
        setNotice({ tone: "error", text: error.message });
        return false;
      }

      setNotice({ tone: "ok", text: success(data) });
      await load();
      // Panels that load their own data load again: the Season panel counted
      // a week as not final until the page was reloaded.
      setVersion((v) => v + 1);
      return true;
    },
    [load],
  );

  if (state.status === "loading") {
    return <Centered>Loading…</Centered>;
  }

  if (state.status === "error") {
    return (
      <Centered>
        <p role="alert" className="break-words text-clay">
          The admin page didn&apos;t load ({state.message}).
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 underline"
        >
          Try again
        </button>
      </Centered>
    );
  }

  if (state.status === "denied") {
    return (
      <Centered>
        <p>This page is for the league owner.</p>
        <Link href={href("/league")} className="mt-3 underline">
          Back to the league
        </Link>
      </Centered>
    );
  }

  const { overview, restorable, counts, starts, games, sims, lockedCards, lockedByWeek } = state;
  const restorableFor = (round: Round) =>
    restorable.find((r) => r.roundId === round.id) ?? null;
  const current =
    overview.rounds.find((r) => r.id === overview.currentRoundId) ?? null;
  const past = overview.rounds.filter((r) => r.id !== overview.currentRoundId);

  const clearScores = (round: Round, signed: number) =>
    run(
      () =>
        supabase.rpc("owner_clear_round_scores", { in_round_id: round.id }),
      (n) =>
        `Cleared ${Number(n)} scores from ${round.name}.${
          signed > 0
            ? ` ${signed === 1 ? "The signed-off card is" : `The ${signed} signed-off or locked cards are`} open again, so the groups can score and sign again.`
            : ""
        }`,
    );

  const clearFeed = (round: Round) =>
    run(
      () => supabase.rpc("owner_clear_round_feed", { in_round_id: round.id }),
      (n) => `Cleared ${Number(n)} clubhouse posts.`,
    );

  const updateRound = (
    round: Round,
    name: string,
    playedOn: string,
    status: RoundStatus,
  ) =>
    run(
      () =>
        supabase.rpc("owner_update_round", {
          in_round_id: round.id,
          in_name: name,
          in_played_on: playedOn,
          in_status: status,
        }),
      () => "Saved.",
    );

  const setWeekSimulator = (round: Round, value: boolean) =>
    run(
      () =>
        supabase.rpc("admin_set_week_simulator", {
          in_round_id: round.id,
          in_value: value,
        }),
      () =>
        value
          ? `${round.name} is marked as a simulator round. Every card in it counts at the league's simulator weight.`
          : `${round.name} is marked as played outdoors.`,
    );

  const setWeekHoles = (round: Round, choice: "18" | "front" | "back") =>
    run(
      () =>
        supabase.rpc("admin_set_week_holes", {
          in_round_id: round.id,
          in_hole_count: choice === "18" ? 18 : 9,
          in_start_hole: choice === "back" ? 10 : 1,
        }),
      () =>
        `${round.name} is now ${
          choice === "18" ? "18 holes" : choice === "back" ? "the back nine" : "the front nine"
        }. Every card is scored over those holes.`,
    );

  const setWeekGame = (round: Round, game: GameId) =>
    run(
      () =>
        supabase.rpc("admin_set_week_game", {
          in_round_id: round.id,
          in_game: game,
        }),
      () =>
        `${round.name} is now ${getGame(game).label.toLowerCase()}. Nothing already entered has changed.`,
    );

  const startWeek = (
    name: string,
    playedOn: string,
    copyGroups: boolean,
    courseId: string | null,
    holeCount: number | null,
    startHole: number | null,
    game: GameId,
  ) =>
    run(
      () =>
        supabase.rpc("owner_start_new_week", {
          in_league_id: leagueId as string,
          in_name: name,
          in_played_on: playedOn,
          in_copy_groups: copyGroups,
          in_course_id: courseId,
          in_hole_count: holeCount,
          in_start_hole: startHole,
          in_game: game,
        }),
      () =>
        copyGroups
          ? `${name} is set up, and it's what the league page shows now.`
          : `${name} is open for RSVPs. Build its groups from Groups & tee times once people have answered.`,
    );

  const restoreScores = (round: Round) =>
    run(
      () => supabase.rpc("owner_restore_scores", { in_round_id: round.id }),
      (n) => putBackDone(round.name, Number(n), restorableFor(round)?.kept ?? 0),
    );

  const setCounts = (round: Round, value: boolean) =>
    run(
      () =>
        supabase.rpc("owner_set_round_counts", {
          in_round_id: round.id,
          in_counts: value,
        }),
      () =>
        value
          ? `${round.name} counts for the standings again.`
          : `${round.name} is marked rained out and doesn't count for the standings.`,
    );

  const clearDemo = () =>
    run(
      () => supabase.rpc("admin_clear_demo_scores"),
      (n) => `Cleared ${Number(n)} demo scores.`,
    );

  return (
    <div className="space-y-10">
      <header className="border-t border-hairline pt-6">
        <p className="meta">{league?.name ?? "League"}</p>
        <h2 className="font-display text-2xl font-bold tracking-tight">
          Weeks, rules and seasons
        </h2>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          For the league picked at the top of the page. Every change here is
          written to the audit log.
        </p>
      </header>

      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.tone === "error"
              ? "border-clay text-clay"
              : "border-forest text-forest"
          }`}
        >
          {notice.text}
        </p>
      )}

      <Section title="This week">
        {current ? (
          <ThisWeek
            key={current.id}
            round={current}
            onSave={(name, playedOn, status) =>
              updateRound(current, name, playedOn, status)
            }
            onClearScores={() => clearScores(current, lockedCards)}
            lockedCards={lockedCards}
            onClearFeed={() => clearFeed(current)}
            restorable={restorableFor(current)}
            onRestore={() => restoreScores(current)}
            counts={counts[current.id] ?? true}
            onCounts={(value) => setCounts(current, value)}
            startHole={starts[current.id] ?? 1}
            game={games[current.id] ?? "stroke"}
            onGame={(value) => setWeekGame(current, value)}
            onHoles={(value) => setWeekHoles(current, value)}
            simulator={sims[current.id] ?? false}
            onSimulator={(value) => setWeekSimulator(current, value)}
          />
        ) : (
          <p className="font-mono text-xs text-ink-soft">
            No weeks yet. Start the first one below.
          </p>
        )}
      </Section>

      <Section title={current ? "Start a new week" : "Start the first week"}>
        <NewWeekForm
          key={`${current?.id ?? "first"}:${current?.status ?? ""}`}
          current={current}
          playedOn={overview.rounds.map((r) => r.playedOn)}
          onStart={startWeek}
        />
      </Section>

      <Section title="League settings">
        <LeagueSettings />
      </Section>

      <Section title="League rules">
        <LeagueRules />
      </Section>

      <Section title="Season">
        <SeasonControl key={version} />
      </Section>

      <Section title="Exports and printouts">
        <Exports />
      </Section>

      {past.length > 0 && (
        <Section title="Past weeks">
          <ul className="border border-hairline bg-card px-4">
            {past.map((round) => (
              <li
                key={round.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-hairline py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-display text-base font-bold">
                    {round.name}
                  </p>
                  <p className="font-mono text-xs text-ink-soft">
                    {round.playedOn} · {STATUS_LABEL[round.status]} ·{" "}
                    {round.scoreCount} scores
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {/* One card put right, without clearing the whole week. */}
                  <Link
                    // Through href(), which joins ?league= and ?week= right:
                    // pasted on after it, a second "?" lost the league.
                    href={href(`/league?week=${encodeURIComponent(round.id)}`)}
                    className="font-mono text-xs text-forest underline"
                  >
                    Fix a card
                  </Link>
                  <CountsToggle
                    counts={counts[round.id] ?? true}
                    onChange={(value) => setCounts(round, value)}
                  />
                  <RestoreButton
                    restorable={restorableFor(round)}
                    final={round.status === "final"}
                    onRestore={() => restoreScores(round)}
                  />
                  <ConfirmButton
                    label="Clear scores"
                    confirmLabel={`Clear all ${round.scoreCount}`}
                    warning={clearWarning(
                      round,
                      lockedByWeek[round.id] ?? 0,
                      overview.rounds.find((r) => r.id !== round.id && r.status === "live")?.name ?? null,
                    )}
                    disabled={round.scoreCount === 0}
                    onConfirm={() => clearScores(round, lockedByWeek[round.id] ?? 0)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {isPukaGolf && overview.demo && (
        <Section title="Demo outing">
          <div className="flex flex-wrap items-center justify-between gap-3 border border-hairline bg-card px-4 py-3">
            <div>
              <Link
                href={`/event/${SAMPLE_EVENT_TOKEN}`}
                className="font-display text-base font-bold hover:underline"
              >
                {overview.demo.name}
              </Link>
              <p className="font-mono text-xs text-ink-soft">
                {overview.demo.scoreCount} scores from visitors
              </p>
            </div>
            <ConfirmButton
              label="Clear demo scores"
              confirmLabel={`Clear all ${overview.demo.scoreCount}`}
              warning="Resets it for the next visitor."
              disabled={overview.demo.scoreCount === 0}
              onConfirm={clearDemo}
            />
          </div>
        </Section>
      )}

      <Section title="Elsewhere">
        <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs">
          <Link href={href("/league/groups")} className="underline">
            Groups &amp; tee times
          </Link>
          <Link href={href("/league/events")} className="underline">
            League events
          </Link>
          {isPukaGolf && (
            <>
              <Link href={href("/outings")} className="underline">
                All outings
              </Link>
              <Link href={href("/outings/new")} className="underline">
                New outing
              </Link>
              <Link href={href("/tournaments")} className="underline">
                Tournaments
              </Link>
              <Link href={href("/charities")} className="underline">
                Charities
              </Link>
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

function ThisWeek({
  round,
  onSave,
  onClearScores,
  onClearFeed,
  restorable,
  onRestore,
  counts,
  onCounts,
  startHole,
  game,
  onGame,
  onHoles,
  simulator,
  onSimulator,
  lockedCards,
}: {
  round: Round;
  lockedCards: number;
  onSave: (
    name: string,
    playedOn: string,
    status: RoundStatus,
  ) => Promise<boolean>;
  onClearScores: () => Promise<boolean>;
  onClearFeed: () => Promise<boolean>;
  restorable: Restorable | null;
  onRestore: () => Promise<boolean>;
  counts: boolean;
  onCounts: (value: boolean) => Promise<boolean>;
  startHole: number;
  game: string;
  onGame: (value: GameId) => Promise<boolean>;
  onHoles: (value: "18" | "front" | "back") => Promise<boolean>;
  simulator: boolean;
  onSimulator: (value: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(round.name);
  const [playedOn, setPlayedOn] = useState(round.playedOn);
  const [status, setStatus] = useState<RoundStatus>(round.status);
  const [busy, setBusy] = useState(false);
  // Making a week final asks first, with whatever looks wrong about it.
  const [finalCheck, setFinalCheck] = useState<string[] | null>(null);
  const supabase = useMemo(() => createClient(), []);

  const save = async () => {
    setBusy(true);
    const saved = await onSave(name, playedOn, status);
    setBusy(false);
    setFinalCheck(null);
    if (saved) setEditing(false);
  };

  const askBeforeFinal = async () => {
    setBusy(true);
    const { data } = await supabase.rpc("round_completion", { in_round_id: round.id });
    setBusy(false);
    const completion = data as unknown as {
      holeCount: number;
      players: { name: string; posted: number }[];
    } | null;
    setFinalCheck(
      finalWarnings({
        playedOn,
        status: round.status,
        holeCount: completion?.holeCount ?? round.holeCount,
        open: openCards(completion, round.holeCount),
        today: localToday(),
      }),
    );
  };

  // Start from what's saved every time, not from an abandoned earlier edit.
  const openEditor = () => {
    setName(round.name);
    setPlayedOn(round.playedOn);
    setStatus(round.status);
    setEditing(true);
  };

  return (
    <div className="border border-hairline bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-lg font-bold">{round.name}</p>
          <p className="font-mono text-xs text-ink-soft">
            {round.playedOn}
            {round.courseName && ` · ${round.courseName}`} ·{" "}
            {holesLabel(round.holeCount, startHole)} · {getGame(game).label}
          </p>
        </div>
        <StatusBadge status={round.status} />
      </div>

      <p className="mt-2 font-mono text-xs text-ink-soft">
        {round.playerCount} players · {round.scoreCount} scores ·{" "}
        {round.feedCount} clubhouse posts
        {round.skinsEnabled !== null &&
          ` · skins ${round.skinsEnabled ? `$${round.skinsStake ?? 0} a hole` : "off"}`}
      </p>

      <div className="mt-3 grid gap-3 border-t border-dashed border-hairline pt-3 sm:grid-cols-2">
        <HolesPicker
          roundId={round.id}
          holeCount={round.holeCount}
          startHole={startHole}
          hasScores={round.scoreCount > 0}
          onChange={onHoles}
        />
        <GamePicker game={game} onChange={onGame} />
      </div>

      <SimulatorToggle on={simulator} onChange={onSimulator} />

      {editing ? (
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (status === "final" && round.status !== "final") await askBeforeFinal();
            else await save();
          }}
          className="mt-3 space-y-3 border-t border-dashed border-hairline pt-3"
        >
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="mt-3 grid gap-3 border-t border-dashed border-hairline pt-3 sm:grid-cols-2">
            <Field label="Date">
              <input
                type="date"
                value={playedOn}
                onChange={(e) => setPlayedOn(e.target.value)}
                className={inputClass}
              />
            </Field>

            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as RoundStatus)}
                className={inputClass}
              >
                {(Object.keys(STATUS_LABEL) as RoundStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {finalCheck && (
            <div role="alert" className="space-y-2 border-2 border-clay bg-cream px-3 py-3">
              <p className="font-mono text-xs text-clay">{finalQuestion(name)}</p>
              {finalCheck.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 font-mono text-xs text-clay">
                  {finalCheck.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="min-h-11 flex-1 bg-clay px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
                >
                  {finalCheck.length > 0 ? "Make it final anyway" : "Make it final"}
                </button>
                <button
                  type="button"
                  onClick={() => setFinalCheck(null)}
                  className="min-h-11 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
                >
                  Not yet
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || finalCheck !== null}
              className="min-h-11 flex-1 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="min-h-11 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-hairline pt-2">
          <button
            type="button"
            onClick={openEditor}
            className="font-mono text-xs text-forest underline"
          >
            Edit name, date or status
          </button>
          <ConfirmButton
            label="Clear scores"
            confirmLabel={`Clear all ${round.scoreCount}`}
            warning={clearWarning(round, lockedCards)}
            disabled={round.scoreCount === 0}
            onConfirm={onClearScores}
          />
          <RestoreButton restorable={restorable} final={round.status === "final"} onRestore={onRestore} />
          <CountsToggle counts={counts} onChange={onCounts} />
          <ConfirmButton
            label="Clear clubhouse feed"
            confirmLabel={`Clear ${round.feedCount} posts`}
            warning="There's no undo."
            disabled={round.feedCount === 0}
            onConfirm={onClearFeed}
          />
        </div>
      )}
    </div>
  );
}

function NewWeekForm({
  current,
  playedOn: weeks,
  onStart,
}: {
  /** The league's latest week, or null when this is its first. */
  current: Round | null;
  /** Every week's date, for the league's usual day. */
  playedOn: readonly string[];
  onStart: (
    name: string,
    playedOn: string,
    copyGroups: boolean,
    courseId: string | null,
    holeCount: number | null,
    startHole: number | null,
    game: GameId,
  ) => Promise<boolean>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { club, league } = useClub();
  const clubId = club.id;
  const leagueId = league?.id ?? null;
  const [courses, setCourses] = useState<{ id: string; name: string; holeCount: number }[]>([]);
  const [courseId, setCourseId] = useState("");
  const [importing, setImporting] = useState(false);
  const [holes, setHoles] = useState<"18" | "front" | "back">(
    !current || current.holeCount === 18 ? "18" : "front",
  );
  // The league's own default, until the owner picks something else here.
  const [game, setGame] = useState<GameId>("stroke");

  const loadCourses = useCallback(async () => {
    const [list, week, rules] = await Promise.all([
      supabase.from("courses").select("id, name, hole_count").eq("club_id", clubId).order("name"),
      current
        ? supabase
            .from("rounds")
            .select("course_id, hole_count, start_hole")
            .eq("id", current.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      leagueId
        ? supabase.from("league_rules").select("default_game").eq("league_id", leagueId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    setGame(getGame(rules.data?.default_game).id);

    setCourses(
      (list.data ?? []).map((c) => ({ id: c.id, name: c.name, holeCount: c.hole_count })),
    );
    setCourseId(week.data?.course_id ?? "");
    // Start from what this week plays.
    if (week.data) {
      setHoles(
        week.data.hole_count === 18 ? "18" : (week.data.start_hole ?? 1) > 1 ? "back" : "front",
      );
    }
  }, [supabase, current, clubId, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCourses();
  }, [loadCourses]);

  const course = courses.find((c) => c.id === courseId) ?? null;
  const maxHoles = course?.holeCount ?? 18;
  // A 9-hole course only has a front nine.
  const choice = maxHoles >= 18 ? holes : "front";
  const [name, setName] = useState(() => (current ? nextWeekName(current.name) : "Week 1"));
  const [playedOn, setPlayedOn] = useState(() =>
    current ? nextLeagueDate(current.playedOn, weeks) : new Date().toISOString().slice(0, 10),
  );
  // A first week has no groups to copy.
  const [copyGroups, setCopyGroups] = useState(current !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Starting the new week makes this one final. Its unfinished cards are
  // read when the form opens, so the note above the button can say so, and
  // read again on Start, in case a group has finished since.
  const [open, setOpen] = useState<OpenCard[] | null>(null);
  // Set when Start found unfinished cards: the admin is asked to confirm.
  const [confirmOpen, setConfirmOpen] = useState<OpenCard[] | null>(null);
  const goingFinal = current !== null && current.status !== "final";

  const readOpen = useCallback(async (): Promise<OpenCard[]> => {
    if (!current) return [];
    const { data } = await supabase.rpc("round_completion", { in_round_id: current.id });
    return openCards(
      data as unknown as { holeCount: number; players: { name: string; posted: number }[] } | null,
      current.holeCount,
    );
  }, [supabase, current]);

  useEffect(() => {
    if (!goingFinal) return;
    let live = true;
    void readOpen().then((cards) => {
      if (live) setOpen(cards);
    });
    return () => {
      live = false;
    };
  }, [goingFinal, readOpen]);

  const start = async () => {
    setConfirmOpen(null);
    setBusy(true);
    await onStart(
      name.trim(),
      playedOn,
      copyGroups,
      courseId || null,
      choice === "18" ? 18 : 9,
      choice === "back" ? 10 : 1,
      game,
    );
    setBusy(false);
  };

  // The course search is a form of its own, so it sits beside this one
  // rather than inside it, and the start button names this form.
  const formId = useId();

  return (
    <div className="space-y-3 border border-hairline bg-card p-4">
      <form
        id={formId}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();

          if (!name.trim()) return setError("Give the week a name.");
          if (!playedOn || (current && playedOn <= current.playedOn)) {
            return setError(current ? `Pick a date after ${current.playedOn}.` : "Pick a date.");
          }
          if (!current && !courseId) {
            return setError("Pick the course for the league's first week, or find it below.");
          }

          setError(null);

          // Every card finished: as quick as ever. Otherwise, ask first.
          if (goingFinal) {
            setBusy(true);
            const cards = await readOpen();
            setBusy(false);
            setOpen(cards);
            if (cards.length > 0) return setConfirmOpen(cards);
          }

          await start();
        }}
        className="space-y-3"
      >
        {current && (
        <>
        <fieldset className="space-y-2">
          <legend className="meta mb-1">Groups</legend>
          <label className="flex items-start gap-2 font-mono text-xs">
            <input
              type="radio"
              name="new-week-groups"
              checked={copyGroups}
              onChange={() => setCopyGroups(true)}
              className="mt-0.5 accent-forest"
            />
            <span>
              Copy this week&apos;s groups and scorer rotation, ready to play.
            </span>
          </label>
          <label className="flex items-start gap-2 font-mono text-xs">
            <input
              type="radio"
              name="new-week-groups"
              checked={!copyGroups}
              onChange={() => setCopyGroups(false)}
              className="mt-0.5 accent-forest"
            />
            <span>
              Start empty: players RSVP, then build the groups from who&apos;s
              in.
            </span>
          </label>
        </fieldset>

        {!goingFinal ? (
          <p className="font-mono text-xs text-ink-soft">
            Either way every card starts blank. {current.name} is already final
            and keeps its scores.
          </p>
        ) : open && open.length > 0 ? (
          <p className="border border-clay bg-cream px-3 py-2 font-mono text-xs text-clay">
            {unfinishedCards(open, current.holeCount)} in {current.name}. Starting
            the new week marks {current.name} final anyway: an unfinished card
            earns no points, and only a club admin can change it after, with a
            reason. You&apos;ll be asked first.
          </p>
        ) : (
          <p className="font-mono text-xs text-ink-soft">
            Either way every card starts blank.{" "}
            {open ? `Every card in ${current.name} is finished, so it` : current.name}{" "}
            is marked final and keeps its scores, so handicaps don&apos;t lose it.
          </p>
        )}
        </>
        )}

        <div className="mt-3 grid gap-3 border-t border-dashed border-hairline pt-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Field>

          {/* The day the date was picked by, where the pro can see it. */}
          <Field
            label="Date"
            hint={
              current
                ? `This league plays ${weekdayPlural(usualWeekday([current.playedOn, ...weeks], current.playedOn))}, so the date offered is the next one.`
                : undefined
            }
          >
            <input
              type="date"
              value={playedOn}
              onChange={(e) => setPlayedOn(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Course">
            <select
              value={courseId}
              onChange={(e) => {
                const next = courses.find((c) => c.id === e.target.value);
                setCourseId(e.target.value);
                if (next && next.holeCount < 18) setHoles("front");
              }}
              className={inputClass}
            >
              {courseId === "" && (
                <option value="">{current ? "Same as this week" : "Pick a course"}</option>
              )}
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Holes">
            <select
              value={choice}
              onChange={(e) => setHoles(e.target.value as "18" | "front" | "back")}
              className={inputClass}
            >
              {maxHoles >= 18 && <option value="18">18 holes</option>}
              <option value="front">{maxHoles >= 18 ? "Front nine (holes 1–9)" : "9 holes"}</option>
              {maxHoles >= 18 && <option value="back">Back nine (holes 10–18)</option>}
            </select>
          </Field>

          <Field label="Game" hint={getGame(game).blurb}>
            <select
              value={game}
              onChange={(e) => setGame(e.target.value as GameId)}
              className={inputClass}
            >
              {GAMES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

      </form>

      <div className="border border-hairline bg-cream p-3">
        <p className="meta mb-2">
          {importing ? "Bringing the course in…" : "Or find the course in the course database"}
        </p>
        <CoursePicker
          onPickCourse={async (externalId) => {
            setImporting(true);
            setError(null);
            try {
              const detail = await (await fetch(`/api/courses/${externalId}`)).json();
              const { data: imported, error: importError } = await supabase.rpc("import_course", {
                payload: detail,
                in_club_id: clubId,
              });
              if (importError) return setError(`Could not import that course: ${importError.message}`);
              await loadCourses();
              setCourseId(imported as unknown as string);
              if (detail.parMismatch) setError(detail.parMismatch);
            } catch {
              setError("The course database didn't answer. Try again in a moment.");
            } finally {
              setImporting(false);
            }
          }}
        />
      </div>

      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}

      {confirmOpen && current ? (
        <div role="alert" className="space-y-2 border-2 border-clay bg-cream px-3 py-3">
          <p className="font-mono text-xs font-bold text-clay">Mark {current.name} final anyway?</p>
          <p className="font-mono text-xs text-clay">
            {unfinishedCards(confirmOpen, current.holeCount)}. Starting {name.trim()} makes{" "}
            {current.name} final now: those cards earn no points, and only a club admin can
            change one after this, with a reason.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="min-h-11 flex-1 bg-clay px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
            >
              Mark it final and start
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(null)}
              className="min-h-11 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
            >
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <button
          type="submit"
          form={formId}
          disabled={busy}
          className="min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Setting up…" : "Start the new week"}
        </button>
      )}
    </div>
  );
}

/** "+12395550132" → "(239) 555-0132" for the input; anything else → blank. */
function phoneForInput(contact: string | null): string {
  return contact?.startsWith("+1") ? formatUsPhone(contact.slice(2)) : "";
}

/**
 * Correct a player's name or phone. For someone who signs in by phone the
 * number is their login, so it changes there too.
 */
export function DetailsEditor({
  player,
  onSave,
}: {
  player: Pick<Player, "name" | "contact">;
  onSave: (name: string, phone: string | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(player.name);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setName(player.name);
          setPhone(phoneForInput(player.contact));
          setError(null);
          setOpen(true);
        }}
        className="font-mono text-xs text-forest underline"
      >
        Edit name or phone
      </button>
    );
  }

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();

        if (name.trim().length < 2) return setError("Enter a name.");

        let e164: string | null = null;
        if (phone.trim()) {
          e164 = toE164(phone);
          if (!e164) return setError("Enter a 10-digit US mobile number.");
        }

        setError(null);
        setBusy(true);
        const saved = await onSave(name.trim(), e164);
        setBusy(false);
        if (saved) setOpen(false);
      }}
      className="w-full space-y-2 border border-dashed border-hairline p-3"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Mobile number">
          <input
            value={phone}
            onChange={(e) => setPhone(formatUsPhone(e.target.value))}
            inputMode="tel"
            placeholder="(239) 555-0132"
            className={inputClass}
          />
        </Field>
      </div>
      <p className="font-mono text-xs text-ink-soft">
        If they sign in by phone, this is the number they sign in with. Leave
        it blank to keep what&apos;s there.
      </p>
      {error && (
        <p role="alert" className="font-mono text-xs text-clay">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="font-mono text-xs font-bold text-forest underline disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="font-mono text-xs text-ink-soft underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Fold this (duplicate) account into another. Two steps: pick who to keep,
 * then confirm with both names and contacts spelled out.
 */
function SimulatorToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (value: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <label className="mt-3 flex items-start gap-3">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          await onChange(e.target.checked);
          setBusy(false);
        }}
        className="mt-1 accent-forest"
      />
      <span>
        <span className="block font-display text-[0.95rem] font-bold">
          Simulator round
        </span>
        <span className="block font-mono text-[0.7rem] text-ink-soft">
          A sim score is real, but it rolls perfectly. It counts towards a
          handicap at the league&apos;s simulator weight, and is labelled
          wherever it shows.
        </span>
      </span>
    </label>
  );
}

/**
 * How many holes this week is, after the fact.
 *
 * A round is complete when a player has posted hole_count holes, so a week
 * set up for 18 that the groups played nine of leaves every card unfinished
 * and hands out no points. This is how the week is told what was actually
 * played. Nothing is deleted: a choice that would strand a score already
 * entered is refused, naming whose it is.
 */
function HolesPicker({
  roundId,
  holeCount,
  startHole,
  hasScores,
  onChange,
}: {
  roundId: string;
  holeCount: number;
  startHole: number;
  hasScores: boolean;
  onChange: (value: "18" | "front" | "back") => Promise<boolean>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [busy, setBusy] = useState(false);
  // The course's own size: a 9-hole course has no 18 and no back nine to offer.
  const [courseHoles, setCourseHoles] = useState<number | null>(null);
  const current = holeCount === 18 ? "18" : startHole > 1 ? "back" : "front";

  useEffect(() => {
    let live = true;
    void (async () => {
      const { data: week } = await supabase
        .from("rounds")
        .select("course_id")
        .eq("id", roundId)
        .maybeSingle();
      if (!week?.course_id) return;
      const { data: course } = await supabase
        .from("courses")
        .select("hole_count")
        .eq("id", week.course_id)
        .maybeSingle();
      if (live && course) setCourseHoles(course.hole_count);
    })();
    return () => {
      live = false;
    };
  }, [supabase, roundId]);

  // Never hide what the week is set to now, even on a course said to be 9.
  const nineOnly = courseHoles !== null && courseHoles < 18 && current === "front";

  return (
    <div>
      <label className="block">
        <span className="meta mb-1 block">Holes played</span>
        <select
          value={current}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            await onChange(e.target.value as "18" | "front" | "back");
            setBusy(false);
          }}
          className={`${inputClass} disabled:opacity-40`}
        >
          {!nineOnly && <option value="18">18 holes</option>}
          <option value="front">{nineOnly ? "9 holes" : "Front nine (holes 1–9)"}</option>
          {!nineOnly && <option value="back">Back nine (holes 10–18)</option>}
        </select>
      </label>
      <p className="mt-1 font-mono text-[0.7rem] text-ink-soft">
        {nineOnly
          ? "A 9-hole course, so the week is its 9 holes. "
          : ""}
        {hasScores
          ? "Scores already entered stay as they are. A choice that would leave one outside the week is refused."
          : "What the groups actually play. A card is only complete once it has all of them."}
      </p>
    </div>
  );
}

/**
 * What this week is played for.
 *
 * Safe to change at any point, including mid-round: the scores stay as they
 * are and every game is worked out from them when it's shown, so picking the
 * wrong one on Tuesday costs nothing to put right on Wednesday.
 */
function GamePicker({
  game,
  onChange,
}: {
  game: string;
  onChange: (value: GameId) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const spec = getGame(game);

  return (
    <div>
      <label className="block">
        <span className="meta mb-1 block">This week&apos;s game</span>
        <select
          value={spec.id}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            await onChange(e.target.value as GameId);
            setBusy(false);
          }}
          className={`${inputClass} disabled:opacity-40`}
        >
          {GAMES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 font-mono text-[0.7rem] text-ink-soft">
        {spec.blurb}
        {spec.team && " Groups & tee times decides who plays with whom."}
      </p>
    </div>
  );
}

function CountsToggle({
  counts,
  onChange,
}: {
  counts: boolean;
  onChange: (value: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await onChange(!counts);
        setBusy(false);
      }}
      className={`font-mono text-xs underline disabled:opacity-40 ${
        counts ? "text-ink-soft" : "text-clay"
      }`}
    >
      {counts ? "Mark rained out" : "Rained out · make it count"}
    </button>
  );
}

/**
 * What clearing a week does, said before it's done. A final week's points
 * are in the season's standings, so clearing it changes them. It goes back
 * to Live only while no other week is (0059): two Live weeks would leave
 * the groups scoring the wrong one.
 */
export function clearWarning(
  round: Pick<Round, "name" | "status">,
  locked: number,
  /** Another week of the league that is Live, if one is. */
  liveWeek: string | null = null,
): string {
  const final =
    round.status !== "final"
      ? ""
      : liveWeek
        ? `${round.name} is final: clearing it takes its scores out of the standings, so the season’s points change. It stays final, as ${liveWeek} is the Live week. To put one card right, use “Fix a card” instead. `
        : `${round.name} is final: clearing it sets it back to Live and takes its scores out of the standings, so the season’s points change. To put one card right, use “Fix a card” instead. `;
  const cards =
    locked > 0
      ? ` ${locked === 1 ? "The signed-off card opens" : `The ${locked} signed-off or locked cards open`} again too: the groups score and sign again.`
      : "";
  return `${final}Kept for 7 days in case you change your mind.${cards}`;
}

/** When a cleared copy stops being kept: "Sat, Nov 14, 3:05 PM". */
function keptUntil(restorable: Restorable): string {
  const until = restorable.keptUntil
    ? new Date(restorable.keptUntil)
    : new Date(Date.parse(restorable.clearedAt) + 7 * 24 * 60 * 60 * 1000);
  return until.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const holes = (n: number) => (n === 1 ? "1 hole" : `${n} holes`);
const scores = (n: number) => (n === 1 ? "1 score" : `${n} scores`);

/**
 * What "Put them back" asks first. Only the holes still empty are filled: a
 * hole scored since the clear keeps its new score (0060).
 */
export function putBackQuestion(restorable: Restorable, final: boolean): string {
  const kept = restorable.kept ?? 0;
  const what =
    kept > 0
      ? `Put the ${scores(restorable.count)} back into the holes that are still empty? ${holes(kept)} scored since the clear ${kept === 1 ? "keeps its" : "keep their"} new score.`
      : `Put the ${scores(restorable.count)} back as they were?`;
  const signs = final
    ? " The week stays final."
    : " Sign-offs aren’t put back: the groups sign again.";
  return `${what}${signs} The cleared copy is kept until ${keptUntil(restorable)}.`;
}

/** The notice once they're back. */
export function putBackDone(week: string, restored: number, kept: number): string {
  return kept > 0
    ? `Put back ${scores(restored)} in ${week}; ${holes(kept)} kept ${kept === 1 ? "its" : "their"} new score.`
    : `Put back ${scores(restored)} in ${week}.`;
}

/** Undo the last "Clear scores" on a week, within seven days, after asking. */
function RestoreButton({
  restorable,
  final,
  onRestore,
}: {
  restorable: Restorable | null;
  final: boolean;
  onRestore: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  if (!restorable) return null;

  if (!asking) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2">
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="font-mono text-xs text-forest underline"
        >
          {`Put back ${restorable.count} cleared ${restorable.count === 1 ? "score" : "scores"}`}
        </button>
        <span className="font-mono text-[11px] text-ink-soft">
          kept until {keptUntil(restorable)}
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-xs text-forest">{putBackQuestion(restorable, final)}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRestore();
          setBusy(false);
          setAsking(false);
        }}
        // Filled, beside an outlined Cancel: the two looked alike.
        className="min-h-9 bg-forest-deep px-3 font-mono text-xs font-bold text-cream disabled:opacity-40"
      >
        {busy ? "Putting back…" : "Put them back"}
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="min-h-9 border border-hairline px-3 font-mono text-xs text-ink-soft"
      >
        Cancel
      </button>
    </span>
  );
}

/**
 * Set or clear a player's handicap index. Net scores and the standings are
 * only as fair as these numbers, so the owner can correct a wrong one.
 */
export function HandicapEditor({
  current,
  onSave,
}: {
  current: number | null;
  onSave: (index: number | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (index: number | null) => {
    setBusy(true);
    const saved = await onSave(index);
    setBusy(false);
    if (saved) setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(current === null ? "" : formatHandicapIndex(current));
          setError(null);
          setOpen(true);
        }}
        className="font-mono text-xs text-forest underline"
      >
        {current === null ? "Set handicap" : "Change handicap"}
      </button>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseHandicapInput(value);
        if (!parsed.ok) return setError(parsed.reason);
        setError(null);
        void save(parsed.value);
      }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {/* Plain text, not a numeric keypad: a plus handicap needs its "+". */}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="12.4 or +1.4"
        aria-label="Handicap index"
        autoFocus
        className="min-h-9 w-28 border border-hairline bg-cream px-2 font-mono text-sm focus:outline-2 focus:outline-forest"
      />
      <button
        type="submit"
        disabled={busy}
        className="font-mono text-xs font-bold text-forest underline disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {current !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(null)}
          className="font-mono text-xs text-clay underline disabled:opacity-40"
        >
          Clear
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="font-mono text-xs text-ink-soft underline"
      >
        Cancel
      </button>
      {error && (
        <span role="alert" className="w-full font-mono text-xs text-clay">
          {error}
        </span>
      )}
    </form>
  );
}

/**
 * A destructive action behind a second click. The first says what it is;
 * the second says exactly what it will do, with the number in it.
 */
function StatusBadge({ status }: { status: RoundStatus }) {
  return (
    <span
      className={`shrink-0 border px-2 py-1 font-mono text-xs tracking-wider uppercase ${
        status === "live"
          ? "border-clay text-clay"
          : status === "final"
            ? "border-forest text-forest"
            : "border-hairline text-ink-soft"
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </div>
  );
}
