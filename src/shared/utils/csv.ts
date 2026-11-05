import type { DateRange } from "./date-range";

/**
 * CSV serialisation for user-facing downloads (account activity, invoices).
 *
 * Output follows RFC 4180: fields separated by commas, records terminated by
 * CRLF (the last one included), and a field wrapped in double quotes — with
 * inner quotes doubled — whenever it contains a comma, a quote, CR or LF.
 * Anything else is written as is, so the text of every cell round-trips
 * through a conforming parser exactly.
 *
 * Exports are opened in spreadsheets, and a spreadsheet treats a cell that
 * starts with `=`, `+`, `-` or `@` (and a few others) as a FORMULA — which can
 * run commands or send the sheet's contents elsewhere ("CSV injection").
 * Several of our cells hold text a user chose (a display name, an email
 * address), so every text cell that could be read as a formula is prefixed
 * with a single quote, which spreadsheets take as "this is text"
 * (`neutralizeCsvFormula`). Numbers the application computed itself are
 * passed as `csvNumeral(...)` instead: they are checked to be plain numerals
 * — which no spreadsheet reads as a formula — and written untouched, so a
 * negative amount stays `-5.00` rather than becoming `'-5.00`.
 */

/** A plain decimal numeral produced by the application, written without neutralisation. */
export type CsvNumeral = { readonly numeral: string };

/** One field: text (neutralised), a numeral (verbatim), or empty. */
export type CsvCell = string | CsvNumeral | null;

/**
 * Byte-order mark for UTF-8. Excel only reads a CSV file as UTF-8 when it
 * starts with one; without it, any non-ASCII text (accented names, the
 * typographic quotes the activity copy uses) is shown garbled.
 */
export const CSV_UTF8_BOM = "\uFEFF";

/** Media type for the download response. */
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

const RECORD_SEPARATOR = "\r\n";

/** Optional sign, digits, optional fraction. No exponent, no spaces, no grouping. */
const PLAIN_NUMERAL = /^-?\d+(\.\d+)?$/;

/**
 * Leading characters that make a spreadsheet (Excel, LibreOffice, Google
 * Sheets) evaluate a cell as a formula or command: the four formula
 * prefixes, TAB and CR (OWASP's list), and the full-width forms of the four,
 * which some East Asian Excel locales treat the same way.
 */
const FORMULA_TRIGGERS = new Set([
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
  "\uFF1D", // ＝
  "\uFF0B", // ＋
  "\uFF0D", // －
  "\uFF20", // ＠
]);

/** Characters that force a field to be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * Marks application-computed numeric text (an amount, a count) to be written
 * verbatim. Throws unless `text` is a plain decimal numeral: anything else —
 * an exponent, a formula, an empty string — is a programming error, and
 * letting it through would bypass formula neutralisation.
 */
export function csvNumeral(text: string): CsvNumeral {
  if (!PLAIN_NUMERAL.test(text)) {
    throw new Error("csvNumeral: not a plain decimal numeral");
  }

  return { numeral: text };
}

/**
 * Prefixes text a spreadsheet would evaluate as a formula with `'`, so it is
 * shown as the text it is. Other text is returned unchanged.
 *
 * Leading whitespace does not make a formula safe: importers can trim it
 * (LibreOffice's "Trim spaces" option, for one), leaving `=…` at the start.
 * So the first NON-whitespace character decides (`trimStart` covers spaces,
 * tabs, line breaks, NBSP, ideographic space and the BOM).
 */
export function neutralizeCsvFormula(text: string): string {
  const first = text.trimStart()[0];
  // TAB and CR are triggers themselves, and whitespace; check the raw start too.
  const triggered =
    text.length > 0 &&
    (FORMULA_TRIGGERS.has(text[0]) ||
      (first !== undefined && FORMULA_TRIGGERS.has(first)));

  return triggered ? `'${text}` : text;
}

/** Quotes a field when RFC 4180 requires it; leaves it alone otherwise. */
export function quoteCsvField(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One cell as it appears in the file. */
export function formatCsvCell(cell: CsvCell): string {
  if (cell === null) return "";
  if (typeof cell === "string") return quoteCsvField(neutralizeCsvFormula(cell));

  // Re-checked: a `{ numeral }` built by hand must not bypass neutralisation.
  return csvNumeral(cell.numeral).numeral;
}

/**
 * Serialises a header and its rows into CSV text (without a BOM; see
 * `CSV_UTF8_BOM`). The header is always written, so an empty export is a
 * file with column names and no rows — never an empty file. Every row must
 * have exactly as many cells as the header: a short or long row would shift
 * values into the wrong columns, so it throws instead.
 */
export function formatCsv(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  if (header.length === 0) throw new Error("formatCsv: a CSV needs at least one column");

  const lines = [header.map(formatCsvCell).join(",")];

  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new Error(
        `formatCsv: row ${index} has ${row.length} cells; the header has ${header.length}`,
      );
    }

    lines.push(row.map(formatCsvCell).join(","));
  }

  return lines.join(RECORD_SEPARATOR) + RECORD_SEPARATOR;
}

/**
 * File name for a download: `<base>-YYYY-MM-DD.csv`, dated in UTC like every
 * time in the exports. `base` is a fixed identifier chosen by the caller
 * (lowercase letters, digits, hyphens) — never user data, which has no place
 * in a `Content-Disposition` header.
 */
export function csvFileName(base: string, now: Date): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(base)) {
    throw new Error("csvFileName: base must be lowercase letters, digits and hyphens");
  }
  if (Number.isNaN(now.getTime())) throw new Error("csvFileName: invalid date");

  return `${base}-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * File name for an export over a date range, so downloads of different
 * periods do not collide: `<base>-2026-03-01-to-2026-03-31.csv`,
 * `<base>-from-2026-03-01.csv`, `<base>-to-2026-03-31.csv`; without a range,
 * `csvFileName(base, now)`. The range must be valid (its days are written
 * verbatim; `YYYY-MM-DD` is safe in a header).
 */
export function csvFileNameForRange(base: string, range: DateRange, now: Date): string {
  const day = /^\d{4}-\d{2}-\d{2}$/;

  if (
    (range.from !== null && !day.test(range.from)) ||
    (range.to !== null && !day.test(range.to))
  ) {
    throw new Error("csvFileNameForRange: the range's days must be YYYY-MM-DD");
  }

  if (range.from === null && range.to === null) return csvFileName(base, now);

  // Validates the base; the date part is replaced below.
  csvFileName(base, now);

  const period =
    range.from !== null && range.to !== null
      ? `${range.from}-to-${range.to}`
      : range.from !== null
        ? `from-${range.from}`
        : `to-${range.to}`;

  return `${base}-${period}.csv`;
}
