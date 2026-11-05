import { combineChunks, stringFromBase64URL } from "@supabase/ssr";

/**
 * Whether a cookie belongs to the Supabase auth session.
 *
 * `@supabase/ssr` stores the session as `sb-<project-ref>-auth-token`, split into
 * `sb-<project-ref>-auth-token.0`, `.1`, … when it exceeds the cookie size limit,
 * plus `sb-<project-ref>-auth-token-code-verifier` during PKCE flows. This project
 * does not configure a custom cookie name (`cookieOptions.name`), so the default
 * prefix is the contract.
 */
export function isSupabaseAuthCookie(name: string): boolean {
  return name.startsWith("sb-") && name.includes("-auth-token");
}

/**
 * Name of a cookie that stores the session itself (`sb-<ref>-auth-token`, or a
 * chunk of it, `sb-<ref>-auth-token.<n>`). Deliberately narrower than
 * {@link isSupabaseAuthCookie}: the PKCE verifier (`…-auth-token-code-verifier`)
 * and the `…-auth-token-user` cookie also carry the prefix but are not sessions.
 */
const SESSION_COOKIE = /^(sb-.+-auth-token)(?:\.(\d+))?$/;

const BASE64_PREFIX = "base64-";

type Cookie = { name: string; value: string };

/**
 * Access tokens of every session currently stored in the cookies, decoded the
 * way `@supabase/ssr` stores them (chunked when large; `base64-` + base64url of
 * the session JSON, or raw JSON). Lets a caller check that a specific session —
 * the one GoTrue just issued — actually reached the cookie store, rather than
 * that *some* session-looking cookie exists (an old one, a verifier, …).
 *
 * Malformed cookies are ignored; nothing throws.
 */
export async function persistedAccessTokens(
  cookies: readonly Cookie[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const { name } of cookies) {
    const match = SESSION_COOKIE.exec(name);
    if (match) keys.add(match[1]);
  }

  const tokens = new Set<string>();

  for (const key of keys) {
    const stored = await combineChunks(
      key,
      (chunkName) => cookies.find((cookie) => cookie.name === chunkName)?.value ?? null,
    );
    if (!stored) continue;

    try {
      const json = stored.startsWith(BASE64_PREFIX)
        ? stringFromBase64URL(stored.slice(BASE64_PREFIX.length))
        : stored;
      const session: unknown = JSON.parse(json);

      if (
        typeof session === "object" &&
        session !== null &&
        typeof (session as { access_token?: unknown }).access_token === "string"
      ) {
        tokens.add((session as { access_token: string }).access_token);
      }
    } catch {
      // Not a session this app wrote; ignore.
    }
  }

  return tokens;
}
