import "server-only";

import {
  consumeRateLimit,
  type RateLimitPolicy,
} from "@/infrastructure/rate-limit/consume-rate-limit";
import { getStripe } from "@/infrastructure/stripe";
import {
  type DateRange,
  dateRangeBounds,
  isInDateRange,
  isValidDateRange,
} from "@/shared/utils/date-range";

import {
  describeInvoiceListFailure,
  invoiceDocumentHosts,
  type InvoiceHistory,
  resolveInvoiceCustomer,
  UnusableInvoiceListAnswer,
} from "./get-invoice-history";
import type { SubscriptionOverview } from "./get-subscription-overview";
import { type InvoiceSummary, readInvoiceList } from "./invoice-history";

const LOG_PREFIX = "[billing]";

/** Objects per Stripe request while exporting: Stripe's maximum. */
export const INVOICE_EXPORT_BATCH_SIZE = 100;

/**
 * Most Stripe requests one export may make: up to
 * `INVOICE_EXPORT_BATCH_SIZE * INVOICE_EXPORT_MAX_FETCHES` objects, drafts
 * included. A longer list is refused as a whole (`too_large`) rather than cut
 * short: a truncated file would look complete.
 */
export const INVOICE_EXPORT_MAX_FETCHES = 100;

/**
 * How often one user may export invoices: five exports at once, then one
 * more every minute. Each export can make up to `INVOICE_EXPORT_MAX_FETCHES`
 * Stripe requests, so this bounds what one user — or a script with their
 * session, or a stuck retry loop — can ask of Stripe. Only exports that are
 * about to call Stripe count (see `collectInvoicesForExport`).
 */
export const INVOICE_EXPORT_RATE_LIMIT: RateLimitPolicy = {
  bucket: "export.invoices",
  burst: 5,
  intervalSeconds: 60,
};

export type InvoiceExportUnavailableReason =
  | Extract<InvoiceHistory, { kind: "unavailable" }>["reason"]
  /** Stripe's paging contradicted itself: an object came back twice, or an empty batch claimed more. */
  | "inconsistent_paging"
  /** The list is longer than the export's request budget allows. */
  | "too_large"
  /** The user's export allowance could not be checked; Stripe is not asked unchecked. */
  | "rate_limit_unavailable";

export type InvoiceExportCollection =
  /** Every issued invoice of the user's customer (in the range, if one is given), newest first; drafts excluded, as on the page. */
  | { kind: "ok"; invoices: InvoiceSummary[] }
  /** The date range given is not a valid one; nothing was read. */
  | { kind: "invalid_range" }
  /** The user has used up their export allowance; Stripe was not asked. Try again after this many seconds. */
  | { kind: "rate_limited"; retryAfterSeconds: number }
  /** No billing account: there are no invoices to export. */
  | { kind: "none" }
  /** The records point at several customers (or one we cannot identify): nothing is exported. */
  | { kind: "ambiguous" }
  | { kind: "unavailable"; reason: InvoiceExportUnavailableReason };

export type CollectInvoiceExportOptions = {
  /**
   * Only invoices created within these UTC days (both inclusive). Must be
   * valid (`parseDateRange` / `isValidDateRange`); anything else is refused as
   * `invalid_range` before the records or Stripe are consulted. Omitted:
   * everything.
   */
  range?: DateRange;
  /** The user's records, when the caller already read them; read here otherwise. */
  overview?: SubscriptionOverview;
  /** Overrides `INVOICE_EXPORT_MAX_FETCHES` (tests). */
  maxFetches?: number;
};

/**
 * Reads EVERY issued invoice of the signed-in user's billing account, for the
 * export.
 *
 * Whose invoices: the customer `resolveInvoiceCustomer` decides from the
 * user's OWN subscription rows (under RLS) — the rule the billing page, "load
 * more", the document links and the Customer Portal all use. It is resolved
 * ONCE, and the whole scan asks Stripe about that one customer only, so the
 * file can never mix accounts even if the records change mid-export. Every
 * batch must consist solely of that customer's invoices (`readInvoiceList`
 * refuses the whole answer otherwise). Nothing comes from the client.
 *
 * What: Stripe's list is walked from the newest object to the end, in
 * batches of Stripe's maximum size, each batch starting after the last object
 * of the one before. Drafts are skipped (as on the page and in the Portal) but
 * still advance the scan, so a batch holding only drafts — zero invoices, with
 * more to come — simply continues.
 *
 * With a `range`, Stripe applies it (`created` from midnight UTC of the first
 * day through the last second before midnight after the last — `created` is
 * in whole seconds, so that is exactly the half-open range), so only invoices
 * inside it are paged through, and a range that matches nothing is an empty,
 * successful export. Each invoice is checked against the range again on the
 * way out: one outside it (which Stripe should never return) is left out and
 * counted, but never ends the scan. Every failure rule below holds unchanged
 * with a range. The page's other filters (status, number) do not apply.
 *
 * Rate limited: once the customer is known — so only an export that would
 * really call Stripe counts — one request is taken from the user's
 * allowance (`INVOICE_EXPORT_RATE_LIMIT`, kept in the database and shared by
 * every server instance). Over it, the answer is `rate_limited` with the wait,
 * and Stripe is not asked at all; if the allowance cannot be checked, the
 * export is refused (`rate_limit_unavailable`) rather than sent to Stripe
 * unchecked. An invalid range, no billing account or an ambiguous one never
 * count: they are answered before the allowance is consulted.
 *
 * All or nothing: a failed request, a refused answer, paging that contradicts
 * itself (an object seen twice; an empty batch that claims more), or a list
 * longer than the budget, and the result is `unavailable` with no invoices.
 * A partial history must never become a file.
 *
 * Never throws; failures are logged with reasons and counts, never ids.
 */
