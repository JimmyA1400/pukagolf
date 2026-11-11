import { createServer } from "node:http";

/**
 * The one piece of Supabase the SERVER has to be able to reach.
 *
 * e2e/supabase-mock.ts answers inside the browser, which is enough for every
 * client component. It is not enough for a page that checks the session on the
 * server: `getUser()` runs in Node, where page.route() cannot reach it, so the
 * call was refused, no user came back, and the page redirected to sign-in
 * before it rendered a line. Whole pages were untestable for that reason.
 *
 * So this answers the auth endpoints, and only those, on the URL the app is
 * pointed at. Everything else still 404s: tables stay the browser mock's job,
 * and a server-side table read returning nothing is the truth about this
 * harness rather than something to paper over.
 *
 * It is not a way past the session check. A request with no bearer token gets
 * a 401, exactly as the real auth server would, so a signed-out visitor is
 * still redirected — which is what the sign-in tests rely on.
 */
// Clear of the ranges Windows reserves for itself (54307-54406 on this
// machine since a restart), which refuse a listener outright.
const PORT = 53999;

/** Must match CASEY in e2e/fixtures.ts. */
const USER = {
  id: "00000000-0000-4000-8000-00000000000a",
  phone: "12395550132",
  fullName: "Casey Tester",
};

function user() {
  const now = new Date().toISOString();

  return {
    id: USER.id,
    aud: "authenticated",
    role: "authenticated",
    phone: USER.phone,
    phone_confirmed_at: now,
    app_metadata: { provider: "phone", providers: ["phone"] },
    user_metadata: { full_name: USER.fullName },
    identities: [],
    created_at: now,
    updated_at: now,
  };
}

function session() {
  const now = Math.floor(Date.now() / 1000);
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return {
    access_token: [
      part({ alg: "HS256", typ: "JWT" }),
      part({
        sub: USER.id,
        role: "authenticated",
        aud: "authenticated",
        iat: now,
        exp: now + 3600,
      }),
      "e2e",
    ].join("."),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "e2e-refresh-token",
    user: user(),
  };
}

/**
 * The access token the browser stored, if the request carries one.
 *
 * Supabase sends it as `Authorization: Bearer <token>`, but falls back to the
 * anon key when there is no session — and the anon key is what a signed-out
 * request carries, so a token equal to it means nobody is signed in.
 */
function bearer(request) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  return token && token !== "e2e-anon-key" ? token : null;
}

createServer((request, response) => {
  const { pathname } = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body === undefined ? "" : JSON.stringify(body));
  };

  if (pathname === "/auth/v1/health") return send(200, { ok: true });

  if (pathname === "/auth/v1/user") {
    return bearer(request)
      ? send(200, user())
      : send(401, { code: 401, error_code: "no_authorization", msg: "No session." });
  }

  if (pathname === "/auth/v1/token") return send(200, session());
  if (pathname === "/auth/v1/logout") return send(204);

  send(404, { msg: `The e2e auth stub does not answer ${pathname}.` });
}).listen(PORT, "127.0.0.1");
