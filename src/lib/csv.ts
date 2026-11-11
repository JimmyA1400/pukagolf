export type Cell = string | number | boolean | null | undefined;

/**
 * Rows to CSV: quoted where needed (RFC 4180), CRLF line ends for Excel.
 *
 * A text cell that starts like a formula (=, +, -, @) gets a leading
 * apostrophe, so a player named "=HYPERLINK(…)" stays a name when the file is
 * opened in a spreadsheet instead of running. Numbers are left alone, which
 * is why to-par figures are passed as numbers, not "-2".
 */
export function toCsv(rows: readonly (readonly Cell[])[]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
