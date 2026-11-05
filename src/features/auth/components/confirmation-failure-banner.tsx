import type { ReactNode } from "react";

import {
  CONFIRMATION_FAILURES,
  type ConfirmationFailure,
} from "../services/email-confirmation-errors";

const CONTENT: Record<ConfirmationFailure, { title: string; body: ReactNode }> = {
  [CONFIRMATION_FAILURES.expired]: {
    title: "That confirmation link has expired or was already used",
    body: "If you haven't confirmed yet, request a new link below and open it within the hour. Already confirmed? Just sign in.",
  },
  [CONFIRMATION_FAILURES.invalid]: {
    title: "That confirmation link didn't work",
    body: "It may be incomplete, already used, or opened in a different browser than the one you signed up in. Request a new link below — it works from any browser. Already confirmed? Just sign in.",
  },
  [CONFIRMATION_FAILURES.unavailable]: {
    title: "We couldn't confirm your email",
    body: "Something went wrong on our end. Please try the link again in a moment; if it then reports as used, just sign in.",
  },
};

/**
 * Shown on the login page after a failed email-confirmation attempt
 * (`/auth/callback` redirects here with `?confirmation=<reason>`).
 *
 * `failure` is already a closed, URL-safe token this app generated itself
 * (`describeExchangeError` / `describeRedirectErrorCode`, round-tripped through
 * `parseConfirmationFailure`) — never Supabase's raw message or the query
 * parameter's raw text — so mapping it straight to copy is safe.
 */
export function ConfirmationFailureBanner({
  failure,
}: {
  failure: ConfirmationFailure | null;
}) {
  if (!failure) return null;

  const { title, body } = CONTENT[failure];

  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 opacity-90">{body}</p>
    </div>
  );
}
