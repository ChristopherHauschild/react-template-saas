"use server";

import { revalidatePath } from "next/cache";

import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";
import { ROUTES } from "@/config/routes";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { revokeOtherSessions } from "@/infrastructure/auth/session/session-tokens";
import { summarizeAuthErrorForLog } from "@/infrastructure/auth/supabase/auth-error-log";
import { createClient } from "@/infrastructure/auth/supabase/server";
import { createStatelessClient } from "@/infrastructure/auth/supabase/stateless";

import {
  CHANGE_PASSWORD_ERRORS,
  type ChangePasswordField,
  describeCurrentPasswordError,
  describeUpdatePasswordError,
} from "../services/change-password-errors";
import { recordSettingsActivity } from "../services/record-settings-activity";

export type { ChangePasswordField } from "../services/change-password-errors";

/**
 * Result of a change attempt. Never redirects on success: the user stays on the
 * settings page and sees a confirmation. Failures are returned (so the form can
 * show them inline) rather than thrown: a thrown error would land in the route's
 * error boundary and replace the page with a generic crash screen.
 *
 * - `error`: something the user can act on. `field` is set when a specific input
 *   is at fault; absent for problems that are not about one field.
 * - `changed`: the new password is in effect. `otherSessionsSignedOut` says
 *   whether every OTHER session of the account was revoked as well (see below);
 *   the form's copy must only claim that when it is true.
 *
 * Unlike the profile action, NOTHING is echoed back: the form's fields are
 * passwords and are always cleared after an attempt.
 */
export type ChangePasswordActionResult =
  | { status: "error"; error: string; field?: ChangePasswordField }
  | { status: "changed"; otherSessionsSignedOut: boolean }
  | null;

/**
 * Messages are attached here so that the first failing issue, in field order,
 * is the one reported: current password first, then the new one, then the
 * confirmation. The cross-field checks only run once every field is
 * individually valid. Passwords are NOT trimmed: whitespace is part of them.
 */
const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ error: CHANGE_PASSWORD_ERRORS.currentPasswordRequired })
      .min(1, CHANGE_PASSWORD_ERRORS.currentPasswordRequired),
    newPassword: z
      .string({ error: CHANGE_PASSWORD_ERRORS.passwordTooShort })
      .min(PASSWORD_MIN_LENGTH, CHANGE_PASSWORD_ERRORS.passwordTooShort)
      .max(PASSWORD_MAX_LENGTH, CHANGE_PASSWORD_ERRORS.passwordTooLong),
    confirmPassword: z.string({ error: CHANGE_PASSWORD_ERRORS.passwordMismatch }),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: CHANGE_PASSWORD_ERRORS.passwordMismatch,
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ["newPassword"],
    message: CHANGE_PASSWORD_ERRORS.passwordUnchanged,
  });

const FIELDS: readonly ChangePasswordField[] = [
  "currentPassword",
  "newPassword",
  "confirmPassword",
];

function isField(value: unknown): value is ChangePasswordField {
  return FIELDS.includes(value as ChangePasswordField);
}

