import { guardOutingLookup, guardLookup } from "@/lib/lookup-guard";
import { forecastUrl, toConditions } from "@/lib/weather";

/**
 * Current conditions for a course.
 *
 * Proxied rather than called from the browser so the upstream response can be
 * cached once for everyone: eight players refreshing a leaderboard shouldn't be
 * eight requests a minute to a free service.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  // An outing page names its link instead: no account needed, and the place
  // is the outing's own, never one the caller chose.
  const outing = params.get("event");

  let latitude = Number(params.get("lat"));
  let longitude = Number(params.get("lon"));

  if (outing) {
    const place = await guardOutingLookup(request, outing);
    if (place instanceof Response) return place;
    ({ latitude, longitude } = place);
  } else {
    const refused = await guardLookup(request);
    if (refused) return refused;
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Response.json(
      { error: "lat and lon are required" },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(forecastUrl({ latitude, longitude }), {
      // Route handlers aren't cached, but this fetch is — keyed on the URL, so
      // each course gets at most one upstream call per interval.
      next: { revalidate: 600 },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Weather service returned ${upstream.status}` },
        { status: 502 },
      );
    }

    return Response.json(toConditions(await upstream.json()));
  } catch {
    // The panel degrades to admin-entered values, so a failure here is not
    // worth breaking the page over.
    return Response.json({ error: "Weather service unreachable" }, { status: 502 });
  }
}
