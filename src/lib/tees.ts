/**
 * Filtering tee names on import.
 *
 * The course source is community-maintained and its tee names range from the
 * obvious ("white", "blue") to things that are plainly not tees at all. Junk
 * names end up as selectable tee sets on the scorecard, so they are dropped at
 * the point of import rather than being carried around and filtered later.
 *
 * This is an ALLOWLIST, deliberately. A denylist of known junk fails open: the
 * next unexpected value sails through and appears on someone's card. An
 * allowlist fails closed — the worst case is a genuinely-named tee going
 * missing, which is visible and fixable, rather than rubbish shown as fact.
 */

/** Colours courses actually paint on tee markers. */
const COLOURS = [
  "white", "blue", "red", "gold", "black", "green", "yellow", "silver",
  "bronze", "copper", "orange", "purple", "teal", "maroon", "navy", "tan",
  "grey", "gray", "pink", "brown", "burgundy", "charcoal",
];

/** Names used instead of, or alongside, a colour. */
const DESCRIPTORS = [
  "championship", "champion", "champ", "tips", "back", "middle", "member",
  "members", "forward", "front", "senior", "seniors", "ladies", "lady",
  "women", "womens", "men", "mens", "junior", "juniors", "pro", "regular",
  "tournament", "executive", "combo", "combination", "long", "short",
  // Gender qualifiers appear as suffixes on tee keys, e.g. "blue-male".
  "male", "female",
];

/**
 * Numbered tee sets.
 *
 * Roman numerals are a real convention — a first pass at this list omitted them
 * and would have deleted the entire tee structure of every course that uses
 * them, which turned out to be most of the ones already imported. Capped low
 * deliberately: a course has a handful of tee sets, so "x" and long numbers
 * stay junk.
 */
const NUMBERED = [
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii",
  "1", "2", "3", "4", "5", "6", "7", "8",
];

const VOCABULARY = new Set([...COLOURS, ...DESCRIPTORS, ...NUMBERED]);

/**
 * True when every part of the name is recognised tee vocabulary.
 *
 * Compound names are normal — "blue/white" for a combined set, "blue-male" for
 * a gendered rating — so the name is split and each token checked.
 */
export function isRecognisedTee(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "") return false;

  const tokens = trimmed.split(/[/\-\s_]+/).filter(Boolean);
  if (tokens.length === 0) return false;

  return tokens.every((token) => VOCABULARY.has(token));
}

export type TeeFilterResult<T> = {
  kept: T[];
  /** Names that were dropped, so an import can say what it discarded. */
  dropped: string[];
};

/** Split a list of tee-ish records into recognised and junk. */
export function filterTees<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): TeeFilterResult<T> {
  const kept: T[] = [];
  const dropped: string[] = [];

  for (const item of items) {
    if (isRecognisedTee(nameOf(item))) kept.push(item);
    else dropped.push(nameOf(item));
  }

  return { kept, dropped };
}

/** Drop unrecognised keys from a hole's per-tee yardages. */
export function filterYardages(
  yardages: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(yardages).filter(([tee]) => isRecognisedTee(tee)),
  );
}
