import { isAuthError } from "@supabase/supabase-js";

/**
 * Messages shown on the email card. Raw Supabase messages are never surfaced:
 * they are not written for end users and their wording is not a contract.
 *
 * Note what is NOT here: any wording that says the address was changed. A
 * successful request only means confirmation email(s) went out; the change
 * happens when the link(s) are opened, and is reported by the callback.
 */
export const CHANGE_EMAIL_ERRORS = {
  invalidEmail: "Enter a valid email address.",
  sameEmail: "That is already the email address of this account.",
  /**
   * Another account already uses the address. Supabase reports this to an
   * authenticated user (`email_exists`); the copy stays matter-of-fact and
   * points at the two things the user can do.
   */
  emailTaken:
    "That email address can't be used for this account. If it's yours, you may already have another account with it; otherwise choose a different address.",
  sessionExpired: "Your session has expired. Please sign in again to change your email.",
  /** Per-address send limit: a confirmation for this address went out moments ago. */
  tooSoon:
    "A confirmation email was sent very recently. Check your inbox (and spam folder), or wait a minute before requesting another.",
  rateLimited: "Too many attempts. Please wait a moment and try again.",
  unavailable:
    "We couldn't send the confirmation email right now. Your address has not changed; please try again in a moment.",
} as const;

export type ChangeEmailErrorMessage =
  (typeof CHANGE_EMAIL_ERRORS)[keyof typeof CHANGE_EMAIL_ERRORS];

/** A user-facing failure, optionally pinned to the (only) input. */
export type ChangeEmailFailure = { message: ChangeEmailErrorMessage; field?: "email" };

const SESSION_GONE_CODES = new Set([
  "session_expired",
  "session_not_found",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
  "user_not_found",
  "user_banned",
]);

/**
 * Maps a failure from `supabase.auth.updateUser({ email })` to a user-facing
 * message. Decided on the stable error `code` (HTTP status as fallback), not on
 * the message text.
 *
 * `email_address_not_authorized` (Supabase's built-in SMTP only delivers to
 * project members) is an operator problem: reported as temporary so the user
 * is not told their address is wrong; the action logs it.
 */
export function describeChangeEmailError(error: unknown): ChangeEmailFailure {
  if (!isAuthError(error)) {
    return { message: CHANGE_EMAIL_ERRORS.unavailable };
  }

  if (error.name === "AuthSessionMissingError") {
    return { message: CHANGE_EMAIL_ERRORS.sessionExpired };
  }

  switch (error.code) {
    case "email_exists":
    case "user_already_exists":
      return { message: CHANGE_EMAIL_ERRORS.emailTaken, field: "email" };
    case "email_address_invalid":
    case "validation_failed":
      return { message: CHANGE_EMAIL_ERRORS.invalidEmail, field: "email" };
    case "over_email_send_rate_limit":
      return { message: CHANGE_EMAIL_ERRORS.tooSoon };
    case "over_request_rate_limit":
      return { message: CHANGE_EMAIL_ERRORS.rateLimited };
  }

  if (error.code !== undefined && SESSION_GONE_CODES.has(error.code)) {
    return { message: CHANGE_EMAIL_ERRORS.sessionExpired };
  }

  if (error.status === 401) {
    return { message: CHANGE_EMAIL_ERRORS.sessionExpired };
  }

  if (error.status === 429) {
    return { message: CHANGE_EMAIL_ERRORS.rateLimited };
  }

  // Includes `email_address_not_authorized`, `email_provider_disabled`,
  // `unexpected_failure` and network errors.
  return { message: CHANGE_EMAIL_ERRORS.unavailable };
}
