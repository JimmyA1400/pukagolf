import { searchUrl, toSearchResults } from "@/lib/courses";
import { guardLookup } from "@/lib/lookup-guard";

/** Course lookup for the admin picking which course a round is played on. */
export async function GET(request: Request) {
  const refused = await guardLookup(request);
  if (refused) return refused;

  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim();
  const state = params.get("state")?.trim() || undefined;

  if (!query) return Response.json({ courses: [] });

  try {
    const upstream = await fetch(searchUrl(query, state), {
      // Courses don't move or get renamed often.
      next: { revalidate: 86400 },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Course search returned ${upstream.status}` },
        { status: 502 },
      );
    }

    return Response.json({ courses: toSearchResults(await upstream.json()) });
  } catch {
    return Response.json({ error: "Course search unreachable" }, { status: 502 });
  }
}
