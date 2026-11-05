"use server";

import { revalidatePath } from "next/cache";

import { isAuthError } from "@supabase/supabase-js";
import { z } from "zod";

import { ROUTES } from "@/config/routes";
import { confirmationRedirectUrl } from "@/infrastructure/auth/confirmation-redirect";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { summarizeAuthErrorForLog } from "@/infrastructure/auth/supabase/auth-error-log";
import { createClient } from "@/infrastructure/auth/supabase/server";

import {
  CHANGE_EMAIL_ERRORS,
  describeChangeEmailError,
} from "../services/change-email-errors";
import { recordSettingsActivity } from "../services/record-settings-activity";

/**
 * Result of an email-change request. Never redirects.
 *
 * - `confirmation_sent`: Supabase accepted the new address and sent the
 *   confirmation email(s). The account's email has NOT changed: it changes when
 *   the link is opened (both links, when the project requires the current
 *   address to approve too). The form copy must say exactly that and no more.
 * - `error`: something the user can act on; `field` is set when the address
 *   itself is at fault.
 *
 * `email` echoes the submitted address (trimmed) so the form can keep it after a
 * failure, and name it in the confirmation-sent notice.
 */
export type ChangeEmailActionResult =
  | { status: "error"; error: string; field?: "email"; email: string }
  | { status: "confirmation_sent"; email: string }
  | null;

/**
 * Same check as sign-up, so an address the sign-up form accepted is never
 * rejected here. Whether it can be used is Supabase's call.
 */
const emailSchema = z
  .string({ error: CHANGE_EMAIL_ERRORS.invalidEmail })
  .trim()
  .pipe(
    z.email({ pattern: z.regexes.html5Email, error: CHANGE_EMAIL_ERRORS.invalidEmail }),
  );

/**
 * Asks Supabase to change the signed-in user's email address.
 *
 * Outcomes, in order of precedence:
 *
 * 1. No signed-in user → redirect to the login page, before reading the input.
 * 2. Invalid address, or the account's current address → `error` on the field,
 *    before contacting Supabase. (Re-submitting the address of a *pending*
 *    change is allowed: it makes Supabase send fresh links — the "resend".)
 * 3. Supabase refuses it (another account uses it, per-address send limit, rate
 *    limit, session gone) → `error` with a specific message.
 * 4. Accepted → `confirmation_sent`. An `email.change_requested` event is
 *    appended to the activity history — marked as a resend when the address
 *    was already the pending one — and the settings route is revalidated so
 *    the re-render shows the address as pending and the history shows the
 *    request. Supabase records the address as `new_email` and emails a link
 *    to it (and, with `double_confirm_changes`, to the current address as
 *    well); the links land on `/auth/callback`, which records `email.changed`
 *    once a link completes the change — nothing here claims the address
 *    changed. Recording is best effort: the request IS accepted at this
 *    point, so a failure to record is logged, never reported or allowed to
 *    fail the action. Nothing is recorded on any earlier outcome.
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function changeEmail(
  _prevState: ChangeEmailActionResult,
  formData: FormData,
): Promise<ChangeEmailActionResult> {
  const user = await requireAuth();

  const rawEmail = formData.get("email");
  const submittedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";

  const parsed = emailSchema.safeParse(rawEmail);

  if (!parsed.success) {
    return {
      status: "error",
      error: CHANGE_EMAIL_ERRORS.invalidEmail,
      field: "email",
      email: submittedEmail,
    };
  }

  const email = parsed.data;

  if (user.email && email.toLowerCase() === user.email.toLowerCase()) {
    return {
      status: "error",
      error: CHANGE_EMAIL_ERRORS.sameEmail,
      field: "email",
      email,
    };
  }

  // Expected failures come back as `error`; anything that throws must also be
  // turned into a result, or it would escape to the error boundary.
  let authError: unknown;

  try {
    const supabase = await createClient();

    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: confirmationRedirectUrl() },
    );

    authError = error;
  } catch (thrown) {
    console.error(
      "[settings] email change threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: CHANGE_EMAIL_ERRORS.unavailable, email };
  }

  if (authError) {
    const failure = describeChangeEmailError(authError);

    if (failure.message === CHANGE_EMAIL_ERRORS.unavailable) {
      // Operators should see a misconfiguration (SMTP allow-list) or an outage;
      // nothing identifying is logged.
      const log =
        isAuthError(authError) && authError.code === "email_address_not_authorized"
          ? console.warn
          : console.error;

      log(
        "[settings] email change confirmation could not be sent",
        summarizeAuthErrorForLog(authError),
      );
    }

    return { status: "error", error: failure.message, field: failure.field, email };
  }

  // Re-submitting the pending address asks for fresh links, not a new change.
  const resend =
    typeof user.new_email === "string" &&
    user.new_email.toLowerCase() === email.toLowerCase();

  await recordSettingsActivity(user.id, {
    type: "email.change_requested",
    details: { from: user.email ?? null, to: email, resend },
  });

  revalidatePath(ROUTES.settings);

  return { status: "confirmation_sent", email };
}
