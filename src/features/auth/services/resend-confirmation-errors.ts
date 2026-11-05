import { isAuthError } from "@supabase/supabase-js";

/**
 * Messages shown by the resend-confirmation form. Raw Supabase messages are
 * never surfaced. Neither message depends on whether an account exists.
 */
export const RESEND_CONFIRMATION_ERRORS = {
  invalidEmail: "Enter a valid email address.",
  unavailable: "We couldn't send a new link right now. Please try again in a moment.",
} as const;

export type ResendConfirmationErrorMessage =
  (typeof RESEND_CONFIRMATION_ERRORS)[keyof typeof RESEND_CONFIRMATION_ERRORS];

/**
 * How the action should report a failure from `supabase.auth.resend`:
 *
 * - `{ kind: "neutral" }`: answer exactly as if a link had been sent. Used for
 *   every outcome whose existence would tell the caller something about the
 *   account — above all rate limiting: Supabase enforces its per-address
 *   `max_frequency` only AFTER finding the user, so a "try again in N seconds"
 *   reply would confirm that the address is registered and unconfirmed. (Supabase
 *   itself already answers 200 for unknown and already-confirmed addresses.)
 * - `{ kind: "message" }`: a problem that is the same for every address.
 */
export type ResendConfirmationFailure =
  | { kind: "neutral" }
  | { kind: "message"; message: ResendConfirmationErrorMessage };

/**
 * Classifies a failure from `supabase.auth.resend({ type: "signup" })`.
 *
 * Decided on the stable error `code` (with the HTTP status as a fallback for
 * rate limiting), not on the message text. Anything unrecognised — including
 * network failures reaching Supabase — is reported as a temporary problem so
 * the user knows to retry instead of waiting for an email that will not come.
 */
export function describeResendConfirmationError(
  error: unknown,
): ResendConfirmationFailure {
  if (!isAuthError(error)) {
    return { kind: "message", message: RESEND_CONFIRMATION_ERRORS.unavailable };
  }

  switch (error.code) {
    // Rate limits: per-address (after the lookup) and global share one code.
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    // Account-state answers. Supabase normally hides these behind a 200 for this
    // endpoint; handled anyway so a change there cannot turn into an oracle.
    case "user_not_found":
    case "email_exists":
    case "user_already_exists":
    case "email_not_confirmed":
    // Built-in SMTP only delivers to project members: reaching this means the
    // account exists. Operators still need to know — the action logs it.
    case "email_address_not_authorized":
      return { kind: "neutral" };
    case "validation_failed":
    case "email_address_invalid":
      return { kind: "message", message: RESEND_CONFIRMATION_ERRORS.invalidEmail };
  }

  if (error.status === 429) {
    return { kind: "neutral" };
  }

  // Includes `email_provider_disabled` / `signup_disabled`: checked before any
  // lookup, so safe to report — but there is nothing the user can do about them.
  return { kind: "message", message: RESEND_CONFIRMATION_ERRORS.unavailable };
}
