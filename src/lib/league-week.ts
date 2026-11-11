/**
 * Defaults for the next week of the league: its name and its date.
 *
 * Only suggestions — the owner can type anything — but they are what gets
 * submitted if nobody changes them, so they have to be right.
 */

/**
 * "Saturday Round 3" -> "Saturday Round 4". A name that doesn't end in a
 * number gets " 2", since the week being carried forward was the first of
 * its kind.
 */
export function nextWeekName(previous: string): string {
  const trimmed = previous.trim();
  if (trimmed === "") return "Week 1";

  const match = trimmed.match(/^(.*?)(\d+)$/);
  if (match) return `${match[1]}${Number(match[2]) + 1}`;

  return `${trimmed} 2`;
}

/**
 * A week after an ISO date, as an ISO date.
 *
 * Worked in UTC so a daylight-saving change between the two weeks can't
 * shift the answer by a day.
 */
export function nextWeekDate(previousIso: string): string {
  const [year, month, day] = previousIso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 7));

  return next.toISOString().slice(0, 10);
}

/**
 * The next week's date on the league's usual day: the first date after the
 * last week that falls on the weekday most of its weeks were played on. A
 * week dated a day out, by mistake or on purpose, doesn't drag every week
 * after it onto that day. With no weeks, or a tie, the latest week's day.
 */
export function nextLeagueDate(previousIso: string, playedOn: readonly string[] = []): string {
  const day = usualWeekday([previousIso, ...playedOn], previousIso);
  const [year, month, date] = previousIso.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, date));
  // One to seven days on: never the same day as the last week.
  const ahead = ((day - from.getUTCDay() + 6) % 7) + 1;

  return new Date(Date.UTC(year, month - 1, date + ahead)).toISOString().slice(0, 10);
}

/** 0 for Sunday. The weekday most of these dates fall on; ties go to `latest`'s. */
export function usualWeekday(dates: readonly string[], latest: string): number {
  const weekday = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  };
  const counts = new Map<number, number>();
  for (const iso of new Set(dates)) counts.set(weekday(iso), (counts.get(weekday(iso)) ?? 0) + 1);

  const mine = weekday(latest);
  let best = mine;
  for (const [day, n] of counts) if (n > (counts.get(best) ?? 0)) best = day;
  return best;
}

/**
 * "Thu, Nov 19" for "2026-11-19", with the year when it isn't this one's.
 * The day itself, read in UTC, so no time zone moves it.
 */
export function friendlyDate(iso: string, today: Date = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(y === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "Thursdays", for the weekday usualWeekday gives (0 for Sunday). */
export function weekdayPlural(day: number): string {
  return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}s`;
}
