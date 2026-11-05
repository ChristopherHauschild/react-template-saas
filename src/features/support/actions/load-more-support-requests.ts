"use server";

import {
  listSupportRequests,
  SUPPORT_REQUESTS_DEFAULT_LIMIT,
} from "../services/list-support-requests";
import { sessionForPage } from "../services/page-session";
import { decodeSupportRequestCursor } from "../services/support-request-cursor";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";
import type { SupportRequest } from "../services/support-request-row";

/**
 * How the list can recover from a failed page:
 * - `retry`: ask for the same page again (a transient failure);
 * - `reload`: the cursor itself is no longer valid — start again from the
 *   first page (`reloadSupportRequests`);
 * - `signIn`: the session has ended — sign in (in another tab, keeping this
 *   page and any draft on it), then retry;
 * - `accountChanged`: the session now belongs to a different account than
 *   the list — sign back in to the list's account, then retry (nothing from
 *   the other account is ever added to this list).
 */
export type SupportHistoryRecovery = "retry" | "reload" | "signIn" | "accountChanged";

/**
 * Result of a "load older requests" request. Expected problems come back as
 * `ok: false` with a message the list shows inline (the requests already on
 * screen stay) and the way to recover.
 *
 * `cursor` echoes what was asked for, so the client can discard a response
 * that no longer matches what it is waiting on (a stale or duplicated request).
 */
export type LoadMoreSupportRequestsResult =
  | {
      ok: true;
      cursor: string;
      requests: SupportRequest[];
      nextCursor: string | null;
    }
  | { ok: false; cursor: string; error: string; recovery: SupportHistoryRecovery };

/**
 * Fetches the page of the signed-in user's support requests older than
 * `cursor`.
 *
 * Never redirects, never throws for expected failures. A redirect to the login
 * page from here would navigate away from the support page — and from any
 * unsent request in its form. An ended session is therefore reported as
 * `recovery: "signIn"`, and nothing is read.
 *
 * `pageOwner` is the account the list was rendered for: the page is refused
 * unless the session still belongs to it, so one account's requests are
 * never appended to another account's list (see `sessionForPage`).
 *
 * `cursor` is untrusted client input: it is only accepted if it decodes to a
 * well-formed position (`decodeSupportRequestCursor`), and the read it then
 * drives is made AS THE USER — row level security and the user-id filter
 * confine it to their own rows. A forged cursor therefore cannot reach anyone
 * else's requests; at best it yields an empty page. The action takes nothing
 * else from the client: not a page size, not a user id.
 */
export async function loadMoreSupportRequests(
  cursor: unknown,
  pageOwner: unknown,
): Promise<LoadMoreSupportRequestsResult> {
  const echoed = typeof cursor === "string" ? cursor : "";

  // Same verified lookup as `requireAuth()`, without its redirect, and
  // checked against the list's account (see above).
  const session = await sessionForPage(pageOwner);

  if (session.status === "signedOut") {
    return {
      ok: false,
      cursor: echoed,
      error: SUPPORT_REQUEST_ERRORS.listSessionExpired,
      recovery: "signIn",
    };
  }

  if (session.status === "accountChanged") {
    return {
      ok: false,
      cursor: echoed,
      error: SUPPORT_REQUEST_ERRORS.listAccountChanged,
      recovery: "accountChanged",
    };
  }

  const before = decodeSupportRequestCursor(cursor);

  if (before === null) {
    // Tampered, truncated or stale: nothing is read. The shape is logged,
    // never the value (it is whatever the client chose to send).
    console.error("[support] refusing a cursor that is not one of ours", {
      userId: session.userId,
      received: typeof cursor,
    });

    return {
      ok: false,
      cursor: echoed,
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    };
  }

  const page = await listSupportRequests(session.userId, {
    limit: SUPPORT_REQUESTS_DEFAULT_LIMIT,
    before,
  });

  if (!page.ok) {
    // Already logged by the service.
    return page.failure === "sessionExpired"
      ? {
          ok: false,
          cursor: echoed,
          error: SUPPORT_REQUEST_ERRORS.listSessionExpired,
          recovery: "signIn",
        }
      : {
          ok: false,
          cursor: echoed,
          error: SUPPORT_REQUEST_ERRORS.listUnavailable,
          recovery: "retry",
        };
  }

  return {
    ok: true,
    cursor: echoed,
    requests: page.requests,
    nextCursor: page.nextCursor,
  };
}
