import { isAuthError } from "@supabase/supabase-js";

import { ROUTES } from "@/config/routes";

/**
 * Why an email-confirmation link could not be turned into a session. Carried to
 * the login page as a query parameter (`?confirmation=<reason>`), so these are
 * short, stable, URL-safe tokens — never Supabase's message text.
 *
 * - `expired`: the link was valid but is past its lifetime; a new one can be
 *   requested.
 * - `invalid`: the link is malformed, was already used, or was opened in a
 *   different browser than the one that signed up (the PKCE verifier cookie is
 *   missing or does not match). Same outcome for the user: request a new link
 *   from the browser they will open it in.
 * - `unavailable`: Supabase could not be reached or failed unexpectedly; the link
 *   itself may still be fine — try again in a moment.
 */
export const CONFIRMATION_FAILURES = {
  expired: "expired",
  invalid: "invalid",
  unavailable: "unavailable",
} as const;

export type ConfirmationFailure =
  (typeof CONFIRMATION_FAILURES)[keyof typeof CONFIRMATION_FAILURES];

/** Query parameter on the login page that carries a {@link ConfirmationFailure}. */
export const CONFIRMATION_QUERY_PARAM = "confirmation";

/** Relative URL of the login page reporting the given failure. */
export function confirmationFailurePath(failure: ConfirmationFailure): string {
  const params = new URLSearchParams({ [CONFIRMATION_QUERY_PARAM]: failure });

  return `${ROUTES.login}?${params}`;
}

const KNOWN_FAILURES: readonly string[] = Object.values(CONFIRMATION_FAILURES);

/**
 * Whether requesting a new confirmation email is the remedy. It is for a dead
 * link; it is not for an outage, where the link the user has is probably fine.
 */
export function canRequestNewLink(failure: ConfirmationFailure): boolean {
  return failure !== CONFIRMATION_FAILURES.unavailable;
}

/**
 * The inverse of {@link confirmationFailurePath}: reads the login page's
 * `?confirmation=` query parameter back into a {@link ConfirmationFailure}.
 *
 * The value is untrusted (anyone can type `?confirmation=<anything>` into the
 * address bar) but is only ever compared against the closed set of known
 * reasons, never rendered — so an unrecognised or repeated value (Next passes
 * a repeated query key as `string[]`) safely yields `null`, showing no banner.
 */
export function parseConfirmationFailure(
  value: string | string[] | undefined,
): ConfirmationFailure | null {
  return typeof value === "string" && KNOWN_FAILURES.includes(value)
    ? (value as ConfirmationFailure)
    : null;
}

/**
 * Maps a failure from `supabase.auth.exchangeCodeForSession` to a reason.
 *
 * Decided on the stable error `code`, not on the message text. Anything
 * unrecognised — including network failures reaching Supabase — is reported as
 * `unavailable`, so a transient outage is not mistaken for a bad link.
 */
export function describeExchangeError(error: unknown): ConfirmationFailure {
  if (!isAuthError(error)) {
    return CONFIRMATION_FAILURES.unavailable;
  }

  switch (error.code) {
    case "flow_state_expired":
    case "otp_expired":
      return CONFIRMATION_FAILURES.expired;
    case "flow_state_not_found": // unknown code, or already exchanged (reused link)
    case "bad_code_verifier": // verifier cookie belongs to a different sign-up
    case "pkce_code_verifier_not_found": // no verifier cookie: different browser/device
    case "validation_failed": // malformed code
    case "bad_json":
      return CONFIRMATION_FAILURES.invalid;
  }

  return CONFIRMATION_FAILURES.unavailable;
}

/**
 * Maps the `error_code` Supabase appends to the redirect when it rejects the
 * link *before* issuing a code (e.g. `?error=access_denied&error_code=otp_expired`).
 * The value is untrusted query input and is only ever compared, never echoed.
 */
export function describeRedirectErrorCode(errorCode: string | null): ConfirmationFailure {
  return errorCode === "otp_expired"
    ? CONFIRMATION_FAILURES.expired
    : CONFIRMATION_FAILURES.invalid;
}
