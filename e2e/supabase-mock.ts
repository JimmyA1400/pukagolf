import type { Page } from "@playwright/test";

/**
 * A stand-in for Supabase, answered inside the browser.
 *
 * The app under test is started with this as its Supabase URL (see
 * playwright.config.ts). Nothing listens there: every request the page makes
 * is caught by page.route() and answered from the tables below, so a test can
 * sign up, sign in and score without touching the real database.
 *
 * Writes change the tables, so a reload after a write sees it, the way the
 * app's own reload-after-write does against the real thing.
 */
export const MOCK_SUPABASE_URL = "http://127.0.0.1:53999";

export type Row = Record<string, unknown>;

export type MockUser = { id: string; phone: string; fullName: string };

export type Call = {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
};

export type MockResponse = { status: number; body?: unknown };

export type MockOptions = {
  /** Rows per table, as PostgREST returns them. Writes change them. */
  tables?: Record<string, Row[]>;
  /** RPC results by function name, given the call's arguments. */
  rpc?: Record<string, (args: Row) => unknown>;
  /** The account the auth endpoints create, sign in and hand back. */
  user?: MockUser;
  /**
   * Answer one call differently, e.g. to refuse a write. Status 0 means no
   * answer at all, as with no signal. Undefined falls through.
   */
  override?: (call: Call) => MockResponse | undefined;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-expose-headers": "content-range",
};

export async function mockSupabase(page: Page, options: MockOptions = {}) {
  const tables = options.tables ?? {};
  const calls: Call[] = [];

  // The app's own API routes call weather and course services from the dev
  // server. Tests have no business reaching those either.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "Not available in tests." } }),
  );

  await page.route(
    (url) => url.origin === MOCK_SUPABASE_URL,
    async (route) => {
      const request = route.request();

      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: CORS });
      }

      const url = new URL(request.url());
      const raw = request.postData();
      const call: Call = {
        method: request.method(),
        path: url.pathname,
        params: url.searchParams,
        body: raw ? JSON.parse(raw) : null,
        headers: request.headers(),
      };
      calls.push(call);

      const response = options.override?.(call) ?? respond(call, tables, options);

      // Status 0 stands for no signal: the request never gets an answer.
      if (response.status === 0) return route.abort("internetdisconnected");

      await route.fulfill({
        status: response.status,
        headers: { ...CORS, "content-type": "application/json" },
        body: response.body === undefined ? "" : JSON.stringify(response.body),
      });
    },
  );

  return {
    calls,
    tables,
    /** Every call made to one endpoint, oldest first. */
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

function respond(
  call: Call,
  tables: Record<string, Row[]>,
  options: MockOptions,
): MockResponse {
  if (call.path.startsWith("/auth/v1/")) return auth(call, options.user);

  if (call.path.startsWith("/rest/v1/rpc/")) {
    const name = call.path.slice("/rest/v1/rpc/".length);
    const handler = options.rpc?.[name] ?? clubDefaults(tables, options.user)[name];
    return { status: 200, body: handler ? handler((call.body ?? {}) as Row) : null };
  }

  if (call.path.startsWith("/rest/v1/")) {
    return rest(call, call.path.slice("/rest/v1/".length), tables);
  }

  return { status: 404, body: { message: `No mock for ${call.method} ${call.path}` } };
}

// ------------------------------------------------------------------- auth

function authUser(user: MockUser, confirmed = true): Row {
  const now = new Date().toISOString();

  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    phone: user.phone.replace(/^\+/, ""),
    phone_confirmed_at: confirmed ? now : null,
    confirmation_sent_at: confirmed ? null : now,
    app_metadata: { provider: "phone", providers: ["phone"] },
    user_metadata: { full_name: user.fullName },
    identities: [],
    created_at: now,
    updated_at: now,
  };
}

/** A session shaped like GoTrue's, with a JWT nobody will verify. */
function session(user: MockUser): Row {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [
    part({ alg: "HS256", typ: "JWT" }),
    part({ sub: user.id, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 }),
    "e2e",
  ].join(".");

  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "e2e-refresh-token",
    user: authUser(user),
  };
}

