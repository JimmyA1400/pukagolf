/**
 * The client-side mirror of the database's write rules.
 *
 * The database is still the authority — `may_score()` and the sequential
 * trigger are what actually stop a bad write. This exists so the UI can refuse
 * the same things for the same reasons, rather than letting someone type a
 * score that will only be rejected on the way out.
 */

import type { Score } from "./leaderboard";
import { buildRotation, type Assignment } from "./rotation";

export type { Assignment };

export type Group = {
  playerIds: string[];
};

/** Seed the rotation for every group. Groups too small to rotate are skipped. */
export function seedAssignments(groups: readonly Group[]): Assignment[] {
  return groups.flatMap((group) =>
    group.playerIds.length >= 2 ? buildRotation(group.playerIds) : [],
  );
}

/** The one player this viewer keeps a card for, or null. */
export function assignedTo(
  assignments: readonly Assignment[],
  viewerId: string,
): string | null {
  return assignments.find((a) => a.scorerId === viewerId)?.scoredId ?? null;
}

/** Who is keeping this player's card, or null if nobody is. */
export function keptBy(
  assignments: readonly Assignment[],
  playerId: string,
): string | null {
  return assignments.find((a) => a.scoredId === playerId)?.scorerId ?? null;
}

/** Why your own card is read-only under Partner Scoring, in one sentence. */
export const PARTNER_OWN_CARD =
  "In Partner Scoring another player in your group keeps your card, so every score is written down by someone else. You can't enter your own.";

export type Refusal = { ok: false; reason: string };
export type Permission = { ok: true } | Refusal;

/**
 * Who enters scores in a league. Partner Scoring is the default: everyone
 * keeps one other player's card and never their own.
 */
export type ScoringMode = "partner" | "self" | "team";

/** The three ways a league keeps score, in the words the pro shop uses. */
export const SCORING_MODES: { id: ScoringMode; label: string; detail: string }[] = [
  {
    id: "partner",
    label: "Partner Scoring",
    detail: "Each player keeps the next player's card, round the group. Nobody enters their own.",
  },
  { id: "self", label: "Self Scoring", detail: "Each player keeps their own card." },
  {
    id: "team",
    label: "Team Card Scoring",
    detail: "Anyone in the group keeps every card in it, so one phone can score the four.",
  },
];

export type ScoringContext = {
  mode?: ScoringMode;
  /** The viewer's group, for Team Card Scoring. */
  group?: readonly string[];
  /** The card is signed off, or the week is final. */
  locked?: boolean;
  /** A club admin: the only one who changes a locked card. Defaults to isAdmin. */
  isClubAdmin?: boolean;
  /** Players in the week with no login, who can't keep anybody's card. */
  noLogin?: readonly string[];
};

/**
 * Partner Scoring, when the person keeping your card has no login: nobody
 * else could ever fill it in, so you keep your own that week.
 */
export function keepsOwnCard(
  assignments: readonly Assignment[],
  viewerId: string,
  noLogin: readonly string[],
): boolean {
  const keeper = keptBy(assignments, viewerId);
  return keeper !== null && noLogin.includes(keeper);
}

/** Who keeps one card this week, by the league's way of scoring. */
export type Keeper =
  /** Another player in the group. */
  | { kind: "player"; id: string }
  /** The player keeps their own. */
  | { kind: "self" }
  /** Team Card Scoring: anyone in the group. */
  | { kind: "group" }
  /** Nobody who can sign in can keep it: the pro shop enters it from paper. */
  | { kind: "pro_shop" }
  /** Partner Scoring, and nobody has been given the card yet. */
  | { kind: "nobody" };

/**
 * Who keeps a card, the one rule the pad and the Groups page both go by.
 *
 * Partner Scoring: whoever is given it, unless they have no login; then the
 * player keeps their own. Self Scoring: the player. Team Card Scoring: anyone
 * in the group. In each, a card nobody with a login can keep is the pro
 * shop's, entered from the paper card.
 */
