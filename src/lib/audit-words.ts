/**
 * One line of a club's audit log, in words a pro shop reads: who did what,
 * to whom, in which week. club_audit_log() (0054) names the player and the
 * week an entry is about; everything else comes from the entry itself.
 */

import { getGame } from "@/lib/games";

export type ClubAuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  /** The player the entry is about, where it names one. */
  player: string | null;
  /** "Week 1 · Practice Ridge Sunday", where it names a week. */
  week: string | null;
  /** The league a rules or season line is about (0056). */
  league?: string | null;
  /** "Group 2", where a player was moved to one (0056). */
  toGroup?: string | null;
};

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export function describeAuditEntry(entry: ClubAuditEntry): string {
  const d = entry.detail ?? {};
  const who = entry.player ?? (text(d.name) || "a player");
  const whose = entry.player ? `${entry.player}’s` : "a";
  const reason = d.reason ? `. Reason: “${text(d.reason)}”` : "";

  switch (entry.entity) {
    case "score":
      if (entry.action === "update") {
        return `changed ${whose} hole ${text(d.hole)} from ${text(d.from)} to ${text(d.to)}${reason}`;
      }
      if (entry.action === "delete") return `removed ${whose} hole ${text(d.hole)} (${text(d.strokes)})${reason}`;
      return `entered ${text(d.strokes)} on hole ${text(d.hole)} for ${entry.player ?? "a player"}${reason}`;

    case "card":
      if (entry.action === "sign_off") return "signed off a group’s cards";
      if (entry.action === "lock") return `locked ${whose} card`;
      if (entry.action === "unlock") return `unlocked ${whose} card`;
      // A sign-off taken back is not an unlock: the group signed it (0057).
      if (entry.action === "take_back") {
        const cards = Number(d.cards);
        // In a final week, with the reason it took (0058).
        const final = d.week_final ? " in a final week" : "";
        return entry.entityId.includes(":")
          ? `took back the sign-off on ${whose} card${final}${reason}`
          : `took back the sign-off on ${entry.player ? `${entry.player}’s group` : "a group"}${
              Number.isFinite(cards) && cards > 0 ? ` (${cards} ${cards === 1 ? "card" : "cards"})` : ""
            }${final}${reason}`;
      }
      break;

    case "season": {
      const of = entry.league ? ` of ${entry.league}` : "";
      if (entry.action === "close") return `closed the ${entry.entityId} season${of}`;
      if (entry.action === "reopen") return `reopened the ${entry.entityId} season${of}`;
      if (entry.action === "score_fix") {
        return `changed ${whose} hole ${text(d.hole)} from ${text(d.from)} to ${text(d.to)} in the closed ${entry.entityId} season${of}${reason}`;
      }
      break;
    }

    case "round":
      if (entry.action === "create") return "started a week";
      if (entry.action === "build_groups") return "built the groups from RSVPs";
      if (entry.action === "retime_groups") return "changed the tee times";
      if (entry.action === "clear_scores") {
        const reopened = Number(d.cards_reopened);
        return reopened > 0
          ? `cleared the week’s scores and took back ${reopened} ${reopened === 1 ? "card’s" : "cards’"} sign-off or lock`
          : "cleared the week’s scores";
      }
      // Made final, by the Final control or by starting the next week (0057).
      if (entry.action === "final") {
        const short = Array.isArray(d.short) ? (d.short as unknown[]).map(text) : [];
        return short.length === 0
          ? "marked the week final, every card finished"
          : `marked the week final with ${short.length} ${short.length === 1 ? "card" : "cards"} unfinished: ${short.join(", ")}`;
      }
      if (entry.action === "restore_scores") {
        // How many, and how many holes kept a score entered since (0060).
        const restored = Number(d.restored);
        const kept = Number(d.kept);
        const back = Number.isFinite(restored)
          ? `put back ${restored} of the week’s cleared ${restored === 1 ? "score" : "scores"}`
          : "put the week’s cleared scores back";
        const final = d.status === "final" ? " in a final week" : "";
        return kept > 0
          ? `${back}${final}; ${kept} ${kept === 1 ? "hole" : "holes"} kept ${kept === 1 ? "its" : "their"} new score`
          : `${back}${final}`;
      }
      if (entry.action === "clear_feed") return "cleared the week’s feed";
      if (d.status) return `set the week to ${text(d.status) === "setup" ? "Setting up" : text(d.status)}`;
      return "changed the week";

    case "group":
      if (entry.action === "create") return "added a group";
      if (entry.action === "delete") return "removed a group";
      return d.tee_at ? "changed a group’s tee time" : "changed a group";

    case "pairing":
      if (!d.to) return `took ${who} out of the week`;
      return `moved ${who} to ${entry.toGroup ?? "another group"}`;

    case "guest":
      return `added ${text(d.name) || "a guest"} as a guest`;

    case "club_member":
      switch (entry.action) {
        case "request":
          return `${entry.player ?? "someone"} asked to join the club`;
        case "approve":
          return `let ${who} into the club`;
        case "decline":
          return `turned down ${who}`;
        case "add":
          return `added ${who} to the club`;
        case "remove":
          return `took ${who} out of the club`;
        default:
          if (typeof d.staff_can_edit_scores === "boolean") {
            return d.staff_can_edit_scores
              ? `turned on “Can fix scores” for ${who}`
              : `turned off “Can fix scores” for ${who}`;
          }
          return d.role ? `made ${who} ${text(d.role)}` : `changed ${whose} club settings`;
      }

    case "league_member":
      return entry.action === "place" ? `put ${who} in a league` : `took ${who} out of a league`;

    case "league":
      return entry.action === "create" ? `started the league ${text(d.name)}`.trim() : "changed a league";

    case "league_rules": {
      const whoseRules = entry.league ? `${entry.league}’s` : "the league’s";
      // A mode change names the mode, and what it was where that's known (0058).
      if (typeof d.scoring_mode === "string") {
        // Before 0058 every rules save wrote the mode, changed or not.
        return typeof d.from === "string"
          ? `switched ${entry.league ?? "the league"} from ${modeName(d.from)} to ${modeName(d.scoring_mode)}`
          : `saved ${whoseRules} rules, on ${modeName(d.scoring_mode)}`;
      }
      if (typeof d.double_par_cap === "boolean") {
        return d.double_par_cap
          ? `turned on “Pick up at double par” for ${entry.league ?? "the league"}`
          : `turned off “Pick up at double par” for ${entry.league ?? "the league"}`;
      }
      if ((d.standings_count === "live" || d.standings_count === "final") && "from" in d) {
        return d.standings_count === "live"
          ? `set ${whoseRules} standings to count a week while it’s played`
          : `set ${whoseRules} standings to count a week once it’s final`;
      }
      // What each rule was, beside what it is now (0060).
      const changes = ruleChanges(d);
      if (changes.length > 0) return `changed ${whoseRules} rules: ${changes.join("; ")}`;
      return `changed ${whoseRules} rules`;
    }

    case "handicap":
      return d.handicap_index === null || d.handicap_index === undefined
        ? `cleared ${whose} handicap index`
        : `set ${whose} handicap index to ${text(d.handicap_index)}`;

    case "player":
      return `changed ${whose} details`;

    case "event":
      return entry.action === "create" ? "set up an outing" : "changed an outing";

    case "club":
      if (entry.action === "view") return "looked at the club as the platform admin";
      return "changed the club";
  }

  return `${entry.action.replaceAll("_", " ")} ${entry.entity.replaceAll("_", " ")}`;
}

