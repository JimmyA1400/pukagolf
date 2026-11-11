export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const SKEW = /issued at future/i;

/**
 * A fetch for the Supabase client that rides out one clock-skew refusal.
 *
 * Straight after a sign-in token is refreshed, the database can judge the
 * new token as issued a moment in the future and answer 401 "JWT issued at
 * future". Whatever asked first on the page lost: /admin once told the owner
 * the page wasn't theirs because its is_owner check landed in that moment.
 * A second later the same request succeeds, so it's asked once more — for
 * that refusal only; every other answer, 401s included, passes straight
 * through.
 */
export function withSkewRetry(
  base: Fetch = (input, init) => fetch(input, init),
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 401) return response;

    const body = await response
      .clone()
      .text()
      .catch(() => "");
    if (!SKEW.test(body)) return response;

    await pause(1000);
    return base(input, init);
  };
}
