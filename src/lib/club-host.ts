/**
 * A club's own address: moose-ridge.pukagolf.com shows /c/moose-ridge.
 *
 * Off until NEXT_PUBLIC_ROOT_DOMAIN is set (to "pukagolf.com", once that
 * domain is bought and pointed at Vercel). Until then every club lives at
 * /c/<club> on whatever address the site has, and this answers null.
 */

/** Addresses on the root domain that are the site itself, not a club. */
const NOT_CLUBS = new Set(["www", "app", "api"]);

/** The club a request's host names, if it is a club subdomain of the root. */
export function clubFromHost(host: string | null, rootDomain: string | undefined): string | null {
  if (!host || !rootDomain) return null;

  const name = host.toLowerCase().replace(/:\d+$/, "");
  const root = rootDomain.toLowerCase();
  if (!name.endsWith(`.${root}`)) return null;

  const sub = name.slice(0, -(root.length + 1));
  // One label only, shaped like a club slug: a.b.pukagolf.com isn't a club.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(sub) || NOT_CLUBS.has(sub)) return null;

  return sub;
}

/**
 * The path to serve for a request on a club's own address. Pages that belong
 * to the whole site, not one club (signing in, a profile, an outing's link),
 * are served as they are; so is anything already under /c/.
 */
export function clubPathFor(club: string, pathname: string): string | null {
  const siteWide = /^\/(c|api|_next|sign-in|signup|reset-password|profile|players|event|join|platform|offline|manifest\.webmanifest|sw\.js)(\/|$)/;
  if (siteWide.test(pathname)) return null;

  return pathname === "/" ? `/c/${club}/league` : `/c/${club}${pathname}`;
}
