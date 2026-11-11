"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { SunlightToggle } from "@/components/SunlightToggle";
import { PUKAGOLF_SLUG } from "@/lib/club-paths";
import { useOptionalClub } from "@/lib/club";
import { createClient, isConfigured } from "@/lib/supabase/client";

/**
 * Navigation across the pages an account can reach.
 *
 * Not in the root layout: /event/[token] is the no-account surface and must
 * not offer links into the league, and the landing page and the two auth pages
 * have nowhere to navigate to yet. Each league page renders this itself.
 *
 * Inside a club (/c/<club>/...) every link stays in that club, and a player in
 * more than one club, or a club with more than one league they can see, gets a
 * switcher. Outside one (the profile, a player's page) League goes to /league,
 * which finds their club.
 *
 * Below `sm` the links collapse behind a button rather than wrapping. Four
 * labels at 375px either wrap to two lines and push the page content down, or
 * scroll sideways and hide the last one with nothing to say it is there.
 */
type NavItem = { href: string; label: string };

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const inClub = useOptionalClub();
  const isPlatformAdmin = usePlatformAdmin();

  const links: NavItem[] = [
    ...(inClub
      ? clubLinks(inClub)
      : [
          { href: "/league", label: "League" },
          { href: "/profile", label: "Profile" },
        ]),
    ...(isPlatformAdmin ? [{ href: "/platform", label: "Platform" }] : []),
  ];

  // Exact match, except that a tournament's own page keeps Tournaments lit.
  // The ?league= a club link may carry doesn't count.
  const isCurrent = (href: string) => {
    const path = href.split("?")[0];
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  return (
    <nav
      aria-label="Main"
      className="border-b border-hairline bg-cream px-5 sm:px-8"
    >
      <div className="flex w-full items-center justify-between gap-3 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="font-display text-base font-bold tracking-tight">
            Puka<span className="text-forest">Golf</span>
          </Link>
          {inClub && <ClubSwitcher />}
        </div>

        <div className="flex items-center gap-5">
          <ul className="hidden gap-5 sm:flex">
            {links.map((link) => (
              <li key={link.href}>
                <NavLink {...link} current={isCurrent(link.href)} />
              </li>
            ))}
          </ul>

          {/* Outside the menu on a phone: it's wanted mid-round, one tap away. */}
          <SunlightToggle />

          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="site-nav-overflow"
            className="min-h-11 border border-hairline px-3 font-mono text-xs tracking-wider uppercase sm:hidden"
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      {inClub && <LeagueSwitcher />}

      <ul
        id="site-nav-overflow"
        hidden={!open}
        className="border-t border-hairline pb-2 sm:hidden"
      >
        {links.map((link) => (
          <li key={link.href} className="border-b border-dashed border-hairline">
            <NavLink
              {...link}
              current={isCurrent(link.href)}
              onNavigate={() => setOpen(false)}
              className="w-full py-1"
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * A club's tabs. Tournaments, Charities and Outings are PukaGolf's own until
 * clubs are given them, so other clubs don't show tabs that lead nowhere.
 * Admin is for any club's admins, Outings for PukaGolf's, and every page
 * behind them checks again.
 */
function clubLinks({
  club,
  href,
}: NonNullable<ReturnType<typeof useOptionalClub>>): NavItem[] {
  const isPukaGolf = club.slug === PUKAGOLF_SLUG;
  const isAdmin = club.role === "admin";

  return [
    { href: href("/league"), label: "League" },
    ...(isPukaGolf
      ? [
          { href: href("/tournaments"), label: "Tournaments" },
          { href: href("/charities"), label: "Charities" },
        ]
      : []),
    { href: "/profile", label: "Profile" },
    ...(isPukaGolf && isAdmin ? [{ href: href("/outings"), label: "Outings" }] : []),
    ...(isAdmin ? [{ href: href("/admin"), label: "Admin" }] : []),
  ];
}

/**
 * Whether to show the Platform tab: the page behind it checks again. Signed
 * out there is nothing to ask, and asking anyway would log a permission
 * error on every page a visitor opens.
 */
function usePlatformAdmin(): boolean {
  const [yes, setYes] = useState(false);

  useEffect(() => {
    if (!isConfigured) return;

    const supabase = createClient();
    let cancelled = false;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const { data } = await supabase.rpc("is_platform_admin");
      if (!cancelled) setYes(data === true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return yes;
}

/**
 * The club this page belongs to, and a way to the others. Only a menu when
 * there is somewhere else to go; one club is just its name.
 */
function ClubSwitcher() {
  const router = useRouter();
  const inClub = useOptionalClub();
  if (!inClub) return null;

  const { club, clubs } = inClub;

  if (clubs.length < 2) {
    return (
      <span className="min-w-0 font-mono text-xs leading-tight tracking-wide break-words text-ink-soft uppercase">
        {club.name}
      </span>
    );
  }

  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">Club</span>
      <select
        value={club.slug}
        onChange={(event) => router.push(`/c/${event.target.value}/league`)}
        className="min-h-9 min-w-0 truncate border border-hairline bg-cream px-2 font-mono text-xs tracking-wider uppercase"
      >
        {clubs.map((c) => (
          <option key={c.id} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The leagues in this club the player can see, when there is more than one:
 * the Saturday league and the Wednesday one. Staff and admins see them all; a
 * player sees the ones they play in. Stays on the same page, in the other
 * league.
 */
function LeagueSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const inClub = useOptionalClub();
  if (!inClub) return null;

  const { club, league, leagueHref } = inClub;
  if (club.leagues.length < 2 || !league) return null;

  // The part of the address after /c/<club>, so the switch keeps the page.
  const page = pathname.replace(/^\/c\/[^/]+/, "") || "/league";

  return (
    <div className="flex items-center gap-2 border-t border-dashed border-hairline py-2">
      <label htmlFor="league-switcher" className="meta">
        League
      </label>
      <select
        id="league-switcher"
        value={league.slug}
        onChange={(event) => {
          const next = club.leagues.find((l) => l.slug === event.target.value);
          if (next) router.push(leagueHref(next, page));
        }}
        className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
      >
        {club.leagues.map((l) => (
          <option key={l.id} value={l.slug}>
            {l.name}
            {l.plays ? "" : " (not playing)"}
          </option>
        ))}
      </select>
    </div>
  );
}

function NavLink({
  href,
  label,
  current,
  onNavigate,
  className = "",
}: {
  href: string;
  label: string;
  current: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={`inline-flex min-h-11 items-center font-mono text-xs tracking-wider uppercase ${className} ${
        current ? "text-forest underline" : "text-ink-soft hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}
