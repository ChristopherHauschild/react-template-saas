import "server-only";

import { cookies } from "next/headers";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/auth/supabase/server";

import { persistedAccessTokens } from "./auth-cookies";
import { summarizeAuthErrorForLog } from "./auth-error-log";
import { EMAIL_CHANGE_STATUSES, type EmailChangeStatus } from "./email-change-status";
import {
  CONFIRMATION_FAILURES,
  type ConfirmationFailure,
  describeExchangeError,
} from "./email-confirmation-errors";

export type ConfirmEmailResult =
  | { ok: true }
  | { ok: false; failure: ConfirmationFailure };

/**
 * `type` values accepted alongside a `token_hash`: `signup` is what this app's
 * confirmation email template sends; `email` is Supabase's documented umbrella
 * value for the same template (covers sign-up and magic-link tokens).
 */
export const TOKEN_HASH_TYPES = ["signup", "email"] as const;

export type TokenHashType = (typeof TOKEN_HASH_TYPES)[number];

export function isTokenHashType(value: unknown): value is TokenHashType {
  return TOKEN_HASH_TYPES.includes(value as TokenHashType);
}

/**
 * `type` of the `token_hash` links in email-change confirmation emails
 * (`supabase/templates/email_change.html`). Handled apart from the sign-up
 * types because its success has two shapes (see `confirmEmailChangeWithTokenHash`).
 */
export const EMAIL_CHANGE_TOKEN_HASH_TYPE = "email_change";

/**
 * Turns the PKCE `code` from a confirmation link into a signed-in session.
 *
 * Only works in the browser that started the sign-up (the PKCE verifier lives in
 * its cookies) and while Supabase's flow state is alive; the `token_hash` path
 * below has neither constraint and is what the email template uses. Kept for
 * links produced by the default template and other PKCE redirects.
 */
export function confirmEmail(code: string): Promise<ConfirmEmailResult> {
  return confirm((supabase) => supabase.auth.exchangeCodeForSession(code));
}

/**
 * Turns the `token_hash` from a confirmation link into a signed-in session.
 *
 * The hash is verified server-to-server with nothing stored in the browser, so
 * the link works from any device and for resent emails (Supabase's resend does
 * not create a PKCE flow, so those links could never be exchanged as a `code`).
 */