/** The rules page's own names for what owner_set_league_rules saves. */
const RULES: readonly [key: string, name: string, say: (value: unknown) => string][] = [
  ["points", "Points for 1st, 2nd, 3rd…", (v) => (Array.isArray(v) ? v.join(", ") : text(v))],
  ["completion", "Point for finishing below that", text],
  ["drop_worst", "Worst weeks dropped", text],
  ["min_weeks", "Weeks to be ranked", text],
  ["ranking", "Rank by", (v) => (v === "gross" ? "gross" : "net")],
  ["guests_score", "Guests take places and points", (v) => (v ? "on" : "off")],
  ["default_stake", "Skins stake for new weeks", (v) => `$${text(v)}`],
  ["default_game", "Game for a new week", (v) => getGame(text(v)).label],
  ["stableford", "Stableford points", (v) => (Array.isArray(v) ? v.join(", ") : text(v))],
];

/** "Worst weeks dropped from 0 to 1", for each rule a save changed. */
export function ruleChanges(d: Record<string, unknown>): string[] {
  const was = d.was;
  if (!was || typeof was !== "object") return [];
  const before = was as Record<string, unknown>;
  return RULES.filter(([key]) => key in d && JSON.stringify(before[key]) !== JSON.stringify(d[key])).map(
    ([key, name, say]) => `${name} from ${say(before[key])} to ${say(d[key])}`,
  );
}

/** The only names the scoring modes go by. */
function modeName(mode: string): string {
  return mode === "self" ? "Self Scoring" : mode === "team" ? "Team Card Scoring" : "Partner Scoring";
}

/**
 * The log with repeats folded: one "Save rules" writes a line for each part
 * of the rules it saves, which read as the same change three times. Lines
 * from the same person saying the same thing within a minute show once.
 */
export function foldRepeats(entries: readonly ClubAuditEntry[]): ClubAuditEntry[] {
  const kept: ClubAuditEntry[] = [];
  const near = (a: ClubAuditEntry, b: ClubAuditEntry) =>
    a.actor === b.actor && Math.abs(Date.parse(a.at) - Date.parse(b.at)) < 60_000;
  for (const entry of entries) {
    // A hole saved again with the number it had changed nothing (before 0061).
    if (
      entry.entity === "score" &&
      entry.action === "update" &&
      entry.detail &&
      "from" in entry.detail &&
      entry.detail.from === entry.detail.to
    ) {
      continue;
    }
    // The Final control sets the status and the database logs the week going
    // final as well: one action, said once, by the line that says more.
    if (
      entry.entity === "round" &&
      entry.action !== "final" &&
      entry.detail?.status === "final" &&
      entries.some((o) => o.entity === "round" && o.action === "final" && o.entityId === entry.entityId && near(o, entry))
    ) {
      continue;
    }
    const last = kept.at(-1);
    if (
      last &&
      last.actor === entry.actor &&
      describeAuditEntry(last) === describeAuditEntry(entry) &&
      Math.abs(Date.parse(last.at) - Date.parse(entry.at)) < 60_000
    ) {
      continue;
    }
    kept.push(entry);
  }
  return kept;
}
