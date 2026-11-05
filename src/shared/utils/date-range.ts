/**
 * An inclusive range of UTC calendar days (`YYYY-MM-DD`), as typed into an
 * export form: parsing and validating the untrusted input, and turning a
 * valid range into exact instants.
 *
 * Days are UTC — the zone every time in the settings page, the billing page's
 * filters and the export files' "(UTC)" columns use — so "1 March" means the
 * same instants on the server, in the browser and in the file.
 *
 * Bounds are HALF-OPEN: a range covers `[start of from-day, start of the day
 * after to-day)`. An inclusive "end of day" such as `23:59:59.999` would drop
 * whatever happens in its last fraction of a second — account activity is
 * stored to the microsecond — while the start of the next day excludes
 * exactly the right instants at any precision.
 */

export type DateRange = {
  /** First day included, `YYYY-MM-DD` (UTC); `null` for no lower bound. */
  from: string | null;
  /** Last day included, `YYYY-MM-DD` (UTC); `null` for no upper bound. */
  to: string | null;
};

export const EMPTY_DATE_RANGE: DateRange = { from: null, to: null };

/** Query-string names of the two fields. */
export const DATE_RANGE_PARAMS = { from: "from", to: "to" } as const;

/** Years outside this range are certainly a typo, not a record of ours. */
export const DATE_RANGE_MIN_YEAR = 2000;
export const DATE_RANGE_MAX_YEAR = 2100;

export const DATE_RANGE_ERRORS = {
  date: "Enter a date as YYYY-MM-DD.",
  year: `Enter a year between ${DATE_RANGE_MIN_YEAR} and ${DATE_RANGE_MAX_YEAR}.`,
  day: "That day does not exist.",
  multiple: "Enter only one date.",
  range: "The start date must be on or before the end date.",
} as const;

export type DateRangeField = "from" | "to" | "range";

export type ParsedDateRange =
  | { ok: true; range: DateRange }
  | {
      ok: false;
      /** One message per offending field (`range`: the two are in the wrong order). */
      errors: Partial<Record<DateRangeField, string>>;
      /** What was received, trimmed, so a form can show it back (strings only). */
      input: { from: string; to: string };
    };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Why `value` is not a usable day, or `null` if it is one: exactly
 * `YYYY-MM-DD`, a day that exists (no 2026-02-30), within the sane years.
 */
function dayError(value: string): string | null {
  const match = DAY.exec(value);
  if (!match) return DATE_RANGE_ERRORS.date;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < DATE_RANGE_MIN_YEAR || year > DATE_RANGE_MAX_YEAR)
    return DATE_RANGE_ERRORS.year;

  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? null
    : DATE_RANGE_ERRORS.day;
}

/** Whether `value` is a `YYYY-MM-DD` day that exists, within the accepted years. */
export function isCalendarDay(value: unknown): value is string {
  return typeof value === "string" && dayError(value) === null;
}

/**
 * Parses the two query parameters, which are UNTRUSTED (typed into a form or
 * the URL). A missing or blank field is "no bound". Each field is validated on
 * its own, then their order; anything invalid yields `ok: false` with a
 * message per field, and the caller must not read any data. A field given
 * more than once (`?from=a&from=b`) is refused rather than guessed at.
 */
export function parseDateRange(
  params: Record<string, string | string[] | undefined> | undefined,
): ParsedDateRange {
  const errors: Partial<Record<DateRangeField, string>> = {};

  const field = (name: "from" | "to"): { text: string; value: string | null } => {
    const raw = params?.[DATE_RANGE_PARAMS[name]];
    const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) =>
      typeof v === "string" ? v.trim() : "",
    );
    const given = values.filter((v) => v !== "");

    if (given.length > 1) {
      errors[name] = DATE_RANGE_ERRORS.multiple;
      return { text: given[0], value: null };
    }

    const text = given[0] ?? "";
    if (text === "") return { text, value: null };

    const error = dayError(text);
    if (error) errors[name] = error;

    return { text, value: error ? null : text };
  };

  const from = field("from");
  const to = field("to");

  // ISO days compare correctly as strings.
  if (from.value && to.value && from.value > to.value) {
    errors.range = DATE_RANGE_ERRORS.range;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, input: { from: from.text, to: to.text } };
  }

  return { ok: true, range: { from: from.value, to: to.value } };
}

/**
 * Whether a value is a valid `DateRange` — for services that receive one from
 * a caller and must not query with anything else (a hand-built object, a
 * range whose ends are swapped).
 */
export function isValidDateRange(value: unknown): value is DateRange {
  if (value === null || typeof value !== "object") return false;

  const { from, to } = value as { from?: unknown; to?: unknown };

  if (!(from === null || isCalendarDay(from))) return false;
  if (!(to === null || isCalendarDay(to))) return false;

  return from === null || to === null || from <= to;
}

export function isEmptyDateRange(range: DateRange): boolean {
  return range.from === null && range.to === null;
}

/**
 * The instants a valid range covers, in milliseconds since the epoch:
 * `start` inclusive (midnight UTC of `from`), `end` EXCLUSIVE (midnight UTC of
 * the day after `to`). `null` for an open end.
 */
export function dateRangeBounds(range: DateRange): {
  start: number | null;
  end: number | null;
} {
  return {
    start: range.from === null ? null : Date.parse(`${range.from}T00:00:00.000Z`),
    end:
      range.to === null
        ? null
        : Date.parse(`${range.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000,
  };
}

/**
 * Whether an ISO 8601 timestamp (any offset, any sub-second precision) falls
 * within the range; `null` when it cannot be parsed, so the caller decides —
 * an unreadable time is neither in nor out.
 *
 * Exact at every precision: the bounds are whole milliseconds, and parsing
 * only ever drops digits below the millisecond, which cannot carry an instant
 * across a whole-millisecond bound.
 */
export function isInDateRange(timestamp: string, range: DateRange): boolean | null {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;

  const { start, end } = dateRangeBounds(range);

  return (start === null || time >= start) && (end === null || time < end);
}

/**
 * The range fields of a request's query string, in the shape
 * `parseDateRange` takes. A field given more than once stays a list, so it is
 * refused rather than silently reduced to its first value (which is what
 * `Object.fromEntries(searchParams)` would do — it keeps the last).
 */
export function dateRangeParamsFrom(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};

  for (const name of Object.values(DATE_RANGE_PARAMS)) {
    const values = searchParams.getAll(name);
    if (values.length === 1) params[name] = values[0];
    else if (values.length > 1) params[name] = values;
  }

  return params;
}
