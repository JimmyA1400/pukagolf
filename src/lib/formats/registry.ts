/**
 * Every game the league and its events can be played under, in one list.
 *
 * There were two of these: src/lib/games.ts for the weekly league, where the
 * tee time was the side, and the events' own enum, where the team size was
 * baked into the format's name (scramble_2, best_ball_4). Neither could see
 * the other, so a format added to one was missing from the other.
 *
 * The thing that collapses them is keeping team size OUT of the format. A
 * scramble is one game whether two play it or four; the size is a property of
 * the week or the event, not of the game. That turns nineteen named
 * combinations into eleven specs, and adding a twentieth is one entry here.
 *
 * A format is five facts. Everything downstream reads those rather than
 * branching on a format's name:
 *
 *   sizes    the team sizes it can be played at (1 = each for themselves)
 *   ball     "own" — everyone plays their own; "one" — the side plays one ball
 *   counts   how many balls count on a hole
 *   scoring  what ranks a side, and therefore what the leaderboard shows
 *   evenSides whether it needs an even number of sides to pair them up
 */

export type FormatId =
  | "stroke"
  | "net_stroke"
  | "stableford"
  | "skins"
  | "match"
  | "best_ball"
  | "two_best"
  | "scramble"
  | "alt_shot"
  | "greensomes"
  | "nines";

/** What ranks a side, and so what the leaderboard has to render. */
export type ScoringRule = "strokes" | "net" | "points" | "skins" | "match" | "nines";

export type FormatSpec = {
  id: FormatId;
  /** The plain name. `labelAt` has the ones that read differently by size. */
  label: string;
  blurb: string;
  /** Team sizes this can be played at. 1 means each player for themselves. */
  sizes: readonly number[];
  /** "one" means the side plays a single ball and posts one score a hole. */
  ball: "own" | "one";
  /** Balls that count on a hole: 1 best ball, 2 two best balls. */
  counts: number;
  scoring: ScoringRule;
  /** Needs an even number of sides, because they play each other. */
  evenSides: boolean;
  /** A name that only makes sense at a particular size. */
  labelAt?: Readonly<Record<number, string>>;
};

const TEAM_SIZES = [2, 3, 4] as const;

export const FORMATS: readonly FormatSpec[] = [
  {
    id: "stroke",
    label: "Stroke Play",
    blurb: "Own ball, lowest total wins.",
    sizes: [1],
    ball: "own",
    counts: 1,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "net_stroke",
    label: "Net Stroke Play",
    blurb: "Stroke play less the strokes each player's handicap gives them.",
    sizes: [1],
    ball: "own",
    counts: 1,
    scoring: "net",
    evenSides: false,
  },
  {
    id: "stableford",
    label: "Stableford",
    blurb: "Points a hole on net score against par, so a blow-up costs the hole and not the round.",
    sizes: [1],
    ball: "own",
    counts: 1,
    scoring: "points",
    evenSides: false,
  },
  {
    id: "skins",
    label: "Skins",
    blurb: "The lowest unique score takes the hole; a tie carries it into the next.",
    sizes: [1],
    ball: "own",
    counts: 1,
    scoring: "skins",
    evenSides: false,
  },
  {
    id: "match",
    label: "Match Play",
    blurb: "Side against side, each hole won, halved or lost.",
    sizes: [1, ...TEAM_SIZES],
    ball: "own",
    counts: 1,
    scoring: "match",
    evenSides: true,
    labelAt: { 2: "2-Man Match Play", 3: "3-Man Match Play", 4: "Team Match" },
  },
  {
    id: "best_ball",
    label: "Best Ball",
    blurb: "Everyone plays their own ball and the lowest score on the side counts.",
    sizes: TEAM_SIZES,
    ball: "own",
    counts: 1,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "two_best",
    label: "2 Best Balls",
    blurb: "The two lowest scores on the side count on every hole.",
    sizes: [3, 4],
    ball: "own",
    counts: 2,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "scramble",
    label: "Scramble",
    blurb: "Everyone hits, the side plays the best shot, and goes again from there.",
    sizes: TEAM_SIZES,
    ball: "one",
    counts: 1,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "alt_shot",
    label: "Alternate Shot",
    blurb: "One ball between you, hit in turn.",
    sizes: [2],
    ball: "one",
    counts: 1,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "greensomes",
    label: "Greensomes",
    blurb: "Both drive, pick the one to play, then alternate to the hole.",
    sizes: [2],
    ball: "one",
    counts: 1,
    scoring: "strokes",
    evenSides: false,
  },
  {
    id: "nines",
    label: "Nines",
    blurb: "Nine points a hole split inside the threesome: 5 to the best, 3, then 1.",
    sizes: [3],
    ball: "own",
    counts: 1,
    scoring: "nines",
    evenSides: false,
  },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

/**
 * Names the league used before the two lists were merged. `solo` was the
 * events' word for one player, one ball; the league already called it stroke
 * play. Kept so old rows and old links keep resolving.
 */
const ALIASES: Readonly<Record<string, FormatId>> = {
  solo: "stroke",
  scramble_2: "scramble",
  scramble_3: "scramble",
  scramble_4: "scramble",
  best_ball_2: "best_ball",
  best_ball_3: "best_ball",
  best_ball_4: "best_ball",
};

export function isFormatId(value: string | null | undefined): value is FormatId {
  return BY_ID.has(value as FormatId);
}

/** The format, falling back to stroke play for anything unrecognised. */
export function getFormat(id: string | null | undefined): FormatSpec {
  const resolved = ALIASES[id ?? ""] ?? id;

  return BY_ID.get(resolved as FormatId) ?? BY_ID.get("stroke")!;
}

/** Only the formats that can be played at this team size. */
export function formatsForSize(size: number): FormatSpec[] {
  return FORMATS.filter((f) => f.sizes.includes(size));
}

/** What to call it at this size: "Team Match" rather than "Match Play". */
export function formatLabel(spec: FormatSpec, size: number): string {
  return spec.labelAt?.[size] ?? spec.label;
}

/**
 * Whether the side plays as a team. Read from the size rather than the
 * format, because the same format is played both ways.
 */
export function isTeamPlay(size: number): boolean {
  return size > 1;
}

/**
 * A handicap needs a score that belongs to one player. Nobody has agreed an
 * allowance for a side sharing a ball, and a shared score is not anyone's
 * own, so those formats are played gross and never reach a handicap.
 */
export function isGrossOnly(spec: FormatSpec): boolean {
  return spec.ball === "one";
}

/**
 * Whether a round under this format can feed a player's handicap record.
 *
 * The same rule as above, stated from the other end: a scramble card is the
 * side's, and posting it to a player's record would corrupt their index.
 */
export function feedsHandicap(spec: FormatSpec): boolean {
  return spec.ball === "own";
}

/** The team sizes anything can be played at, for the size picker. */
export const PLAYABLE_SIZES = [1, 2, 3, 4] as const;
