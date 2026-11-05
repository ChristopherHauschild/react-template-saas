"use server";

import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

import { getInvoiceHistory } from "../services/get-invoice-history";
import { decodeInvoiceCursor } from "../services/invoice-cursor";
import { type InvoicePage, LOAD_MORE_INVOICES_COPY } from "../services/invoice-history";

/**
 * Result of a "load more" request. Expected problems come back as `ok: false`
 * with a message the list shows inline (the rows already on screen stay);
 * `restart` marks the one case a retry cannot fix, because the cursor itself is
 * no longer valid — the list must be reloaded from the top.
 *
 * `cursor` echoes what was asked for, so the client can discard a response
 * that no longer matches what it is waiting on (a stale or duplicated request).
 */
export type LoadMoreInvoicesResult =
  | ({ ok: true; cursor: string } & InvoicePage)
  | { ok: false; cursor: string; error: string; restart: boolean };

/**
 * Fetches the next page of the signed-in user's invoices.
 *
 * `cursor` is untrusted client input: it is only accepted if it decodes to a
 * well-formed invoice id plus valid filters, and that id is only ever used
 * inside the list of the customer resolved — on every call — from the user's
 * OWN subscription rows, by the same rule the Customer Portal uses. A forged
 * cursor therefore cannot reach another customer's invoices; at worst Stripe
 * does not know it, and the user is asked to reload. The filters come from the
 * cursor too, so a page is always continued with the filters it started with.
 * The action takes nothing else from the client.
 *
 * Never throws for Stripe or record failures (they are returned); only an
 * unexpected failure or the sign-in redirect propagates.
 */
export async function loadMoreInvoices(cursor: unknown): Promise<LoadMoreInvoicesResult> {
  // Redirects to /login when there is no session.
  const user = await requireAuth();

  const echoed = typeof cursor === "string" ? cursor : "";
  const decoded = decodeInvoiceCursor(cursor);

  if (decoded === null) {
    // Tampered, truncated or stale: nothing is sent to Stripe. The shape is
    // logged, never the value (it is whatever the client chose to send).
    console.error("[billing] refusing a paging cursor that is not one of ours", {
      userId: user.id,
      received: typeof cursor,
    });

    return {
      ok: false,
      cursor: echoed,
      error: LOAD_MORE_INVOICES_COPY.restart,
      restart: true,
    };
  }

  const history = await getInvoiceHistory(user.id, {
    startingAfter: decoded.afterId,
    filters: decoded.filters,
  });

  if (history.kind === "ok") {
    const { invoices, nextCursor, examined } = history;

    return { ok: true, cursor: echoed, invoices, nextCursor, examined };
  }

  // The records changed underneath the list (or could not be read), or Stripe
  // failed. Specific causes are already logged by the service; the user gets
  // one message, plus the instruction to reload when a retry cannot help.
  const restart =
    history.kind === "none" ||
    history.kind === "ambiguous" ||
    history.reason === "cursor_invalid";

  return {
    ok: false,
    cursor: echoed,
    error: restart ? LOAD_MORE_INVOICES_COPY.restart : LOAD_MORE_INVOICES_COPY.retry,
    restart,
  };
}
