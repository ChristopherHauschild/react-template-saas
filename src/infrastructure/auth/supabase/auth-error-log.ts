import { isAuthError } from "@supabase/supabase-js";

/**
 * What may be logged about a Supabase auth failure (sign-in, sign-out, profile
 * update, …): the error's class name and, for Supabase errors, its stable code
 * and HTTP status. Deliberately NOT the message, stack or cause — an unexpected
 * error from anywhere in the call chain could echo request details, and an auth
 * request can contain the user's credentials, tokens or profile data.
 *
 * Lives in infrastructure (not in a feature) because every feature that talks to
 * Supabase auth needs the same policy, and features may not import each other.
 */
export function summarizeAuthErrorForLog(error: unknown): {
  name: string;
  code?: string;
  status?: number;
} {
  if (isAuthError(error)) {
    return { name: error.name, code: error.code, status: error.status };
  }

  if (error instanceof Error) {
    return { name: error.name };
  }

  return { name: typeof error };
}
