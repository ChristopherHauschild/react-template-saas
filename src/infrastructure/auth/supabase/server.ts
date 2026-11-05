import "server-only";

import { cookies, headers } from "next/headers";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { clientEnv } from "@/config/env.client";

import { isServerActionRequest, keepDeadSessionCookies } from "./action-session-cookies";
import { isReadonlyCookiesError } from "./readonly-cookies";

/**
 * A failed attempt to write the session cookies, kept per client so that a
 * caller which is about to redirect on the strength of those cookies (sign-in,
 * sign-up, email confirmation) can find out they were not written. `readonly`
 * is the expected render-time case; `unexpected` is a bug or a broken store.
 */
export type SessionCookieFailure = {
  kind: "readonly" | "unexpected";
  error: unknown;
  /** How many cookies the write covered. */
  cookies: number;
};

const failures = new WeakMap<SupabaseClient, { last: SessionCookieFailure | null }>();

/**
 * The last failure to persist the session cookies through `client`, or `null`
 * if every write succeeded (or none was needed). Server Actions and Route
 * Handlers can write cookies, so for them any value here is a real problem:
 * supabase-js holds a session this request can use, but the browser will not.
 */
export function sessionCookieFailure(
  client: SupabaseClient,
): SessionCookieFailure | null {
  return failures.get(client)?.last ?? null;
}

export async function createClient() {
  const cookieStore = await cookies();
  const isAction = await isActionRequest();
  const record = { last: null as SessionCookieFailure | null };

  const client = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // A dead session is not cleared during a Server Action request:
          // Next would refresh the route and its guard would navigate the tab
          // away mid-action (see action-session-cookies.ts).
          if (keepDeadSessionCookies(isAction, cookiesToSet)) return;

          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
            record.last = null;
          } catch (error) {
            // The write is made from inside supabase-js's auth state-change
            // callback, during a token refresh. Throwing here does NOT reach the
            // caller cleanly: supabase-js rejects internal promises nobody awaits
            // (its refresh "deferred"), which surface as unhandled rejections in
            // the server process, and the request crashes for a condition the
            // read-only case below proves is survivable. So nothing is thrown
            // from here. The refreshed tokens are still applied in memory for
            // this request; only persisting them to the browser failed.
            if (isReadonlyCookiesError(error)) {
              // Expected: a Server Component (layout, page, `getCurrentUser`)
              // triggered the refresh and Next forbids cookie writes while
              // rendering. The proxy persists the tokens on the next request.
              // Seen at all means the proxy did not refresh the session first
              // (e.g. its request to Supabase failed); worth knowing about.
              record.last = { kind: "readonly", error, cookies: cookiesToSet.length };
              console.warn(
                "[auth] session cookies could not be updated during rendering; the proxy will persist them on the next request",
                { cookies: cookiesToSet.length },
              );
              return;
            }

            // Unexpected: a bug or a broken cookie store. Reported loudly — the
            // next request will have to refresh again, and the old refresh token
            // may have been rotated away by then — but never with token values.
            // Callers about to redirect can see it via `sessionCookieFailure`.
            record.last = { kind: "unexpected", error, cookies: cookiesToSet.length };
            console.error("[auth] session cookies could not be updated", {
              cookies: cookiesToSet.length,
              // Never log exception messages: providers may include secrets or user data.
              error: { name: error instanceof Error ? error.name : typeof error },
            });
          }
        },
      },
    },
  );

  failures.set(client, record);

  return client;
}

/**
 * Whether this client serves a Server Action request. `headers()` is
 * available wherever `cookies()` is; should it ever not be (a caller outside
 * a request), the client behaves as on a page request.
 */
async function isActionRequest(): Promise<boolean> {
  try {
    return isServerActionRequest(await headers());
  } catch {
    return false;
  }
}
