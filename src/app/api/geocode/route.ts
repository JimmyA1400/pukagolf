import { guardLookup } from "@/lib/lookup-guard";
import { geocodeUrl, toPlaces } from "@/lib/weather";

/** Place search for the admin choosing where a course is. */
export async function GET(request: Request) {
  const refused = await guardLookup(request);
  if (refused) return refused;

  const query = new URL(request.url).searchParams.get("q")?.trim();

  if (!query) return Response.json({ places: [] });

  try {
    const upstream = await fetch(geocodeUrl(query), {
      // Place coordinates don't move; a long cache is safe and keeps repeated
      // searches off the upstream service.
      next: { revalidate: 86400 },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Search returned ${upstream.status}` },
        { status: 502 },
      );
    }

    return Response.json({ places: toPlaces(await upstream.json()) });
  } catch {
    return Response.json({ error: "Search unreachable" }, { status: 502 });
  }
}
