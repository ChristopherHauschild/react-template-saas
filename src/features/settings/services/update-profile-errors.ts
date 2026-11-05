import { isAuthError } from "@supabase/supabase-js";

import { PROFILE_NAME_MAX_LENGTH } from "./profile";

/**
 * Messages shown on the profile form. Raw Supabase messages are never surfaced:
 * they are not written for end users and their wording is not a contract.
 */
export const UPDATE_PROFILE_ERRORS = {
  nameRequired: "Enter your name.",
  nameTooLong: `Name must be at most ${PROFILE_NAME_MAX_LENGTH} characters.`,
  nameInvalid: "Name can't contain line breaks or control characters.",
  sessionExpired: "Your session has expired. Please sign in again to save changes.",
  rateLimited: "Too many changes in a short time. Please wait a moment and try again.",
  unavailable: "We couldn't save your changes right now. Please try again in a moment.",
} as const;

export type UpdateProfileErrorMessage =
  (typeof UPDATE_PROFILE_ERRORS)[keyof typeof UPDATE_PROFILE_ERRORS];

/**
 * Maps a failure from `supabase.auth.updateUser` to a user-facing message.
 *
 * Decided on the stable error `code` (with the HTTP status as a fallback), not on
 * the message text. The action has already verified the session, so a session
 * problem here means it ended between that check and the write; the user is
 * told to sign in again rather than shown a generic failure. Anything
 * unrecognised — including network failures reaching Supabase — is reported as
 * a temporary problem.
 */
export function describeUpdateProfileError(error: unknown): UpdateProfileErrorMessage {
  if (!isAuthError(error)) {
    return UPDATE_PROFILE_ERRORS.unavailable;
  }

  // supabase-js throws this one itself, before any request, when it holds no
  // session; it carries no `code`.
  if (error.name === "AuthSessionMissingError") {
    return UPDATE_PROFILE_ERRORS.sessionExpired;
  }

  switch (error.code) {
    case "session_expired":
    case "session_not_found":
    case "refresh_token_not_found":
    case "refresh_token_already_used":
    case "bad_jwt":
    case "user_not_found":
    case "user_banned":
      return UPDATE_PROFILE_ERRORS.sessionExpired;
    case "over_request_rate_limit":
      return UPDATE_PROFILE_ERRORS.rateLimited;
  }

  if (error.status === 401) {
    return UPDATE_PROFILE_ERRORS.sessionExpired;
  }

  if (error.status === 429) {
    return UPDATE_PROFILE_ERRORS.rateLimited;
  }

  return UPDATE_PROFILE_ERRORS.unavailable;
}
