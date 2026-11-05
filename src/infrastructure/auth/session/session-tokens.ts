import "server-only";

import { AuthSessionMissingError } from "@supabase/supabase-js";

import { createClient } from "../supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/*
 * How sessions end, and what that means for other devices
 * --------------------------------------------------------
 * A Supabase session is a refresh token (stored server-side, revocable) plus a
 * short-lived access token (a signed JWT, NOT revocable: it is valid until its
 * `exp`, `jwt_expiry` seconds after issue — 3600 in supabase/config.toml).
 *
 * Revoking a session deletes it in GoTrue. From then on:
 * - it can no longer be refreshed;
 * - THIS APP rejects it on the device's next request, even while its access
 *   token is unexpired: every server-side auth decision here goes through
 *   `auth.getUser()` (proxy, guards, `getCurrentUser`), which asks GoTrue, and
 *   GoTrue answers `session_not_found` for a deleted session. (Pinned by
 *   auth-verification.invariants.test.ts: nothing authorizes on `getSession()`
 *   or on locally verified claims.)
 * - BUT the Supabase Data API (PostgREST), Storage and Realtime only verify the
 *   JWT's signature and expiry. A device that still holds an unexpired access
 *   token can call them directly until it expires. With this project's schema
 *   that is SELECT on the user's own `public.subscriptions` rows (RLS), nothing
 *   else. Shortening `jwt_expiry` shortens that window; nothing revokes a JWT
 *   early.
 *
 * The UI states exactly this, using the lifetime read from the current token.
 */

/**
 * Lifetime (`exp - iat`) of an access token, read from its payload. For display
 * only — this is not a verification and is never used to authorize anything.
 */
export function accessTokenLifetimeSeconds(accessToken: string): number | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;

  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );

    if (typeof claims === "object" && claims !== null) {
      const { exp, iat } = claims as { exp?: unknown; iat?: unknown };

      if (typeof exp === "number" && typeof iat === "number" && exp > iat) {
        return exp - iat;
      }
    }
  } catch {
    // Malformed token: nothing to report.
  }

  return null;
}

export type CurrentSessionInfo = {
  /** How long an access token of this project lives; null when unknown. */
  accessTokenLifetimeSeconds: number | null;
};

/**
 * Informational facts about the current session, for the settings page. Reads
 * the session from the cookies (no extra round trip to Supabase unless the
 * token needs refreshing); never throws — unknown facts are null.
 */
export async function getCurrentSessionInfo(): Promise<CurrentSessionInfo> {
  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    return {
      accessTokenLifetimeSeconds: session
        ? accessTokenLifetimeSeconds(session.access_token)
        : null,
    };
  } catch {
    return { accessTokenLifetimeSeconds: null };
  }
}

export type RevokeOtherSessionsResult = { ok: true } | { ok: false; error: unknown };

/**
 * Revokes every session of the signed-in user EXCEPT the current one.
 *
 * Deliberately NOT `auth.signOut({ scope: "others" })`: supabase-js's client
 * sign-out swallows 401/403/404 answers and a missing session and returns
 * `{ error: null }` without having revoked anything — so a caller could report
 * "other devices signed out" after a no-op. `auth.admin.signOut(jwt, scope)`
 * calls the same `/logout?scope=others` endpoint (authenticated by the user's
 * own access token, not the service role) and returns GoTrue's real answer.
 *
 * Pass the request's server client when the caller already has one. Throws
 * only for non-auth failures (bugs, client construction); callers contain them.
 */
export async function revokeOtherSessions(
  client?: ServerClient,
): Promise<RevokeOtherSessionsResult> {
  const supabase = client ?? (await createClient());

  // The access token only identifies the session to GoTrue, which verifies it;
  // nothing is authorized on it here.
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) return { ok: false, error: sessionError };
  if (!session) return { ok: false, error: new AuthSessionMissingError() };

  const { error } = await supabase.auth.admin.signOut(session.access_token, "others");

  return error ? { ok: false, error } : { ok: true };
}
