import { describe, expect, it } from "vitest";

import { databaseBanner } from "./database-banner";

const URL = "https://abcd1234.supabase.co";

describe("databaseBanner", () => {
  it("shows nothing in production", () => {
    expect(
      databaseBanner({ vercelEnv: "production", supabaseUrl: URL, label: "test" }),
    ).toBeNull();
    expect(databaseBanner({ vercelEnv: "production", supabaseUrl: URL })).toBeNull();
  });

  it("names the test database on a preview marked as test", () => {
    const banner = databaseBanner({ vercelEnv: "preview", supabaseUrl: URL, label: "test" });
    expect(banner?.tone).toBe("test");
    expect(banner?.text).toContain("abcd1234");
  });

  it("warns on a preview that isn't marked, since it may be live", () => {
    const banner = databaseBanner({ vercelEnv: "preview", supabaseUrl: URL });
    expect(banner?.tone).toBe("warning");
    expect(banner?.text).toContain("abcd1234");
  });

  it("treats a local build like a preview", () => {
    expect(databaseBanner({ supabaseUrl: URL })?.tone).toBe("warning");
    expect(databaseBanner({ supabaseUrl: URL, label: "test" })?.tone).toBe("test");
  });

  it("leaves demo mode to its own banner", () => {
    expect(databaseBanner({ vercelEnv: "preview" })).toBeNull();
    expect(databaseBanner({ vercelEnv: "preview", supabaseUrl: "not a url" })).toBeNull();
  });
});