function auth(call: Call, user: MockUser | undefined): MockResponse {
  if (!user) {
    return { status: 400, body: { code: 400, error_code: "validation_failed", msg: "No mock user." } };
  }

  switch (call.path.slice("/auth/v1/".length)) {
    // Phone confirmation is on, so signing up hands back a user and no
    // session: the code has to be entered first.
    case "signup":
      return { status: 200, body: authUser(user, false) };
    case "verify":
    case "token":
      return { status: 200, body: session(user) };
    case "user":
      return { status: 200, body: authUser(user) };
    case "otp":
    case "resend":
      return { status: 200, body: {} };
    case "logout":
      return { status: 204 };
    default:
      return { status: 404, body: { msg: `No mock for auth ${call.path}` } };
  }
}

// ------------------------------------------------------------------- rest

/** Query parameters PostgREST reserves, which are not column filters. */
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [column, filter] of params) {
    if (RESERVED.has(column)) continue;

    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot);
    const operand = filter.slice(dot + 1);
    const value = row[column] === null || row[column] === undefined ? null : String(row[column]);

    switch (op) {
      case "eq":
        if (value !== operand) return false;
        break;
      case "neq":
        if (value === operand) return false;
        break;
      case "gt":
        if (value === null || !(value > operand)) return false;
        break;
      case "gte":
        if (value === null || !(value >= operand)) return false;
        break;
      case "lt":
        if (value === null || !(value < operand)) return false;
        break;
      case "lte":
        if (value === null || !(value <= operand)) return false;
        break;
      case "in": {
        const list = operand
          .replace(/^\(|\)$/g, "")
          .split(",")
          .map((item) => item.replace(/^"|"$/g, ""));
        if (value === null || !list.includes(value)) return false;
        break;
      }
      case "is":
        if (operand === "null" ? value !== null : value !== operand) return false;
        break;
      default:
        throw new Error(`The Supabase mock can't filter with "${op}" (${column}=${filter}).`);
    }
  }

  return true;
}

function rest(call: Call, table: string, tables: Record<string, Row[]>): MockResponse {
  const rows = (tables[table] ??= []);

  switch (call.method) {
    case "GET": {
      const found = rows.filter((row) => matches(row, call.params));

      // .single() asks for one object and PostgREST refuses anything else.
      if ((call.headers.accept ?? "").includes("vnd.pgrst.object")) {
        return found.length === 1
          ? { status: 200, body: found[0] }
          : {
              status: 406,
              body: {
                code: "PGRST116",
                message: `JSON object requested, ${found.length} rows returned`,
                details: null,
                hint: null,
              },
            };
      }

      return { status: 200, body: found };
    }

    case "POST": {
      const keys = call.params.get("on_conflict")?.split(",");

      for (const row of [call.body].flat() as Row[]) {
        const existing = keys && rows.find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
      }

      return { status: 201 };
    }

    case "PATCH":
      for (const row of rows.filter((r) => matches(r, call.params))) {
        Object.assign(row, call.body);
      }
      return { status: 204 };

    case "DELETE": {
      const kept = rows.filter((row) => !matches(row, call.params));
      rows.splice(0, rows.length, ...kept);
      return { status: 204 };
    }

    default:
      return { status: 405, body: { message: `No mock for ${call.method}` } };
  }
}

// ------------------------------------------------------------------- clubs

/**
 * Every page under /c/<club> looks its club up first. Unless a test says
 * otherwise, the signed-in player is in PukaGolf and its Saturday League, and
 * is its admin when their profile row says is_admin, as before clubs.
 */
function clubDefaults(
  tables: Record<string, Row[]>,
  user: MockUser | undefined,
): Record<string, (args: Row) => unknown> {
  const pukagolf = {
    id: "a0000000-0000-4000-8000-000000000001",
    slug: "pukagolf",
    name: "PukaGolf",
    status: "active",
    isDemo: false,
  };
  const me = (tables.profiles ?? []).find((row) => row.id === user?.id);

  return {
    my_clubs: () =>
      user
        ? [
            {
              ...pukagolf,
              role: me?.is_admin ? "admin" : "player",
              leagues: [
                {
                  id: "b0000000-0000-4000-8000-000000000001",
                  slug: "saturday",
                  name: "Saturday League",
                  plays: true,
                },
              ],
            },
          ]
        : [],
    club_public: (args) => (args.in_slug === "pukagolf" ? pukagolf : null),
    can_fix_scores: () => me?.is_admin === true,
    // Everyone in the fixtures can sign in, and there are no other leagues.
    round_players_without_login: () => [],
    club_league_choices: () => [],
  };
}
