import type { NextRequest } from "next/server";

import { prepareAccountActivityDownload } from "@/features/settings/services/account-activity-download";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import {
  csvDownloadResponse,
  INTERNAL_ERROR_DOWNLOAD,
  wantsJsonErrors,
} from "@/shared/utils/csv-download";

/**
 * `GET /settings/export/activity?from=YYYY-MM-DD&to=YYYY-MM-DD` — the signed-in
 * user's account activity as a CSV download (both dates optional, UTC days).
 *
 * The session is established first; a visitor without one is sent to /login
 * before the query string is even looked at. Everything else happens on the
 * server from the session's user id: the range is validated, the whole history
 * in it is collected under RLS, and the file is answered only once it is
 * complete. Any failure answers a non-2xx plain-text message and no file (see
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
      await prepareAccountActivityDownload(user.id, request.nextUrl.searchParams),
      { json },
    );
  } catch (thrown) {
    // The services report failures as values; this is a broken contract.
    console.error("[settings] account activity download threw unexpectedly", {
      userId: user.id,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return csvDownloadResponse(INTERNAL_ERROR_DOWNLOAD, { json });
  }
}
