"use client";

import { useState } from "react";

import { roundHoles } from "@/lib/holes";
import { formatToPar, type Score } from "@/lib/leaderboard";
import type { CoursePars, ScorecardExtras } from "@/lib/scorecard";

const SCORE_NAMES: Record<number, string> = {
  [-3]: "Albatross",
  [-2]: "Eagle",
  [-1]: "Birdie",
  0: "Par",
  1: "Bogey",
  2: "Double bogey",
  3: "Triple bogey",
};

/** The most strokes the database takes on one hole. */
const MOST_STROKES = 20;

function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return "Hole in one";

  const diff = strokes - par;
  return SCORE_NAMES[diff] ?? `+${diff}`;
}

/**
 * Hole-by-hole scoring with big buttons, for the card a player is keeping.
 *
 * Built for a phone held in one hand, maybe in a glove: one hole at a time,
 * a large − and +, quick picks around par, and one button that saves and
 * moves on. Strokes run from 1 to double par for the hole — the league's
 * pick-up rule, unless the league has turned it off — so there is no typing
 * and nothing to mistype. Where "+" stops, the pad says why.
 *
 * The same order rule as the database: any hole already entered can be
 * corrected, and the next one due can be entered; nothing beyond it.
 */
export function BigScorer({
  playerName,
  pars,
  scores,
  holeCount,
  startHole = 1,
  extras,
  received,
  doubleParCap = true,
  onSubmit,
}: {
  playerName: string;
  pars: CoursePars;
  scores: readonly Score[];
  holeCount: number;
  /** 10 for a back-nine week. */
  startHole?: number;
  extras?: ScorecardExtras;
  /** Handicap strokes this player gets, by hole, in a net week. */
  received?: Readonly<Record<number, number>>;
  /** The league's pick-up rule: a hole stops at double par. Off, at 20. */
  doubleParCap?: boolean;
  onSubmit: (hole: number, strokes: number) => void;
}) {
  const byHole = new Map(scores.map((s) => [s.hole, s.strokes]));
  const holes = roundHoles(holeCount, startHole);
  const first = holes[0];
  const last = holes[holes.length - 1];

  // The next hole due, or one past the last once the card is full.
  const nextOpen = holes.find((h) => !byHole.has(h)) ?? last + 1;
  const lastReachable = Math.min(nextOpen, last);

  // Null until the player picks a hole: until then the pad follows the next
  // hole due, so it opens on the first hole without a score even when the
  // card (or the phone's unsent scores) arrives a moment after the pad does.
  const [picked, setPicked] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ hole: number; strokes: number } | null>(null);
  // Where you were before going back to correct a hole, to return to after.
  const [returnTo, setReturnTo] = useState<number | null>(null);

  // Never beyond the next hole due, even if scores were cleared underneath us.
  const hole = picked === null ? lastReachable : Math.min(picked, lastReachable);
  const par = pars[hole] ?? 4;
  const max = doubleParCap ? Math.min(par * 2, MOST_STROKES) : MOST_STROKES;
  const entered = byHole.get(hole) ?? null;
  const strokes = draft?.hole === hole ? draft.strokes : (entered ?? par);

  const go = (target: number) => {
    const next = Math.max(first, Math.min(target, lastReachable));
    // Going back from the hole you're on remembers it; going forward again
    // to it (or past it) means you've found your own way back.
    if (next < hole && returnTo === null) setReturnTo(hole);
    else if (returnTo !== null && next >= returnTo) setReturnTo(null);
    setPicked(next);
    setDraft(null);
  };

  const set = (next: number) => setDraft({ hole, strokes: Math.max(1, Math.min(max, next)) });

  // A correction takes you back to where you were; a new hole moves on.
  const returning = entered !== null && returnTo !== null && returnTo > hole ? returnTo : null;

  const save = () => {
    onSubmit(hole, strokes);
    setDraft(null);
    if (returning !== null) {
      setPicked(returning);
      setReturnTo(null);
    } else if (hole < last) setPicked(hole + 1);
  };

  let toPar = 0;
  for (const [h, s] of byHole) toPar += s - (pars[h] ?? 4);
  const thru = byHole.size;
  // Every hole in: nothing left to move on to, only corrections.
  const complete = thru >= holeCount;
  const unchanged = entered !== null && strokes === entered;
  const getsHere = received?.[hole] ?? 0;

  const yards = extras?.yards?.[hole];
  const strokeIndex = extras?.strokeIndexes?.[hole];

  const out = holes.filter((h) => h <= 9);
  const back = holes.filter((h) => h > 9);
  const rows =
    out.length > 0 && back.length > 0
      ? [
          { label: "Out", holes: out },
          { label: "In", holes: back },
        ]
      : [{ label: back.length > 0 ? "In" : "Holes", holes }];

  return (
    <section aria-label={`Scoring ${playerName}`} className="border border-hairline bg-card">
      {/* Whose card it is: kept clear of the unsent bar, below Save. */}
      <header data-keep-clear className="flex items-baseline justify-between gap-3 bg-forest-deep px-4 py-3 text-cream">
        <p className="font-display text-xl font-bold">{playerName}</p>
        <p className="text-right">
          <span className="font-display text-2xl font-bold">
            {thru === 0 ? "—" : formatToPar(toPar)}
          </span>
          <span className="block font-mono text-xs text-hairline">
            {/* Not "Final": that's for the week, which the pro shop marks. */}
            {complete ? "Card complete" : `Thru ${thru}`}
          </span>
        </p>
      </header>

      <div className="space-y-5 p-4">
        <div className="flex items-center justify-between gap-2">
          <ArrowButton label="Previous hole" disabled={hole <= first} onClick={() => go(hole - 1)}>
            ‹
          </ArrowButton>
          <div data-keep-clear className="text-center">
            <p className="font-display text-3xl font-bold">Hole {hole}</p>
            <p className="font-mono text-xs text-ink-soft">
              Par {par}
              {yards ? ` · ${yards} yds` : ""}
              {strokeIndex ? ` · SI ${strokeIndex}` : ""}
            </p>
            {getsHere > 0 && (
              <p className="font-mono text-xs text-forest">
                {"•".repeat(Math.min(getsHere, 3))} {getsHere}{" "}
                {getsHere === 1 ? "handicap stroke" : "handicap strokes"} here
              </p>
            )}
          </div>
          <ArrowButton
            label="Next hole"
            disabled={hole >= lastReachable}
            onClick={() => go(hole + 1)}
          >
            ›
          </ArrowButton>
        </div>

        <div className="flex items-center justify-between px-1">
          <RoundButton label="One fewer stroke" disabled={strokes <= 1} onClick={() => set(strokes - 1)}>
            −
          </RoundButton>
          <div className="text-center">
            <output
              aria-label="Strokes"
              aria-live="polite"
              className="block font-display text-7xl leading-none font-bold tabular-nums"
            >
              {strokes}
            </output>
            <p className="mt-1 font-mono text-xs text-ink-soft">{scoreName(strokes, par)}</p>
          </div>
          <RoundButton label="One more stroke" disabled={strokes >= max} onClick={() => set(strokes + 1)}>
            +
          </RoundButton>
        </div>

        {/* "+" greyed out and nothing said: a golfer who took a 9 on a par 4
            was left wondering how to enter it. */}
        {strokes >= max && (
          <p role="status" className="-mt-3 text-center font-mono text-xs text-clay">
            {doubleParCap
              ? `Max is double par (${max}) in this league: pick up at ${max}. The pro shop can turn this off.`
              : `${MOST_STROKES} is the most a hole can take.`}
          </p>
        )}

        <div className="flex gap-2">
          {[-1, 0, 1, 2]
            .map((diff) => par + diff)
            .filter((value) => value >= 1 && value <= max)
            .map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={value === strokes}
                onClick={() => set(value)}
                className={`min-h-12 flex-1 border font-mono text-xs leading-tight ${
                  value === strokes
                    ? "border-forest-deep bg-forest-deep text-cream"
                    : "border-hairline bg-cream"
                }`}
              >
                {value - par === 2 ? "Double" : scoreName(value, par)}
                <span className="block text-sm font-bold">{value}</span>
              </button>
            ))}
        </div>

        {complete && returning === null && (
          <p role="status" className="border border-forest bg-cream px-3 py-2 font-mono text-xs text-forest">
            All {holeCount} holes are in. Check the card, then sign it with the group below.
            Tap any hole to correct it.
          </p>
        )}

        <button
          type="button"
          // Never left under the unsent bar (UnsentScores).
          data-keep-clear="2"
          onClick={save}
          disabled={complete && returning === null && unchanged}
          className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {complete && returning === null
            ? unchanged
              ? `Hole ${hole}: ${strokes}`
              : `Update hole ${hole} to ${strokes}`
            : `${entered !== null ? "Update" : "Save"} ${strokes} · ${
                returning !== null ? `back to hole ${returning}` : hole < last ? "next hole" : "finish"
              }`}
        </button>

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.label}>
              <p className="meta mb-1">{row.label}</p>
              {/* Five across on a phone, so each hole is big enough to tap. */}
              <div className="grid grid-cols-5 gap-1 sm:grid-cols-9">
                {row.holes.map((h) => {
                  const value = byHole.get(h);
                  const locked = h > nextOpen;
                  const diff = value !== undefined ? value - (pars[h] ?? 4) : 0;
                  const dots = received?.[h] ?? 0;

                  return (
                    <button
                      key={h}
                      type="button"
                      disabled={locked}
                      onClick={() => go(h)}
                      aria-label={`Hole ${h}${value !== undefined ? `, ${value} strokes` : ""}${
                        dots > 0 ? `, ${dots} handicap ${dots === 1 ? "stroke" : "strokes"}` : ""
                      }`}
                      aria-current={h === hole ? "step" : undefined}
                      className={`relative flex h-11 flex-col items-center justify-center border font-mono leading-none disabled:opacity-35 ${
                        h === hole ? "border-forest ring-2 ring-forest" : "border-hairline"
                      } ${diff >= 2 ? "bg-sand" : "bg-cream"}`}
                    >
                      {dots > 0 && (
                        <span aria-hidden className="absolute top-0.5 right-1 text-[0.55rem] text-forest">
                          {"•".repeat(Math.min(dots, 3))}
                        </span>
                      )}
                      <span className="text-[0.6rem] text-ink-soft">{h}</span>
                      {/* Red under par, as everywhere; a double or worse stands out too. */}
                      <span
                        className={`text-xs ${diff < 0 ? "text-clay" : ""} ${diff >= 2 ? "font-bold underline" : ""}`}
                      >
                        {value ?? "·"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {nextOpen < last && (
            <p className="font-mono text-xs text-ink-soft">
              Holes go in order, the way they&rsquo;re played: save hole {nextOpen} and
              hole {nextOpen + 1} opens. Any hole already saved can be changed.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function RoundButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-forest bg-cream font-display text-4xl text-forest-deep disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function ArrowButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-cream text-xl disabled:opacity-30"
    >
      {children}
    </button>
  );
}
