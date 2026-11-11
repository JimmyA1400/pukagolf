"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { GAMES, parseStablefordTable, STABLEFORD, type GameId } from "@/lib/games";
import { parsePointsTable } from "@/lib/league-rules";
import { useClub } from "@/lib/club";
import { SCORING_MODES, type ScoringMode } from "@/lib/scoring-rules";
import { createClient } from "@/lib/supabase/client";

type Form = {
  points: string;
  completion: string;
  dropWorst: string;
  minWeeks: string;
  ranking: "net" | "gross";
  guestsScore: boolean;
  stake: string;
  defaultGame: GameId;
  stableford: string;
  scoringMode: ScoringMode;
  standingsCount: "final" | "live";
  doubleParCap: boolean;
};

/**
 * The rules owner_set_league_rules saves, as one string to compare: Save
 * sends them only when one of them changed, or the log had a "changed the
 * rules" line beside each mode or cap change that was the only change.
 */
function generalRules(form: Form): string {
  const points = parsePointsTable(form.points);
  const stableford = parseStablefordTable(form.stableford);
  return JSON.stringify([
    points.ok ? points.value : form.points,
    Number(form.completion),
    Number(form.dropWorst),
    Number(form.minWeeks),
    form.ranking,
    form.guestsScore,
    Number(form.stake),
    form.defaultGame,
    stableford.ok ? stableford.value : form.stableford,
  ]);
}

/**
 * How the league picked on the page is scored, for its club's admins.
 *
 * Only the rules are stored. The standings are worked out from the scores
 * each time they're shown, so a change here reaches every table at once, and
 * changing it back puts everything back as it was.
 */
