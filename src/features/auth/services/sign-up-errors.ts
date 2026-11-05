import { isAuthError } from "@supabase/supabase-js";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";

// The bounds live in config so the settings feature's change-password form
// applies the same policy; re-exported here for the auth feature's own imports.
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/**
 * Messages shown on the sign-up form. Raw Supabase messages are never surfaced:
 * they are not written for end users and their wording is not a contract.
 *
 * None of these messages may reveal whether an account already exists for an
 * email address; see `describeSignUpError` and the sign-up action for how the
 * duplicate-account case is handled.
 */
export const SIGN_UP_ERRORS = {
  invalidEmail: "Enter a valid email address.",
  passwordTooShort: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordTooLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  passwordMismatch: "Passwords do not match.",
  weakPassword: "Choose a stronger password.",
  signUpDisabled: "Sign-up is currently unavailable.",
  rateLimited: "Too many sign-up attempts. Please wait a moment and try again.",
  unavailable: "We couldn't create your account right now. Please try again in a moment.",
} as const;

export type SignUpErrorMessage = (typeof SIGN_UP_ERRORS)[keyof typeof SIGN_UP_ERRORS];

/**
 * The outcome of a failed `supabase.auth.signUp` call, from the action's point of
 * view:
 *
 * - `{ kind: "message" }`: shown to the user as-is.
 * - `{ kind: "account_exists" }`: the answer would reveal that the address is
 *   already registered. Must NOT be shown as an error — the action reports it
 *   exactly like a successful sign-up that awaits confirmation. (When
 *   confirmations are enabled Supabase already hides a confirmed duplicate behind
 *   a placeholder user; a 422 comes back when they are disabled, and a 429 when an
 *   unconfirmed duplicate is re-sent its confirmation too often.)
 */
export type SignUpFailure =
  | { kind: "message"; message: SignUpErrorMessage }
  | { kind: "account_exists" };

/**
 * Classifies a failure from `supabase.auth.signUp`.
 *
 * Decided on the stable error `code` (with the HTTP status as a fallback for rate
 * limiting), not on the message text. Anything unrecognised — including network
 * failures reaching Supabase — is reported as a temporary problem.
 */
export function describeSignUpError(error: unknown): SignUpFailure {
  if (!isAuthError(error)) {
    return { kind: "message", message: SIGN_UP_ERRORS.unavailable };
  }

  switch (error.code) {
    case "user_already_exists":
    case "email_exists":
    // Signing up an address that exists but is unconfirmed makes Supabase re-send
    // the confirmation, subject to the per-address `max_frequency` check — so this
    // code only ever surfaces for such an address. Reported like any other
    // "check your email" outcome; the global hourly quota shares the code and is
    // swept along (no email goes out, which the neutral copy allows for).
    case "over_email_send_rate_limit":
      return { kind: "account_exists" };
    case "weak_password":
      return { kind: "message", message: SIGN_UP_ERRORS.weakPassword };
    case "email_address_invalid":
    case "validation_failed":
      return { kind: "message", message: SIGN_UP_ERRORS.invalidEmail };
    case "signup_disabled":
    case "email_provider_disabled":
      return { kind: "message", message: SIGN_UP_ERRORS.signUpDisabled };
    case "over_request_rate_limit": // per-IP, checked before any lookup
      return { kind: "message", message: SIGN_UP_ERRORS.rateLimited };
  }

  if (error.status === 429) {
    return { kind: "message", message: SIGN_UP_ERRORS.rateLimited };
  }

  // Includes `email_address_not_authorized` (Supabase's built-in SMTP only
  // delivers to project members): an operator problem, not something the user
  // can fix, so it is reported as temporary and logged by the action.
  return { kind: "message", message: SIGN_UP_ERRORS.unavailable };
}
