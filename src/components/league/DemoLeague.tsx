"use client";

import { useMemo, useState } from "react";

import { buildBoard, Leaderboard, LeaderCard } from "@/components/league/Leaderboard";
import { CourseSetup } from "@/components/league/CourseSetup";
import {
  ClubhouseFeed,
  SkinsPot,
  TeeSheet,
} from "@/components/league/Panels";
import { ScoreEntry } from "@/components/league/ScoreEntry";
import { Tabs } from "@/components/league/Tabs";
import { WhosWhere } from "@/components/league/WhosWhere";
import { describePlace } from "@/lib/weather";
import {
  COURSE,
  COURSE_PAR,
  FEED,
  GROUPS,
  PARS,
  PLAYERS,
  SCORES,
  SKINS_STAKE,
  shortName,
  VIEWER_ID,
  type FeedItem,
  type TeeGroup,
} from "@/lib/demo-round";
import type { Score } from "@/lib/leaderboard";
import {
  applyScore,
  seedAssignments,
  validateSubmission,
} from "@/lib/scoring-rules";

/**
 * The league page. Every panel reads the same score state and writes back to
 * it, so the leaderboard, skins and progress bars all follow from the cards
 * being kept rather than from anything hardcoded.
 *
 * Still local state — nothing persists or syncs until Supabase is wired in.
 */
export function DemoLeague() {
  const [scores, setScores] = useState<readonly Score[]>(SCORES);
  const [feed, setFeed] = useState<readonly FeedItem[]>(FEED);
  const [stake, setStake] = useState(SKINS_STAKE);
  const [skinsOn, setSkinsOn] = useState(true);
  // Real conditions, even in the demo — the weather endpoint needs no account.
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
    locationName: string | null;
  } | null>(null);
  const [groups, setGroups] = useState<readonly TeeGroup[]>(GROUPS);

  // Stands in for signing in. Real auth replaces both of these.
  const [viewerId, setViewerId] = useState(VIEWER_ID);
  const [isAdmin, setIsAdmin] = useState(false);

  const assignments = useMemo(() => seedAssignments(groups), [groups]);

  /** Returns a refusal message, or null when the score is accepted. */
  const submitScore = (targetId: string, hole: number, strokes: number) => {
    const check = validateSubmission({
      assignments,
      scores,
      viewerId,
      targetId,
      hole,
      strokes,
      isAdmin,
    });

    if (!check.ok) return check.reason;

    setScores((current) => applyScore(current, targetId, hole, strokes));

    return null;
  };

  const post = (what: string) =>
    setFeed((current) => [
      { id: crypto.randomUUID(), authorId: viewerId, what, ageMinutes: 0 },
      ...current,
    ]);

  const skinsGroup =
    groups.find((g) => g.playerIds.includes(viewerId))?.playerIds ??
    groups[0].playerIds;

  // The demo is always plain stroke play; the real league picks its game.
  const board = buildBoard({
    players: PLAYERS,
    scores,
    pars: PARS,
    holeCount: COURSE.holeCount,
  });

  return (
    <div className="min-w-0">
      <header className="border-b-4 border-rule bg-cream px-5 py-6 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Puka<span className="text-forest">Golf</span>
          </h1>

          <span className="flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 font-mono text-xs tracking-wider uppercase">
            <span aria-hidden className="h-2 w-2 rounded-full bg-clay" />
            Live — Rd 14
          </span>
        </div>

        <p className="mt-2 font-mono text-xs text-ink-soft sm:text-sm">
          {COURSE.name} · Par {COURSE_PAR} ·{" "}
          {new Set(scores.map((s) => s.playerId)).size} players out
        </p>

        {/* Stands in for signing in — replaced by real auth. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          <label className="meta">
            Signed in as{" "}
            <select
              value={viewerId}
              onChange={(e) => setViewerId(e.target.value)}
              className="ml-1 border border-hairline bg-card px-2 py-1 font-mono text-xs normal-case"
            >
              {PLAYERS.map((player) => (
                <option key={player.id} value={player.id}>
                  {shortName(player.name)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 font-mono text-xs">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="accent-forest"
            />
            Admin mode
          </label>
        </div>
      </header>

      <main className="min-w-0 space-y-10 bg-sand px-5 py-8 sm:px-8">
        <section className="min-w-0">
          <p className="meta mb-2">Current leader</p>
          <LeaderCard {...board} game="stroke" holeCount={COURSE.holeCount} />
        </section>


        <section className="min-w-0">
          <h2 className="section-head mb-3 pb-2 text-xl">Leaderboard</h2>
          <Leaderboard
            {...board}
            game="stroke"
            pars={PARS}
            holeCount={COURSE.holeCount}
            viewerId={viewerId}
          />
        </section>

        <Tabs
          tabs={[
            {
              id: "scorecards",
              label: "Scorecards",
              content: (
                <ScoreEntry
                  players={PLAYERS}
                  scores={scores}
                  pars={PARS}
                  holeCount={COURSE.holeCount}
                  assignments={assignments}
                  viewerId={viewerId}
                  isAdmin={isAdmin}
                  onSubmit={submitScore}
                />
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
                <span className="meta">{COURSE.holeCount} holes</span>
              </div>
              <WhosWhere
                players={PLAYERS}
                scores={scores}
                pars={PARS}
                holeCount={COURSE.holeCount}
                viewerId={viewerId}
              />
            </section>

            <SkinsPot
              players={PLAYERS}
              groupIds={skinsGroup}
              scores={scores}
              pars={PARS}
              stake={stake}
              enabled={skinsOn}
              onStakeChange={setStake}
              onEnabledChange={setSkinsOn}
              isAdmin={isAdmin}
            />
            <CourseSetup
              courseName={COURSE.name}
              locationName={location?.locationName ?? null}
              attribution={null}
              onLocationChange={(place) =>
                setLocation({
                  latitude: place.latitude,
                  longitude: place.longitude,
                  locationName: describePlace(place),
                })
              }
              isAdmin={isAdmin}
            />
            <TeeSheet
              groups={groups}
              players={PLAYERS}
              isAdmin={isAdmin}
              onChange={(id, patch) =>
                setGroups((current) =>
                  current.map((g) => (g.id === id ? { ...g, ...patch } : g)),
                )
              }
            />
            <ClubhouseFeed
              items={feed}
              players={PLAYERS}
              viewerId={viewerId}
              onPost={post}
              onDelete={(id) =>
                setFeed((current) => current.filter((f) => f.id !== id))
              }
              isAdmin={isAdmin}
            />
                </div>
              ),
            },
          ]}
        />
      </main>
    </div>
  );
}
