import { type NextRequest, NextResponse } from "next/server";

import { ROUTES } from "@/config/routes";
import { getInvoiceDocument } from "@/features/billing/services/get-invoice-document";
import {
  INVOICE_DOCUMENT_NOTICE_PARAM,
  type InvoiceDocumentNotice,
} from "@/features/billing/services/invoice-document-notice";
import { isInvoiceDocumentKind } from "@/features/billing/services/invoice-history";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

const LOG_PREFIX = "[billing]";

/**
 * `GET /billing/invoices/<key>/<view|pdf>` — opens an invoice document.
 *
 * The billing page links here instead of to Stripe's document URLs, which
 * embed access tokens and must not sit in the page's markup. On each request
 * the signed-in user is re-established, the invoice is fetched from Stripe and
 * checked to belong to the customer resolved from the user's own records, and
 * only then is the browser redirected to Stripe's current URL for it
 * (`getInvoiceDocument`). Anything else sends the user back to the billing
 * page with a notice — "missing" for a document that does not exist for them
 * (including another customer's), "unavailable" when Stripe or the records
 * could not be consulted.
 *
 * Responses are never cached: a URL minted for one user must not be served to
 * another, and Stripe's URLs may change.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string; kind: string }> },
) {
  // Redirects to /login when there is no session.
  const user = await requireAuth();

  const { key, kind } = await params;

  if (!isInvoiceDocumentKind(kind)) {
    return backToBilling("missing");
  }

  const result = await getInvoiceDocument(user.id, key, kind);

  if (result.kind === "ok") {
    return noStore(NextResponse.redirect(result.url, 302));
  }

  if (result.kind === "missing") {
    return backToBilling("missing");
  }

  // `refused` is already logged by the service with its reason; `unavailable`
  // too. Both are "try again later / see the billing page" from here.
  console.error(`${LOG_PREFIX} invoice document not opened`, {
    userId: user.id,
    kind,
    outcome: result.kind,
    reason: result.reason,
  });

  return backToBilling("unavailable");
}

/**
 * A RELATIVE redirect, deliberately: `request.url` is not the origin the browser
 * used (in development Next reports `localhost` for a request made to
 * `127.0.0.1`), and the session cookie is scoped to that origin. A relative
 * `Location` keeps the browser where it is.
 */
function backToBilling(notice: InvoiceDocumentNotice) {
  const location = `${ROUTES.billing}?${INVOICE_DOCUMENT_NOTICE_PARAM}=${notice}`;

  return noStore(
    new NextResponse(null, { status: 303, headers: { Location: location } }),
  );
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");

  return response;
}
