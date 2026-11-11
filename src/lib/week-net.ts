import { netField, type NetField } from "./net";
import type { LiveRound } from "./useLiveRound";
import { teeOptions } from "./yardage";

/**
 * Each player's course handicap and the holes they get strokes on, for one
 * week: worked out from the same inputs as the leaderboard (played tee, then
 * preference, then the longest), so a printed card and the phone agree.
 */
export function weekNet(data: LiveRound): NetField {
  const playedTees: Record<string, string> = Object.assign(
    {},
    ...data.groups.map((g) => g.playedTees),
  );

  return netField({
    players: data.players.map((p) => ({
      id: p.id,
      handicapIndex: p.handicap_index,
      preferredTee: p.preferred_tee,
      playedTee: playedTees[p.id] ?? null,
    })),
    tees: teeOptions(data.holes, data.tees),
    coursePar: Object.values(data.pars).reduce((a, b) => a + b, 0),
    holeCount: data.course.holeCount,
    strokeIndexes: Object.fromEntries(
      data.holes
        .filter((h) => h.strokeIndex !== null)
        .map((h) => [h.hole, h.strokeIndex as number]),
    ),
    startHole: data.course.startHole,
  });
}
