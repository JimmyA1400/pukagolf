/**
 * The five tee sets a player can ask for.
 *
 * Courses name their tees whatever they like — colours at one club, Roman
 * numerals at the next, "Championship-male" at a third — so a preference
 * saved as a raw tee name only ever matches the one course it came from.
 * These five are categories instead, resolved against each course's own card
 * when the scorecard is drawn.
 */

export type TeePreferenceId = "tips" | "mens" | "elderly" | "ladies" | "front";

export type TeePreference = {
  id: TeePreferenceId;
  label: string;
  hint: string;
};

/**
 * Longest first, which is the order they appear on a scorecard and the order
 * a golfer thinks in when picking one.
 */
export const TEE_PREFERENCES: readonly TeePreference[] = [
  { id: "tips", label: "Tips", hint: "The back tees, played at full length." },
  { id: "mens", label: "Mens", hint: "The regular men's tees." },
  { id: "elderly", label: "Seniors", hint: "The senior tees." },
  { id: "ladies", label: "Ladies", hint: "The women's tees." },
  { id: "front", label: "Front Tees", hint: "The shortest set on the card." },
];

/** Rank down the card, 0 = longest. Drives the fallback in `resolveTee`. */
const RANK: Record<TeePreferenceId, number> = {
  tips: 0,
  mens: 1,
  elderly: 2,
  ladies: 3,
  front: 4,
};

const LAST_RANK = 4;

/**
 * Words a course actually prints on its card. Only used where the source data
 * says so outright — colours are not on this list, because red is the women's
 * tee at one club and the back tee at another.
 */
const KEYWORDS: Partial<Record<TeePreferenceId, RegExp>> = {
  tips: /\b(championship|tips|tiger)\b/,
  elderly: /\b(senior|seniors|elder|elderly)\b/,
  ladies: /\b(female|ladies|lady|women|womens)\b/,
  front: /\b(forward|front|junior|family)\b/,
};

export function isTeePreference(value: unknown): value is TeePreferenceId {
  return (
    typeof value === "string" &&
    TEE_PREFERENCES.some((preference) => preference.id === value)
  );
}

export function teePreferenceLabel(value: unknown): string | null {
  const found = TEE_PREFERENCES.find((preference) => preference.id === value);

  return found ? found.label : null;
}

type Sizable = { tee: string; totalYards: number };

/**
 * The tee on this course that best answers the preference.
 *
 * A named match wins — a card that says "Silver-female" has settled the
 * question. Otherwise the five ranks are spread across however many sets the
 * course carries, so Tips is always the longest and Front Tees always the
 * shortest no matter how many lie between them.
 *
 * Returns null when the preference is unset or unrecognised, which leaves the
 * caller on its own default.
 */
export function resolveTee<T extends Sizable>(
  preference: string | null | undefined,
  options: readonly T[],
): T | null {
  if (!isTeePreference(preference) || options.length === 0) return null;

  // Never trust the caller's order for something this load-bearing.
  const longestFirst = [...options].sort((a, b) => b.totalYards - a.totalYards);

  const keyword = KEYWORDS[preference];
  if (keyword) {
    const named = longestFirst.find((option) => keyword.test(normalise(option.tee)));
    if (named) return named;
  }

  const rank = RANK[preference];
  const index = Math.round(
    (rank * (longestFirst.length - 1)) / LAST_RANK,
  );

  return longestFirst[index];
}

/** "Iv-v-female" and "silver_female" both need to look like words first. */
function normalise(tee: string): string {
  return tee.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}
