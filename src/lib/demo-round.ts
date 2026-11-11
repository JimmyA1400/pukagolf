/**
 * Demo data for the layout preview.
 *
 * Invented, not real: it exists so the screens can be judged before Supabase is
 * wired up. Every number here is self-consistent — the standings, skins and
 * progress bars are all computed from these cards rather than hardcoded.
 */

import type { Score } from "./leaderboard";
import type { CoursePars } from "./scorecard";

export const COURSE = {
  name: "Pinehollow Municipal",
  holeCount: 18,
} as const;

/** Front 36, back 35. */
export const PARS: CoursePars = {
  1: 4, 2: 4, 3: 4, 4: 5, 5: 4, 6: 4, 7: 3, 8: 4, 9: 4,
  10: 4, 11: 4, 12: 3, 13: 4, 14: 4, 15: 5, 16: 3, 17: 4, 18: 4,
};

export const COURSE_PAR = Object.values(PARS).reduce((a, b) => a + b, 0);

export type Player = {
  id: string;
  name: string;
  /** Shortened for the progress bars. */
  short: string;
};

export const PLAYERS: Player[] = [
  { id: "marcus", name: "Marcus Diallo", short: "Marcus D." },
  { id: "jreyes", name: "J. Reyes", short: "J. Reyes" },
  { id: "priya", name: "Priya Nair", short: "Priya N." },
  { id: "owen", name: "Owen Fitch", short: "Owen F." },
  { id: "dana", name: "Dana Kowalski", short: "Dana K." },
  { id: "theo", name: "Theo Brandt", short: "Theo B." },
  { id: "sam", name: "Sam Whitfield", short: "Sam W." },
];

/** The signed-in player, for the highlighted row. */
export const VIEWER_ID = "jreyes";

/** Cards as played, hole 1 onward. */
const CARDS: Record<string, number[]> = {
  marcus: [4, 3, 4, 5, 3, 4, 3, 4, 3, 3, 4],
  jreyes: [5, 4, 3, 4, 4, 4, 3, 4, 3, 3],
  priya: [4, 4, 4, 5, 4, 3, 3, 4, 4, 4, 4],
  owen: [4, 5, 4, 5, 4, 5, 3, 4, 4],
  dana: [5, 4, 5, 5, 4, 4, 4, 4],
  theo: [5, 5, 4, 5, 5, 4, 4, 4, 4, 4],
  sam: [5, 6, 4, 5, 5, 4, 4],
};

export const SCORES: Score[] = Object.entries(CARDS).flatMap(
  ([playerId, strokes]) =>
    strokes.map((s, i) => ({ playerId, hole: i + 1, strokes: s })),
);

/**
 * Tee groups, in ring order. Scoring rotates within each: player[i] keeps
 * player[i+1]'s card, wrapping.
 */
export type TeeGroup = {
  id: string;
  label: string;
  time: string;
  playerIds: string[];
  open: boolean;
};

export const GROUPS: TeeGroup[] = [
  {
    id: "g1",
    label: "Group 1",
    time: "8:10a",
    playerIds: ["marcus", "priya", "jreyes"],
    open: false,
  },
  {
    id: "g2",
    label: "Group 2",
    time: "8:20a",
    playerIds: ["owen", "dana"],
    open: false,
  },
  {
    id: "g3",
    label: "Group 3",
    time: "8:30a",
    playerIds: ["theo", "sam"],
    open: true,
  },
];

/** The viewer's own group shares a skins pot. */
export const GROUP_IDS = GROUPS[0].playerIds;

export const SKINS_STAKE = 20;

export type FeedItem = {
  id: string;
  authorId: string;
  what: string;
  /**
   * Minutes since posting. Stored rather than a timestamp so the server and
   * client render the same string — a live clock would mismatch on hydration.
   */
  ageMinutes: number;
};

export const FEED: FeedItem[] = [
  { id: "f1", authorId: "priya", what: "chipped in on 7 for the skin", ageMinutes: 4 },
  { id: "f2", authorId: "theo", what: "lost a sleeve in the pond on 6, again", ageMinutes: 11 },
  { id: "f3", authorId: "dana", what: "called next Saturday's tee times", ageMinutes: 60 },
];


export function initials(name: string): string {
  return name
    .replace(/^You — /, "")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function shortName(name: string): string {
  return name.replace(/^You — /, "");
}