/**
 * Changes the signed-in user's password.
 *
 * Outcomes, in order of precedence:
 *
 * 1. No signed-in user → redirect to the login page, before reading the input.
 *    The page is behind the `(protected)` guard, but a Server Action is an HTTP
 *    endpoint of its own and must not trust that.
 * 2. An account without an email cannot have its password verified → `error`.
 * 3. Invalid input → `error` with the offending `field`, before contacting Supabase.
 * 4. Current password wrong → `error` on that field. The check is a sign-in made
 *    with a *stateless* client, so the browser's session is neither replaced nor
 *    refreshed by it; the throwaway session it yields is revoked right away.
 *    Requiring the current password means a hijacked or left-open session cannot
 *    be used to lock the owner out.
 * 5. Supabase refuses the new password (weak, breached, unchanged, sign-in too
 *    old for the project's secure-password-change setting, session gone) →
 *    `error` with a specific message.
 * 6. Written → `changed`. Supabase keeps the current session valid. Every OTHER
 *    session of the account is then revoked (`revokeOtherSessions`): a password
 *    is typically changed to evict someone who should not have access.
 *    (Recent GoTrue versions also end other sessions on a password update; the
 *    explicit revocation makes the outcome — and what the UI may claim —
 *    independent of the server version.) Best effort: the password IS changed
 *    at this point, so a failure here is reported in the result
 *    (`otherSessionsSignedOut: false`), not as an error. `true` is reported only
 *    on GoTrue's own confirmation — see `revokeOtherSessions` for why the
 *    client sign-out cannot be trusted for that. What revocation does NOT do
 *    (end access tokens already issued) is for the UI to state.
 *    Finally a `password.changed` event — carrying only whether the other
 *    sessions were signed out, never a password — is appended to the activity
 *    history, and the settings route is revalidated so the history card shows
 *    it. Best effort: the password IS changed at this point, so a failure to
 *    record is logged, never reported or allowed to fail the action. Nothing
 *    is recorded on any earlier outcome.
 * 7. Any other failure → `error` with a generic message; raw Supabase messages are
 *    never surfaced, and nothing identifying is logged.
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function changePassword(
  _prevState: ChangePasswordActionResult,
  formData: FormData,
): Promise<ChangePasswordActionResult> {
  const user = await requireAuth();

  if (!user.email) {
    return { status: "error", error: CHANGE_PASSWORD_ERRORS.noPasswordAccount };
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];

    return {
      status: "error",
      error: issue.message,
      field: isField(field) ? field : undefined,
    };
  }

  const { currentPassword, newPassword } = parsed.data;

  // Expected failures come back as `error`; anything that throws (client
  // construction, a non-auth error from supabase-js, a bug) must also be turned
  // into a result, or it would escape to the error boundary. The two Supabase
  // calls are reported separately so operators can tell them apart.

  // --- 1. Verify the current password without touching the browser's session.
  let verifyError: unknown;

  try {
    const verifier = createStatelessClient();

    const { error } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });

    verifyError = error;

    if (!error) {
      // The check produced a session nobody will use; revoke it. Best effort:
      // a failure here changes nothing for the user (the token expires on its own).
      const { error: signOutError } = await verifier.auth.signOut({ scope: "local" });

      if (signOutError) {
        console.warn(
          "[settings] could not revoke the password-verification session",
          summarizeAuthErrorForLog(signOutError),
        );
      }
    }
  } catch (thrown) {
    console.error(
      "[settings] current password check threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: CHANGE_PASSWORD_ERRORS.unavailable };
  }

  if (verifyError) {
    const failure = describeCurrentPasswordError(verifyError);

    if (failure.message === CHANGE_PASSWORD_ERRORS.unavailable) {
      console.error(
        "[settings] current password check failed unexpectedly",
        summarizeAuthErrorForLog(verifyError),
      );
    }

    return { status: "error", error: failure.message, field: failure.field };
  }

  // --- 2. Set the new password as the signed-in user.
  let supabase: Awaited<ReturnType<typeof createClient>>;
  let updateError: unknown;

  try {
    supabase = await createClient();

    const { error } = await supabase.auth.updateUser({ password: newPassword });

    updateError = error;
  } catch (thrown) {
    console.error(
      "[settings] password update threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: CHANGE_PASSWORD_ERRORS.unavailable };
  }

  if (updateError) {
    const failure = describeUpdatePasswordError(updateError);

    if (failure.message === CHANGE_PASSWORD_ERRORS.unavailable) {
      console.error(
        "[settings] password update failed unexpectedly",
        summarizeAuthErrorForLog(updateError),
      );
    }

    return { status: "error", error: failure.message, field: failure.field };
  }

  // --- 3. Evict every other session; this one stays signed in.
  let otherSessionsSignedOut = false;

  try {
    const revoked = await revokeOtherSessions(supabase);

    if (revoked.ok) {
      otherSessionsSignedOut = true;
    } else {
      console.warn(
        "[settings] other sessions could not be signed out after a password change",
        summarizeAuthErrorForLog(revoked.error),
      );
    }
  } catch (thrown) {
    console.warn(
      "[settings] signing out other sessions threw after a password change",
      summarizeAuthErrorForLog(thrown),
    );
  }

  // --- 4. Record the change (only now: the password is in effect) and show it.
  await recordSettingsActivity(user.id, {
    type: "password.changed",
    details: { otherSessionsSignedOut },
  });

  revalidatePath(ROUTES.settings);

  return { status: "changed", otherSessionsSignedOut };
}
