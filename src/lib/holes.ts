/**
 * The holes a round plays, in order: 1–18, the front nine 1–9, or the back
 * nine 10–18.
 *
 * Scores are stored under the real hole numbers, so a back-nine week's card,
 * pars, stroke indexes and yardages line up with the course's own card, and
 * editing the course never touches the wrong holes.
 */
export function roundHoles(holeCount: number, startHole = 1): number[] {
  return Array.from({ length: holeCount }, (_, i) => startHole + i);
}

/** "18 holes", "9 holes", or "Back nine" for a week that starts on 10. */
export function holesLabel(holeCount: number, startHole = 1): string {
  return startHole > 1 ? "Back nine" : `${holeCount} holes`;
}
