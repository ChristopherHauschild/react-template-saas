"use server";

import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/routes";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { revokeOtherSessions } from "@/infrastructure/auth/session/session-tokens";
import { summarizeAuthErrorForLog } from "@/infrastructure/auth/supabase/auth-error-log";

import { recordSettingsActivity } from "../services/record-settings-activity";
import {
  describeSessionRevocationError,
  SESSION_ERRORS,
} from "../services/session-errors";

/**
 * Result of "Sign out other sessions". Never redirects on success: this session
 * stays signed in.
 *
 * - `signed_out`: GoTrue confirmed that every OTHER session of the account was
 *   revoked (possibly none existed — the request is idempotent, and GoTrue does
 *   not say how many there were, so the UI must not claim a number). `at` is
 *   when it happened (server time, ISO 8601), so a repeated request visibly
 *   takes effect again.
 * - `error`: nothing was revoked (or it cannot be known that anything was).
 */
export type SignOutOtherSessionsResult =
  | { status: "signed_out"; at: string }
  | { status: "error"; error: string }
  | null;

/**
 * Revokes every session of the signed-in user except the current one.
 *
 * 1. No signed-in user → redirect to the login page (the guard; this also
 *    confirms with GoTrue that the current session still exists).
 * 2. GoTrue refuses (the current session ended in the meantime, rate limit,
 *    outage) → `error`; nothing is claimed.
 * 3. Confirmed → `signed_out`. A `sessions.others_signed_out` event is appended
 *    to the activity history and the settings route is revalidated so the
 *    history card shows it. Best effort: the sessions ARE revoked at this
 *    point, so a failure to record is logged, never reported or allowed to
 *    fail the action. Nothing is recorded on any earlier outcome.
 *
 * Takes no input; the form carries none. Repeated submissions are harmless: each
 * one revokes whatever other sessions exist at that moment (and each is recorded).
 *
 * Compatible with `useActionState` (React passes `(prevState, formData)`, both
 * unused — like `createPortalSession`, the action takes no input).
 */
export async function signOutOtherSessions(): Promise<SignOutOtherSessionsResult> {
  const user = await requireAuth();

  let revoked: Awaited<ReturnType<typeof revokeOtherSessions>>;

  try {
    revoked = await revokeOtherSessions();
  } catch (thrown) {
    console.error(
      "[settings] signing out other sessions threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: SESSION_ERRORS.unavailable };
  }

  if (!revoked.ok) {
    const message = describeSessionRevocationError(revoked.error);

    if (message === SESSION_ERRORS.unavailable) {
      console.error(
        "[settings] signing out other sessions failed unexpectedly",
        summarizeAuthErrorForLog(revoked.error),
      );
    }

    return { status: "error", error: message };
  }

  await recordSettingsActivity(user.id, {
    type: "sessions.others_signed_out",
    details: {},
  });

  revalidatePath(ROUTES.settings);

  return { status: "signed_out", at: new Date().toISOString() };
}
