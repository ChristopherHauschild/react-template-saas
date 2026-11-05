/**
 * Keeping a dead session's cookies during a Server Action request.
 *
 * When supabase-js finds the session gone (revoked, expired for good), it
 * removes it: @supabase/ssr hands `setAll` one batch that does nothing but
 * clear the auth cookies. On a page request that is right — the page is about
 * to be rendered for a signed-out visitor anyway.
 *
 * During a SERVER ACTION request it is harmful. Next.js treats any cookie
 * written while handling an action — including cookies the proxy
 * (middleware) sets on that request, which Next merges into the action's
 * cookie store — as "cookies changed", answers with `x-action-revalidated`,
 * and the client router then refreshes the current route. That refresh runs
 * the `(protected)` layout's guard, which redirects to the login page: the
 * tab navigates away in the middle of an action, taking everything unsaved on
 * the page with it (a half-written support request, a settings form). Seen in
 * Chromium: one "Load older requests" click after the session ended sent the
 * whole page to /login, although the action itself answered "signed out".
 *
 * So during an action request, a batch that ONLY clears cookies is skipped.
 * The action still sees no session (supabase-js has dropped it in memory), and
 * reports that to the page, which can say so in place.
 *
 * What this does not change:
 * - Saving a session (sign-in, token refresh) always has at least one
 *   non-empty cookie, so it is written as before — including the clearing of
 *   stale chunks that comes with it (skipping those would corrupt the session).
 * - Page and route-handler requests clear dead sessions as before; the next
 *   page load after the action does it.
 * - Nothing is less secure: clearing a cookie revokes nothing (the tokens are
 *   already dead at the auth server), and an explicit sign-out deletes the
 *   cookies itself rather than through this path.
 */

/** Header Next.js sends with every Server Action request. */
export const SERVER_ACTION_HEADER = "next-action";

/** Whether a request (its headers) is a Server Action call. */
export function isServerActionRequest(headers: Pick<Headers, "has">): boolean {
  return headers.has(SERVER_ACTION_HEADER);
}

/** Whether a `setAll` batch only clears cookies, i.e. supabase-js removing the session. */
export function isSessionRemoval(cookies: ReadonlyArray<{ value: string }>): boolean {
  return cookies.length > 0 && cookies.every((cookie) => cookie.value === "");
}

/** The rule above: skip this batch? */
export function keepDeadSessionCookies(
  isAction: boolean,
  cookies: ReadonlyArray<{ value: string }>,
): boolean {
  return isAction && isSessionRemoval(cookies);
}
