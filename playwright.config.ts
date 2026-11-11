import { defineConfig, devices } from "@playwright/test";

import { MOCK_SUPABASE_URL } from "./e2e/supabase-mock";

const PORT = 3100;

/**
 * Browser tests for joining the league and scoring a hole.
 *
 * They never touch the real database. The app is started against a Supabase
 * URL where nothing listens, and every request the browser makes there is
 * answered by e2e/supabase-mock.ts. The server's own session refresh
 * (src/proxy.ts) gets a refused connection, which Supabase treats as "try
 * again later" and ignores.
 *
 * Runs in the Chrome already installed on the machine, so there's no browser
 * download: `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Tee times are shown in local time; pin it so assertions are stable.
    timezoneId: "America/New_York",
    locale: "en-US",
    // A stale worker could answer from cache instead of the mock.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    // Answers the auth endpoints for the app's own server. See the note at
    // the top of e2e/auth-stub.mjs: without it, any page that checks the
    // session on the server redirects before it renders.
    {
      command: "node e2e/auth-stub.mjs",
      url: `${MOCK_SUPABASE_URL}/auth/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx next dev --port ${PORT}`,
      url: `http://localhost:${PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      // Set here, these win over .env.local, which Next never overrides.
      env: {
        NEXT_PUBLIC_SUPABASE_URL: MOCK_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
      },
    },
  ],
});
