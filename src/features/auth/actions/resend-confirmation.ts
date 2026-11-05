"use server";

import { isAuthError } from "@supabase/supabase-js";
import { z } from "zod";

import { createClient } from "@/infrastructure/auth/supabase/server";

import { summarizeAuthErrorForLog } from "../services/auth-error-log";
import { confirmationRedirectUrl } from "../services/confirmation-redirect";
import {
  describeResendConfirmationError,
  RESEND_CONFIRMATION_ERRORS,
} from "../services/resend-confirmation-errors";

/**
 * Result of a resend request. Never redirects.
 *
 * - `sent`: the request was accepted. This does NOT mean an email is on its way:
 *   it is also the answer when the address is unknown, already confirmed, or
 *   rate-limited, so the response never reveals whether an account exists. The
 *   form copy must therefore stay conditional ("if this address still needs
 *   confirming…") and never assert delivery.
 * - `error`: a problem that is the same for every address (bad input, outage).
 *
 * `email` echoes the submitted address so the form can keep it.
 */
export type ResendConfirmationActionResult =
  | { status: "sent"; email: string }
  | { status: "error"; error: string; email: string }
  | null;

/** Same check as the sign-up form, so nothing it accepted is rejected here. */
const emailSchema = z
  .string()
  .trim()
  .pipe(z.email({ pattern: z.regexes.html5Email }));

/**
 * Asks Supabase to send a fresh confirmation email for an unconfirmed sign-up.
 *
 * Repeated submissions are bounded by Supabase (`max_frequency` per address and
 * the project's hourly email quota) and, in the form, by a cool-down after each
 * request. Neither limit is visible in the result (see `describeResendConfirmationError`).
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function resendConfirmation(
  _prevState: ResendConfirmationActionResult,
  formData: FormData,
): Promise<ResendConfirmationActionResult> {
  const rawEmail = formData.get("email");
  const submittedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";

  const parsed = emailSchema.safeParse(rawEmail);

  if (!parsed.success) {
    return {
      status: "error",
      error: RESEND_CONFIRMATION_ERRORS.invalidEmail,
      email: submittedEmail,
    };
  }

  const email = parsed.data;

  // Expected failures come back as `error`; anything that throws must also be
  // turned into a result, or it would escape to the error boundary.
  let authError: unknown;

  try {
    const supabase = await createClient();

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: confirmationRedirectUrl() },
    });

    authError = error;
  } catch (thrown) {
    console.error(
      "[auth] resend confirmation threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: RESEND_CONFIRMATION_ERRORS.unavailable, email };
  }

  if (!authError) {
    return { status: "sent", email };
  }

  const failure = describeResendConfirmationError(authError);

  if (failure.kind === "neutral") {
    // Operators should still see a misconfiguration; nothing identifying is logged.
    if (isAuthError(authError) && authError.code === "email_address_not_authorized") {
      console.warn(
        "[auth] confirmation email not sent: recipient not authorised (configure SMTP)",
        summarizeAuthErrorForLog(authError),
      );
    }

    return { status: "sent", email };
  }

  if (failure.message === RESEND_CONFIRMATION_ERRORS.unavailable) {
    console.error(
      "[auth] resend confirmation failed unexpectedly",
      summarizeAuthErrorForLog(authError),
    );
  }

  return { status: "error", error: failure.message, email };
}
