import "server-only";

import { getStripe } from "@/infrastructure/stripe";

import {
  getSubscriptionOverview,
  type SubscriptionOverview,
} from "./get-subscription-overview";
import { encodeInvoiceCursor } from "./invoice-cursor";
import {
  EMPTY_INVOICE_FILTERS,
  invoiceCreatedRange,
  type InvoiceFilters,
  matchesInvoiceFilters,
} from "./invoice-filters";
import {
  INVOICE_FETCH_BATCH_SIZE,
  INVOICE_HISTORY_PAGE_SIZE,
  INVOICE_MAX_FETCHES_PER_PAGE,
  INVOICE_SEARCH_BATCH_SIZE,
  INVOICE_SEARCH_MAX_FETCHES_PER_PAGE,
  type InvoicePage,
  type InvoiceSummary,
  isStripeInvoiceId,
  readInvoiceList,
} from "./invoice-history";
import {
  isMissingCustomerError,
  isStripeCustomerId,
  summarizePortalErrorForLog,
} from "./portal-errors";

const LOG_PREFIX = "[billing]";

/**
 * Extra hosts an invoice document URL may point at, from
 * `STRIPE_INVOICE_DOCUMENT_HOSTS` (comma-separated): a custom invoice domain
 * configured in Stripe, or a Stripe stand-in in development. Stripe's own hosts
 * are always accepted; see `isInvoiceDocumentUrl`.
 */
