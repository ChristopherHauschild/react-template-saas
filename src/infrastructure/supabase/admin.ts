import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { clientEnv } from "@/config/env.client";
import { serverEnv } from "@/config/env.server";

/**
 * Privileged Supabase client authenticated with the service-role key.
 *
 * The service role bypasses Row Level Security, so this client must only be used
 * in trusted, server-to-server contexts. Its users, all pinned by a test:
 *
 * - The Stripe webhook handler: Stripe's request carries no Supabase cookies, so
 *   the cookie-based client in `@/infrastructure/auth` would run as the
 *   anonymous role and any write would be subject to (or blocked by) RLS.
 * - The account activity writer (`@/infrastructure/account-activity`): the
 *   history must not be writable with a user's session token, since the browser
 *   holds that same token. The writer takes the user id the request was already
 *   verified for and can only append, through one database function.
 * - The rate limiter (`@/infrastructure/rate-limit`): a user must not be able
 *   to read or reset their own allowance, so the one function that consumes it
 *   is executable by the service role alone. The limiter takes the user id the
 *   request was already verified for.
 *
 * Never import this from components, server actions, or anything else that acts
 * on behalf of a user; go through a narrow, infrastructure-level function like
 * the writer above instead, and extend the allow-list in admin.test.ts
 * knowingly. `server-only` makes the Next.js build fail if it ends up in a client
 * bundle, and the key is read through `serverEnv`, which is itself `server-only`.
 *
 * A new client is created per call; it is cheap (no network on construction) and
 * keeps requests isolated.
 */
export function createAdminClient(): SupabaseClient {
  return createClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        // There is no user session to persist or refresh for a service-role client.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
