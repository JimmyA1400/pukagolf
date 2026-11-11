import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Outings moved out from under /league/events when they got their own tab.
   *
   * The old addresses would still resolve, which is worse than a 404:
   * /league/events/new now matches /league/events/[id] and would look up an
   * event called "new". Anyone holding the old link gets the page they meant.
   */
  async redirects() {
    return [
      {
        source: "/league/events/new",
        destination: "/c/pukagolf/outings/new",
        permanent: true,
      },

      /*
        Pages moved under /c/<club> when there came to be more than one club.
        Everything that existed before belongs to PukaGolf, so every old
        address, bookmarked or shared, means PukaGolf's page. Temporary rather
        than permanent: a browser caches a permanent redirect for good, and
        these may yet point somewhere smarter.

        /league itself is not here: it is a page, and sends each player to
        their own club's league.
      */
      { source: "/league/:path+", destination: "/c/pukagolf/league/:path+", permanent: false },
      { source: "/admin", destination: "/c/pukagolf/admin", permanent: false },
      { source: "/outings/:path*", destination: "/c/pukagolf/outings/:path*", permanent: false },
      { source: "/tournaments/:path*", destination: "/c/pukagolf/tournaments/:path*", permanent: false },
      { source: "/charities", destination: "/c/pukagolf/charities", permanent: false },
    ];
  },

  async headers() {
    return [
      {
        // The worker must never be served from cache: a stale one keeps
        // control of the origin and there is no way to push a fix past it.
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
