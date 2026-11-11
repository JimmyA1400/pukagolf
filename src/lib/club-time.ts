/**
 * Tee times in the club's own time zone.
 *
 * A tee time is stored as an instant. Shown in the viewer's zone, a phone
 * set to another zone (or a test machine in UTC) moved an 8:00 AM tee time to
 * 1:00 PM, or a Thursday week to Wednesday night. Every clock time on a
 * league page is the club's: set in it, shown in it.
 */

/** Where a club has said nothing, and the zone every club so far is in. */
export const DEFAULT_TIME_ZONE = "America/New_York";

function zoneOrDefault(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** The wall-clock parts of an instant in a zone. */
function partsIn(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** "8:10 AM", at the club. */
export function clubClock(iso: string, timeZone?: string | null): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zoneOrDefault(timeZone),
  });
}

/** "08:10", at the club: what a time input holds. */
export function clubHHMM(iso: string, timeZone?: string | null): string {
  const { hour, minute } = partsIn(new Date(iso), zoneOrDefault(timeZone));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Today's date at the club, YYYY-MM-DD. */
export function clubToday(timeZone?: string | null, now: Date = new Date()): string {
  const { year, month, day } = partsIn(now, zoneOrDefault(timeZone));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The instant a club clock reads `hhmm` on `date` (YYYY-MM-DD), as an ISO
 * string for the database. Right across a daylight-saving change too.
 */
export function clubInstant(date: string, hhmm: string, timeZone?: string | null): string {
  const zone = zoneOrDefault(timeZone);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);

  // Guess the instant as if the club were on UTC, see what its clock reads
  // then, and move by the difference; twice, in case the guess crossed a
  // change of offset.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), zone);
    const reads = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wanted - reads;
  }

  return new Date(guess).toISOString();
}
