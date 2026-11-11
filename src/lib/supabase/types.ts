/**
 * Database types, written by hand to match supabase/migrations.
 *
 * Once the project exists these can be regenerated instead:
 *   npx supabase gen types typescript --project-id <id> > src/lib/supabase/types.ts
 */

export type Profile = {
  id: string;
  full_name: string;
  is_admin: boolean;
  created_at: string;
  phone: string | null;
  /** Self-reported. A plus handicap is stored negative: "+1.4" is -1.4. */
  handicap_index: number | null;
  preferred_tee_time: string | null;
  preferred_tee: string | null;
  /** A name with no account, added by an admin for a week. */
  is_guest: boolean;
  phone_verified: boolean;
  /** Shows the player's scores from other clubs to members of clubs they share. */
  show_scores: boolean;
};

export type RoundRsvp = {
  round_id: string;
  player_id: string;
  status: "in" | "out" | "undecided";
  set_by: string | null;
  updated_at: string;
};

export type Course = {
  id: string;
  name: string;
  hole_count: number;
  created_at: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  location_name: string | null;
  external_id: string | null;
  city: string | null;
  state: string | null;
  attribution: string | null;
  /** The club whose layout this is. */
  club_id: string;
};

export type CourseTee = {
  course_id: string;
  tee_key: string;
  tee_name: string;
  tee_color: string | null;
  gender: string | null;
  course_rating: number | null;
  slope: number | null;
  par: number | null;
  yardage: number | null;
};

export type CourseHole = {
  course_id: string;
  hole: number;
  par: number;
  /** Stroke index, 1 = hardest. Null when the course has not been rated. */
  handicap_index: number | null;
  /** Yardage keyed by tee colour, e.g. { blue: 371 }. */
  yardages: Record<string, number> | null;
};

export type Round = {
  id: string;
  name: string;
  played_on: string;
  hole_count: number;
  status: "setup" | "live" | "final";
  course_id: string | null;
  rsvp_lock_at: string | null;
  /** False once the owner marks the week rained out. */
  counts_for_standings: boolean;
  /** 1, or 10 for a week played on the back nine. */
  start_hole: number;
  /** What the week is played for. See src/lib/games.ts. */
  game: "stroke" | "stableford" | "scramble" | "best_ball";
  /** The week's own Stableford values; null in a week not played for points. */
  stableford_points: number[] | null;
  /** Players per side. 1 is each player for themselves. */
  team_size: number;
  /** Played indoors. Counts at league_settings.simulator_weight. */
  is_simulator: boolean;
  /** The league the week belongs to. */
  league_id: string;
  created_at: string;
};

export type RoundTeam = {
  id: string;
  round_id: string;
  /** Null until named; "Team 3" comes from the position. */
  name: string | null;
  position: number;
  /** Reserved for Ryder Cup's two sides; nothing reads it yet. */
  side: number | null;
  created_at: string;
};

export type RoundTeamPlayer = {
  team_id: string;
  round_id: string;
  player_id: string;
  position: number;
};

export type RoundMatch = {
  id: string;
  round_id: string;
  position: number;
  home_team_id: string;
  /** Null is a bye: an odd field leaves one side without an opponent. */
  away_team_id: string | null;
  tee_time_id: string | null;
  created_at: string;
};

export type TeeTime = {
  id: string;
  round_id: string;
  tee_at: string;
  starting_hole: number;
  /** How many this tee time holds: a threesome is 3, not 4 with a gap. */
  seats: number;
  created_at: string;
};

export type TeeTimePlayer = {
  tee_time_id: string;
  round_id: string;
  player_id: string;
  position: number;
  /** Which tee this player played, for the handicap differential. */
  played_tee: string | null;
};

export type ScorerAssignment = {
  tee_time_id: string;
  scored_player_id: string;
  scorer_player_id: string;
  updated_at: string;
};

