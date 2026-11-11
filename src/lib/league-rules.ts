export type ParsedPoints = { ok: true; value: number[] } | { ok: false; reason: string };

/**
 * "10, 8, 6" into a points table, or why not. The same limits as
 * owner_set_league_rules, so the form can say what's wrong before saving.
 */
export function parsePointsTable(input: string): ParsedPoints {
  const parts = input.split(/[\s,]+/).filter(Boolean);

  if (parts.length === 0) {
    return { ok: false, reason: "Give at least first place some points." };
  }
  if (parts.length > 12) {
    return { ok: false, reason: "Points go to 12 places at most." };
  }

  const value = parts.map(Number);

  if (value.some((n) => !Number.isInteger(n) || n < 0 || n > 100)) {
    return { ok: false, reason: "Points are whole numbers from 0 to 100." };
  }
  if (value.some((n, i) => i > 0 && n > value[i - 1])) {
    return { ok: false, reason: "Points can't go up further down the table." };
  }

  return { ok: true, value };
}
