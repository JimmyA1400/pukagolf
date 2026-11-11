import { courseUrl, toImportedCourse } from "@/lib/courses";
import { guardLookup } from "@/lib/lookup-guard";

/**
 * Full detail for one course: holes with par, stroke index and yardages, plus
 * the tee sets with their rating and slope.
 *
 * `params` is a Promise in Next 16 — the synchronous form was removed, not
 * deprecated, so most published examples won't compile here.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = await guardLookup(request);
  if (refused) return refused;

  const { id } = await params;

  try {
    const upstream = await fetch(courseUrl(id), {
      next: { revalidate: 86400 },
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Course lookup returned ${upstream.status}` },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }

    return Response.json(toImportedCourse(await upstream.json()));
  } catch {
    return Response.json({ error: "Course lookup unreachable" }, { status: 502 });
  }
}
