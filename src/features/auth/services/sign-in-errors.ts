import { isAuthError } from "@supabase/supabase-js";

/**
 * Messages shown on the sign-in form. Raw Supabase messages are never surfaced:
 * they are not written for end users and their wording is not a contract.
 */
export const SIGN_IN_ERRORS = {
  invalidInput: "Enter your email address and password.",
  invalidCredentials: "Invalid email or password.",
  emailNotConfirmed: "Please confirm your email address before signing in.",
  rateLimited: "Too many sign-in attempts. Please wait a moment and try again.",
  unavailable: "We couldn't sign you in right now. Please try again in a moment.",
} as const;

export type SignInErrorMessage = (typeof SIGN_IN_ERRORS)[keyof typeof SIGN_IN_ERRORS];

/**
 * Maps a failure from `supabase.auth.signInWithPassword` to a user-facing message.
 *
 * Decided on the stable error `code` (with the HTTP status as a fallback for rate
 * limiting), not on the message text. Anything unrecognised — including network
 * failures reaching Supabase — is reported as a temporary problem.
 */
export function describeSignInError(error: unknown): SignInErrorMessage {
  if (!isAuthError(error)) {
    return SIGN_IN_ERRORS.unavailable;
  }

  switch (error.code) {
    case "invalid_credentials":
    case "validation_failed":
    case "email_address_invalid":
      return SIGN_IN_ERRORS.invalidCredentials;
    case "email_not_confirmed":
      return SIGN_IN_ERRORS.emailNotConfirmed;
    case "over_request_rate_limit":
      return SIGN_IN_ERRORS.rateLimited;
  }

  if (error.status === 429) {
    return SIGN_IN_ERRORS.rateLimited;
  }

  return SIGN_IN_ERRORS.unavailable;
}
