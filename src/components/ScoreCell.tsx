import {
  describeScore,
  isRound,
  ringCount,
  scoreDecoration,
} from "@/lib/score-decoration";

/**
 * One score on a scorecard, marked the way golfers read one.
 *
 * Circles under par, boxes over, nothing at par, with a ring per stroke away.
 *
 * The rings are absolutely positioned inside a fixed-size box, so a triple
 * bogey occupies exactly the same space as a par. Drawing them with borders on
 * the cell itself would change its size and shunt every column along.
 */
export function ScoreCell({
  strokes,
  par,
  size = "md",
  className = "",
}: {
  strokes: number | null | undefined;
  par: number | null | undefined;
  /** sm for dense grids, md for a scorecard. */
  size?: "sm" | "md";
  className?: string;
}) {
  const decoration = scoreDecoration(strokes, par);
  const rings = ringCount(decoration);
  const round = isRound(decoration);
  const description = describeScore(strokes, par);

  const box = size === "sm" ? "h-6 w-6 text-xs" : "h-7 w-7 text-sm";

  if (strokes === null || strokes === undefined) {
    return (
      <span
        className={`inline-flex items-center justify-center ${box} text-ink-soft ${className}`}
      >
        —
      </span>
    );
  }

  return (
    <span
      className={`relative inline-flex items-center justify-center ${box} ${className}`}
      // The shape carries meaning a border cannot convey to a screen reader.
      aria-label={description ?? undefined}
    >
      {/*
        Rings step inward 3px at a time: with 1px borders that leaves ~2px of
        clear space between them, which is the least that still reads as
        separate rings on a phone.

        currentColor rather than a fixed colour, so the rings follow the text
        and stay legible whatever the surrounding theme does.
      */}
      {Array.from({ length: rings }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`pointer-events-none absolute border border-current ${
            round ? "rounded-full" : "rounded-[1px]"
          } ${["inset-0", "inset-[3px]", "inset-[6px]"][i]}`}
        />
      ))}

      <span className="relative font-mono tabular-nums">{strokes}</span>
    </span>
  );
}
