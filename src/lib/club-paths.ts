/**
 * Which league a club page shows, and the addresses inside a club.
 *
 * Kept apart from the React context in club.tsx so the choices are plain
 * functions with tests: a player who lands on the wrong league sees someone
 * else's leaderboard, and that should be caught here rather than by a player.
 */

/** PukaGolf itself, where everything that existed before clubs now lives. */
export const PUKAGOLF_SLUG = "pukagolf";

export type ClubLeague = {
  id: string;
  slug: string;
  name: string;
  /** The caller plays in it, as opposed to seeing it as staff or an admin. */
  plays: boolean;
};

export type ClubRole = "admin" | "staff" | "player";

/** One entry from my_clubs(). */
export type MyClub = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "paused" | "closed";
  isDemo: boolean;
  role: ClubRole | null;
  /** The admin role comes only from being the platform admin, not membership. */
  viaPlatform?: boolean;
  /** Where the club's clocks are, for tee times. Missing before 0054. */
  timeZone?: string;
  leagues: ClubLeague[];
};

/** What club_public() says about an address, for anyone. */
export type PublicClub = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "paused" | "closed";
  isDemo: boolean;
};

/**
 * The league to show: the one the address names, if the caller can see it;
 * otherwise the first one they play in; otherwise, for staff and admins who
 * play in none, the first one. Null for a club with no league yet.
 *
 * Leagues arrive sorted by name from my_clubs(), so "first" is stable.
 */
export function pickLeague(
  leagues: readonly ClubLeague[],
  wanted: string | null | undefined,
): ClubLeague | null {
  return (
    leagues.find((league) => league.slug === wanted) ??
    leagues.find((league) => league.plays) ??
    leagues[0] ??
    null
  );
}

/**
 * An address inside a club: "/league/events" becomes
 * "/c/moose-ridge/league/events", carrying ?league= only when the league isn't
 * the one the club would show anyway, so ordinary links stay short.
 */
export function clubPath(
  clubSlug: string,
  path: string,
  league: ClubLeague | null,
  leagues: readonly ClubLeague[],
): string {
  const base = `/c/${clubSlug}${path.startsWith("/") ? path : `/${path}`}`;
  const usual = pickLeague(leagues, null);

  if (!league || league.id === usual?.id) return base;

  return `${base}${base.includes("?") ? "&" : "?"}league=${encodeURIComponent(league.slug)}`;
}
