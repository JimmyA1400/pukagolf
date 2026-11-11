import { describe, expect, it, vi } from "vitest";

import {
  clientIp,
  guardLookup,
  guardOutingLookup,
  hashIp,
  SIGN_IN_MESSAGE,
  SLOW_DOWN_MESSAGE,
} from "./lookup-guard";

type RpcResult = { data: boolean | null; error: { message: string } | null };

function fakeClient({ signedIn = true, rpc = { data: true, error: null } as RpcResult } = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: signedIn ? { id: "u1" } : null }, error: null })),
    },
    rpc: vi.fn(async () => rpc),
  };
}

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/weather?lat=1&lon=2", { headers });

// The guard only touches auth.getUser and rpc; the rest of the client is noise.
const asClient = (c: ReturnType<typeof fakeClient>) => c as unknown as Parameters<typeof guardLookup>[1];

describe("guardLookup", () => {
  it("turns a signed-out caller away without counting anything", async () => {
    const client = fakeClient({ signedIn: false });
    const refused = await guardLookup(request(), asClient(client));

    expect(refused?.status).toBe(401);
    expect(await refused?.json()).toEqual({ error: SIGN_IN_MESSAGE });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("lets a signed-in caller within their ration through", async () => {
    const client = fakeClient();
    expect(await guardLookup(request({ "x-forwarded-for": "203.0.113.9" }), asClient(client))).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith("api_lookup_allowed", {
      in_ip: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("asks politely to wait once the ration is used up", async () => {
    const client = fakeClient({ rpc: { data: false, error: null } });
    const refused = await guardLookup(request(), asClient(client));

    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBe("60");
    expect(await refused?.json()).toEqual({ error: SLOW_DOWN_MESSAGE });
    expect(SLOW_DOWN_MESSAGE).not.toMatch(/429|rate|limit/i);
  });

  it("goes ahead when the counter can't be reached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient({ rpc: { data: null, error: { message: "function api_lookup_allowed does not exist" } } });

    expect(await guardLookup(request(), asClient(client))).toBeNull();
    error.mockRestore();
  });

  it("sends no fingerprint when there's no address", async () => {
    const client = fakeClient();
    await guardLookup(request(), asClient(client));
    expect(client.rpc).toHaveBeenCalledWith("api_lookup_allowed", { in_ip: null });
  });
});

describe("clientIp", () => {
  it("takes the first forwarded address", () => {
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, then to nothing", () => {
    expect(clientIp(request({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(request())).toBeNull();
  });
});

describe("hashIp", () => {
  it("is stable, short, and not the address", async () => {
    const a = await hashIp("203.0.113.9");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(await hashIp("203.0.113.9"));
    expect(a).not.toBe(await hashIp("203.0.113.10"));
    expect(a).not.toContain("203");
  });
});

describe("guardOutingLookup", () => {
  const outingClient = (data: unknown, error: { message: string } | null = null) => ({
    rpc: vi.fn(async () => ({ data, error })),
  });
  const asOuting = (c: ReturnType<typeof outingClient>) =>
    c as unknown as Parameters<typeof guardOutingLookup>[2];

  it("looks up the outing's own place, with no account, and counts the network", async () => {
    const client = outingClient({ latitude: 26.6, longitude: -81.9 });
    const place = await guardOutingLookup(
      request({ "x-forwarded-for": "203.0.113.9" }),
      "tok",
      asOuting(client),
    );

    expect(place).toEqual({ latitude: 26.6, longitude: -81.9 });
    expect(client.rpc).toHaveBeenCalledWith("api_outing_weather_place", {
      in_token: "tok",
      in_ip: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("says nothing about a link that isn't an outing", async () => {
    const refused = await guardOutingLookup(request(), "nope", asOuting(outingClient(null)));
    expect((refused as Response).status).toBe(404);
  });

  it("keeps the ration", async () => {
    const refused = await guardOutingLookup(request(), "tok", asOuting(outingClient({ limited: true })));
    expect((refused as Response).status).toBe(429);
  });
});
