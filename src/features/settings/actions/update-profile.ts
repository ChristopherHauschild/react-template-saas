"use server";

import { revalidatePath } from "next/cache";

import { z } from "zod";

import { ROUTES } from "@/config/routes";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { summarizeAuthErrorForLog } from "@/infrastructure/auth/supabase/auth-error-log";
import { createClient } from "@/infrastructure/auth/supabase/server";

import {
  PROFILE_NAME_KEY,
  PROFILE_NAME_MAX_LENGTH,
  toProfile,
} from "../services/profile";
import { recordSettingsActivity } from "../services/record-settings-activity";
import {
  describeUpdateProfileError,
  UPDATE_PROFILE_ERRORS,
} from "../services/update-profile-errors";

/** Form fields; `field` in an error result names the one that should be flagged. */
export type UpdateProfileField = "fullName";

/**
 * Result of a save attempt. Never redirects on success: the user stays on the
 * settings page and sees a confirmation. Failures are returned (so the form can
 * show them inline) rather than thrown: a thrown error would land in the route's
 * error boundary and replace the page with a generic crash screen.
 *
 * - `error`: something the user can act on. `field` is set when a specific input
 *   is at fault (validation); absent for problems that are not about one field.
 * - `saved`: the change was written.
 *
 * `fullName` echoes the submitted name (trimmed) so the form can keep it after
 * a failure and show the saved value after a success — React resets the form
 * once the action settles.
 */
export type UpdateProfileActionResult =
  | { status: "error"; error: string; field?: UpdateProfileField; fullName: string }
  | { status: "saved"; fullName: string }
  | null;

/** Unicode "control" category: line breaks, tabs, NUL, C1 controls, … */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Messages are attached here so that the first failing issue is the one
 * reported. Trimming happens before the length checks, so a name made of
 * spaces is "required", not "too long".
 */
const profileSchema = z.object({
  fullName: z
    .string({ error: UPDATE_PROFILE_ERRORS.nameRequired })
    .trim()
    .min(1, UPDATE_PROFILE_ERRORS.nameRequired)
    .max(PROFILE_NAME_MAX_LENGTH, UPDATE_PROFILE_ERRORS.nameTooLong)
    .refine(
      (value) => !CONTROL_CHARACTERS.test(value),
      UPDATE_PROFILE_ERRORS.nameInvalid,
    ),
});

const PROFILE_FIELDS: readonly UpdateProfileField[] = ["fullName"];

function isProfileField(value: unknown): value is UpdateProfileField {
  return PROFILE_FIELDS.includes(value as UpdateProfileField);
}

/**
 * Saves the signed-in user's display name to their Supabase `user_metadata`.
 *
 * Outcomes, in order of precedence:
 *
 * 1. No signed-in user → redirect to the login page, before reading the input.
 *    The page is behind the `(protected)` guard, but a Server Action is an HTTP
 *    endpoint of its own and must not trust that.
 * 2. Invalid input → `error` with the offending `field`, before contacting Supabase.
 * 3. Written → `saved`, and the settings route is revalidated so the re-render
 *    that follows the action (page and layout, hence the header's account menu)
 *    shows the new name. If the name actually differs from the one the form
 *    showed, a `profile.updated` event (old and new name) is appended to the
 *    user's activity history. Best effort: the name IS saved at this point, so
 *    a failure to record it is logged, never reported to the user or allowed
 *    to fail the action (`recordSettingsActivity`). Saving the same name again
 *    is not a change and leaves no entry.
 * 4. Any other failure → `error` with a user-facing message; raw Supabase
 *    messages are never surfaced, and nothing identifying is logged.
 *
 * Only `full_name` is written; other metadata keys are left untouched (Supabase
 * merges `data` into the existing metadata).
 *
 * Compatible with `useActionState`: React calls it with `(prevState, formData)`.
 */
export async function updateProfile(
  _prevState: UpdateProfileActionResult,
  formData: FormData,
): Promise<UpdateProfileActionResult> {
  const user = await requireAuth();

  const rawName = formData.get("fullName");
  const submittedName = typeof rawName === "string" ? rawName.trim() : "";

  const parsed = profileSchema.safeParse({ fullName: rawName });

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];

    return {
      status: "error",
      error: issue.message,
      field: isProfileField(field) ? field : undefined,
      fullName: submittedName,
    };
  }

  const { fullName } = parsed.data;

  // Expected failures come back as `error`; anything that throws (client
  // construction, a non-auth error from supabase-js, a bug) must also be turned
  // into a result, or it would escape to the error boundary.
  let authError: unknown;

  try {
    const supabase = await createClient();

    const { error } = await supabase.auth.updateUser({
      data: { [PROFILE_NAME_KEY]: fullName },
    });

    authError = error;
  } catch (thrown) {
    console.error(
      "[settings] profile update threw unexpectedly",
      summarizeAuthErrorForLog(thrown),
    );

    return { status: "error", error: UPDATE_PROFILE_ERRORS.unavailable, fullName };
  }

  if (authError) {
    const message = describeUpdateProfileError(authError);

    if (message === UPDATE_PROFILE_ERRORS.unavailable) {
      // Unexpected: worth a log line for operators. No profile data is logged.
      console.error(
        "[settings] profile update failed unexpectedly",
        summarizeAuthErrorForLog(authError),
      );
    }

    return { status: "error", error: message, fullName };
  }

  // The name the form was pre-filled with (same derivation as the page), so
  // the history says what the user saw change. `user` is the guard's verified
  // lookup, made before the write.
  const previousName = toProfile(user).fullName;

  if (fullName !== previousName) {
    await recordSettingsActivity(user.id, {
      type: "profile.updated",
      details: { changes: { fullName: { from: previousName || null, to: fullName } } },
    });
  }

  revalidatePath(ROUTES.settings);

  return { status: "saved", fullName };
}
