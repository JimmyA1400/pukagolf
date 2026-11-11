import type { MetadataRoute } from "next";

/**
 * Served at /manifest.webmanifest, which is what makes the site installable.
 *
 * `start_url` is the landing page rather than /league: the app serves two
 * surfaces, and someone who installs it from an outing link has no league
 * account to land in.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PukaGolf",
    short_name: "PukaGolf",
    description: "Live golf scoring for the league and one-off outings.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf7ec",
    theme_color: "#1d3521",
    categories: ["sports"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      // Separate artwork, drawn smaller: Android crops a maskable icon to
      // whatever shape the launcher uses, and the same file would lose the flag.
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
