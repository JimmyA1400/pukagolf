/**
 * US phone numbers: a readable mask while typing, E.164 when stored.
 *
 * Only US numbers are handled, because that is what the league is. A number
 * that isn't a valid US one is rejected rather than stored in a shape nothing
 * can dial.
 */

/** Digits only, capped at what a US number can hold including the country code. */
function digitsOf(input: string): string {
  return input.replace(/\D/g, "").slice(0, 11);
}

/**
 * Format for display as the user types: (313) 555-0142.
 *
 * Partial input formats as far as it goes, so the mask never fights the
 * cursor by inserting punctuation the user has not reached yet.
 */
export function formatUsPhone(input: string): string {
  let digits = digitsOf(input);

  // A leading 1 is the country code, not part of the number.
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  else if (digits.length > 10) digits = digits.slice(0, 10);

  const area = digits.slice(0, 3);
  const prefix = digits.slice(3, 6);
  const line = digits.slice(6, 10);

  if (digits.length === 0) return "";
  if (digits.length <= 3) return `(${area}`;
  if (digits.length <= 6) return `(${area}) ${prefix}`;

  return `(${area}) ${prefix}-${line}`;
}

/**
 * E.164 for storage: +13135550142.
 *
 * Null when the input isn't a valid US number, so a caller cannot accidentally
 * store something unusable.
 */
export function toE164(input: string): string | null {
  let digits = digitsOf(input);

  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;

  // North American numbering: area code and exchange both start 2-9. This
  // rejects the placeholder-looking numbers people type to skip a field.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;

  return `+1${digits}`;
}

export function isValidUsPhone(input: string): boolean {
  return toE164(input) !== null;
}

/** E.164 back to something readable: +13135550142 -> (313) 555-0142. */
export function fromE164(e164: string | null | undefined): string {
  if (!e164) return "";

  return formatUsPhone(e164);
}
