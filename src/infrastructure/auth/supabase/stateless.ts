import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { clientEnv } from "@/config/env.client";

/**
 * A Supabase client that keeps whatever session it obtains in memory only —
 * never in the request's cookies. Used to *verify* credentials on behalf of a
 * signed-in user (e.g. the current password before changing it) without
 * replacing or refreshing the session the browser actually holds.
 *
 * Each call returns a fresh instance: the memory store must not be shared
 * between requests. Callers should revoke any session they obtained
 * (`auth.signOut({ scope: "local" })`) once the check is done.
 */
export function createStatelessClient() {
  return createSupabaseClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
