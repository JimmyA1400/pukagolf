"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { buildBoard, Leaderboard, LeaderCard } from "@/components/league/Leaderboard";
import { GroupMatch } from "@/components/league/GroupMatch";
import { CourseSetup } from "@/components/league/CourseSetup";
import { ClubhouseFeed, SkinsPot, TeeSheet } from "@/components/league/Panels";
import { ScoreEntry } from "@/components/league/ScoreEntry";
import { UnsentScores } from "@/components/league/UnsentScores";
import { Tabs } from "@/components/league/Tabs";
import { WhosWhere } from "@/components/league/WhosWhere";
import { WeatherStrip } from "@/components/WeatherStrip";
import { TeeSelect, useTeeSelection } from "@/components/TeeSelect";
import { RsvpAdmin } from "@/components/league/RsvpAdmin";
import { CompleteRound } from "@/components/league/CompleteRound";
import { WeekRsvp } from "@/components/league/WeekRsvp";
import { SeasonStandings } from "@/components/league/SeasonStandings";
import { SkinsBracket } from "@/components/league/SkinsBracket";
import { AskForLeague, LeagueChoices } from "@/components/AskForLeague";
import { PUKAGOLF_SLUG } from "@/lib/club-paths";
import { useClub } from "@/lib/club";
import { clubClock } from "@/lib/club-time";
import { Announcement } from "@/components/league/Announcement";
import { MyWeek } from "@/components/league/MyWeek";
import { getGame } from "@/lib/games";
import { holesLabel, roundHoles } from "@/lib/holes";
import { netField, toNetScores } from "@/lib/net";
import { readPending, unsentCount, withPending } from "@/lib/score-queue";
import { useSeason } from "@/lib/useSeason";
import { teeOptions } from "@/lib/yardage";
import { resolveTee } from "@/lib/tee-preference";
import type { FeedItem, Player, TeeGroup } from "@/lib/demo-round";
import { createClient } from "@/lib/supabase/client";
import { useLiveRound } from "@/lib/useLiveRound";
import { describePlace } from "@/lib/weather";
import { friendlyDate } from "@/lib/league-week";

