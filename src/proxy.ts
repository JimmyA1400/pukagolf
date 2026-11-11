import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { clubFromHost, clubPathFor } from "@/lib/club-host";

/**
 * Session refresh on every request.
 *
 * Next 16 renamed `middleware.ts` to `proxy.ts` and the export from
 * `middleware` to `proxy` — Supabase's published auth guide still shows the old
 * names. The proxy runtime is Node; the edge runtime isn't supported here.
 *
 * Without this, access tokens expire and users are silently logged out.
 *
 * It also serves a club's own address: on moose-ridge.pukagolf.com, /league
 * is /c/moose-ridge/league, rewritten here so the address bar keeps the
 * club's name. Off until NEXT_PUBLIC_ROOT_DOMAIN is set; see lib/club-host.ts.
 */
export async function proxy(request: NextRequest) {
  const club = clubFromHost(request.headers.get("host"), process.env.NEXT_PUBLIC_ROOT_DOMAIN);
  const clubPath = club ? clubPathFor(club, request.nextUrl.pathname) : null;

  // Every response this makes, including the ones remade below when the
  // session cookies change, has to keep the club's rewrite.
  const respond = () => {
    if (!clubPath) return NextResponse.next({ request });

    const target = request.nextUrl.clone();
    target.pathname = clubPath;
    return NextResponse.rewrite(target, { request });
  };

  let response = respond();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Before the project is configured there is no session to refresh, and
  // createServerClient throws on empty credentials — which would 500 every
  // route in the app, including the demo.
  if (!url || !key) return response;

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = respond();

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }

          // This build of @supabase/ssr also hands back cache-control headers.
          // They must be applied, or a CDN could cache one user's session
          // cookie and serve it to somebody else.
          for (const [key, value] of Object.entries(headers)) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // Must happen before the response is committed, or a refresh completing
  // afterwards is lost and every request refreshes again.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
      Everything except static assets and images — those never need a session
      and refreshing on them wastes a round trip per file.
    */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
