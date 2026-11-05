import "server-only";

import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

import {
  listSupportRequests,
  type ListSupportRequestsResult,
  SUPPORT_REQUESTS_DEFAULT_LIMIT,
} from "../services/list-support-requests";

import { SupportRequestHistory } from "./support-request-history";

/**
 * Server half of the history: reads the first page AS THE USER (row level
 * security plus the user filter) and hands it to the client list, which pages
 * further through `loadMoreSupportRequests` at the same page size.
 *
 * Rendered inside a Suspense boundary on the support page, so the form is
 * usable while this read is in flight. Re-rendered whenever the support route
 * is revalidated — which filing a request does — and that is how a new
 * request appears in the list.
 */
export async function SupportRequestHistorySection() {
  // Same per-request cached lookup the (protected) layout's guard already made.
  const user = await requireAuth();

  // Keyed by the account: a re-render for a different account (the session
  // changed hands while the page was open) starts a fresh list.
  return (
    <SupportRequestHistory
      key={user.id}
      ownerId={user.id}
      initial={await loadFirstPage(user.id)}
    />
  );
}

/**
 * The service never throws by contract; this guard makes the section hold
 * even if that contract were broken, because a history that cannot be shown
 * is no reason to take the form down with it. Logged without user data.
 */
async function loadFirstPage(userId: string): Promise<ListSupportRequestsResult> {
  try {
    return await listSupportRequests(userId, { limit: SUPPORT_REQUESTS_DEFAULT_LIMIT });
  } catch (thrown) {
    console.error("[support] request history could not be loaded for the page", {
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false, failure: "unavailable" };
  }
}