export function cardKeeper(
  playerId: string,
  {
    mode = "partner",
    assignments = [],
    group = [],
    noLogin = [],
  }: {
    mode?: ScoringMode;
    assignments?: readonly Assignment[];
    /** Everyone in the player's group, for Team Card Scoring. */
    group?: readonly string[];
    noLogin?: readonly string[];
  },
): Keeper {
  const canSignIn = (id: string) => !noLogin.includes(id);

  if (mode === "self") return canSignIn(playerId) ? { kind: "self" } : { kind: "pro_shop" };

  if (mode === "team") {
    const members = group.length > 0 ? group : [playerId];
    const keepers = members.filter(canSignIn);
    if (keepers.length === 0) return { kind: "pro_shop" };
    // "Anyone in the group" when only one of them can sign in is that one.
    return keepers.length === 1 ? { kind: "player", id: keepers[0] } : { kind: "group" };
  }

  const keeper = keptBy(assignments, playerId);
  if (keeper === null) return { kind: "nobody" };
  if (canSignIn(keeper)) return { kind: "player", id: keeper };
  return canSignIn(playerId) ? { kind: "self" } : { kind: "pro_shop" };
}

/**
 * `isAdmin` is anyone who may fix scores: a club admin, or staff the admin
 * has let fix them. That is for other people's cards; their own is kept the
 * league's way, like anybody's. Only a club admin gets past a lock, and never
 * on their own card.
 */
export function canScore(
  assignments: readonly Assignment[],
  viewerId: string,
  targetId: string,
  isAdmin: boolean,
  {
    mode = "partner",
    group = [],
    locked = false,
    isClubAdmin = isAdmin,
    noLogin = [],
  }: ScoringContext = {},
): Permission {
  const own = targetId === viewerId;

  if (locked) {
    if (isClubAdmin && own) {
      return { ok: false, reason: "This is your own signed-off card. Another club admin can change it." };
    }
    return isClubAdmin
      ? { ok: true }
      : { ok: false, reason: "This card is signed off. Ask a club admin to change it." };
  }

  if (isAdmin && !own) return { ok: true };

  if (mode === "self") {
    return targetId === viewerId
      ? { ok: true }
      : { ok: false, reason: "In Self Scoring you keep your own card." };
  }

  if (mode === "team") {
    return group.includes(viewerId) && group.includes(targetId)
      ? { ok: true }
      : { ok: false, reason: "You can only keep cards in your own group." };
  }

  if (own) {
    if (keepsOwnCard(assignments, viewerId, noLogin)) return { ok: true };
    return { ok: false, reason: PARTNER_OWN_CARD };
  }

  if (assignedTo(assignments, viewerId) !== targetId) {
    return { ok: false, reason: "You aren't keeping this player's card." };
  }

  return { ok: true };
}

export type SubmitAttempt = {
  assignments: readonly Assignment[];
  scores: readonly Score[];
  viewerId: string;
  targetId: string;
  hole: number;
  strokes: number;
  isAdmin: boolean;
} & ScoringContext;

/**
 * Full check for one submission: permission, then the value, then order.
 *
 * Order only constrains a *new* hole. Correcting a hole that already has a
 * score is always allowed, matching the trigger, which fires on insert only.
 */
export function validateSubmission({
  assignments,
  scores,
  viewerId,
  targetId,
  hole,
  strokes,
  isAdmin,
  ...context
}: SubmitAttempt): Permission {
  const permission = canScore(assignments, viewerId, targetId, isAdmin, context);
  if (!permission.ok) return permission;

  if (!Number.isInteger(strokes) || strokes < 1 || strokes > 20) {
    return { ok: false, reason: "A hole score must be between 1 and 20." };
  }

  const card = scores.filter((s) => s.playerId === targetId);
  const isCorrection = card.some((s) => s.hole === hole);
  if (isCorrection) return { ok: true };

  // The admin bypasses the sequential trigger, so they may fill a gap.
  if (isAdmin) return { ok: true };

  const entered = card.filter((s) => s.hole < hole).length;
  if (entered !== hole - 1) {
    return {
      ok: false,
      reason: `Enter holes 1–${hole - 1} before hole ${hole}.`,
    };
  }

  return { ok: true };
}

/** Apply a submission, replacing any existing score for that hole. */
export function applyScore(
  scores: readonly Score[],
  playerId: string,
  hole: number,
  strokes: number,
): Score[] {
  return [
    ...scores.filter((s) => !(s.playerId === playerId && s.hole === hole)),
    { playerId, hole, strokes },
  ];
}
