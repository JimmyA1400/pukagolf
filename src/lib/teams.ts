/**
 * Building teams from a roster.
 *
 * Auto-assign gets an outing to the first tee quickly; the admin can rearrange
 * afterwards. Both paths land in the same shape, so nothing downstream cares
 * which was used.
 */

import { isTeamFormat, teamSize, type FormatId } from "./formats";

export type DraftTeam = {
  /** Stable within a draft, so React keys and drag targets survive edits. */
  key: string;
  name: string;
  memberIds: string[];
};

export type AutoAssignment = {
  teams: DraftTeam[];
  /**
   * Teams below the format's size. A 22-player scramble in fours leaves a pair,
   * which is playable but a real disadvantage — so it is surfaced rather than
   * quietly created.
   */
  shortTeamKeys: string[];
  warning: string | null;
};

/**
 * Chunk the roster into teams, in the order given.
 *
 * Deterministic on purpose: shuffling happens in `shuffle` with an explicit
 * seed, so an admin who hits "randomise" gets a new draw while tests and
 * re-renders stay stable.
 */
export function autoAssignTeams(
  format: FormatId,
  playerIds: readonly string[],
): AutoAssignment {
  if (!isTeamFormat(format)) {
    return {
      teams: playerIds.map((id, i) => ({
        key: `t${i + 1}`,
        name: `Player ${i + 1}`,
        memberIds: [id],
      })),
      shortTeamKeys: [],
      warning: null,
    };
  }

  const size = teamSize(format);
  const teams: DraftTeam[] = [];

  for (let i = 0; i < playerIds.length; i += size) {
    teams.push({
      key: `t${teams.length + 1}`,
      name: `Team ${teams.length + 1}`,
      memberIds: playerIds.slice(i, i + size),
    });
  }

  const short = teams.filter((t) => t.memberIds.length < size);
  const remainder = playerIds.length % size;

  return {
    teams,
    shortTeamKeys: short.map((t) => t.key),
    warning:
      remainder === 0
        ? null
        : `${playerIds.length} players don't divide into teams of ${size}. ` +
          `${remainder === 1 ? "One player is" : `${remainder} players are`} ` +
          `in a short team — add ${size - remainder} more, or move them by hand.`,
  };
}

/**
 * Deterministic shuffle, so "randomise" is reproducible from its seed.
 *
 * Fisher-Yates driven by a small PRNG rather than Math.random: the same seed
 * gives the same draw, which makes an unfair-looking result checkable instead
 * of a mystery.
 */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;

  const next = () => {
    // xorshift32 — small, fast, and good enough for pairing golfers.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return (state >>> 0) / 0x100000000;
  };

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

/** Move a player to another team, removing them from wherever they were. */
export function movePlayer(
  teams: readonly DraftTeam[],
  playerId: string,
  toTeamKey: string,
): DraftTeam[] {
  return teams.map((team) => {
    const without = team.memberIds.filter((id) => id !== playerId);

    if (team.key !== toTeamKey) return { ...team, memberIds: without };

    // Guard against a double-add if the player was already here.
    return { ...team, memberIds: [...without, playerId] };
  });
}

/** Swap two players between (or within) teams in a single step. */
export function swapPlayers(
  teams: readonly DraftTeam[],
  a: string,
  b: string,
): DraftTeam[] {
  const teamOf = (id: string) =>
    teams.find((t) => t.memberIds.includes(id))?.key;

  const teamA = teamOf(a);
  const teamB = teamOf(b);
  if (!teamA || !teamB || teamA === teamB) return [...teams];

  return teams.map((team) => ({
    ...team,
    memberIds: team.memberIds.map((id) => {
      if (id === a) return b;
      if (id === b) return a;

      return id;
    }),
  }));
}

/** Players on no team yet. */
export function unassigned(
  teams: readonly DraftTeam[],
  playerIds: readonly string[],
): string[] {
  const placed = new Set(teams.flatMap((t) => t.memberIds));

  return playerIds.filter((id) => !placed.has(id));
}
