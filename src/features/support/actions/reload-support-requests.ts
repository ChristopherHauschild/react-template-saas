"use server";

import {
  listSupportRequests,
  type ListSupportRequestsResult,
  SUPPORT_REQUESTS_DEFAULT_LIMIT,
} from "../services/list-support-requests";
import { sessionForPage } from "../services/page-session";

/**
 * Reads the first page of the signed-in user's support requests again — the
 * history's "Try again" and "Reload requests".
 *
 * Why an action and not `router.refresh()`: a refresh re-renders the route,
 * and the `(protected)` layout's guard redirects to the login page when the
 * session has ended. That navigation would throw away an unsent request in
 * the form above the history. This action never redirects: an ended session
 * comes back as `{ ok: false, failure: "sessionExpired" }`, and the history
 * offers to sign in in another tab.
 *
 * `pageOwner` is the account the list was rendered for: the read is refused
 * (`accountChanged`) unless the session still belongs to it, so another
 * account's requests never replace this list (see `sessionForPage`).
 *
 * Reads AS THE USER (row level security plus the user filter), at the same
 * page size as the first render and "load older". Never throws: anything
 * unexpected is reported as `unavailable`.
 */
export async function reloadSupportRequests(
  pageOwner: unknown,
): Promise<ListSupportRequestsResult> {
  try {
    const session = await sessionForPage(pageOwner);

    if (session.status === "signedOut") return { ok: false, failure: "sessionExpired" };
    if (session.status === "accountChanged")
      return { ok: false, failure: "accountChanged" };

    return await listSupportRequests(session.userId, {
      limit: SUPPORT_REQUESTS_DEFAULT_LIMIT,
    });
  } catch (thrown) {
    console.error("[support] reloading requests threw unexpectedly", {
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false, failure: "unavailable" };
  }
}
