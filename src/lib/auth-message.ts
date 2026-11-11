/**
 * What to tell a player when Supabase Auth refuses them.
 *
 * Never the provider's own text. An SMS failure comes back with Twilio's full
 * error inside it — a paragraph about compliance profiles and a console URL
 * carrying the account SID — and every would-be member was being shown it.
 * The raw error still goes to the console, for whoever is debugging.
 */

type AuthErrorLike = { code?: string | null; message?: string | null };

const MESSAGES: Record<string, string> = {
  sms_send_failed:
    "We couldn't send a text to that number just now. Try again later, or let the organiser know.",
  over_sms_send_rate_limit:
    "Too many codes sent to that number. Wait a minute and try again.",
  phone_provider_disabled:
    "Signing up by phone isn't switched on yet. Let the organiser know.",
  signup_disabled: "New accounts are closed for now.",
  phone_exists:
    "That number already has an account. Sign in instead.",
  user_already_exists:
    "That number already has an account. Sign in instead.",
  weak_password: "Pick a longer password — at least 8 characters.",
  otp_expired:
    "That code is wrong or has expired. Send another and try again.",
  invalid_credentials: "That number and password don't match.",
  // A reset code asked for a number with no account: it signs in, never up.
  otp_disabled:
    "No account uses that number. Check it, or join the league first.",
  same_password: "That's already your password. Choose a different one.",
  phone_not_confirmed:
    "That number was never confirmed. Sign up again to get a new code.",
  over_request_rate_limit:
    "Too many attempts. Wait a minute and try again.",
};

const FALLBACK = "Something went wrong. Try again in a moment.";

export function authMessage(error: AuthErrorLike | null | undefined): string {
  if (!error) return FALLBACK;

  const known = error.code ? MESSAGES[error.code] : undefined;
  if (known) return known;

  // An unrecognised code is still better shown than hidden, as long as it
  // isn't a provider's response pasted in whole.
  const message = error.message?.trim();
  if (!message || /https?:\/\//i.test(message) || message.length > 160) {
    return FALLBACK;
  }

  return message;
}
