import { isAuthError, isAuthWeakPasswordError } from "@supabase/supabase-js";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";

/** Form fields; `field` in an error names the one that should be flagged. */
export type ChangePasswordField = "currentPassword" | "newPassword" | "confirmPassword";

/**
 * Messages shown on the change-password form. Raw Supabase messages are never
 * surfaced: they are not written for end users and their wording is not a
 * contract. None of them may contain or hint at a password.
 */
export const CHANGE_PASSWORD_ERRORS = {
  currentPasswordRequired: "Enter your current password.",
  currentPasswordIncorrect: "Your current password is incorrect.",
  passwordTooShort: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordTooLong: `New password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  passwordMismatch: "New passwords do not match.",
  passwordUnchanged: "Choose a new password that differs from your current one.",
  weakPassword: "Choose a stronger password.",
  weakPasswordCharacters:
    "Password doesn't meet the complexity rules. Try mixing upper- and lower-case letters, digits and symbols.",
  weakPasswordBreached:
    "This password has appeared in a data breach and can't be used. Choose a different one.",
  reauthenticationRequired:
    "For security, please sign out and sign in again before changing your password.",
  sessionExpired:
    "Your session has expired. Please sign in again to change your password.",
  noPasswordAccount: "Password changes aren't available for this account.",
  rateLimited: "Too many attempts. Please wait a moment and try again.",
  unavailable:
    "We couldn't change your password right now. Please try again in a moment.",
} as const;

export type ChangePasswordErrorMessage =
  (typeof CHANGE_PASSWORD_ERRORS)[keyof typeof CHANGE_PASSWORD_ERRORS];

/** A user-facing failure, optionally pinned to the input that caused it. */
export type ChangePasswordFailure = {
  message: ChangePasswordErrorMessage;
  field?: ChangePasswordField;
};

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
 * Maps a failure of the *current password* check (a `signInWithPassword` made
 * with the stateless client) to a user-facing message.
 *
 * Decided on the stable error `code`, not the message text. A wrong password is
 * the expected failure and is pinned to its field. Anything unrecognised —
 * including network failures — is reported as a temporary problem.
 */
export function describeCurrentPasswordError(error: unknown): ChangePasswordFailure {
  if (!isAuthError(error)) {
    return { message: CHANGE_PASSWORD_ERRORS.unavailable };
  }

  switch (error.code) {
    case "invalid_credentials":
    case "validation_failed":
      return {
        message: CHANGE_PASSWORD_ERRORS.currentPasswordIncorrect,
        field: "currentPassword",
      };
    case "user_banned":
      return { message: CHANGE_PASSWORD_ERRORS.sessionExpired };
    case "over_request_rate_limit":
      return { message: CHANGE_PASSWORD_ERRORS.rateLimited };
  }

  if (error.status === 429) {
    return { message: CHANGE_PASSWORD_ERRORS.rateLimited };
  }

  // Includes `email_not_confirmed` and `email_provider_disabled`: the user is
  // signed in, so these point at a project misconfiguration, not at the input.
  return { message: CHANGE_PASSWORD_ERRORS.unavailable };
}

/**
 * Maps a failure of `supabase.auth.updateUser({ password })` to a user-facing
 * message.
 *
 * Weak passwords are explained as far as Supabase's `reasons` allow (without
 * echoing its message): a breached password is called out specifically because
 * "stronger" would not help; a complexity failure names the kinds of characters
 * to try. Session problems tell the user to sign in again; `reauthentication_needed`
 * (the project's "secure password change" setting, when the sign-in is too old)
 * is reported as such rather than as a generic failure.
 */
export function describeUpdatePasswordError(error: unknown): ChangePasswordFailure {
  if (!isAuthError(error)) {
    return { message: CHANGE_PASSWORD_ERRORS.unavailable };
  }

  if (isAuthWeakPasswordError(error) || error.code === "weak_password") {
    const reasons: readonly string[] = isAuthWeakPasswordError(error)
      ? (error.reasons ?? [])
      : [];

    if (reasons.includes("pwned")) {
      return {
        message: CHANGE_PASSWORD_ERRORS.weakPasswordBreached,
        field: "newPassword",
      };
    }
    if (reasons.includes("characters")) {
      return {
        message: CHANGE_PASSWORD_ERRORS.weakPasswordCharacters,
        field: "newPassword",
      };
    }
    return { message: CHANGE_PASSWORD_ERRORS.weakPassword, field: "newPassword" };
  }

  // supabase-js throws this one itself, before any request, when it holds no
  // session; it carries no `code`.
  if (error.name === "AuthSessionMissingError") {
    return { message: CHANGE_PASSWORD_ERRORS.sessionExpired };
  }

  switch (error.code) {
    case "same_password":
      return { message: CHANGE_PASSWORD_ERRORS.passwordUnchanged, field: "newPassword" };
    case "reauthentication_needed":
    case "reauthentication_not_valid":
      return { message: CHANGE_PASSWORD_ERRORS.reauthenticationRequired };
    case "validation_failed":
      // GoTrue's own length/format check on the new password (the app validates
      // first, so this is a policy mismatch rather than a user error; still about
      // the new password).
      return { message: CHANGE_PASSWORD_ERRORS.weakPassword, field: "newPassword" };
    case "over_request_rate_limit":
      return { message: CHANGE_PASSWORD_ERRORS.rateLimited };
  }

  if (error.code !== undefined && SESSION_GONE_CODES.has(error.code)) {
    return { message: CHANGE_PASSWORD_ERRORS.sessionExpired };
  }

  if (error.status === 401) {
    return { message: CHANGE_PASSWORD_ERRORS.sessionExpired };
  }

  if (error.status === 429) {
    return { message: CHANGE_PASSWORD_ERRORS.rateLimited };
  }

  return { message: CHANGE_PASSWORD_ERRORS.unavailable };
}
