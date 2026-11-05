import type { User } from "@supabase/supabase-js";

/**
 * What the Security card shows. Crosses into a client component: display values
 * only — no id, tokens, factor secrets or raw metadata.
 */
export type AccountSecurity = {
  email: string | null;
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string | null;
  /** Human-readable sign-in methods ("Email and password", "Google", …). */
  signInMethods: string[];
  /** Address of an unconfirmed email change, if any (also shown in the Email card). */
  pendingEmail: string | null;
};

export type AccountSecuritySource = Pick<
  User,
  | "email"
  | "email_confirmed_at"
  | "last_sign_in_at"
  | "created_at"
  | "app_metadata"
  | "new_email"
>;

const PROVIDER_LABELS: Record<string, string> = {
  email: "Email and password",
  google: "Google",
  github: "GitHub",
  apple: "Apple",
  azure: "Microsoft",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  discord: "Discord",
  facebook: "Facebook",
  twitter: "X (Twitter)",
  phone: "Phone",
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function label(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

export function toAccountSecurity(user: AccountSecuritySource): AccountSecurity {
  const metadata: Record<string, unknown> = user.app_metadata ?? {};
  const providers = Array.isArray(metadata.providers)
    ? metadata.providers.filter((p): p is string => typeof p === "string" && p !== "")
    : typeof metadata.provider === "string"
      ? [metadata.provider]
      : [];

  const email = nonEmpty(user.email);
  const pending = nonEmpty(user.new_email);

  return {
    email,
    emailConfirmedAt: nonEmpty(user.email_confirmed_at),
    lastSignInAt: nonEmpty(user.last_sign_in_at),
    createdAt: nonEmpty(user.created_at),
    signInMethods: [...new Set(providers)].map(label),
    pendingEmail:
      pending !== null && pending.toLowerCase() !== email?.toLowerCase() ? pending : null,
  };
}
