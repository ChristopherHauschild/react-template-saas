import type { User } from "@supabase/supabase-js";

/**
 * What the account menu needs to know about the signed-in user — and nothing
 * more. This object crosses into a client component, so it carries derived
 * display strings only: no id, tokens, metadata or provider details.
 */
export type AccountMenuUser = {
  /** Display name; falls back to the email, then to a neutral label. */
  name: string;
  /** Shown under the name when it adds information; null when there is no email. */
  email: string | null;
  /** 1–2 uppercase characters for the avatar fallback. */
  initials: string;
};

/** Shown when the account has neither a usable name nor an email. */
export const ANONYMOUS_ACCOUNT_LABEL = "Account";

/**
 * `user_metadata` keys that may hold a display name, in order of preference.
 * Supabase's email sign-up stores whatever the app sent; OAuth providers populate
 * `full_name` / `name`; `display_name` is used by some dashboards and imports.
 */
const NAME_KEYS = ["full_name", "name", "display_name"] as const;

/** Minimal shape consumed; lets callers pass a Supabase `User` or a test double. */
export type AccountMenuSource = Pick<User, "email" | "user_metadata">;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Initials from a display label: first character of the first and last word
 * ("Mary Jane Watson" → "MW", "Prince" → "P"). For an email, the local part is
 * split on common separators so "jane.doe@example.com" → "JD", and a
 * plus-addressing tag is ignored ("jane+work@…" → "J"). Unicode-safe
 * (works on code points, not UTF-16 units) and uppercased in a locale-neutral way.
 */
export function initialsOf(label: string): string {
  const isEmail = label.includes("@");
  // For an email keep the local part and drop any plus-addressing tag ("+work").
  const base = isEmail ? label.slice(0, label.indexOf("@")).split("+")[0] : label;
  const words = base.split(/[\s._-]+/).filter(Boolean);

  if (words.length === 0) return "";

  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : "";

  return `${first}${last}`.toUpperCase();
}

/**
 * Derives the account menu's view model from the authenticated user.
 *
 * Missing or malformed profile data never breaks the header: a missing name
 * falls back to the email, a missing email to a neutral label, and non-string
 * metadata values are ignored. `user` may be null (defensive: the protected
 * layout has already redirected anonymous visitors).
 */
export function toAccountMenuUser(
  user: AccountMenuSource | null | undefined,
): AccountMenuUser {
  const email = nonEmptyString(user?.email);

  const metadata: Record<string, unknown> = user?.user_metadata ?? {};
  const name = NAME_KEYS.map((key) => nonEmptyString(metadata[key])).find(
    (value): value is string => value !== null,
  );

  const label = name ?? email ?? ANONYMOUS_ACCOUNT_LABEL;

  return {
    name: label,
    // The email is extra information only when the name is something else.
    email: email !== null && email !== label ? email : null,
    initials: initialsOf(label) || initialsOf(ANONYMOUS_ACCOUNT_LABEL),
  };
}
