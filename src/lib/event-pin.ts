/**
 * What's wrong with a chosen outing admin PIN, in words, or null if nothing.
 *
 * The database is the real check — create_event and admin_set_event_pin both
 * refuse the same PINs through pin_is_weak() — so this exists for the message:
 * saying so before the round trip, next to the box it applies to.
 */

/** Keep in step with pin_is_weak() in migration 0015. */
const KEYPAD_CLASSICS = new Set([
  "12345678",
  "87654321",
  "01234567",
  "76543210",
  "23456789",
  "98765432",
  "12341234",
  "11223344",
]);

export function pinProblem(pin: string): string | null {
  if (!/^\d{8}$/.test(pin)) return "The PIN has to be exactly 8 digits.";

  if (/^(.)\1{7}$/.test(pin) || KEYPAD_CLASSICS.has(pin)) {
    return "That PIN is too easy to guess. Avoid repeated digits and runs like 12345678.";
  }

  return null;
}
