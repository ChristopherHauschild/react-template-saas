import type { NextRequest } from "next/server";

import { prepareInvoiceDownload } from "@/features/billing/services/invoice-download";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import {
  csvDownloadResponse,
  INTERNAL_ERROR_DOWNLOAD,
  wantsJsonErrors,
} from "@/shared/utils/csv-download";

/**
 * `GET /billing/export/invoices?from=YYYY-MM-DD&to=YYYY-MM-DD` — the signed-in
 * user's issued invoices as a CSV download (both dates optional, UTC days).
 *
 * The session is established first; a visitor without one is sent to /login
 * before the query string is even looked at. Everything else happens on the
 * server from the session's user id: the range is validated, the billing
 * account is resolved from the user's own records, every invoice in the range
 * is collected from Stripe, and the file is answered only once it is complete.
 * Any failure answers a non-2xx plain-text message and no file (see
 * `csvDownloadResponse`); never part of one. A request that accepts
 * `application/json` gets the failure as JSON instead of text, so the exports
 * page can show it in place.
 */
export async function GET(request: NextRequest) {
  // Redirects to /login when there is no session. Outside the `try`: the
  // redirect is thrown and must reach Next.
  const user = await requireAuth();
  const json = wantsJsonErrors(request.headers.get("accept"));

  try {
    // The response is built inside the `try` too: a file that cannot be
    // answered safely is answered as no file, like any other failure.
    return csvDownloadResponse(
      await prepareInvoiceDownload(user.id, request.nextUrl.searchParams),
      { json },
    );
  } catch (thrown) {
    // The services report failures as values; this is a broken contract.
    console.error("[billing] invoice download threw unexpectedly", {
      userId: user.id,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return csvDownloadResponse(INTERNAL_ERROR_DOWNLOAD, { json });
  }
}
