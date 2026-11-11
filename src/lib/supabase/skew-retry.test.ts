import { describe, expect, it, vi } from "vitest";

import { withSkewRetry, type Fetch } from "./skew-retry";

const skewed = () =>
  new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), {
    status: 401,
  });
const ok = () => new Response("true", { status: 200 });
const noPause = () => Promise.resolve();

describe("withSkewRetry", () => {
  it("asks once more after a clock-skew refusal, and returns that answer", async () => {
    const base = vi.fn<Fetch>().mockResolvedValueOnce(skewed()).mockResolvedValueOnce(ok());

    const response = await withSkewRetry(base, noPause)("https://x/rest/v1/rpc/is_owner");

    expect(base).toHaveBeenCalledTimes(2);
    expect(await response.text()).toBe("true");
  });

  it("asks only once more, even if the second is refused too", async () => {
    const base = vi.fn<Fetch>().mockResolvedValue(skewed());

    const response = await withSkewRetry(base, noPause)("https://x");

    expect(base).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(401);
  });

  it("passes any other 401 straight through", async () => {
    const base = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response('{"message":"JWT expired"}', { status: 401 }));

    await withSkewRetry(base, noPause)("https://x");

    expect(base).toHaveBeenCalledTimes(1);
  });

  it("leaves successful answers alone", async () => {
    const base = vi.fn<Fetch>().mockResolvedValue(ok());

    await withSkewRetry(base, noPause)("https://x");

    expect(base).toHaveBeenCalledTimes(1);
  });

  it("sends the retry with the same request details", async () => {
    const base = vi.fn<Fetch>().mockResolvedValueOnce(skewed()).mockResolvedValueOnce(ok());
    const init = { method: "POST", body: '{"in_year":null}' };

    await withSkewRetry(base, noPause)("https://x/rest/v1/rpc/league_season", init);

    expect(base).toHaveBeenLastCalledWith("https://x/rest/v1/rpc/league_season", init);
  });
});
