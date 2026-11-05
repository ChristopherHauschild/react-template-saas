import "server-only";

import { getCurrentUser } from "@/infrastructure/auth/session/get-current-user";

export type PageSession =
  /** The session belongs to the account the page was rendered for. */
  | { status: "ok"; userId: string }
  /** No session at all: sign in again. */
  | { status: "signedOut" }
  /**
   * The session belongs to a DIFFERENT account than the page: someone signed
   * in as another user (typically in another tab — tabs share cookies) after
   * this page was rendered.
   */
  | { status: "accountChanged" };

/**
 * The session a support-page action may act for, checked against the account
 * the page was rendered for (`pageOwner`, sent back by the page).
 *
 * Why: an open page keeps what it showed and what was typed into it, while
 * the session cookies can change underneath it. Acting for the CURRENT
 * session would file one account's unsent request under another account, or
 * page one account's history into another's list. So every action refuses
 * unless the session's user is the page's owner.
 *
 * This is a consistency check, not authorization. `pageOwner` comes from the
 * client and is not trusted for anything: the session alone decides whose
 * data is read or written (and row level security enforces it). A client
 * sending some other id can only get itself refused — never access.
 *
 * Order matters: no session at all is reported as `signedOut` (sign in again),
 * ahead of any comparison.
 */
export async function sessionForPage(pageOwner: unknown): Promise<PageSession> {
  const user = await getCurrentUser();

  if (!user) return { status: "signedOut" };

  if (typeof pageOwner !== "string" || pageOwner !== user.id) {
    // The claimed owner is client input: only its shape is logged.
    console.warn(
      "[support] refusing an action for a different account than the session's",
      {
        sessionUserId: user.id,
        pageOwner: typeof pageOwner,
      },
    );
    return { status: "accountChanged" };
  }

  return { status: "ok", userId: user.id };
}
