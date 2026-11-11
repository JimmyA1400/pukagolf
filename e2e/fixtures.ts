import type { MockUser, Row } from "./supabase-mock";

/**
 * A small league for the browser tests: one group of two, nine holes, every
 * hole a par 4. Casey is signed in and keeps Riley's card; Riley keeps Casey's.
 */
/** PukaGolf and its Saturday League, the ids migration 0045 gave them. */
export const PUKAGOLF = "a0000000-0000-4000-8000-000000000001";
export const SATURDAY = "b0000000-0000-4000-8000-000000000001";

export const CASEY: MockUser = {
  id: "00000000-0000-4000-8000-00000000000a",
  phone: "+12395550132",
  fullName: "Casey Tester",
};
export const RILEY_ID = "00000000-0000-4000-8000-00000000000b";
/** A second group, for the group-against-group side game. */
export const TAYLOR_ID = "00000000-0000-4000-8000-00000000000c";
export const JORDAN_ID = "00000000-0000-4000-8000-00000000000d";

const COURSE = "00000000-0000-4000-8000-0000000000c1";
const LAST_WEEK = "00000000-0000-4000-8000-0000000000d1";
export const THIS_WEEK = "00000000-0000-4000-8000-0000000000d2";
export const TEE_TIME = "00000000-0000-4000-8000-0000000000e1";
const TEE_TIME_2 = "00000000-0000-4000-8000-0000000000e2";

const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const ALL_HOLES = [...HOLES, 10, 11, 12, 13, 14, 15, 16, 17, 18];

/**
 * Stroke indexes as most cards have them: the odd numbers on the front
 * (hole 1 hardest), the even ones on the back (hole 10 hardest).
 */
const strokeIndex = (hole: number) => (hole <= 9 ? hole * 2 - 1 : (hole - 9) * 2);

/**
 * Casey's index is 10 and Riley's 4. The tee is unrated, so over nine holes
 * each gets half their index in strokes: 5 and 2.
 */
function profile(id: string, fullName: string, handicapIndex: number): Row {
  return {
    id,
    full_name: fullName,
    phone: null,
    handicap_index: handicapIndex,
    preferred_tee: null,
    preferred_tee_time: null,
    is_admin: false,
  };
}

/**
 * This week, live, with no scores yet. Fresh each call: writes change it.
 * `backNine` makes it a nine on the back of an 18-hole course, holes 10–18.
 * `game` is what the week is played for, `seats` how many the tee time holds,
 * and `twoGroups` puts a second pair out behind them.
 */
export function leagueTables({
  backNine = false,
  game = "stroke",
  seats = 4,
  twoGroups = false,
} = {}): Record<string, Row[]> {
  return {
    profiles: [
      profile(CASEY.id, CASEY.fullName, 10),
      profile(RILEY_ID, "Riley Mock", 4),
      ...(twoGroups
        ? [profile(TAYLOR_ID, "Taylor Sample", 8), profile(JORDAN_ID, "Jordan Stub", 12)]
        : []),
    ],
    rounds: [
      {
        id: THIS_WEEK,
        league_id: SATURDAY,
        name: "Week 2",
        played_on: "2026-09-14",
        hole_count: 9,
        start_hole: backNine ? 10 : 1,
        status: "live",
        course_id: COURSE,
        rsvp_lock_at: null,
        game,
        stableford_points: null,
        created_at: "2026-09-08T12:00:00Z",
      },
    ],
    tee_times: [
      { id: TEE_TIME, round_id: THIS_WEEK, tee_at: "2026-09-14T13:00:00Z", seats },
      ...(twoGroups
        ? [{ id: TEE_TIME_2, round_id: THIS_WEEK, tee_at: "2026-09-14T13:10:00Z", seats }]
        : []),
    ],
    tee_time_players: [
      { tee_time_id: TEE_TIME, round_id: THIS_WEEK, player_id: CASEY.id, position: 1, played_tee: null },
      { tee_time_id: TEE_TIME, round_id: THIS_WEEK, player_id: RILEY_ID, position: 2, played_tee: null },
      ...(twoGroups
        ? [
            { tee_time_id: TEE_TIME_2, round_id: THIS_WEEK, player_id: TAYLOR_ID, position: 1, played_tee: null },
            { tee_time_id: TEE_TIME_2, round_id: THIS_WEEK, player_id: JORDAN_ID, position: 2, played_tee: null },
          ]
        : []),
    ],
    scorer_assignments: [
      { tee_time_id: TEE_TIME, scorer_player_id: CASEY.id, scored_player_id: RILEY_ID },
      { tee_time_id: TEE_TIME, scorer_player_id: RILEY_ID, scored_player_id: CASEY.id },
      ...(twoGroups
        ? [
            { tee_time_id: TEE_TIME_2, scorer_player_id: TAYLOR_ID, scored_player_id: JORDAN_ID },
            { tee_time_id: TEE_TIME_2, scorer_player_id: JORDAN_ID, scored_player_id: TAYLOR_ID },
          ]
        : []),
    ],
    scores: [],
    courses: [
      { id: COURSE, club_id: PUKAGOLF, name: "Mock Links", latitude: null, longitude: null, location_name: null, attribution: null },
    ],
    course_holes: (backNine ? ALL_HOLES : HOLES).map((hole) => ({
      course_id: COURSE,
      hole,
      par: 4,
      handicap_index: strokeIndex(hole),
      yardages: { white: 350 },
    })),
    course_tees: [
      { course_id: COURSE, tee_key: "white", tee_color: "white", course_rating: null, slope: null, yardage: 3150 },
    ],
    round_settings: [
      { round_id: THIS_WEEK, skins_enabled: true, skins_stake: 0, temp_f: null, wind: null, greens: null, sunset: null },
    ],
    feed_posts: [],
  };
}

/**
 * What league_season() hands back: last week, finished. Casey shot 36 and
 * Riley 45; net of 5 and 2 strokes that's 31 and 43, so Casey wins it.
 */
export function season({ leagueSkins = true } = {}) {
  return {
    year: 2026,
    leagueSkins,
    players: [
      { id: CASEY.id, name: CASEY.fullName, handicapIndex: 10, preferredTee: null },
      { id: RILEY_ID, name: "Riley Mock", handicapIndex: 4, preferredTee: null },
    ],
    rounds: [
      {
        id: LAST_WEEK,
        name: "Week 1",
        playedOn: "2026-09-07",
        status: "final",
        holeCount: 9,
        skinsEnabled: true,
        skinsStake: 0,
        pars: Object.fromEntries(HOLES.map((hole) => [String(hole), 4])),
        strokeIndexes: Object.fromEntries(HOLES.map((hole) => [String(hole), strokeIndex(hole)])),
        tees: [{ tee: "white", courseRating: null, slope: null, yardage: 3150 }],
        groups: [{ id: "last-week-group", playerIds: [CASEY.id, RILEY_ID], playedTees: {} }],
        scores: [
          ...HOLES.map((hole) => ({ playerId: CASEY.id, hole, strokes: 4 })),
          ...HOLES.map((hole) => ({ playerId: RILEY_ID, hole, strokes: 5 })),
        ],
      },
    ],
  };
}
