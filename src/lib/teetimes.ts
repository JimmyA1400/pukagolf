/**
 * Packing teams into tee times.
 *
 * A tee time holds four players. Teams are never split across tee times — a
 * scramble team that can't putt out together isn't a team — so the number of
 * teams per tee time falls out of the format's team size.
 *
 *   solo    (1 per team)  4 teams  -> 4 players
 *   2-man   (2 per team)  2 teams  -> 4 players
 *   3-man   (3 per team)  1 team   -> 3 players
 *   4-man   (4 per team)  1 team   -> 4 players
 *
 * Three-man formats are the exception: three does not divide four, and the only
 * way to reach four would be to break a team up. A threesome goes off instead.
 */

import { teamSize, type FormatId } from "./formats";

/** Players a tee time is meant to hold. */
export const TEE_TIME_CAPACITY = 4;

/** Default gap between tee times. */
export const DEFAULT_INTERVAL_MINUTES = 10;

/** The gaps between groups a league can pick, the same on every page. */
export const TEE_GAPS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 15, 20];

/** The gaps offered, plus a league's own if it isn't one of them. */
export function teeGaps(current?: number): number[] {
  return [...new Set([...TEE_GAPS, ...(current ? [current] : [])])].sort((a, b) => a - b);
}

export type TeeTimeDraft = {
  key: string;
  /** Teams going off together, in order. */
  teamKeys: string[];
  playerCount: number;
  /** "8:10a" — generated from the start time and interval. */
  time: string;
};

export type TeeTimePlan = {
  teeTimes: TeeTimeDraft[];
  warning: string | null;
};

/** How many whole teams fit in one tee time without splitting any of them. */
export function teamsPerTeeTime(format: FormatId): number {
  return Math.max(1, Math.floor(TEE_TIME_CAPACITY / teamSize(format)));
}

export type TeamRef = { key: string; memberIds: string[] };

export function planTeeTimes(
  format: FormatId,
  teams: readonly TeamRef[],
  startMinutes = 8 * 60 + 10,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
): TeeTimePlan {
  const perSlot = teamsPerTeeTime(format);
  const teeTimes: TeeTimeDraft[] = [];

  for (let i = 0; i < teams.length; i += perSlot) {
    const slotTeams = teams.slice(i, i + perSlot);

    teeTimes.push({
      key: `tt${teeTimes.length + 1}`,
      teamKeys: slotTeams.map((t) => t.key),
      playerCount: slotTeams.reduce((sum, t) => sum + t.memberIds.length, 0),
      time: clockLabel(startMinutes + teeTimes.length * intervalMinutes),
    });
  }

  // A tee time short of four is worth saying out loud: it means either a short
  // team or a roster that doesn't fill the last slot.
  const short = teeTimes.filter((t) => t.playerCount < TEE_TIME_CAPACITY);
  const expected = perSlot * teamSize(format);

  return {
    teeTimes,
    warning:
      short.length === 0 || expected < TEE_TIME_CAPACITY
        ? null
        : `${short.length} tee time${short.length === 1 ? "" : "s"} ` +
          `${short.length === 1 ? "has" : "have"} fewer than ${TEE_TIME_CAPACITY} players.`,
  };
}

/** Minutes past midnight as "8:10a" / "1:20p". */
export function clockLabel(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const suffix = hour24 < 12 ? "a" : "p";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
}

/** "8:10a" back to minutes past midnight, for editing an existing time. */
export function parseClock(label: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*([ap])?m?$/i.exec(label.trim());
  if (!match) return null;

  const [, rawHour, rawMinute, meridiem] = match;
  let hour = Number(rawHour);
  const minute = Number(rawMinute);

  if (hour > 23 || minute > 59) return null;

  if (meridiem) {
    const pm = meridiem.toLowerCase() === "p";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }

  return hour * 60 + minute;
}
