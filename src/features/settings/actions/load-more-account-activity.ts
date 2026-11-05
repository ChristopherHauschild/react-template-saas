"use server";

import { decodeAccountActivityCursor } from "@/infrastructure/account-activity/cursor";
import {
  type AccountActivityEntry,
  listAccountActivity,
} from "@/infrastructure/account-activity/list-account-activity";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

import {
  ACCOUNT_ACTIVITY_PAGE_SIZE,
  LOAD_MORE_ACTIVITY_COPY,
} from "../services/account-activity-copy";

/**
 * Result of a "load older activity" request. Expected problems come back as
 * `ok: false` with a message the card shows inline (the entries already on
 * screen stay); `restart` marks the one case a retry cannot fix — the cursor
 * itself is not valid — so the list must be reloaded from the top.
 *
 * `cursor` echoes what was asked for, so the client can discard a response
 * that no longer matches what it is waiting on (a stale or duplicated request).
 */
export type LoadMoreAccountActivityResult =
  | {
      ok: true;
      cursor: string;
      entries: AccountActivityEntry[];
      nextCursor: string | null;
    }
  | { ok: false; cursor: string; error: string; restart: boolean };

/**
 * Fetches the page of the signed-in user's account activity that is older
 * than `cursor`.
 *
 * `cursor` is untrusted client input: it is only accepted if it decodes to a
 * well-formed position (`decodeAccountActivityCursor`), and the read it then
 * drives is made AS THE USER — row level security and the user-id filter
 * confine it to their own rows. A forged cursor therefore cannot reach
 * anyone else's history; at best it yields an empty page. The action takes
 * nothing else from the client.
 *
 * Never throws for read failures (they are returned); only the sign-in
 * redirect propagates.
 */
export async function loadMoreAccountActivity(
  cursor: unknown,
): Promise<LoadMoreAccountActivityResult> {
  // Redirects to /login when there is no session.
  const user = await requireAuth();

  const echoed = typeof cursor === "string" ? cursor : "";
  const before = decodeAccountActivityCursor(cursor);

  if (before === null) {
    // Tampered, truncated or stale: nothing is read. The shape is logged,
    // never the value (it is whatever the client chose to send).
    console.error("[settings] refusing an activity cursor that is not one of ours", {
      userId: user.id,
      received: typeof cursor,
    });

    return {
      ok: false,
      cursor: echoed,
      error: LOAD_MORE_ACTIVITY_COPY.restart,
      restart: true,
    };
  }

  const page = await listAccountActivity(user.id, {
    limit: ACCOUNT_ACTIVITY_PAGE_SIZE,
    before,
  });

  if (!page.ok) {
    // Already logged by the service; the user can simply try again.
    return {
      ok: false,
      cursor: echoed,
      error: LOAD_MORE_ACTIVITY_COPY.retry,
      restart: false,
    };
  }

  return { ok: true, cursor: echoed, entries: page.entries, nextCursor: page.nextCursor };
}
