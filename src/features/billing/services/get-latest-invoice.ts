import "server-only";

import { getInvoiceHistory, type InvoiceHistory } from "./get-invoice-history";
import type { SubscriptionOverview } from "./get-subscription-overview";
import type { InvoiceSummary } from "./invoice-history";

/**
 * The dashboard's one-line view of the user's invoices: the newest ISSUED
 * invoice, or why there is none to show. Six shapes the card must never
 * confuse with each other:
 * - `ok`: the newest issued invoice Stripe holds for the user's customer;
 * - `empty`: Stripe holds no issued invoice (drafts do not count);
 * - `undetermined`: the scan's budget ran out before an issued invoice was
 *   found (an unusual run of drafts). Not "no invoices": the billing page's
 *   list can go on from there;
 * - `none`: the user has no billing account, so there is nothing to look for;
 * - `ambiguous`: the records point at several customers or at one we cannot
 *   identify — showing any customer's invoice would be a guess;
 * - `unavailable`: something failed. The card must say so, never "no invoices".
 */
export type LatestInvoice =
  | { kind: "ok"; invoice: InvoiceSummary }
  | { kind: "empty" }
  | { kind: "undetermined" }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | {
      kind: "unavailable";
      reason: Extract<InvoiceHistory, { kind: "unavailable" }>["reason"];
    };

export type LatestInvoiceOptions = {
  /** The user's records, when the caller already read them (the dashboard). */
  overview?: SubscriptionOverview;
};

/**
 * The newest issued invoice of the signed-in user, found exactly as the first
 * row of the billing page's list is: same customer resolution (the portal's
 * rule), same scan past drafts, same budget, same refusal of answers that are
 * not this customer's. Only the page size differs — one invoice — so the
 * dashboard never shows something the billing page would not list first.
 *
 * A user without a billing account costs no Stripe call.
 */
export async function getLatestInvoice(
  userId: string,
  options: LatestInvoiceOptions = {},
): Promise<LatestInvoice> {
  const history = await getInvoiceHistory(userId, {
    overview: options.overview,
    pageSize: 1,
  });

  switch (history.kind) {
    case "none":
    case "ambiguous":
      return { kind: history.kind };

    case "unavailable":
      return { kind: "unavailable", reason: history.reason };

    case "ok":
      if (history.invoices.length > 0) {
        return { kind: "ok", invoice: history.invoices[0] };
      }
      // Nothing found: "empty" only if Stripe had nothing further to scan.
      return { kind: history.nextCursor === null ? "empty" : "undetermined" };
  }
}
