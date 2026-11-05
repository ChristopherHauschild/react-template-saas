import type { User } from "@supabase/supabase-js";

/**
 * The editable part of an account, as shown on the settings page. This object
 * crosses into a client component, so it carries only what the form displays:
 * no id, tokens, provider details or other metadata.
 */
export type Profile = {
  /** Display name; empty string when the account has none yet. */
  fullName: string;
  /** Sign-in address; null when the account has none. */
  email: string | null;
  /**
   * Address of an email change that was requested but not confirmed yet (Supabase's
   * `new_email`); null when there is none. The account still signs in with `email`.
   */
  pendingEmail: string | null;
  /** When the confirmation email(s) for `pendingEmail` went out (ISO 8601); null if unknown. */
  pendingEmailSentAt: string | null;
};

/**
 * Upper bound for the display name. Generous enough for long multi-part names;
 * small enough that the header's truncation and Supabase's metadata stay sane.
 */
export const PROFILE_NAME_MAX_LENGTH = 100;

/** `user_metadata` key the settings page writes the display name to. */
export const PROFILE_NAME_KEY = "full_name";

/**
 * `user_metadata` keys that may hold a display name, in order of preference.
 * Must match what the dashboard's account menu reads (its `toAccountMenuUser`),
 * so the form is pre-filled with the name the header already shows; writing to
 * `full_name` — first in that order — is what makes a saved name win there too.
 * The settings page test pins the two in agreement.
 */
const NAME_KEYS = [PROFILE_NAME_KEY, "name", "display_name"] as const;

/** Minimal shape consumed; lets callers pass a Supabase `User` or a test double. */
export type ProfileSource = Pick<
  User,
  "email" | "user_metadata" | "new_email" | "email_change_sent_at"
>;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derives the settings form's initial values from the authenticated user.
 * Missing or malformed metadata never breaks the page: a missing name becomes an
 * empty field and non-string values are ignored.
 */
export function toProfile(user: ProfileSource): Profile {
  const metadata: Record<string, unknown> = user.user_metadata ?? {};
  const fullName = NAME_KEYS.map((key) => nonEmptyString(metadata[key])).find(
    (value): value is string => value !== null,
  );

  const email = nonEmptyString(user.email);
  const requested = nonEmptyString(user.new_email);
  // Supabase clears `new_email` once the change is confirmed; should it ever
  // equal the current address anyway, there is nothing pending.
  const pendingEmail =
    requested !== null && requested.toLowerCase() !== email?.toLowerCase()
      ? requested
      : null;

  return {
    fullName: fullName ?? "",
    email,
    pendingEmail,
    pendingEmailSentAt:
      pendingEmail !== null ? nonEmptyString(user.email_change_sent_at) : null,
  };
}
