/**
 * Turning a list of players into sides.
 *
 * Three things happen between "these people are in" and "here are the tee
 * times": the field is checked against the format, split into teams, and
 * paired into matches where the format needs it. All three are pure, so the
 * setup screen can show what a change would produce before anything is saved.
 *
 * Nothing here refuses. An uneven field is a fact about the evening, not a
 * mistake to be blocked on — the admin is told, and decides.
 */

import { getFormat, type FormatSpec } from "./registry";

export type FieldPlayer = {
  id: string;
  name: string;
  /** Null for a player with no index yet; they're drafted last. */
  handicapIndex: number | null;
};

export type WarningKind = "leftover" | "odd_sides" | "wrong_size" | "too_few";

export type FieldFix =
  | { kind: "add_players"; count: number }
  | { kind: "team_size"; size: number }
  | { kind: "bye" }
  | { kind: "blind_draw" };

export type FieldWarning = {
  kind: WarningKind;
  /**
   * The headline: what is wrong, in as few words as read at a glance. The
   * setup screen sets it in the display face, above the explanation, because
   * an admin standing on the first tee reads one line and acts.
   */
  headline: string;
  /** One line, in the admin's own terms. */
  message: string;
  /** What would resolve it, best first. */
  fixes: FieldFix[];
};

export type FieldCheck = {
  players: number;
  teamSize: number;
  /** Whole teams the field makes. */
  teams: number;
  /** Players who don't fit into a whole team. */
  leftOver: number;
  warnings: FieldWarning[];
  /** True when nothing is outstanding. Saving is allowed either way. */
  ready: boolean;
};

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What this field makes under this format, and anything the admin should know.
 *
 * Deliberately returns warnings rather than errors: "18 players → 4 teams of
 * 4, 2 left over" is something to act on, not something to be stopped by. A
 * week can be saved with it outstanding and fixed on the first tee.
 */
export function checkField({
  players,
  teamSize,
  format,
}: {
  players: number;
  teamSize: number;
  format: string | FormatSpec;
}): FieldCheck {
  const spec = typeof format === "string" ? getFormat(format) : format;
  const size = Math.max(1, Math.trunc(teamSize));
  const teams = size === 1 ? players : Math.floor(players / size);
  const leftOver = size === 1 ? 0 : players % size;
  const warnings: FieldWarning[] = [];

  if (!spec.sizes.includes(size)) {
    warnings.push({
      kind: "wrong_size",
      headline: `${spec.label} isn't played in ${size === 1 ? "singles" : `${size}s`}`,
      message: `${spec.label} is played in ${spec.sizes
        .map((s) => (s === 1 ? "singles" : `${s}s`))
        .join(" or ")}, not ${size === 1 ? "singles" : `${size}s`}.`,
      fixes: spec.sizes.map((s) => ({ kind: "team_size" as const, size: s })),
    });
  }

  if (leftOver > 0) {
    const need = size - leftOver;
    warnings.push({
      kind: "leftover",
      headline: `${plural(leftOver, "player")} left over`,
      message: `${plural(players, "player")} → ${plural(teams, "team")} of ${size}, ${leftOver} left over. Add ${plural(need, "player")} or pick an option.`,
      fixes: [
        { kind: "add_players", count: need },
        // A smaller team that the leftovers do divide into, where one exists.
        ...(leftOver >= 2 ? [{ kind: "team_size" as const, size: leftOver }] : []),
        { kind: "bye" },
        { kind: "blind_draw" },
      ],
    });
  }

  if (spec.evenSides && teams % 2 === 1) {
    warnings.push({
      kind: "odd_sides",
      headline: `${plural(teams, "side")} can't all be paired`,
      message: `${spec.label} pairs sides against each other, and ${plural(teams, "side")} leaves one without an opponent.`,
      fixes: [{ kind: "add_players", count: size }, { kind: "bye" }],
    });
  }

  if (teams < 2) {
    warnings.push({
      kind: "too_few",
      headline: "Not enough for a game",
      message: `That makes ${plural(teams, "side")}. A game needs at least two.`,
      fixes: [{ kind: "add_players", count: size * 2 - players }],
    });
  }

  return { players, teamSize: size, teams, leftOver, warnings, ready: warnings.length === 0 };
}

export type DraftedTeam = {
  /** 1-based, and the order they are shown and timed in. */
  position: number;
  players: FieldPlayer[];
};

export type Draft = {
  teams: DraftedTeam[];
  /** Players the team size couldn't seat. They keep their place in the field. */
  leftOver: FieldPlayer[];
};

/**
 * Split the field into teams, strongest spread evenly.
 *
 * A snake draft: the teams pick 1, 2, 3, 4 and then 4, 3, 2, 1, so the side
 * that got the best player gets the worst of the next round. Straight
 * round-robin would hand one team every low index.
 *
 * A player with no index drafts last rather than as a scratch player, which
 * is what sorting nulls first would quietly do.
 */
export function draftTeams(
  players: readonly FieldPlayer[],
  teamSize: number,
): Draft {
  const size = Math.max(1, Math.trunc(teamSize));

  if (size === 1) {
    return {
      teams: players.map((p, i) => ({ position: i + 1, players: [p] })),
      leftOver: [],
    };
  }

  const order = [...players].sort(
    (a, b) =>
      (a.handicapIndex ?? Infinity) - (b.handicapIndex ?? Infinity) ||
      a.name.localeCompare(b.name),
  );

  const count = Math.floor(order.length / size);
  if (count < 1) return { teams: [], leftOver: order };

  const teams: DraftedTeam[] = Array.from({ length: count }, (_, i) => ({
    position: i + 1,
    players: [],
  }));

  let next = 0;
  for (let round = 0; round < size; round++) {
    const picks = round % 2 === 0 ? teams : [...teams].reverse();
    for (const team of picks) team.players.push(order[next++]);
  }

  return { teams, leftOver: order.slice(next) };
}

export type Pairing = {
  position: number;
  home: DraftedTeam;
  /** Null when the field is odd and this side draws a bye. */
  away: DraftedTeam | null;
};

/**
 * Pair the sides into matches.
 *
 * Strongest against strongest, so the closest games are the ones that decide
 * it; the draft has already ordered the teams that way. An odd field leaves
 * the last side with a bye rather than dropping it from the sheet.
 */
export function pairMatches(teams: readonly DraftedTeam[]): Pairing[] {
  const out: Pairing[] = [];

  for (let i = 0; i < teams.length; i += 2) {
    out.push({
      position: out.length + 1,
      home: teams[i],
      away: teams[i + 1] ?? null,
    });
  }

  return out;
}
