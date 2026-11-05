import { isAuthError } from "@supabase/supabase-js";

/** Messages for revoking other sessions. Raw Supabase messages are never surfaced. */
export const SESSION_ERRORS = {
  sessionExpired:
    "Your own session has expired, so other sessions could not be signed out. Sign in again, then retry.",
  rateLimited: "Too many requests. Please wait a moment and try again.",
  unavailable:
    "We couldn't sign out your other sessions right now. Nothing was changed; please try again in a moment.",
} as const;

export type SessionErrorMessage = (typeof SESSION_ERRORS)[keyof typeof SESSION_ERRORS];

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
 * Maps a failure of `revokeOtherSessions` (GoTrue's `/logout?scope=others`) to a
 * message. The current session being gone is the important case: GoTrue then
 * refuses the request (401/403), and nothing was revoked — which is why the
 * helper must not use the client sign-out that hides those answers.
 */
export function describeSessionRevocationError(error: unknown): SessionErrorMessage {
  if (!isAuthError(error)) return SESSION_ERRORS.unavailable;

  if (error.name === "AuthSessionMissingError") return SESSION_ERRORS.sessionExpired;
  if (error.code !== undefined && SESSION_GONE_CODES.has(error.code)) {
    return SESSION_ERRORS.sessionExpired;
  }
  if (error.code === "over_request_rate_limit" || error.status === 429) {
    return SESSION_ERRORS.rateLimited;
  }
  if (error.status === 401 || error.status === 403) return SESSION_ERRORS.sessionExpired;

  return SESSION_ERRORS.unavailable;
}