export function LeagueRules() {
  const supabase = useMemo(() => createClient(), []);
  const leagueId = useClub().league?.id ?? null;
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // As loaded, so Save only sets the cap when it changes: a database from
  // before 0058 has no switch for it, and the rest still saves.
  const [capWas, setCapWas] = useState(true);
  const [generalWas, setGeneralWas] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!leagueId) return;

    const { data } = await supabase
      .from("league_rules")
      .select(
        "points_table, completion_point, drop_worst, min_weeks, ranking, guests_score, default_skins_stake, default_game, stableford_points, scoring_mode, standings_count",
      )
      .eq("league_id", leagueId)
      .maybeSingle();
    // Apart from the rest, as the column is newer (0058).
    const { data: cap } = await supabase
      .from("league_rules")
      .select("double_par_cap")
      .eq("league_id", leagueId)
      .maybeSingle();
    const doubleParCap = cap?.double_par_cap !== false;
    setCapWas(doubleParCap);

    const loaded: Form = {
      points: (data?.points_table ?? [10, 8, 6, 5, 4, 3, 2]).join(", "),
      completion: String(data?.completion_point ?? 1),
      dropWorst: String(data?.drop_worst ?? 0),
      minWeeks: String(data?.min_weeks ?? 0),
      ranking: data?.ranking === "gross" ? "gross" : "net",
      guestsScore: data?.guests_score ?? false,
      stake: String(data?.default_skins_stake ?? 0),
      defaultGame: (data?.default_game ?? "stroke") as GameId,
      stableford: (data?.stableford_points ?? [...STABLEFORD]).join(", "),
      scoringMode: (data?.scoring_mode ?? "partner") as ScoringMode,
      standingsCount: data?.standings_count === "live" ? "live" : "final",
      doubleParCap,
    };
    setForm(loaded);
    setGeneralWas(data ? generalRules(loaded) : null);
  }, [supabase, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!form) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });

  const whole = (value: string, low: number, high: number, what: string): number | string => {
    const n = Number(value);
    return value.trim() !== "" && Number.isInteger(n) && n >= low && n <= high
      ? n
      : `${what} runs from ${low} to ${high}.`;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();

    const points = parsePointsTable(form.points);
    if (!points.ok) return setNotice({ ok: false, text: points.reason });

    const numbers = {
      completion: whole(form.completion, 0, 10, "The finishing point"),
      dropWorst: whole(form.dropWorst, 0, 20, "Dropped weeks"),
      minWeeks: whole(form.minWeeks, 0, 52, "Weeks to qualify"),
      stake: whole(form.stake, 0, 1000, "The skins stake"),
    };
    const problem = Object.values(numbers).find((v): v is string => typeof v === "string");
    if (problem) return setNotice({ ok: false, text: problem });

    const stableford = parseStablefordTable(form.stableford);
    if (!stableford.ok) return setNotice({ ok: false, text: stableford.reason });

    if (!leagueId) return;

    setBusy(true);
    const { error: modeError } = await supabase.rpc("league_set_scoring_mode", {
      in_league_id: leagueId,
      in_mode: form.scoringMode,
    });

    if (modeError) {
      setBusy(false);
      return setNotice({ ok: false, text: modeError.message });
    }

    const { error: countError } = await supabase.rpc("league_set_standings_count", {
      in_league_id: leagueId,
      in_count: form.standingsCount,
    });

    if (countError) {
      setBusy(false);
      return setNotice({ ok: false, text: countError.message });
    }

    if (form.doubleParCap !== capWas) {
      const { error: capError } = await supabase.rpc("league_set_double_par_cap", {
        in_league_id: leagueId,
        in_on: form.doubleParCap,
      });
      if (capError) {
        setBusy(false);
        return setNotice({ ok: false, text: capError.message });
      }
      setCapWas(form.doubleParCap);
    }

    if (generalRules(form) === generalWas) {
      setBusy(false);
      setNotice({ ok: true, text: "Rules saved. The standings use them straight away." });
      return void load();
    }

    const { error } = await supabase.rpc("owner_set_league_rules", {
      in_league_id: leagueId,
      in_points: points.value,
      in_completion: numbers.completion as number,
      in_drop_worst: numbers.dropWorst as number,
      in_min_weeks: numbers.minWeeks as number,
      in_ranking: form.ranking,
      in_guests_score: form.guestsScore,
      in_default_stake: numbers.stake as number,
      in_default_game: form.defaultGame,
      in_stableford: stableford.value,
    });
    setBusy(false);

    setNotice(
      error
        ? { ok: false, text: error.message }
        : { ok: true, text: "Rules saved. The standings use them straight away." },
    );
    if (!error) await load();
  };

  return (
    <form noValidate onSubmit={save} className="space-y-4 border border-hairline bg-card p-4">
      <Field label="Points for 1st, 2nd, 3rd…" hint="Separate with commas. Equal points for neighbouring places are fine.">
        <input
          value={form.points}
          onChange={(e) => set("points", e.target.value)}
          className={inputClass}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Point for finishing below that" hint="For a completed card outside the places.">
          <input
            inputMode="numeric"
            value={form.completion}
            onChange={(e) => set("completion", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Worst weeks dropped" hint="Each player's lowest weeks don't count. 0 keeps them all.">
          <input
            inputMode="numeric"
            value={form.dropWorst}
            onChange={(e) => set("dropWorst", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Weeks to be ranked" hint="Fewer, and a player is listed below the table.">
          <input
            inputMode="numeric"
            value={form.minWeeks}
            onChange={(e) => set("minWeeks", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Skins stake for new weeks ($ a hole)" hint="0 carries each week's stake over from the last.">
          <input
            inputMode="numeric"
            value={form.stake}
            onChange={(e) => set("stake", e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="meta mb-1">Game for a new week</legend>
        {GAMES.map((option) => (
          <label key={option.id} className="flex items-start gap-2 font-mono text-xs">
            <input
              type="radio"
              name="defaultGame"
              checked={form.defaultGame === option.id}
              onChange={() => set("defaultGame", option.id)}
              className="mt-0.5 accent-forest"
            />
            <span>
              <span className="font-bold">{option.label}</span>
              <span className="block text-ink-soft">{option.blurb}</span>
            </span>
          </label>
        ))}
        <p className="font-mono text-[0.7rem] text-ink-soft">
          Any week can be set to a different game on its own, on the admin page.
        </p>
      </fieldset>

      <Field
        label="Stableford points"
        hint="Albatross, eagle, birdie, par, bogey, double or worse. Change them and it's a modified Stableford. A week keeps the values it was started with."
      >
        <input
          value={form.stableford}
          onChange={(e) => set("stableford", e.target.value)}
          className={inputClass}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="meta mb-1">Who enters the scores</legend>
        {SCORING_MODES.map((mode) => (
          <label key={mode.id} className="flex items-start gap-2 font-mono text-xs">
            <input
              type="radio"
              name="scoring-mode"
              checked={form.scoringMode === mode.id}
              onChange={() => set("scoringMode", mode.id)}
              className="mt-0.5 accent-forest"
            />
            <span>
              <span className="font-bold">{mode.label}</span>
              <span className="block text-ink-soft">{mode.detail}</span>
            </span>
          </label>
        ))}
        <p className="font-mono text-[0.7rem] text-ink-soft">
          A change takes effect straight away, in the week being played too: every
          score already entered stays, and the rest of the holes are kept the new way.
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="meta mb-1">The standings during a week</legend>
        {STANDINGS_COUNT.map((option) => (
          <label key={option.id} className="flex items-start gap-2 font-mono text-xs">
            <input
              type="radio"
              name="standings-count"
              checked={form.standingsCount === option.id}
              onChange={() => set("standingsCount", option.id)}
              className="mt-0.5 accent-forest"
            />
            <span>
              <span className="font-bold">{option.label}</span>
              <span className="block text-ink-soft">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="meta mb-1">Rank by</legend>
        {(["net", "gross"] as const).map((option) => (
          <label key={option} className="flex items-center gap-2 font-mono text-xs">
            <input
              type="radio"
              name="ranking"
              checked={form.ranking === option}
              onChange={() => set("ranking", option)}
              className="accent-forest"
            />
            {option === "net"
              ? "Net: strokes less each player's handicap"
              : "Gross: strokes as played"}
          </label>
        ))}
      </fieldset>

      <label className="flex items-center gap-2 font-mono text-xs">
        <input
          type="checkbox"
          checked={form.guestsScore}
          onChange={(e) => set("guestsScore", e.target.checked)}
          className="accent-forest"
        />
        Guests take places and points
      </label>

      <label className="flex items-start gap-2 font-mono text-xs">
        <input
          type="checkbox"
          checked={form.doubleParCap}
          onChange={(e) => set("doubleParCap", e.target.checked)}
          className="mt-0.5 accent-forest"
        />
        <span>
          Pick up at double par: the scoring pad stops a hole at twice its par.
          Off, a hole goes up to 20, for a league that plays every ball out.
        </span>
      </label>

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`font-mono text-xs ${notice.ok ? "text-forest" : "text-clay"}`}
        >
          {notice.text}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save rules"}
      </button>
    </form>
  );
}

/** Whether a week still being played counts in the season table. */
const STANDINGS_COUNT = [
  {
    id: "final",
    label: "Show the winner at the end only",
    detail:
      "A week counts once it's marked final. Until then the standings don't change and nobody is shown as leading.",
  },
  {
    id: "live",
    label: "Show the current leader during the week",
    detail:
      "A week being played counts straight away, marked provisional, and the leader is shown as the current leader until the week is final.",
  },
] as const;

const inputClass =
  "min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block font-mono text-[0.7rem] text-ink-soft">{hint}</span>}
    </label>
  );
}
