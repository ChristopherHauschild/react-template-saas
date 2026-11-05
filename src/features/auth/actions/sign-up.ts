"use server";

import { redirect } from "next/navigation";

import { z } from "zod";

import { ROUTES } from "@/config/routes";
import {
  createClient,
  sessionCookieFailure,
} from "@/infrastructure/auth/supabase/server";

import { summarizeAuthErrorForLog } from "../services/auth-error-log";
import { confirmationRedirectUrl } from "../services/confirmation-redirect";
import {
  describeSignUpError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SIGN_UP_ERRORS,
} from "../services/sign-up-errors";

/** Form fields; `field` in an error result names the one that should be flagged. */
export type SignUpField = "email" | "password" | "confirmPassword";

/**
 * Result of a sign-up attempt that did NOT redirect. Failures are returned (so the
 * form can show them inline) rather than thrown: a thrown error would land in the
 * nearest error boundary and replace the whole page with a generic crash screen.
 *
 * - `error`: something the user can act on. `field` is set when a specific input
 *   is at fault (validation); absent for problems that are not about one field.
 * - `confirmation_required`: the form should tell the user to check their inbox.
 *   Deliberately also returned when the address is already registered (see
 *   `signUp`), so the form copy must stay neutral — "check your email" — and never
 *   assert that a new account was created.
 *
 * `email` echoes the submitted address so the form can keep it after a failure
 * (React resets the form once the action settles). Passwords are never echoed.
 */
export type SignUpActionResult =
  | { status: "error"; error: string; field?: SignUpField; email: string }
  | { status: "confirmation_required"; email: string }
  | null;

/**
 * The email check mirrors the browser's `<input type="email">` (WHATWG/HTML5
 * pattern), so the server never rejects an address the form already accepted.
 *
 * Messages are attached here so that the first failing issue, in field order,
 * is the one reported: a submission with several problems is corrected one
 * field at a time, email first. The confirmation check only runs once both
 * passwords are individually valid.
 */
const signUpSchema = z
  .object({
    email: z
      .string({ error: SIGN_UP_ERRORS.invalidEmail })
      .trim()
      .pipe(
        z.email({ pattern: z.regexes.html5Email, error: SIGN_UP_ERRORS.invalidEmail }),
      ),
    password: z
      .string({ error: SIGN_UP_ERRORS.passwordTooShort })
      .min(PASSWORD_MIN_LENGTH, SIGN_UP_ERRORS.passwordTooShort)
      .max(PASSWORD_MAX_LENGTH, SIGN_UP_ERRORS.passwordTooLong),
    confirmPassword: z.string({ error: SIGN_UP_ERRORS.passwordMismatch }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: SIGN_UP_ERRORS.passwordMismatch,
  });

const SIGN_UP_FIELDS: readonly SignUpField[] = ["email", "password", "confirmPassword"];

function isSignUpField(value: unknown): value is SignUpField {
  return SIGN_UP_FIELDS.includes(value as SignUpField);
}

/**
 * Creates an account with email and password.
 *
 * Outcomes, in order of precedence:
 *
 * 1. Invalid input → `error` with the offending `field`, before contacting Supabase.
 * 2. Supabase returned a session (email confirmations disabled in the project) →
 *    the user is signed in; cookies were set by the server client; redirect to
 *    the dashboard.
 * 3. Supabase returned no session (confirmation email sent) → `confirmation_required`.
 *    The link in that email lands on `ROUTES.authCallback`, whose handler
 *    exchanges the code for a session and forwards to the dashboard.
 * 4. The address is already registered → ALSO `confirmation_required`. With
 *    confirmations enabled Supabase itself answers exactly like case 3 (a
 *    placeholder user with no identities and no error) to prevent account
 *    enumeration; with confirmations disabled it answers 422 `user_already_exists`,
 *    which this action folds into the same result so the two deployments behave
 *    alike and the response never reveals that an account exists. The cost is
 *    that, in the confirmations-disabled case, no email is actually sent; the
 *    neutral form copy ("check your email", "already have an account? sign in")
 *    is what keeps this honest.
 * 5. Any other failure → `error` with a user-facing message; raw Supabase
 *    messages are never surfaced, and nothing identifying is logged.
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function signUp(
  _prevState: SignUpActionResult,
  formData: FormData,
): Promise<SignUpActionResult> {
  const rawEmail = formData.get("email");
  const submittedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";

  const parsed = signUpSchema.safeParse({
    email: rawEmail,
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];

    return {
      status: "error",
      error: issue.message,
      field: isSignUpField(field) ? field : undefined,
      email: submittedEmail,
    };
  }

  const { email, password } = parsed.data;

  // Expected failures come back as `error`; anything that throws (client
  // construction, a non-auth error from supabase-js, a bug) must also be turned
  // into a result, or it would escape to the error boundary and replace the
  // sign-up page with a crash screen. Only the Supabase calls are wrapped:
  // `redirect()` below works by throwing and must not be caught.
  let signedIn: boolean;
  let authError: unknown;
  let cookieFailure: ReturnType<typeof sessionCookieFailure> = null;

  try {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: confirmationRedirectUrl() },
    });

    signedIn = data.session !== null;
    authError = error;
    cookieFailure = sessionCookieFailure(supabase);
  } catch (thrown) {
    console.error("[auth] sign-up threw unexpectedly", summarizeAuthErrorForLog(thrown));

    return { status: "error", error: SIGN_UP_ERRORS.unavailable, email };
  }

  if (authError) {
    const failure = describeSignUpError(authError);

    if (failure.kind === "account_exists") {
      // Not logged: the only interesting detail would be the email address.
      return { status: "confirmation_required", email };
    }

    if (failure.message === SIGN_UP_ERRORS.unavailable) {
      // Unexpected: worth a log line for operators. No credentials are logged.
      console.error(
        "[auth] sign-up failed unexpectedly",
        summarizeAuthErrorForLog(authError),
      );
    }

    return { status: "error", error: failure.message, email };
  }

  if (signedIn) {
    if (cookieFailure !== null) {
      // The account exists and Supabase returned a session, but it could not be
      // written to the browser: a redirect would land unauthenticated. The
      // account was created, so the user can sign in; say the sign-in is what
      // is unavailable right now.
      console.error(
        "[auth] sign-up could not persist the session",
        summarizeAuthErrorForLog(cookieFailure.error),
      );

      return { status: "error", error: SIGN_UP_ERRORS.unavailable, email };
    }

    redirect(ROUTES.dashboard);
  }

  return { status: "confirmation_required", email };
}
