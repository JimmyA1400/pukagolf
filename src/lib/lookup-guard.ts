import { createClient } from "@/lib/supabase/server";

/**
 * The gate in front of the course, place and weather lookups.
 *
 * Each of those routes calls a free outside service on our behalf. Left open,
 * anyone on the internet could run them in a loop and get the site cut off by
 * the service, or run up the Vercel and Supabase free tiers. So a lookup needs
 * a signed-in account, and both the account and the network it comes from get
 * a ration (api_lookup_allowed, migration 0055).
 *
 * Returns the response to send instead, or null to carry on.
 *
 * If the ration can't be checked (the migration isn't on that database yet,
 * or Supabase is slow), the lookup goes ahead: the sign-in check is the main
 * gate, and a broken counter shouldn't take the weather strip down with it.
 */

type GuardClient = Pick<Awaited<ReturnType<typeof createClient>>, "auth" | "rpc">;

export const SIGN_IN_MESSAGE = "Sign in to look this up.";
export const SLOW_DOWN_MESSAGE =
  "That's a lot of lookups in a short time. Give it a minute and try again.";

export async function guardLookup(
  request: Request,
  client?: GuardClient,
): Promise<Response | null> {
  const supabase = client ?? (await createClient());

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: SIGN_IN_MESSAGE }, { status: 401 });
  }

  const ip = clientIp(request);

  const { data: allowed, error } = await supabase.rpc("api_lookup_allowed", {
    in_ip: ip ? await hashIp(ip) : null,
  });

  if (error) {
    console.error("lookup rate limit unavailable", error);
    return null;
  }

  if (allowed === false) {
    return Response.json(
      { error: SLOW_DOWN_MESSAGE },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  return null;
}

/**
 * The gate for a signed-out outing page's weather: the outing's link instead
 * of an account, and the outing's own place (api_outing_weather_place, 0056).
 * Returns the place to look up, or the response to send instead.
 */
export async function guardOutingLookup(
  request: Request,
  token: string,
  client?: Pick<GuardClient, "rpc">,
): Promise<{ latitude: number; longitude: number } | Response> {
  const supabase = client ?? (await createClient());
  const ip = clientIp(request);

  const { data, error } = await supabase.rpc("api_outing_weather_place", {
    in_token: token,
    in_ip: ip ? await hashIp(ip) : null,
  });
  const place = data as { latitude?: number; longitude?: number; limited?: boolean } | null;

  if (error || !place) {
    return Response.json({ error: "No weather for that outing." }, { status: 404 });
  }
  if (place.limited) {
    return Response.json(
      { error: SLOW_DOWN_MESSAGE },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  return { latitude: Number(place.latitude), longitude: Number(place.longitude) };
}

/**
 * Where the request came from. On Vercel, x-forwarded-for is written by the
 * platform, not passed through from the caller, so its first entry can be
 * trusted there. Anywhere else it's only as good as whatever is in front.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * The database keeps a fingerprint of the address, never the address itself:
 * the counter only needs to tell one network from another.
 */
export async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pukagolf:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