/** The real thing: everything below reads and writes Supabase. */
export function LiveLeague() {
  const router = useRouter();
  // A past week, opened from the admin page to put one card in it right.
  const params = useSearchParams();
  const week = params.get("week");
  // A ?league= the address gave itself, as against the club's first league.
  const leagueAsked = params.get("league");
  const {
    state,
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
    reload,
    postToFeed,
    deletePost,
    pending,
    showing,
    sendPending,
    queueNotice,
  } = useLiveRound(week);
  const { club, href, league, leagueHref, missingLeague } = useClub();
  const [notice, setNotice] = useState<string | null>(null);
  const [scoring, setScoring] = useState<"gross" | "net">("gross");
  // Whether the leader is the leading player or the leading group. This
  // phone's choice, remembered: it is how you like to read the page, not
  // something the league decides.
  const [leaderView, setLeaderView] = useState<"players" | "groups">("players");
  // Loaded alongside the round, since hooks can't follow the early returns.
  // Undefined is this year; the Standings tab's picker changes it.
  const [seasonYear, setSeasonYear] = useState<number | undefined>(undefined);
  const season = useSeason(seasonYear);
  // A week asked for that isn't this league's: whose it is, for the notice.
  const asked = useAskedWeek(week, state.status === "ready" ? state.data.round.id : null);
  // The league of this club it's a week of, if the viewer can open it.
  const askedLeague = asked ? club.leagues.find((l) => l.id === asked.leagueId && l.id !== league?.id) ?? null : null;
  // An address with only a week in it opens that week's own league, not the
  // club's first: a link without ?league= showed the wrong league's week.
  useEffect(() => {
    if (week && askedLeague && !leagueAsked) {
      router.replace(leagueHref(askedLeague, `/league?week=${encodeURIComponent(week)}`));
    }
  }, [week, askedLeague, leagueAsked, leagueHref, router]);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(LEADER_VIEW_KEY) === "groups") setLeaderView("groups");
    } catch {
      // Blocked storage: players, every time.
    }
  }, []);

  const chooseLeaderView = (next: "players" | "groups") => {
    setLeaderView(next);
    try {
      if (next === "groups") localStorage.setItem(LEADER_VIEW_KEY, "groups");
      else localStorage.removeItem(LEADER_VIEW_KEY);
    } catch {
      // As above.
    }
  };

  const players: Player[] = useMemo(() => {
    if (state.status !== "ready") return [];

    // Everyone gets their own name, including the viewer — the highlighted row
    // already says which one is you.
    return state.data.players.map((profile) => ({
      id: profile.id,
      name: profile.full_name,
      short: abbreviate(profile.full_name),
    }));
  }, [state]);

  // Computed before the early returns below: hooks cannot run conditionally,
  // and the tee selection is a hook.
  const teeChoices = useMemo(
    () =>
      state.status === "ready"
        ? teeOptions(state.data.holes, state.data.tees)
        : [],
    [state],
  );

  const [tee, setTee] = useTeeSelection(
    state.status === "ready"
      ? `course:${state.data.course.id ?? "none"}`
      : "course:none",
    teeChoices,
    // The saved preference is a category — Tips, Mens, Ladies — so it has to
    // be resolved against this course's own card before it names a tee.
    // Nothing resolved means the longest, per Step 2.
    state.status === "ready"
      ? (resolveTee(state.viewer.preferred_tee, teeChoices)?.tee ?? null)
      : null,
  );

  // A member the pro shop hasn't put in a league yet sees which leagues there
  // are, and can ask, instead of an empty leaderboard.
  if (!league) return <AskForLeague />;

  if (state.status === "loading") {
    return <Centered>Loading the round…</Centered>;
  }

  if (state.status === "error") {
    return (
      <Centered>
        <p>{state.message}</p>
        <Link href="/sign-in" className="mt-3 inline-block underline">
          Sign in
        </Link>
      </Centered>
    );
  }

  const { data, viewer } = state;
  // Scores still waiting on this phone for a signal show as if saved.
  const { scores: saved } = data;
  // Saved scores, with what's waiting and what has only just landed on top,
  // so a hole never shows blank between being sent and the card reloading.
  const scores = withPending(saved, showing);
  const playersOut = new Set(scores.map((s) => s.playerId)).size;
  // An admin of this club, not of any club: a PukaGolf admin gets no controls
  // in somebody else's league. The database checks the same thing again.
  const isAdmin = club.role === "admin";
  const holeCount = data.course.holeCount;
  const startHole = data.course.startHole;
  // What the week is being played for. Stroke play unless an admin said so.
  const game = data.round.game ?? "stroke";
  const spec = getGame(game);

  const groups: TeeGroup[] = data.groups.map((group, i) => ({
    id: group.id,
    label: `Group ${i + 1}`,
    // The club's clock, whatever zone the phone is set to.
    time: clubClock(group.teeAt, club.timeZone),
    playerIds: group.playerIds,
    // A threesome that is meant to be a threesome has no open slot.
    open: group.playerIds.length < group.seats,
  }));

  const feed: FeedItem[] = data.feed.map((post) => ({
    id: post.id,
    authorId: post.author_id,
    what: post.body,
    ageMinutes: post.ageMinutes,
  }));

  const myTeeTime = data.groups.find((g) => g.playerIds.includes(viewer.id));
  const myGroup = myTeeTime?.playerIds ?? data.groups[0]?.playerIds ?? [];

  // The whole course's par, which a tee's rating is set against, for net.
  const coursePar = Object.values(data.pars).reduce((a, b) => a + b, 0);
  // Par for the holes this week plays, for the header.
  const roundPar = roundHoles(holeCount, startHole).reduce(
    (sum, hole) => sum + (data.pars[hole] ?? 0),
    0,
  );

  // Noon, so the date can't slip a day in any US time zone.
  const teeSheetSubtitle = `${new Date(`${data.round.played_on}T12:00:00`).toLocaleDateString(
    undefined,
    { weekday: "short", month: "short", day: "numeric" },
  )} · ${groups.length} ${groups.length === 1 ? "group" : "groups"}`;

  const scorecardExtras = {
    yards: Object.fromEntries(
      data.holes
        .map((h) => [h.hole, tee ? h.yardages[tee] : undefined])
        .filter(([, yards]) => typeof yards === "number"),
    ) as Record<number, number>,
    strokeIndexes: Object.fromEntries(
      data.holes
        .filter((h) => h.strokeIndex !== null)
        .map((h) => [h.hole, h.strokeIndex as number]),
    ),
  };

  // Net is worked out from the same inputs the season standings use — played
  // tee, then preference, then the longest — so the two always agree.
  const playedTees: Record<string, string> = Object.assign(
    {},
    ...data.groups.map((g) => g.playedTees),
  );
  const net = netField({
    players: data.players.map((p) => ({
      id: p.id,
      handicapIndex: p.handicap_index,
      preferredTee: p.preferred_tee,
      playedTee: playedTees[p.id] ?? null,
    })),
    tees: teeChoices,
    coursePar,
    holeCount,
    strokeIndexes: scorecardExtras.strokeIndexes,
    startHole,
  });
  // A side sharing one ball has no handicap allowance, so a scramble is gross.
  const showNet = scoring === "net" && net.available && !spec.grossOnly;
  const shownScores = showNet
    ? toNetScores(scores, net.received)
    : scores;
  // Someone with no index has no net score, and a gross one would top the table.
  const shownPlayers = showNet
    ? players.filter((p) => p.id in net.received)
    : players;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.short ?? "?";

  const board = buildBoard({
    game,
    players: shownPlayers,
    scores: shownScores,
    pars: data.pars,
    holeCount,
    startHole,
    groups,
    stableford: data.round.stableford_points ?? undefined,
    // Under Self Scoring every card is its own player's; elsewhere it's news.
    selfKept: data.scoringMode === "self" ? [] : data.selfKept,
  });

  // The side game: the same scores read as best ball, group against group.
  // Pointless in a week that is already played between the tee times, so the
  // choice is only offered when it would show something different.
  const groupsPlayable = !spec.team && groups.length > 0;
  const groupBoard = groupsPlayable
    ? buildBoard({
        game: "best_ball",
        players: shownPlayers,
        scores: shownScores,
        pars: data.pars,
        holeCount,
        startHole,
        groups,
      })
    : null;
  const byGroups = leaderView === "groups" && groupBoard !== null;

  // Until the season loads, assume skins are on rather than flash them away.
  const leagueSkins =
    season.state.status === "ready" ? season.state.season.leagueSkins : true;

  // The league chooses whether anyone is named as leading before the week is
  // final ("Show the current leader during the week"), or only the winner at
  // the end. Nobody is named before anyone has played a hole, either way.
  const showsLeaderLive =
    season.state.status === "ready" && season.state.season.rules.standingsCount === "live";
  const weekIsFinal = data.round.status === "final";
  const showLeader = board.rows.some((row) => row.thru > 0) && (weekIsFinal || showsLeaderLive);

  /** Surfaces whatever the database refused, rather than failing silently. */
  const report = async (run: Promise<string | null>) => {
    setNotice(await run);
  };

  return (
    <div className="min-w-0">
      <WeatherStrip
        courseName={data.course.name}
        locationName={data.course.locationName}
        latitude={data.course.latitude}
        longitude={data.course.longitude}
        edge="px-5 sm:px-8"
      />

      <header className="border-b-4 border-rule bg-cream px-5 py-6 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* The club's own name: PukaGolf is already in the bar above. */}
          <h1 className="min-w-0 font-display text-3xl font-bold tracking-tight break-words sm:text-4xl">
            {club.slug === PUKAGOLF_SLUG ? (
              <>
                Puka<span className="text-forest">Golf</span>
              </>
            ) : (
              club.name
            )}
          </h1>

          <span className="flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 font-mono text-xs tracking-wider uppercase">
            <span aria-hidden className="h-2 w-2 rounded-full bg-clay" />
            {data.round.status === "live" ? "Live" : data.round.status} —{" "}
            {data.round.name}
          </span>
        </div>

        <p className="mt-2 font-display text-lg font-bold">{league.name}</p>

        <p className="mt-1 font-mono text-xs text-ink-soft sm:text-sm">
          {data.course.name} · Par {roundPar}
          {startHole > 1 && " · back nine"}
          {game !== "stroke" && ` · ${spec.label}`}
          {data.round.is_simulator && " · simulator"} ·{" "}
          {playersOut} {playersOut === 1 ? "player" : "players"} out
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
          <span className="meta">
            {viewer.full_name}
            {isAdmin && " · admin"}
          </span>

          {/* Each link a full finger high: these get tapped on the course. */}
          <div className="flex flex-wrap items-center gap-x-4">
            <Link href="/profile" className="inline-flex min-h-11 items-center font-mono text-xs underline">
              Profile
            </Link>

            {isAdmin && (
              <>
                <Link
                  href={href("/league/groups")}
                  className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
                >
                  Groups &amp; tee times
                </Link>
                <Link
                  href={href("/league/print")}
                  className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
                >
                  Print sheets
                </Link>
                <Link
                  href={href("/league/events")}
                  className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
                >
                  League events
                </Link>
                {/* Outings are PukaGolf's own until clubs are given them. */}
                {club.slug === PUKAGOLF_SLUG && (
                  <>
                    <Link
                      href={href("/outings")}
                      className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
                    >
                      All outings
                    </Link>
                    <Link
                      href={href("/outings/new")}
                      className="inline-flex min-h-11 items-center font-mono text-xs text-forest underline"
                    >
                      New outing
                    </Link>
                  </>
                )}
              </>
            )}

            <button
              type="button"
              onClick={async () => {
                await createClient().auth.signOut();
                router.push("/sign-in");
                router.refresh();
              }}
              className="inline-flex min-h-11 items-center font-mono text-xs text-ink-soft underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="min-w-0 space-y-10 bg-sand px-5 py-8 sm:px-8">
        {missingLeague && (
          <section
            aria-label="That league"
            className="border border-clay bg-card px-4 py-3 font-mono text-xs"
          >
            <p className="text-clay">
              The address asked for the &ldquo;{missingLeague}&rdquo; league, but you
              don&rsquo;t play in a league by that name at {club.name}, so this is{" "}
              {league.name}. To play in another of the club&rsquo;s leagues, ask the pro
              shop below.
            </p>
            <LeagueChoices clubId={club.id} clubName={club.name} othersOnly />
          </section>
        )}

        {/* A week asked for that isn't this league's: said, so nobody fixes
            a card in the wrong league thinking it's the week they meant. */}
        {week && data.round.id !== week && (
          <section
            aria-label="Not that week"
            role="alert"
            className="border-2 border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
          >
            {asked && askedLeague ? (
              <>
                The week asked for is {asked.week} of {askedLeague.name}, not one of {league.name}&rsquo;s,
                so this is {league.name}&rsquo;s current week, {data.round.name}.{" "}
                <Link
                  href={leagueHref(askedLeague, `/league?week=${encodeURIComponent(asked.id)}`)}
                  className="inline-flex min-h-11 items-center font-bold underline"
                >
                  Open {asked.week} in {askedLeague.name}
                </Link>
              </>
            ) : (
              `The week asked for isn’t one of ${league.name}’s, so this is ${league.name}’s current week, ${data.round.name}. Open the week from its own league’s admin page.`
            )}
          </section>
        )}

        {week && data.round.id === week && (
          <section
            aria-label="A past week"
            className="border-2 border-clay bg-card px-4 py-3 font-mono text-xs"
          >
            <p className="text-clay">
              You&rsquo;re looking at {league.name}&rsquo;s {data.round.name} (
              {friendlyDate(data.round.played_on)}
              {weekIsFinal ? ", final" : ""}), not this week.
              {isAdmin &&
                (weekIsFinal
                  ? " To put one card right, pick it in \u201cFix any card\u201d on the Scorecards tab. A change here needs a reason, and the week\u2019s results and everyone\u2019s season points are worked out again from the cards."
                  : " Pick a card in \u201cFix any card\u201d on the Scorecards tab to change it.")}
            </p>
            <Link href={href("/league")} className="mt-2 inline-flex min-h-11 items-center underline">
              Back to this week
            </Link>
          </section>
        )}

        <Announcement canEdit={isAdmin} />

        {(notice ?? queueNotice) && (
          <p
            role="alert"
            className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
          >
            {notice ?? queueNotice}
          </p>
        )}

        <UnsentScores
          pending={pending}
          onSendNow={async () => {
            await report(sendPending());
            // Read from the phone itself: this render's list is from before the try.
            return unsentCount(readPending(data.round.id));
          }}
          // A signed-off group, or a final week: no card here to keep, so no
          // signal is nothing to warn about.
          nothingToScore={
            data.round.status === "final" ||
            (myGroup.length > 0 && myGroup.every((id) => data.lockedPlayerIds.includes(id)))
          }
        />

        <MyWeek
          viewerId={viewer.id}
          players={players}
          groups={groups}
          assignments={data.assignments}
          playedOn={data.round.played_on}
          mode={data.scoringMode}
          noLogin={data.noLogin}
          isAdmin={isAdmin}
        />

        {/* Asked only until the groups exist: once the pro shop has built
            them, by RSVP or by hand, the answer no longer changes anything. */}
        {data.round.status === "setup" && data.groups.length === 0 && (
          <WeekRsvp
            roundId={data.round.id}
            roundName={data.round.name}
            playedOn={data.round.played_on}
          />
        )}

        {showLeader && (
          <section className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="meta">
                {weekIsFinal
                  ? byGroups
                    ? "Winning group"
                    : "This week’s winner"
                  : byGroups
                    ? "Leading group · provisional"
                    : "Current leader · provisional"}
                {showNet && " · net"}
              </p>
              {groupsPlayable && (
                <LeaderToggle value={leaderView} onChange={chooseLeaderView} />
              )}
            </div>

            {byGroups ? (
              <div className="space-y-3">
                <LeaderCard
                  {...groupBoard}
                  game="best_ball"
                  holeCount={holeCount}
                  startHole={startHole}
                />
                <GroupMatch
                  rows={groupBoard.rows}
                  label={groupBoard.label}
                  holeCount={holeCount}
                  viewerId={viewer.id}
                />
                <p className="font-mono text-xs text-ink-soft">
                  A side game: the lowest card in each group on every hole, groups
                  ranked against each other. A group&rsquo;s hole counts once
                  everyone in it has posted, so a threesome and a foursome are
                  compared on the same footing. The week is still scored as{" "}
                  {spec.label.toLowerCase()}.
                </p>
              </div>
            ) : (
              <LeaderCard
                {...board}
                game={game}
                holeCount={holeCount}
                startHole={startHole}
              />
            )}
          </section>
        )}

        <section className="min-w-0">
          <div className="section-head mb-3 flex flex-wrap items-baseline justify-between gap-2 pb-2">
            <h2 className="text-xl">Leaderboard</h2>
            {!spec.grossOnly && <ScoringToggle value={scoring} onChange={setScoring} />}
          </div>

          {spec.grossOnly && (
            <p className="mb-3 font-mono text-xs text-ink-soft">
              {spec.label} is played gross: there is no handicap allowance for a
              side sharing one ball.
            </p>
          )}

          {scoring === "net" && !spec.grossOnly && (
            <p className="mb-3 font-mono text-xs break-words text-ink-soft">
              {!net.available
                ? "Net needs a stroke index on every hole. An admin can add them under Course setup on the 19th Hole tab; until then this is gross."
                : [
                    Object.keys(net.handicaps).length > 0 &&
                      `Strokes: ${Object.entries(net.handicaps)
                        .map(([id, strokes]) => `${nameOf(id)} ${strokes}`)
                        .join(" · ")}.`,
                    net.withoutIndex.length > 0 &&
                      `${net.withoutIndex.map(nameOf).join(", ")} ${
                        net.withoutIndex.length === 1 ? "has" : "have"
                      } no handicap index, so ${
                        net.withoutIndex.length === 1 ? "isn't" : "aren't"
                      } in the net table.`,
                  ]
                    .filter(Boolean)
                    .join(" ")}
            </p>
          )}

          <Leaderboard
            {...board}
            game={game}
            pars={data.pars}
            holeCount={holeCount}
            startHole={startHole}
            viewerId={viewer.id}
          />
        </section>

        <Tabs
          tabs={[
            {
              id: "scorecards",
              label: "Scorecards",
              content: (
                <>
                  {data.round.status === "setup" && (
                    <p
                      role="status"
                      className="mb-3 border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
                    >
                      This week is still being set up, so it hasn&rsquo;t started and
                      can&rsquo;t be scored yet. Cards open here when the pro shop sets the
                      week to Live.
                      {isAdmin && (
                        <>
                          {" "}
                          <Link href={href("/admin")} className="underline">
                            Set it to Live on the admin page
                          </Link>
                          .
                        </>
                      )}
                    </p>
                  )}
                  <TeeSelect
                    options={teeChoices}
                    value={tee}
                    onChange={setTee}
                  />
                  {data.round.status !== "setup" && (
                    <ScoreEntry
                      players={players}
                      scores={scores}
                      pars={data.pars}
                      holeCount={holeCount} startHole={startHole}
                      assignments={data.assignments}
                      viewerId={viewer.id}
                      isAdmin={isAdmin}
                      canFix={isAdmin || data.canFixScores}
                      mode={data.scoringMode}
                      lockedIds={data.lockedPlayerIds}
                      extras={scorecardExtras}
                      game={game}
                      team={
                        myTeeTime
                          ? {
                              id: myTeeTime.id,
                              label:
                                groups.find((g) => g.id === myTeeTime.id)?.label ?? "Your side",
                              playerIds: myTeeTime.playerIds,
                            }
                          : null
                      }
                      onSubmit={(targetId, hole, strokes) => {
                        void report(submitScore(targetId, hole, strokes));
                        // The database has the final say; its refusal arrives above.
                        return null;
                      }}
                      onSubmitTeam={(hole, strokes) => {
                        if (myTeeTime) void report(submitTeamScore(myTeeTime.id, hole, strokes));
                        return null;
                      }}
                      onSignOff={signOffGroup}
                      onSetLock={setCardLock}
                      onTakeBack={takeBackSignOff}
                      groups={data.groups}
                      onHistory={cardHistory}
                      noLogin={data.noLogin}
                      seasonClosed={data.seasonClosed}
                      weekFinal={data.round.status === "final"}
                      cardLocks={data.cardLocks}
                      onFixSigned={fixSignedScore}
                      strokesReceived={net.available && !spec.grossOnly ? net.received : undefined}
                      selfKept={data.selfKept}
                      unsent={unsentCount(pending)}
                      waiting={pending}
                      doubleParCap={data.doubleParCap}
                    />
                  )}
                </>
              ),
            },
            {
              id: "nineteenth-hole",
              label: "19th Hole",
              content: (
                <div className="space-y-4">
                  <section className="min-w-0">
                    <div className="section-head mb-3 flex items-baseline justify-between pb-2">
                      <h2 className="text-xl">Who&apos;s where</h2>
                      <span className="meta">{holesLabel(holeCount, startHole)}</span>
                    </div>
                    <WhosWhere
                      players={players}
                      scores={scores}
                      pars={data.pars}
                      holeCount={holeCount} startHole={startHole}
                      viewerId={viewer.id}
                    />
                  </section>

                  {isAdmin && (
                    <CompleteRound
                      roundId={data.round.id}
                      roundName={data.round.name}
                      playedOn={data.round.played_on}
                      status={data.round.status}
                      onCompleted={() => void reload()}
                    />
                  )}

                  {isAdmin && <RsvpAdmin roundId={data.round.id} />}

                  {leagueSkins && spec.sharedBall && (
                    <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
                      No skins in a scramble: every card in a group carries the
                      same number, so every hole would tie itself into a carry.
                    </p>
                  )}

                  {leagueSkins && !spec.sharedBall && (
                    <SkinsPot
                      players={players}
                      groupIds={myGroup}
                      scores={scores}
                      pars={data.pars}
                      stake={data.settings.skins_stake}
                      enabled={data.settings.skins_enabled}
                      holeCount={holeCount}
                      startHole={startHole}
                      onStakeChange={(next) =>
                        void report(updateSettings({ skins_stake: next }))
                      }
                      onEnabledChange={(next) =>
                        void report(updateSettings({ skins_enabled: next }))
                      }
                      isAdmin={isAdmin}
                    />
                  )}

                  <CourseSetup
                    courseName={data.course.name}
                    locationName={data.course.locationName}
                    attribution={data.course.attribution}
                    courseId={data.course.id}
                    holes={data.holes}
                    onHolesSaved={() => void reload()}
                    onCourseChange={(externalId) =>
                      void report(importCourse(externalId))
                    }
                    onLocationChange={(place) =>
                      void report(
                        updateCourseLocation({
                          latitude: place.latitude,
                          longitude: place.longitude,
                          timezone: place.timezone,
                          label: describePlace(place),
                        }),
                      )
                    }
                    isAdmin={isAdmin}
                  />

                  <TeeSheet
                    groups={groups}
                    players={players}
                    isAdmin={false}
                    onChange={() => {}}
                    subtitle={teeSheetSubtitle}
                  />

                  <ClubhouseFeed
                    items={feed}
                    players={players}
                    viewerId={viewer.id}
                    onPost={(text) => void report(postToFeed(text))}
                    onDelete={(id) => void report(deletePost(id))}
                    isAdmin={isAdmin}
                  />
                </div>
              ),
            },
            {
              id: "standings",
              label: "Standings",
              content: (
                <SeasonStandings
                  state={season.state}
                  viewerId={viewer.id}
                  onRefresh={() => void season.reload()}
                  onYearChange={setSeasonYear}
                />
              ),
            },
            ...(leagueSkins && !spec.sharedBall
              ? [
                  {
                    id: "skins",
                    label: "Skins",
                    content: (
                      <SkinsBracket
                        groups={groups.map((g) => ({
                          id: g.id,
                          label: `${g.label} · ${g.time}`,
                          playerIds: g.playerIds,
                        }))}
                        players={players}
                        scores={scores}
                        pars={data.pars}
                        holeCount={holeCount} startHole={startHole}
                        stake={data.settings.skins_stake}
                        weekEnabled={data.settings.skins_enabled}
                        season={season.state}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />

        {!missingLeague && (
          <OtherLeagues clubId={club.id} clubName={club.name} current={league?.id} />
        )}
      </main>
    </div>
  );
}

/**
 * The club's other leagues, and a way to ask to play in them. Nothing at all
 * when there is none the player isn't already in.
 */
function OtherLeagues({
  clubId,
  clubName,
  current,
}: {
  clubId: string;
  clubName: string;
  current?: string;
}) {
  return (
    <LeagueChoices
      clubId={clubId}
      clubName={clubName}
      othersOnly
      exclude={current}
      intro={
        <>
          <div className="section-head mb-1 pb-2">
            <h2 className="text-xl">Other leagues at {clubName}</h2>
          </div>
          <p className="mb-3 font-mono text-xs text-ink-soft">
            Want to play in another one too? Ask, and the pro shop will add you.
          </p>
        </>
      }
    />
  );
}

/** This phone's choice of what the leader card shows. */
const LEADER_VIEW_KEY = "pukagolf:leader-view";

/** The leading player, or the leading group played as best ball. */
function LeaderToggle({
  value,
  onChange,
}: {
  value: "players" | "groups";
  onChange: (next: "players" | "groups") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Leader"
      className="flex border border-hairline font-mono text-xs tracking-wider uppercase"
    >
      {(["players", "groups"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`min-h-9 px-3 ${
            value === option ? "bg-forest-deep text-cream" : "bg-card"
          }`}
        >
          {option === "players" ? "Players" : "Groups"}
        </button>
      ))}
    </div>
  );
}

/** Gross or net, for the leader card and the leaderboard together. */
function ScoringToggle({
  value,
  onChange,
}: {
  value: "gross" | "net";
  onChange: (next: "gross" | "net") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Scoring"
      className="flex border border-hairline font-mono text-xs tracking-wider uppercase"
    >
      {(["gross", "net"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`min-h-9 px-3 ${
            value === option ? "bg-forest-deep text-cream" : "bg-card"
          }`}
        >
          {option === "gross" ? "Gross" : "Net"}
        </button>
      ))}
    </div>
  );
}

/** "Marcus Diallo" -> "Marcus D.", so progress rows stay narrow on a phone. */
function abbreviate(fullName: string): string {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.at(-1);

  return last ? `${first} ${last[0]}.` : first;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}

/**
 * The name and league of a week asked for by id that the page isn't showing,
 * as far as the viewer may see it. Null until known, or when it can't be.
 */
function useAskedWeek(weekId: string | null, shownId: string | null) {
  const [found, setFound] = useState<{ id: string; week: string; leagueId: string } | null>(null);
  const wanted = weekId && shownId && weekId !== shownId ? weekId : null;

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void createClient()
      .from("rounds")
      .select("name, league_id")
      .eq("id", wanted)
      .maybeSingle()
      .then(({ data }) => {
        if (live && data?.name && data.league_id) setFound({ id: wanted, week: data.name, leagueId: data.league_id });
      });
    return () => {
      live = false;
    };
  }, [wanted]);

  return found && found.id === wanted ? found : null;
}