export function confirmEmailWithTokenHash(
  tokenHash: string,
  type: TokenHashType,
): Promise<ConfirmEmailResult> {
  return confirm((supabase) => supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
}

/**
 * On success supabase-js has already written the session cookies through the
 * server client; the caller only has to redirect. Failures are returned, never
 * thrown, and are classified (`expired`, `invalid`, `unavailable`) without
 * surfacing Supabase's message. Nothing identifying is logged: codes and token
 * hashes are one-time credentials and are never written anywhere.
 *
 * "Success" requires a session in the response, not merely the absence of an
 * error: redirecting to the dashboard without one would bounce the user straight
 * back to the login page with no explanation — after the one-time credential has
 * already been consumed. Such a response is reported as `unavailable` (the login
 * page's copy for it tells the user what to do) and logged for operators.
 *
 * The same goes for a session that did not reach the cookie store: the server
 * client's cookie adapter does not throw on a failed write (it cannot, safely —
 * see `setAll`), so it is checked here, where persistence is the whole point.
 * "Reached" means the stored session carries the access token GoTrue just
 * issued — not that some session-looking cookie exists: a stale session from an
 * earlier sign-in, or the PKCE verifier cookie, would otherwise pass.
 */
async function confirm(
  verify: (supabase: SupabaseClient) => Promise<{
    data: { session: { access_token?: unknown } | null } | null;
    error: unknown;
  }>,
): Promise<ConfirmEmailResult> {
  let authError: unknown;
  let issuedAccessToken: string | null = null;

  try {
    const supabase = await createClient();

    const { data, error } = await verify(supabase);

    authError = error;
    issuedAccessToken =
      typeof data?.session?.access_token === "string" ? data.session.access_token : null;
  } catch (thrown) {
    // Client construction, a non-auth error from supabase-js, a bug: contained so
    // the route can still send the user somewhere sensible.
    console.error(
      "[auth] email confirmation threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { ok: false, failure: CONFIRMATION_FAILURES.unavailable };
  }

  if (!authError) {
    if (issuedAccessToken === null) {
      console.error("[auth] email confirmation returned no session");

      return { ok: false, failure: CONFIRMATION_FAILURES.unavailable };
    }

    if (!(await sessionIsPersisted(issuedAccessToken))) {
      console.error(
        "[auth] email confirmation verified but the issued session is not in the cookies",
      );

      return { ok: false, failure: CONFIRMATION_FAILURES.unavailable };
    }

    return { ok: true };
  }

  const failure = describeExchangeError(authError);

  if (failure === CONFIRMATION_FAILURES.unavailable) {
    // Unexpected: worth a log line for operators. Expired/invalid links are
    // routine and are not logged.
    console.error(
      "[auth] email confirmation failed unexpectedly",
      summarizeAuthErrorForLog(authError),
    );
  }

  return { ok: false, failure };
}

/**
 * Whether the request's cookie store now holds the session GoTrue just issued
 * (identified by its access token). Read after the verification wrote through
 * the server client; in a Route Handler the store is mutable, so a successful
 * write is visible here at once. A leftover session from an earlier sign-in,
 * or the PKCE verifier cookie, does not count. The token is compared, never
 * logged.
 */
async function sessionIsPersisted(issuedAccessToken: string): Promise<boolean> {
  const cookieStore = await cookies();

  return (await persistedAccessTokens(cookieStore.getAll())).has(issuedAccessToken);
}

/**
 * Verifies the `token_hash` of an email-change confirmation link.
 *
 * Supabase's answer has two successful shapes, and the distinction is what the
 * settings page's copy hinges on:
 *
 * - a session → the change is complete: the account's email is now the new
 *   address (and, like any verification, the browser that opened the link is
 *   signed in through the server client's cookies);
 * - no session and no error → the project requires BOTH addresses to confirm
 *   (`double_confirm_changes`) and this was the first of the two links: the
 *   change is pending until the other one is opened. Reported as
 *   `awaiting_other`, NOT as a success, so nothing ever claims the email changed
 *   before it did. (For sign-up the same response would be a failure — see
 *   `confirm` — which is why this is not routed through it.)
 *
 * Failures are classified without surfacing Supabase's message; nothing
 * identifying is logged, and the hash — a one-time credential — is never
 * written anywhere.
 */
export type EmailChangeConfirmation = {
  status: EmailChangeStatus;
  /**
   * The account whose email change was completed (`confirmed` only): the user
   * GoTrue returned with the new session. Null for every other status. Lets the
   * callback address the outcome to that account and nobody else — the browser
   * may hold a different, still-valid session if writing the new one failed.
   */
  userId: string | null;
  /**
   * That account's address after the change (`confirmed` only; null for every
   * other status, or if GoTrue's user carried none). What the activity history
   * records as the new address.
   */
  email: string | null;
};

export async function confirmEmailChangeWithTokenHash(
  tokenHash: string,
): Promise<EmailChangeConfirmation> {
  let authError: unknown;
  let hasSession = false;
  let userId: string | null = null;
  let email: string | null = null;

  try {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: EMAIL_CHANGE_TOKEN_HASH_TYPE,
    });

    authError = error;
    hasSession = Boolean(data?.session);
    // For the first of two confirmations supabase-js puts GoTrue's `{ msg }`
    // body where the user would be; only a real user object has a string id.
    userId = hasSession && typeof data?.user?.id === "string" ? data.user.id : null;
    email =
      userId !== null && typeof data?.user?.email === "string" && data.user.email !== ""
        ? data.user.email
        : null;
  } catch (thrown) {
    console.error(
      "[auth] email change confirmation threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: EMAIL_CHANGE_STATUSES.unavailable, userId: null, email: null };
  }

  if (!authError) {
    return hasSession
      ? { status: EMAIL_CHANGE_STATUSES.confirmed, userId, email }
      : { status: EMAIL_CHANGE_STATUSES.awaitingOther, userId: null, email: null };
  }

  const failure = describeExchangeError(authError);

  if (failure === CONFIRMATION_FAILURES.unavailable) {
    console.error(
      "[auth] email change confirmation failed unexpectedly",
      summarizeAuthErrorForLog(authError),
    );
  }

  // Same classification as sign-up links; the tokens happen to coincide.
  return { status: failure, userId: null, email: null };
}
