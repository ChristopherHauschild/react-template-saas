/**
 * Paging cursors of the invoice history. A cursor names where the next page
 * starts — the last Stripe object the previous page examined — AND the filters
 * that page was listed with, so that "load more" can only ever continue the
 * same listing: the client sends the cursor alone, and a page cannot be
 * continued with other filters than it started with (which would skip or
 * repeat matches).
 *
 * Like invoice keys, cursors are opaque but not secret: the server decodes
 * them strictly (`decodeInvoiceCursor`) and only uses them inside the list of
 * the customer resolved from the user's own records.
 */
import {
  EMPTY_INVOICE_FILTERS,
  type InvoiceFilters,
  invoiceFiltersFromQuery,
  invoiceFiltersToQuery,
} from "./invoice-filters";
import { decodeToken, encodeToken, isStripeInvoiceId } from "./invoice-history";

export type InvoiceCursor = {
  /** Stripe id of the last object examined; the next page starts after it. */
  afterId: string;
  /** The filters of the listing being continued. */
  filters: InvoiceFilters;
};

/** Longest token accepted: an id plus the longest valid filter query, with slack. */
export const INVOICE_CURSOR_MAX_LENGTH = 512;

export function encodeInvoiceCursor(cursor: InvoiceCursor): string {
  return encodeToken(
    JSON.stringify({ a: cursor.afterId, f: invoiceFiltersToQuery(cursor.filters) }),
  );
}

/**
 * Inverse of `encodeInvoiceCursor`; `null` for anything that is not a token
 * for a well-formed invoice id and a valid, canonical filter query.
 */
export function decodeInvoiceCursor(token: unknown): InvoiceCursor | null {
  const text = decodeToken(token, INVOICE_CURSOR_MAX_LENGTH);
  if (text === null) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;

  const { a, f } = parsed as { a?: unknown; f?: unknown };

  if (!isStripeInvoiceId(a) || typeof f !== "string") return null;

  const filters = f === "" ? EMPTY_INVOICE_FILTERS : invoiceFiltersFromQuery(f);

  // Canonical form only: the token must be exactly what this code would emit.
  if (filters === null || invoiceFiltersToQuery(filters) !== f) return null;

  const cursor = { afterId: a, filters };

  return encodeInvoiceCursor(cursor) === token ? cursor : null;
}
