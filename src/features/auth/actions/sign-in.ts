"use server";

import { redirect } from "next/navigation";

import { z } from "zod";

import { ROUTES } from "@/config/routes";
import {
  createClient,
  sessionCookieFailure,
} from "@/infrastructure/auth/supabase/server";

import { summarizeAuthErrorForLog } from "../services/auth-error-log";
import { describeSignInError, SIGN_IN_ERRORS } from "../services/sign-in-errors";

/**
 * Result of a sign-in attempt that did NOT redirect. Failures are returned (so the
 * form can show them inline) rather than thrown: a thrown error would land in the
 * nearest error boundary and replace the whole page with a generic crash screen.
 *
 * `email` echoes the submitted address so the form can keep it after a failure
 * (React resets the form once the action settles). The password is never echoed.
 *
 * `needsConfirmation` is set when Supabase refused the sign-in because the
 * address has not been confirmed yet, so the form can offer a new confirmation
 * link for `email` right there. Note that the `email_not_confirmed` answer
 * itself (pre-existing, `SIGN_IN_ERRORS.emailNotConfirmed`) tells the caller that
 * an unconfirmed account exists for the address; whether Supabase checks the
 * password first is a GoTrue detail this code does not rely on. The resend
 * offered here adds nothing to that: its answer is the same for every address.
 */
export type SignInActionResult = {
  error: string;
  email: string;
  needsConfirmation?: true;
} | null;

/**
 * The email check mirrors the browser's `<input type="email">` (WHATWG/HTML5
 * pattern), so the server never rejects an address the form already accepted —
 * e.g. `jane@intranet` on a self-hosted Supabase. Whether the account exists is
 * Supabase's call, not ours.
 */
const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email({ pattern: z.regexes.html5Email })),
  password: z.string().min(1),
});

/**
 * Signs the user in with email and password and sends them to the dashboard.
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function signIn(
  _prevState: SignInActionResult,
  formData: FormData,
): Promise<SignInActionResult> {
  const rawEmail = formData.get("email");
  const submittedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";

  const parsed = credentialsSchema.safeParse({
    email: rawEmail,
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: SIGN_IN_ERRORS.invalidInput, email: submittedEmail };
  }

  const { email } = parsed.data;

  // Expected authentication failures come back as `error`; anything that throws
  // (client construction, a non-auth error from supabase-js, a bug) must also be
  // turned into a result, or it would escape to the error boundary and replace
  // the login page with a crash screen. Only the Supabase calls are wrapped:
  // `redirect()` below works by throwing and must not be caught.
  let authError: unknown;
  let cookieFailure: ReturnType<typeof sessionCookieFailure> = null;

  try {
    const supabase = await createClient();

    const { error } = await supabase.auth.signInWithPassword(parsed.data);

    authError = error;
    cookieFailure = sessionCookieFailure(supabase);
  } catch (thrown) {
    console.error("[auth] sign-in threw unexpectedly", summarizeAuthErrorForLog(thrown));

    return { error: SIGN_IN_ERRORS.unavailable, email };
  }

  if (!authError && cookieFailure !== null) {
    // Supabase accepted the credentials but the session could not be written
    // to the browser: a redirect would land on the dashboard unauthenticated.
    console.error(
      "[auth] sign-in could not persist the session",
      summarizeAuthErrorForLog(cookieFailure.error),
    );

    return { error: SIGN_IN_ERRORS.unavailable, email };
  }

  if (authError) {
    const message = describeSignInError(authError);

    if (message === SIGN_IN_ERRORS.unavailable) {
      // Unexpected: worth a log line for operators. No credentials are logged.
      console.error(
        "[auth] sign-in failed unexpectedly",
        summarizeAuthErrorForLog(authError),
      );
    }

    if (message === SIGN_IN_ERRORS.emailNotConfirmed) {
      return { error: message, email, needsConfirmation: true };
    }

    return { error: message, email };
  }

  redirect(ROUTES.dashboard);
}
