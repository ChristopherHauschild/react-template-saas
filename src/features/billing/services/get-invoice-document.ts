import "server-only";

import { getStripe } from "@/infrastructure/stripe";

import { invoiceDocumentHosts } from "./get-invoice-history";
import { getSubscriptionOverview } from "./get-subscription-overview";
import {
  decodeInvoiceKey,
  INVOICE_DOCUMENT_FIELDS,
  type InvoiceDocumentKind,
  isInvoiceDocumentUrl,
  namesCustomer,
} from "./invoice-history";
import {
  isMissingCustomerError,
  isStripeCustomerId,
  summarizePortalErrorForLog,
} from "./portal-errors";

const LOG_PREFIX = "[billing]";

/**
 * Where an invoice document can be opened, or why not. The route handler maps
 * these onto redirects; the distinction that matters to the user is only
 * `ok` / "that document does not exist for you" / "try again later".
 */
export type InvoiceDocumentResult =
  /** Stripe's current URL for the document, verified to be on an accepted host. */
  | { kind: "ok"; url: string }
  /** No such document for this user. One answer for all of them: nothing about other customers' invoices is revealed. */
  | {
      kind: "missing";
      reason: /** The key is not a token for a well-formed invoice id. */
        | "invalid_key"
        /** Stripe has no such invoice (or it was a draft that has been deleted). */
        | "not_found"
        /** The invoice exists but belongs to another customer than the user's. */
        | "foreign_invoice"
        /** Still a draft: not issued, no documents yet. */
        | "draft"
        /** Issued, but Stripe has not provided this document (yet). */
        | "no_document"
        /** Stripe provided a URL this application will not follow. */
        | "invalid_url";
    }
  /** The user's billing account cannot be determined; same refusals as the list and the portal. */
  | {
      kind: "refused";
      reason: "records_unreadable" | "no_customer" | "ambiguous" | "invalid_customer_id";
    }
  /** Stripe could not be asked, or answered with something that is not this invoice. */
  | {
      kind: "unavailable";
      reason: "customer_missing" | "stripe_error" | "unusable_response";
    };

/**
 * Resolves the current URL of an invoice document for the signed-in user.
 *
 * The page never carries Stripe's document URLs (they embed access tokens).
 * Instead each link names the invoice by its opaque key, and this function is
 * called when the link is followed. It decides whose invoices may be opened
 * by exactly the rule the list and the Customer Portal use — the customer
 * resolved from the user's OWN subscription rows — and then fetches the
 * invoice from Stripe and checks that it names that customer. So a key
 * belonging to another customer, a guessed key, or a key pasted from another
 * account opens nothing: the answer is `missing`, indistinguishable from an
 * invoice that does not exist. The URL is followed only if Stripe provided it
 * for that very document and it passes `isInvoiceDocumentUrl`.
 *
 * Fails closed and never throws for Stripe or record failures.
 */
export async function getInvoiceDocument(
  userId: string,
  key: unknown,
  kind: InvoiceDocumentKind,
): Promise<InvoiceDocumentResult> {
  const invoiceId = decodeInvoiceKey(key);

  if (invoiceId === null) {
    console.error(`${LOG_PREFIX} refusing an invoice key that is not one of ours`, {
      userId,
      received: typeof key,
    });

    return { kind: "missing", reason: "invalid_key" };
  }

  const records = await getSubscriptionOverview(userId);

  if (!records.ok) {
    return { kind: "refused", reason: "records_unreadable" };
  }

  const { customerResolution } = records;

  if (customerResolution.kind === "none") {
    return { kind: "refused", reason: "no_customer" };
  }

  if (customerResolution.kind === "ambiguous") {
    console.error(`${LOG_PREFIX} customer is ambiguous; invoice document not opened`, {
      userId,
      reason: customerResolution.reason,
      customers: customerResolution.customers,
      subscriptions: records.subscriptions.length,
    });

    return { kind: "refused", reason: "ambiguous" };
  }

  const customer = customerResolution.stripeCustomerId;

  if (!isStripeCustomerId(customer)) {
    console.error(`${LOG_PREFIX} stored customer id is not a Stripe customer id`, {
      userId,
    });

    return { kind: "refused", reason: "invalid_customer_id" };
  }

  let invoice: unknown;

  try {
    invoice = await getStripe().invoices.retrieve(invoiceId);
  } catch (error) {
    if (isMissingCustomerError(error)) {
      console.error(`${LOG_PREFIX} Stripe does not know the user's customer`, {
        userId,
        error: summarizePortalErrorForLog(error),
      });

      return { kind: "unavailable", reason: "customer_missing" };
    }

    if (isMissingInvoiceError(error)) {
      // Not an outage: the invoice is gone (a deleted draft) or never existed
      // in this Stripe account (a key from elsewhere). Counts as missing.
      console.warn(`${LOG_PREFIX} Stripe does not know the requested invoice`, {
        userId,
        error: summarizePortalErrorForLog(error),
      });

      return { kind: "missing", reason: "not_found" };
    }

    console.error(`${LOG_PREFIX} could not retrieve the user's invoice`, {
      userId,
      error: summarizePortalErrorForLog(error),
    });

    return { kind: "unavailable", reason: "stripe_error" };
  }

  if (invoice === null || typeof invoice !== "object") {
    console.error(`${LOG_PREFIX} Stripe returned an unusable invoice`, {
      userId,
      received: typeof invoice,
    });

    return { kind: "unavailable", reason: "unusable_response" };
  }

  const fields = invoice as Record<string, unknown>;

  if (fields.deleted === true) {
    return { kind: "missing", reason: "not_found" };
  }

  if (fields.id !== invoiceId) {
    // Asked for one invoice, got another: refuse rather than trust it.
    console.error(`${LOG_PREFIX} Stripe returned a different invoice than requested`, {
      userId,
    });

    return { kind: "unavailable", reason: "unusable_response" };
  }

  if (!namesCustomer(fields.customer, customer)) {
    // The ownership check proper. A foreign key is reported as missing to the
    // user (no information about other accounts) but logged loudly: it is
    // either a bug or someone probing.
    console.error(`${LOG_PREFIX} invoice belongs to another customer; document refused`, {
      userId,
    });

    return { kind: "missing", reason: "foreign_invoice" };
  }

  if (fields.status === "draft") {
    return { kind: "missing", reason: "draft" };
  }

  const url = fields[INVOICE_DOCUMENT_FIELDS[kind]];

  if (url === null || url === undefined) {
    return { kind: "missing", reason: "no_document" };
  }

  if (!isInvoiceDocumentUrl(url, invoiceDocumentHosts())) {
    // Shape only — the URL would be the thing we refused to follow.
    console.warn(`${LOG_PREFIX} invoice document URL is not usable; not followed`, {
      userId,
      kind,
      received: typeof url,
    });

    return { kind: "missing", reason: "invalid_url" };
  }

  return { kind: "ok", url };
}

/** Stripe does not know the invoice id that was asked for. */
function isMissingInvoiceError(error: unknown): boolean {
  const e = error as { type?: unknown; code?: unknown; param?: unknown } | null;

  return (
    e !== null &&
    typeof e === "object" &&
    e.type === "StripeInvalidRequestError" &&
    e.code === "resource_missing" &&
    (e.param === "id" || e.param === "invoice")
  );
}
