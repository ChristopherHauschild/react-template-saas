/**
 * Filters of the invoice history: a status, a creation-date range and an
 * invoice-number search. Pure: parsing and validating what arrives in the
 * URL, matching an invoice against the filters, and the canonical text form
 * used in links and paging cursors. How the filters are applied — Stripe's own
 * `status`/`created` parameters plus matching while scanning — is
 * `getInvoiceHistory`.
 */
import {
  type InvoiceSummary,
  isListedInvoiceStatus,
  LISTED_INVOICE_STATUSES,
  type ListedInvoiceStatus,
} from "./invoice-history";

export type InvoiceFilters = {
  /** Only invoices in this Stripe status; `null` for any. */
  status: ListedInvoiceStatus | null;
  /** Earliest creation date, `YYYY-MM-DD` (a UTC calendar day, inclusive); `null` for none. */
  from: string | null;
  /** Latest creation date, `YYYY-MM-DD` (a UTC calendar day, inclusive); `null` for none. */
  to: string | null;
  /**
   * Invoice-number search, as typed (trimmed). Matched case-insensitively as
   * a substring of the number with separators ignored, so `0042`, `abcd0042`
   * and `ABCD-0042` all find `ABCD-0042`.
   */
  number: string | null;
};

export const EMPTY_INVOICE_FILTERS: InvoiceFilters = {
  status: null,
  from: null,
  to: null,
  number: null,
};

/** Query-string names, shared by the filter form, the page and the cursors. */
export const INVOICE_FILTER_PARAMS = {
  status: "status",
  from: "from",
  to: "to",
  number: "q",
} as const;

export type InvoiceFilterField = keyof typeof INVOICE_FILTER_PARAMS | "range";

export const INVOICE_NUMBER_MAX_LENGTH = 40;

/** Years outside this range are certainly a typo, not a Stripe invoice. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export const INVOICE_FILTER_ERRORS = {
  status: "Choose a status from the list.",
  date: "Enter a date as YYYY-MM-DD.",
  range: "The start date must be on or before the end date.",
  number: `Enter up to ${INVOICE_NUMBER_MAX_LENGTH} letters, digits or hyphens.`,
} as const;

export type ParsedInvoiceFilters =
  | {
      ok: true;
      filters: InvoiceFilters;
      /** Whether any filter is set; an empty form lists everything. */
      active: boolean;
    }
  | {
      ok: false;
      /** One message per offending field, for the form. */
      errors: Partial<Record<InvoiceFilterField, string>>;
      /** What was typed, trimmed, so the form can show it back (strings only). */
      input: Record<keyof typeof INVOICE_FILTER_PARAMS, string>;
    };

/**
 * Parses the filter query parameters, which are UNTRUSTED (typed into the
 * form, or into the URL). Every field is validated independently; an empty
 * field means "no filter". Anything invalid yields `ok: false` with a message
 * per field and nothing is sent to Stripe.
 */
export function parseInvoiceFilters(
  params: Record<string, string | string[] | undefined> | undefined,
): ParsedInvoiceFilters {
  const raw = (name: string) => {
    const value = params?.[name];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first.trim() : "";
  };

  const input = {
    status: raw(INVOICE_FILTER_PARAMS.status),
    from: raw(INVOICE_FILTER_PARAMS.from),
    to: raw(INVOICE_FILTER_PARAMS.to),
    number: raw(INVOICE_FILTER_PARAMS.number),
  };

  const errors: Partial<Record<InvoiceFilterField, string>> = {};

  let status: ListedInvoiceStatus | null = null;
  if (input.status !== "") {
    if (isListedInvoiceStatus(input.status)) status = input.status;
    else errors.status = INVOICE_FILTER_ERRORS.status;
  }

  const from =
    input.from === "" ? null : isCalendarDate(input.from) ? input.from : undefined;
  if (from === undefined) errors.from = INVOICE_FILTER_ERRORS.date;

  const to = input.to === "" ? null : isCalendarDate(input.to) ? input.to : undefined;
  if (to === undefined) errors.to = INVOICE_FILTER_ERRORS.date;

  // ISO dates compare correctly as strings.
  if (from && to && from > to) errors.range = INVOICE_FILTER_ERRORS.range;

  let number: string | null = null;
  if (input.number !== "") {
    if (isSearchableNumber(input.number)) number = input.number;
    else errors.number = INVOICE_FILTER_ERRORS.number;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, input };

  const filters: InvoiceFilters = {
    status,
    from: from ?? null,
    to: to ?? null,
    number,
  };

  return { ok: true, filters, active: !isEmptyInvoiceFilters(filters) };
}

