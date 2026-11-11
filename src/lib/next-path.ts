/**
 * Where to go after signing in or signing up, from a ?next= in the address.
 *
 * Only a path on this site: "/join/moose-ridge" yes; "https://elsewhere",
 * "//elsewhere" and "/\elsewhere" no, since a browser treats the last two as
 * another site too. A link that sent people to a lookalike page after they
 * had just typed their password would be a gift to anyone phishing them.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // Control characters and backslashes have no place in a path of ours.
  if (/[\u0000-\u001f\\]/.test(raw)) return fallback;
  return raw;
}

/** The ?next= of the page the browser is on, made safe. */
export function nextFromLocation(fallback = "/"): string {
  if (typeof window === "undefined") return fallback;
  return safeNextPath(new URLSearchParams(window.location.search).get("next"), fallback);
}