export function invoiceDocumentHosts(): string[] {
  return (process.env.STRIPE_INVOICE_DOCUMENT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/**
 * One page of the user's invoices, or why it cannot be listed. Four shapes the
 * page must never confuse with each other:
 * - `ok`: a page of the invoices Stripe holds for the user's customer (possibly
 *   empty) and, when Stripe has more, the cursor of the next page;
 * - `none`: the user has no billing account, so there is nothing to list;
 * - `ambiguous`: the records point at several customers or at one we cannot
 *   identify — listing any of them would be a guess, so none is listed;
 * - `unavailable`: something failed. The page must say so, never "no invoices".
 */
export type InvoiceHistory =
  | ({ kind: "ok" } & InvoicePage)
  | { kind: "none" }
  | { kind: "ambiguous" }
  | {
      kind: "unavailable";
      /** For logs, tests and the one failure the UI treats differently (`cursor_invalid`). */
      reason: /** Our own records could not be read, so the customer is unknown. */
        | "records_unreadable"
        /** The stored customer id is not a Stripe customer id; never sent. */
        | "invalid_customer_id"
        /** Stripe does not know the customer (deleted, or a test/live mismatch). */
        | "customer_missing"
        /**
         * Stripe does not know the invoice the cursor points at (a draft that
         * was deleted after the page was served). Not transient: the list must
         * be restarted from the top.
         */
        | "cursor_invalid"
        /** Stripe could not be asked (outage, rate limit, bad key, …). */
        | "stripe_error"
        /** Stripe answered with something other than this customer's invoices. */
        | "unusable_response";
    };

export type InvoiceHistoryOptions = {
  /**
   * The user's records, when the caller already read them (the billing page,
   * which shows the subscription from the same read), so both cards agree on
   * the same rows. Without it, the rows are read here.
   */
  overview?: SubscriptionOverview;
  /**
   * Stripe invoice id after which the page starts — from a decoded cursor (see
   * `decodeInvoiceCursor`); the caller is responsible for decoding and
   * validating what the client sent. Omitted for the first page.
   */
  startingAfter?: string;
  /**
   * Validated filters (`parseInvoiceFilters`, or the ones a cursor carries).
   * Status and dates are sent to Stripe; the number search happens while
   * scanning. Omitted: everything is listed.
   */
  filters?: InvoiceFilters;
  /**
   * How many issued invoices the page holds, `1` to `INVOICE_HISTORY_PAGE_SIZE`
   * (the default). The dashboard asks for `1`: the newest issued invoice, found
   * by the same scan (drafts skipped, same budget) as the first row of the
   * billing page's list.
   */
  pageSize?: number;
};

/**
 * Lists one page of the signed-in user's invoices from Stripe.
 *
 * Which customer to ask about is decided by exactly the rule the Customer
 * Portal uses — `SubscriptionOverview.customerResolution`, built from the
 * user's OWN subscription rows read under RLS — so the invoices shown are
 * always those of the account the portal would open, and nothing is listed
 * whenever the portal would refuse to open. No second notion of "the user's
 * customer" exists here, and a cursor from the client can only move within
 * that customer's list.
 *
 * A page holds `INVOICE_HISTORY_PAGE_SIZE` ISSUED invoices that satisfy the
 * filters. Stripe's list cannot exclude drafts and cannot search by number,
 * so the page is filled by scanning forward in batches (`fillPage`) until
 * enough matching invoices are in hand or the list ends — never by taking the
 * first N objects and dropping the rest, which would hide older invoices and
 * could report an empty history that is not empty. Status and date filters
 * are also given to Stripe, so those scans only ever see candidates.
 *
 * Every step fails closed and nothing is thrown: the invoice list is one card
 * on a page whose other card does not depend on Stripe, so a Stripe failure is
 * returned as `unavailable` (and logged — ids never, only the error's stable
 * fields) rather than taking the whole page down. Stripe's answers are used
 * only if they are lists of invoices for the very customer we asked about.
 */
export async function getInvoiceHistory(
  userId: string,
  options: InvoiceHistoryOptions = {},
): Promise<InvoiceHistory> {
  const resolved = await resolveInvoiceCustomer(userId, options.overview);

  if (!resolved.ok) return resolved.history;

  const { customer } = resolved;

  if (options.startingAfter !== undefined && !isStripeInvoiceId(options.startingAfter)) {
    // The caller must decode and validate cursors; refuse rather than forward.
    console.error(`${LOG_PREFIX} refusing a paging cursor that is not an invoice id`, {
      userId,
    });

    return { kind: "unavailable", reason: "cursor_invalid" };
  }

  const filters = options.filters ?? EMPTY_INVOICE_FILTERS;
  const pageSize = clampPageSize(options.pageSize);
  let page: InvoicePage & { rejectedDocumentUrls: number };

  try {
    page = await fillPage(customer, options.startingAfter ?? null, filters, pageSize);
  } catch (error) {
    return describeInvoiceListFailure(userId, error);
  }

  if (page.rejectedDocumentUrls > 0) {
    // Stripe named a document at a URL this application will not follow: the
    // rows show "not available" for it. Worth noticing (a custom invoice domain
    // missing from STRIPE_INVOICE_DOCUMENT_HOSTS?), but not a failure.
    console.warn(`${LOG_PREFIX} some invoice document URLs were not usable`, {
      userId,
      rejected: page.rejectedDocumentUrls,
    });
  }

  return {
    kind: "ok",
    invoices: page.invoices,
    nextCursor: page.nextCursor,
    examined: page.examined,
  };
}

/** The one Stripe customer whose invoices the user may see, or the history to return instead. */
export type ResolvedInvoiceCustomer =
  | { ok: true; customer: string }
  | { ok: false; history: Exclude<InvoiceHistory, { kind: "ok" }> };

/**
 * Decides whose invoices may be listed for the user: the customer of
 * `SubscriptionOverview.customerResolution`, built from the user's OWN
 * subscription rows read under RLS — the rule the Customer Portal uses. Every
 * reader of the invoice list (the page, "load more", the export) goes through
 * here, so there is one notion of "the user's customer". `none` and
 * `ambiguous` are returned as such; unreadable records or a stored id that is
 * not a Stripe customer id are `unavailable`. Logs refusals (counts, never ids).
 */
export async function resolveInvoiceCustomer(
  userId: string,
  overview?: SubscriptionOverview,
): Promise<ResolvedInvoiceCustomer> {
  const records = overview ?? (await getSubscriptionOverview(userId));

  if (!records.ok) {
    // Already logged by the overview. We do not know which customer to ask about.
    return { ok: false, history: { kind: "unavailable", reason: "records_unreadable" } };
  }

  const { customerResolution } = records;

  if (customerResolution.kind === "none") {
    return { ok: false, history: { kind: "none" } };
  }

  if (customerResolution.kind === "ambiguous") {
    // Same refusal as the portal, for the same reason: listing one of several
    // accounts' invoices would misreport the user's history. Counts only.
    console.error(`${LOG_PREFIX} customer is ambiguous; invoices not listed`, {
      userId,
      reason: customerResolution.reason,
      customers: customerResolution.customers,
      subscriptions: records.subscriptions.length,
    });

    return { ok: false, history: { kind: "ambiguous" } };
  }

  const customer = customerResolution.stripeCustomerId;

  if (!isStripeCustomerId(customer)) {
    console.error(`${LOG_PREFIX} stored customer id is not a Stripe customer id`, {
      userId,
    });

    return { ok: false, history: { kind: "unavailable", reason: "invalid_customer_id" } };
  }

  return { ok: true, customer };
}

/**
 * Thrown by a scan of the customer's invoice list when an answer is refused;
 * carries the reading's reason and the request's number for the log.
 */
export class UnusableInvoiceListAnswer extends Error {
  constructor(
    public readonly reason: string,
    public readonly fetch: number,
  ) {
    super(`unusable invoice list: ${reason}`);
  }
}

/**
 * What a failed scan of the invoice list means for the user, logged with the
 * error's stable fields only: a refused answer, a customer Stripe does not
 * know, a cursor Stripe does not know (the list must restart), or any other
 * failure to ask Stripe.
 */
export function describeInvoiceListFailure(
  userId: string,
  error: unknown,
): Extract<InvoiceHistory, { kind: "unavailable" }> {
  if (error instanceof UnusableInvoiceListAnswer) {
    console.error(`${LOG_PREFIX} Stripe returned an unusable invoice list`, {
      userId,
      reason: error.reason,
      fetch: error.fetch,
    });

    return { kind: "unavailable", reason: "unusable_response" };
  }

  if (isMissingCustomerError(error)) {
    console.error(`${LOG_PREFIX} Stripe does not know the user's customer`, {
      userId,
      error: summarizePortalErrorForLog(error),
    });

    return { kind: "unavailable", reason: "customer_missing" };
  }

  if (isMissingCursorError(error)) {
    console.error(`${LOG_PREFIX} Stripe does not know the invoice a cursor points at`, {
      userId,
      error: summarizePortalErrorForLog(error),
    });

    return { kind: "unavailable", reason: "cursor_invalid" };
  }

  console.error(`${LOG_PREFIX} could not list the user's invoices`, {
    userId,
    error: summarizePortalErrorForLog(error),
  });

  return { kind: "unavailable", reason: "stripe_error" };
}

/** A page size outside `1..INVOICE_HISTORY_PAGE_SIZE` (or not a whole number) is the default. */
export function clampPageSize(pageSize: number | undefined): number {
  return typeof pageSize === "number" &&
    Number.isInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= INVOICE_HISTORY_PAGE_SIZE
    ? pageSize
    : INVOICE_HISTORY_PAGE_SIZE;
}

/**
 * Scans the customer's invoice list forward from `startingAfter` (or the top)
 * and collects `pageSize` issued invoices matching `filters`.
 *
 * The cursor of the next page is the last object EXAMINED — the invoice that
 * filled the page, or the last object of the last batch when the list ran
 * out — together with the filters, so the next page neither re-reads nor
 * skips anything: drafts and non-matching invoices included. `nextCursor` is
 * `null` only when Stripe reported nothing beyond the last examined object.
 * (It may therefore be non-null when nothing further matches; the next page
 * then comes back empty with `nextCursor: null`, which the UI shows as the
 * end of the list.)
 *
 * Stops after a bounded number of requests regardless, returning what it has
 * with a cursor past everything examined — so a long history is searched in
 * instalments the UI can continue, never in one unbounded request. The budget
 * is larger for a number search, which Stripe cannot narrow down for us.
 * Rejects with the SDK's error on a failed request and with `UnusableInvoiceListAnswer`
 * on a refused answer; in either case no partial page is kept, since a page
 * with holes would misreport the history.
 */
async function fillPage(
  customer: string,
  startingAfter: string | null,
  filters: InvoiceFilters,
  pageSize: number,
): Promise<InvoicePage & { rejectedDocumentUrls: number }> {
  const searching = filters.number !== null;
  const batchSize = searching ? INVOICE_SEARCH_BATCH_SIZE : INVOICE_FETCH_BATCH_SIZE;
  const maxFetches = searching
    ? INVOICE_SEARCH_MAX_FETCHES_PER_PAGE
    : INVOICE_MAX_FETCHES_PER_PAGE;
  const created = invoiceCreatedRange(filters);

  const invoices: InvoiceSummary[] = [];
  const seen = new Set<string>();
  const documentHosts = invoiceDocumentHosts();
  let cursor = startingAfter;
  let hasMore = true;
  let examined = 0;
  let rejectedDocumentUrls = 0;

  const done = (nextAfter: string | null) => ({
    invoices,
    nextCursor:
      nextAfter === null ? null : encodeInvoiceCursor({ afterId: nextAfter, filters }),
    examined,
    rejectedDocumentUrls,
  });

  for (let fetch = 1; fetch <= maxFetches && hasMore; fetch++) {
    const answer: unknown = await getStripe().invoices.list({
      customer,
      limit: batchSize,
      ...(cursor !== null && { starting_after: cursor }),
      ...(filters.status !== null && { status: filters.status }),
      ...(created !== null && { created }),
    });

    const reading = readInvoiceList(answer, customer, { documentHosts });

    if (!reading.ok) throw new UnusableInvoiceListAnswer(reading.reason, fetch);

    rejectedDocumentUrls += reading.rejectedDocumentUrls;
    examined += reading.received;

    // An empty batch says the list ended even if has_more claimed otherwise.
    if (reading.received === 0 || reading.lastId === null) return done(null);

    for (const [index, invoice] of reading.invoices.entries()) {
      const id = reading.ids[index];

      // Batches do not overlap; a duplicate across them would be Stripe
      // misbehaving, and is dropped rather than shown twice.
      if (seen.has(id)) continue;
      seen.add(id);

      if (!matchesInvoiceFilters(invoice, filters)) continue;
      invoices.push(invoice);

      if (invoices.length === pageSize) {
        // Filled mid-batch (or exactly at its end): the page ends at this
        // invoice. Anything after it in the batch is examined again next time.
        examined -= reading.received - (reading.positions[index] + 1);
        const filledAtEnd = id === reading.lastId;

        return done(filledAtEnd && !reading.hasMore ? null : id);
      }
    }

    cursor = reading.lastId;
    hasMore = reading.hasMore;
  }

  // `hasMore` is false here only if the list ended; otherwise the fetch bound
  // was reached and the cursor points past everything examined so far.
  return done(hasMore ? cursor : null);
}

/**
 * Stripe does not know the object `starting_after` names. Only the cursor's own
 * target can cause this (the customer is checked first, with its own error).
 */
function isMissingCursorError(error: unknown): boolean {
  const e = error as { type?: unknown; code?: unknown; param?: unknown } | null;

  return (
    e !== null &&
    typeof e === "object" &&
    e.type === "StripeInvalidRequestError" &&
    e.code === "resource_missing" &&
    e.param === "starting_after"
  );
}