export type ScoreRow = {
  id: string;
  round_id: string;
  player_id: string;
  hole: number;
  strokes: number;
  entered_by: string;
  /** When it was entered on the phone, for a score that waited for signal (0057). */
  entered_on_phone_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type TeeTimeRequest = {
  id: string;
  round_id: string;
  player_id: string;
  earliest: string | null;
  latest: string | null;
  preferred_partners: string[];
  notes: string | null;
  status: "pending" | "scheduled" | "declined";
  created_at: string;
  updated_at: string;
};

export type RoundSettingsRow = {
  round_id: string;
  skins_enabled: boolean;
  skins_stake: number;
  temp_f: number | null;
  wind: string | null;
  greens: string | null;
  sunset: string | null;
  updated_at: string;
};

export type LeagueSettingsRow = {
  singleton: boolean;
  skins_enabled: boolean;
  /** "08:00:00": the default first tee time for a week's groups. */
  first_tee_time: string;
  tee_interval_minutes: number;
  announcement: string | null;
  announcement_at: string | null;
  points_table: number[];
  completion_point: number;
  drop_worst: number;
  min_weeks: number;
  ranking: "net" | "gross";
  guests_score: boolean;
  default_skins_stake: number;
  /** The game a new week starts under. */
  default_game: "stroke" | "stableford" | "scramble" | "best_ball";
  stableford_points: number[];
  /** How much a simulator round moves an index, 0 to 1. A house rule. */
  simulator_weight: number;
  updated_at: string;
};

/** One league's rules (league_rules): the Saturday League's came from league_settings. */
export type LeagueRulesRow = Omit<LeagueSettingsRow, "singleton" | "simulator_weight"> & {
  league_id: string;
  /** Who enters scores: Partner Scoring, Self Scoring or Team Card Scoring. */
  scoring_mode: "partner" | "self" | "team";
  /** Whether a week still being played counts in the standings, provisionally. */
  standings_count: "final" | "live";
  /** The pad stops a hole at double par, the pick-up rule (0058). */
  double_par_cap: boolean;
};

/** A season its league has closed (seasons). */
export type SeasonRow = {
  league_id: string;
  year: number;
  closed_at: string;
  champion_id: string | null;
  champion_name: string | null;
};

/** A signed-off or admin-locked card: only a club admin changes it now. */
/** A final week's handicap index for one player, from when it was marked final. */
export type RoundHandicapRow = {
  round_id: string;
  player_id: string;
  handicap_index: number | null;
  frozen_at: string;
};

export type CardLockRow = {
  round_id: string;
  player_id: string;
  locked_at: string;
  locked_by: string | null;
  /** "signed" by the group, or locked by an "admin". */
  how: "signed" | "admin";
};

export type CharityRow = {
  id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  website: string | null;
  active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  club_id: string;
};

export type TournamentRow = {
  id: string;
  name: string;
  description: string | null;
  played_on: string;
  course_id: string | null;
  course_name: string | null;
  format: string;
  entry_fee: number;
  field_limit: number | null;
  rsvp_lock_at: string | null;
  completed_at: string | null;
  charity_id: string | null;
  raised: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  club_id: string;
};

export type TournamentRsvp = {
  tournament_id: string;
  player_id: string;
  status: "in" | "out" | "undecided";
  set_by: string | null;
  updated_at: string;
};

export type TournamentResult = {
  tournament_id: string;
  player_id: string;
  position: number;
  gross: number | null;
  notes: string | null;
};

export type FeedPostRow = {
  id: string;
  round_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile>;
      courses: Table<Course>;
      course_holes: Table<CourseHole>;
      course_tees: Table<CourseTee>;
      rounds: Table<Round>;
      tee_times: Table<TeeTime>;
      round_teams: Table<RoundTeam>;
      round_team_players: Table<RoundTeamPlayer>;
      round_matches: Table<RoundMatch>;
      tee_time_players: Table<TeeTimePlayer>;
      scorer_assignments: Table<ScorerAssignment>;
      scores: Table<
        ScoreRow,
        Pick<ScoreRow, "round_id" | "player_id" | "hole" | "strokes" | "entered_by"> &
          Pick<ScoreRow, "entered_on_phone_at">
      >;
      tee_time_requests: Table<TeeTimeRequest>;
      round_settings: Table<RoundSettingsRow>;
      round_rsvps: Table<RoundRsvp>;
      tournaments: Table<TournamentRow>;
      charities: Table<CharityRow>;
      league_settings: Table<LeagueSettingsRow>;
      league_rules: Table<LeagueRulesRow>;
      card_locks: Table<CardLockRow>;
      round_handicaps: Table<RoundHandicapRow>;
      seasons: Table<SeasonRow>;
      tournament_rsvps: Table<TournamentRsvp>;
      tournament_results: Table<TournamentResult>;
      feed_posts: Table<
        FeedPostRow,
        Pick<FeedPostRow, "round_id" | "author_id" | "body">
      >;
    };
    Views: Record<never, never>;
    Functions: {
      import_course: {
        Args: { payload: unknown; in_club_id: string };
        Returns: string;
      };
      create_event: {
        Args: { payload: unknown };
        Returns: {
          share_token: string;
          admin_pin: string;
          pin_was_chosen: boolean;
        };
      };
      save_player_details: {
        Args: {
          in_full_name: string;
          in_phone: string | null;
          in_handicap_index: number | null;
          in_preferred_tee_time: string | null;
          in_preferred_tee: string | null;
        };
        Returns: unknown;
      };
      is_owner: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      owner_league_overview: {
        Args: { in_league_id: string };
        Returns: unknown;
      };
      owner_clear_round_scores: {
        Args: { in_round_id: string };
        Returns: number;
      };
      owner_clear_round_feed: {
        Args: { in_round_id: string };
        Returns: number;
      };
      owner_update_round: {
        Args: {
          in_round_id: string;
          in_name: string;
          in_played_on: string;
          in_status: string;
        };
        Returns: void;
      };
      owner_start_new_week: {
        Args: {
          in_league_id: string;
          in_name: string;
          in_played_on: string;
          in_copy_groups?: boolean;
          in_course_id?: string | null;
          in_hole_count?: number | null;
          in_start_hole?: number | null;
          in_game?: string | null;
        };
        Returns: string;
      };
      owner_set_admin: {
        Args: { in_profile_id: string; in_is_admin: boolean };
        Returns: void;
      };
      owner_remove_player: {
        Args: { in_profile_id: string };
        Returns: void;
      };
      admin_clear_demo_scores: {
        Args: Record<string, never>;
        Returns: number;
      };
      admin_set_event_pin: {
        Args: { in_event_id: string; in_pin?: string | null };
        Returns: unknown;
      };
      report_client_error: {
        Args: {
          in_kind: string;
          in_message: string;
          in_stack?: string | null;
          in_path?: string | null;
          in_user_agent?: string | null;
          in_digest?: string | null;
        };
        Returns: void;
      };
      owner_audit_log: {
        Args: { in_limit?: number; in_before?: string | null };
        Returns: unknown;
      };
      owner_client_errors: {
        Args: { in_limit?: number };
        Returns: unknown;
      };
      owner_clear_client_errors: {
        Args: Record<string, never>;
        Returns: number;
      };
      admin_week_groups: {
        Args: { in_round_id: string };
        Returns: unknown;
      };
      admin_add_group: {
        Args: { in_round_id: string; in_tee_at: string; in_seats?: number };
        Returns: string;
      };
      admin_set_group_seats: {
        Args: { in_tee_time_id: string; in_seats: number };
        Returns: void;
      };
      owner_create_league_event: {
        Args: {
          in_league_id: string;
          in_name: string;
          in_played_on: string;
          in_course_id?: string | null;
          in_hole_count?: number;
          in_start_hole?: number;
          in_is_simulator?: boolean;
        };
        Returns: string;
      };
      admin_event_invite: {
        Args: { in_event_id: string; in_profile_ids: string[] };
        Returns: number;
      };
      admin_event_add_guest: {
        Args: { in_event_id: string; in_name: string; in_handicap?: number | null };
        Returns: string;
      };
      admin_event_remove_player: {
        Args: { in_event_id: string; in_player_id: string };
        Returns: void;
      };
      event_rsvp: {
        Args: { in_event_id: string; in_status: string; in_player_id?: string | null };
        Returns: void;
      };
      admin_event_set_format: {
        Args: { in_event_id: string; in_format_id: string; in_team_size: number };
        Returns: void;
      };
      admin_event_set_flags: {
        Args: {
          in_event_id: string;
          in_counts?: boolean | null;
          in_simulator?: boolean | null;
        };
        Returns: void;
      };
      admin_event_set_teams: {
        Args: { in_event_id: string; in_teams: string[][] };
        Returns: number;
      };
      league_event: {
        Args: { in_event_id: string };
        Returns: unknown;
      };
      league_events: {
        Args: { in_league_id: string };
        Returns: unknown;
      };
      admin_event_set_tee: {
        Args: { in_event_id: string; in_player_id: string; in_tee: string | null };
        Returns: void;
      };
      event_set_my_tee: {
        Args: { in_event_id: string; in_tee: string | null };
        Returns: void;
      };
      player_team_events: {
        Args: { in_player_id: string };
        Returns: unknown;
      };
      player_event_rounds: {
        Args: { in_player_id: string };
        Returns: unknown;
      };
      owner_set_simulator_weight: {
        Args: { in_weight: number };
        Returns: void;
      };
      admin_set_week_simulator: {
        Args: { in_round_id: string; in_value: boolean };
        Returns: void;
      };
      admin_set_week_holes: {
        Args: {
          in_round_id: string;
          in_hole_count: number;
          in_start_hole?: number;
        };
        Returns: void;
      };
      admin_set_week_game: {
        Args: {
          in_round_id: string;
          in_game: string;
          in_points?: number[] | null;
        };
        Returns: void;
      };
      enter_team_score: {
        Args: {
          in_round_id: string;
          in_tee_time_id: string;
          in_hole: number;
          in_strokes: number;
        };
        Returns: number;
      };
      admin_set_group_time: {
        Args: { in_tee_time_id: string; in_tee_at: string };
        Returns: void;
      };
      admin_delete_group: {
        Args: { in_tee_time_id: string };
        Returns: void;
      };
      admin_place_player: {
        Args: {
          in_round_id: string;
          in_player_id: string;
          in_tee_time_id?: string | null;
        };
        Returns: void;
      };
      admin_build_week_from_rsvps: {
        Args: {
          in_round_id: string;
          in_first_tee: string;
          in_interval_minutes?: number;
          in_group_size?: number;
        };
        Returns: unknown;
      };
      league_season: {
        Args: { in_league_id: string; in_year?: number | null };
        Returns: unknown;
      };
      owner_set_league_skins: {
        Args: { in_league_id: string; in_enabled: boolean };
        Returns: void;
      };
      owner_set_handicap: {
        Args: { in_profile_id: string; in_index: number | null };
        Returns: void;
      };
      admin_add_guest: {
        Args: {
          in_round_id: string;
          in_tee_time_id: string | null;
          in_name: string;
          in_handicap?: number | null;
        };
        Returns: string;
      };
      admin_set_tee_defaults: {
        Args: { in_league_id: string; in_first_tee: string; in_interval: number };
        Returns: void;
      };
      admin_retime_groups: {
        Args: {
          in_round_id: string;
          in_first_tee: string;
          in_interval_minutes: number;
        };
        Returns: number;
      };
      admin_set_announcement: {
        Args: { in_league_id: string; in_text: string | null };
        Returns: void;
      };
      owner_update_player: {
        Args: { in_profile_id: string; in_full_name: string; in_phone?: string | null };
        Returns: void;
      };
      owner_merge_players: {
        Args: { in_keep: string; in_remove: string };
        Returns: void;
      };
      owner_restorable_scores: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      owner_restore_scores: {
        Args: { in_round_id: string };
        Returns: number;
      };
      owner_set_league_rules: {
        Args: {
          in_league_id: string;
          in_points: number[];
          in_completion: number;
          in_drop_worst: number;
          in_min_weeks: number;
          in_ranking: string;
          in_guests_score: boolean;
          in_default_stake: number;
          in_default_game?: string | null;
          in_stableford?: number[] | null;
        };
        Returns: void;
      };
      owner_set_round_counts: {
        Args: { in_round_id: string; in_counts: boolean };
        Returns: void;
      };
      owner_close_season: {
        Args: { in_league_id: string; in_year: number; in_champion_id: string | null };
        Returns: void;
      };
      owner_reopen_season: {
        Args: { in_league_id: string; in_year: number };
        Returns: void;
      };
      admin_events: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      admin_delete_event: {
        Args: { in_event_id: string };
        Returns: void;
      };
      charity_totals: {
        Args: { in_club_id: string };
        Returns: unknown;
      };
      my_clubs: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      club_public: {
        Args: { in_slug: string };
        Returns: unknown;
      };
      my_club_request: { Args: { in_slug: string }; Returns: unknown };
      club_request_join: { Args: { in_slug: string }; Returns: unknown };
      club_decide: {
        Args: { in_club_id: string; in_profile_id: string; in_approve: boolean };
        Returns: void;
      };
      club_add_member: {
        Args: { in_club_id: string; in_phone: string; in_role?: string };
        Returns: string | null;
      };
      api_lookup_allowed: { Args: { in_ip: string | null }; Returns: boolean };
      api_outing_weather_place: { Args: { in_token: string; in_ip: string | null }; Returns: unknown };
      club_set_role: {
        Args: { in_club_id: string; in_profile_id: string; in_role: string };
        Returns: void;
      };
      club_set_staff_scores: {
        Args: { in_club_id: string; in_profile_id: string; in_allowed: boolean };
        Returns: void;
      };
      club_remove_member: { Args: { in_club_id: string; in_profile_id: string }; Returns: void };
      club_admin_overview: { Args: { in_club_id: string }; Returns: unknown };
      club_league_choices: { Args: { in_club_id: string }; Returns: unknown };
      league_create: { Args: { in_club_id: string; in_name: string }; Returns: unknown };
      league_request_join: { Args: { in_league_id: string }; Returns: unknown };
      league_set_member: {
        Args: { in_league_id: string; in_profile_id: string; in_playing: boolean };
        Returns: void;
      };
      is_platform_admin: { Args: Record<string, never>; Returns: unknown };
      can_fix_scores: { Args: { in_club_id: string }; Returns: unknown };
      platform_clubs: { Args: Record<string, never>; Returns: unknown };
      club_audit_log: {
        Args: { in_club_id: string; in_limit?: number; in_before?: string | null };
        Returns: unknown;
      };
      platform_create_club: {
        Args: { in_slug: string; in_name: string; in_is_demo?: boolean; in_admin_phone?: string | null };
        Returns: unknown;
      };
      platform_set_club_status: { Args: { in_club_id: string; in_status: string }; Returns: void };
      platform_note_view: { Args: { in_club_id: string }; Returns: void };
      site_settings: { Args: Record<string, never>; Returns: unknown };
      league_set_scoring_mode: { Args: { in_league_id: string; in_mode: string }; Returns: void };
      sign_off_group: { Args: { in_tee_time_id: string }; Returns: unknown };
      admin_set_card_lock: {
        Args: { in_round_id: string; in_player_id: string; in_locked: boolean };
        Returns: void;
      };
      admin_take_back_sign_off: {
        Args: { in_round_id: string; in_player_id: string; in_reason?: string | null };
        Returns: number;
      };
      card_history: { Args: { in_round_id: string; in_player_id: string }; Returns: unknown };
      round_players_without_login: { Args: { in_round_id: string }; Returns: string[] };
      admin_fix_signed_score: {
        Args: {
          in_round_id: string;
          in_player_id: string;
          in_hole: number;
          in_strokes: number;
          in_reason: string;
        };
        Returns: void;
      };
      league_set_standings_count: {
        Args: { in_league_id: string; in_count: "final" | "live" };
        Returns: void;
      };
      league_set_double_par_cap: {
        Args: { in_league_id: string; in_on: boolean };
        Returns: void;
      };
      set_tournament_rsvp: {
        Args: {
          in_tournament_id: string;
          in_status: string;
          in_player_id?: string | null;
        };
        Returns: unknown;
      };
      round_completion: {
        Args: { in_round_id: string };
        Returns: unknown;
      };
      complete_round: {
        Args: { in_round_id: string; force?: boolean };
        Returns: unknown;
      };
      event_admin_complete: {
        Args: { admin_token: string; force?: boolean };
        Returns: unknown;
      };
      player_rounds: {
        Args: { in_player_id: string };
        Returns: unknown;
      };
      set_rsvp: {
        Args: {
          in_round_id: string;
          in_status: string;
          in_player_id?: string | null;
        };
        Returns: unknown;
      };
      event_admin_unlock: {
        Args: { token: string; pin: string };
        Returns: string;
      };
      event_admin_set_tee_time: {
        Args: { admin_token: string; in_tee_time_id: string; in_tee_at: string };
        Returns: unknown;
      };
      event_admin_set_score: {
        Args: {
          admin_token: string;
          in_team_id: string;
          in_player_id: string | null;
          in_hole: number;
          in_strokes: number;
        };
        Returns: unknown;
      };
      event_admin_set_skins: {
        Args: {
          admin_token: string;
          in_enabled: boolean;
          in_stake: number;
        };
        Returns: unknown;
      };
      event_admin_rename_player: {
        Args: { admin_token: string; in_player_id: string; in_name: string };
        Returns: unknown;
      };
      event_state: {
        Args: { token: string };
        Returns: unknown;
      };
      event_score_submit: {
        Args: {
          token: string;
          in_team_id: string;
          in_player_id: string | null;
          in_hole: number;
          in_strokes: number;
          in_entered_by: string;
        };
        Returns: unknown;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
