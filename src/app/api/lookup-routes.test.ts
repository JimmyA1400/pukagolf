import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Every lookup route asks the guard first, and never calls the outside service
  for someone it turned away.
*/

const state = vi.hoisted(() => ({ signedIn: false, allowed: true as boolean }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.signedIn ? { id: "u1" } : null }, error: null }),
    },
    rpc: async () => ({ data: state.allowed, error: null }),
  }),
}));

const { GET: searchCourses } = await import("./courses/search/route");
const { GET: courseDetail } = await import("./courses/[id]/route");
const { GET: geocode } = await import("./geocode/route");
const { GET: weather } = await import("./weather/route");

const calls = [
  { name: "course search", run: () => searchCourses(new Request("http://localhost/api/courses/search?q=pine")) },
  {
    name: "course detail",
    run: () => courseDetail(new Request("http://localhost/api/courses/42"), { params: Promise.resolve({ id: "42" }) }),
  },
  { name: "place search", run: () => geocode(new Request("http://localhost/api/geocode?q=traverse")) },
  { name: "weather", run: () => weather(new Request("http://localhost/api/weather?lat=44.7&lon=-85.6")) },
];

const upstream = vi.fn(async () => new Response("{}", { status: 500 }));

beforeEach(() => {
  state.signedIn = false;
  state.allowed = true;
  upstream.mockClear();
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => vi.unstubAllGlobals());

describe.each(calls)("$name", ({ run }) => {
  it("needs a signed-in account", async () => {
    const response = await run();
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("stops at the ration", async () => {
    state.signedIn = true;
    state.allowed = false;

    const response = await run();
    expect(response.status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("looks it up for a signed-in account within the ration", async () => {
    state.signedIn = true;

    await run();
    expect(upstream).toHaveBeenCalledOnce();
  });
});