export function isEmptyInvoiceFilters(filters: InvoiceFilters): boolean {
  return (
    filters.status === null &&
    filters.from === null &&
    filters.to === null &&
    filters.number === null
  );
}

/** `YYYY-MM-DD` naming a real day (no 2026-02-30) within a sane range of years. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Letters, digits, hyphens and inner spaces, with at least one letter or digit. */
function isSearchableNumber(value: string): boolean {
  return (
    value.length <= INVOICE_NUMBER_MAX_LENGTH &&
    /^[A-Za-z0-9 -]+$/.test(value) &&
    normalizeInvoiceNumber(value).length > 0
  );
}

/** Upper-case letters and digits only: how numbers are compared. */
export function normalizeInvoiceNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The `created` range to send to Stripe, in Unix seconds: the start of the
 * `from` day to the end of the `to` day, UTC.
 */
export function invoiceCreatedRange(
  filters: InvoiceFilters,
): { gte?: number; lte?: number } | null {
  if (filters.from === null && filters.to === null) return null;

  const range: { gte?: number; lte?: number } = {};

  if (filters.from !== null)
    range.gte = Date.parse(`${filters.from}T00:00:00.000Z`) / 1000;
  if (filters.to !== null) range.lte = Date.parse(`${filters.to}T23:59:59.999Z`) / 1000;

  return range;
}

/**
 * Whether an invoice satisfies the filters. Stripe already applies status and
 * dates server-side; checking them here as well costs nothing and means a
 * page can never show a row its filters exclude, whatever Stripe returned.
 * The number search only exists here.
 */
export function matchesInvoiceFilters(
  invoice: InvoiceSummary,
  filters: InvoiceFilters,
): boolean {
  if (filters.status !== null && invoice.status !== filters.status) return false;

  if (filters.from !== null && invoice.createdAt < `${filters.from}T00:00:00.000Z`)
    return false;
  if (filters.to !== null && invoice.createdAt > `${filters.to}T23:59:59.999Z`)
    return false;

  if (filters.number !== null) {
    const wanted = normalizeInvoiceNumber(filters.number);
    if (!normalizeInvoiceNumber(invoice.number ?? "").includes(wanted)) return false;
  }

  return true;
}

/**
 * Canonical query string of the filters (`status=paid&from=…`), with empty
 * fields left out and fields in a fixed order. Used for links, for keying the
 * list so a filter change resets it, and inside paging cursors.
 */
export function invoiceFiltersToQuery(filters: InvoiceFilters): string {
  const params = new URLSearchParams();

  if (filters.status !== null) params.set(INVOICE_FILTER_PARAMS.status, filters.status);
  if (filters.from !== null) params.set(INVOICE_FILTER_PARAMS.from, filters.from);
  if (filters.to !== null) params.set(INVOICE_FILTER_PARAMS.to, filters.to);
  if (filters.number !== null) params.set(INVOICE_FILTER_PARAMS.number, filters.number);

  return params.toString();
}

/** Inverse of `invoiceFiltersToQuery`; `null` if the text does not parse as valid filters. */
export function invoiceFiltersFromQuery(query: string): InvoiceFilters | null {
  const params = Object.fromEntries(new URLSearchParams(query));
  const parsed = parseInvoiceFilters(params);

  return parsed.ok ? parsed.filters : null;
}

/** Labels for the status select. */
export const INVOICE_STATUS_FILTER_OPTIONS: {
  value: "" | ListedInvoiceStatus;
  label: string;
}[] = [
  { value: "", label: "All statuses" },
  ...LISTED_INVOICE_STATUSES.map((status) => ({
    value: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
  })),
];
