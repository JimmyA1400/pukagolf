import { describe, expect, it } from "vitest";

import { authMessage } from "./auth-message";

describe("authMessage", () => {
  it("never shows Twilio's own error to a player", () => {
    // From the live signup page, with the account SID swapped for a fake one.
    const raw = {
      code: "sms_send_failed",
      message:
        "Error sending confirmation OTP to provider: To send messages or make calls to unverified numbers, you must have an approved Primary Compliance Profile. Go to https://1console.twilio.com/account/AC00000000000000000000000000000000/us1/trusthub/compliance-profiles/primary to create your profile.",
    };

    const shown = authMessage(raw);

    expect(shown).not.toMatch(/twilio|AC[0-9a-f]{32}|https?:/i);
    expect(shown).toMatch(/couldn't send a text/i);
  });

  it("points an existing member at sign-in", () => {
    expect(authMessage({ code: "phone_exists" })).toMatch(/sign in/i);
    expect(authMessage({ code: "user_already_exists" })).toMatch(/sign in/i);
  });

  it("explains a bad or stale code", () => {
    expect(authMessage({ code: "otp_expired" })).toMatch(/send another/i);
  });

  it("says a wrong password plainly", () => {
    expect(authMessage({ code: "invalid_credentials" })).toBe(
      "That number and password don't match.",
    );
  });

  it("passes through a short, unrecognised message", () => {
    expect(authMessage({ code: "something_new", message: "Try again." })).toBe(
      "Try again.",
    );
  });

  it("falls back rather than show a long or linked unknown message", () => {
    expect(
      authMessage({ code: "something_new", message: "See https://example.com" }),
    ).toMatch(/something went wrong/i);
    expect(
      authMessage({ code: "something_new", message: "x".repeat(300) }),
    ).toMatch(/something went wrong/i);
  });

  it("copes with no error object at all", () => {
    expect(authMessage(null)).toMatch(/something went wrong/i);
  });
});