export async function collectInvoicesForExport(
  userId: string,
  options: CollectInvoiceExportOptions = {},
): Promise<InvoiceExportCollection> {
  const range = options.range;

  // Before anything is read: a malformed range must not reach Stripe.
  if (range !== undefined && !isValidDateRange(range)) {
    console.error(`${LOG_PREFIX} invoice export refused`, {
      userId,
      reason: "invalid_range",
    });
    return { kind: "invalid_range" };
  }

  const resolved = await resolveInvoiceCustomer(userId, options.overview);

  if (!resolved.ok) return resolved.history;

  const { customer } = resolved;

  const allowance = await consumeRateLimit(userId, INVOICE_EXPORT_RATE_LIMIT);

  if (allowance.outcome === "limited") {
    console.warn(`${LOG_PREFIX} invoice export rate limited`, {
      userId,
      retryAfterSeconds: allowance.retryAfterSeconds,
    });
    return { kind: "rate_limited", retryAfterSeconds: allowance.retryAfterSeconds };
  }

  if (allowance.outcome === "unavailable") {
    // Logged by the limiter. Fail closed: the limit exists to protect Stripe.
    return { kind: "unavailable", reason: "rate_limit_unavailable" };
  }

  const maxFetches = options.maxFetches ?? INVOICE_EXPORT_MAX_FETCHES;
  const documentHosts = invoiceDocumentHosts();

  const invoices: InvoiceSummary[] = [];
  /** Every object id seen: issued invoices, and the last object of each batch (a draft or not). */
  const seen = new Set<string>();
  let cursor: string | null = null;
  let outOfRange = 0;
  const created = range === undefined ? null : stripeCreatedRange(range);

  const refuse = (
    reason: "inconsistent_paging" | "too_large",
    fetch: number,
  ): InvoiceExportCollection => {
    console.error(`${LOG_PREFIX} invoice export refused`, { userId, reason, fetch });
    return { kind: "unavailable", reason };
  };

  try {
    for (let fetch = 1; ; fetch++) {
      if (fetch > maxFetches) return refuse("too_large", fetch - 1);

      const answer: unknown = await getStripe().invoices.list({
        customer,
        limit: INVOICE_EXPORT_BATCH_SIZE,
        ...(cursor !== null && { starting_after: cursor }),
        ...(created !== null && { created }),
      });

      const reading = readInvoiceList(answer, customer, { documentHosts });

      if (!reading.ok) throw new UnusableInvoiceListAnswer(reading.reason, fetch);

      if (reading.received === 0 || reading.lastId === null) {
        // The end — unless Stripe says otherwise, and then we cannot know what
        // is missing (the UI's list may take this as the end; the export may not).
        if (reading.hasMore) return refuse("inconsistent_paging", fetch);
        break;
      }

      for (const id of reading.ids) {
        if (seen.has(id)) return refuse("inconsistent_paging", fetch);
        seen.add(id);
      }

      // The batch's last object: an issued invoice (just added) or a draft.
      if (!reading.ids.includes(reading.lastId)) {
        if (seen.has(reading.lastId)) return refuse("inconsistent_paging", fetch);
        seen.add(reading.lastId);
      }

      for (const invoice of reading.invoices) {
        if (range !== undefined) {
          const inside = isInDateRange(invoice.createdAt, range);

          // Cannot be placed in or out of the range (readInvoiceList builds
          // `createdAt` from validated seconds, so this is never expected).
          if (inside === null) {
            throw new UnusableInvoiceListAnswer("unreadable_created", fetch);
          }
          if (!inside) {
            // Still counted as seen (duplicates, progress, budget), just not exported.
            outOfRange += 1;
            continue;
          }
        }
        invoices.push(invoice);
      }

      if (!reading.hasMore) break;
      cursor = reading.lastId;
    }
  } catch (error) {
    return describeInvoiceListFailure(userId, error);
  }

  if (outOfRange > 0) {
    // Stripe should have excluded these; the export did, but say so.
    console.warn(`${LOG_PREFIX} invoice export left out invoices outside the range`, {
      userId,
      outOfRange,
    });
  }

  return { kind: "ok", invoices };
}

/**
 * The `created` filter for Stripe, in whole Unix seconds (Stripe's type for
 * it): `gte` midnight UTC of `from`, `lte` the last second before midnight
 * after `to`. `null` when the range is open at both ends.
 */
export function stripeCreatedRange(
  range: DateRange,
): { gte?: number; lte?: number } | null {
  const { start, end } = dateRangeBounds(range);

  if (start === null && end === null) return null;

  return {
    ...(start !== null && { gte: start / 1000 }),
    ...(end !== null && { lte: end / 1000 - 1 }),
  };
}
