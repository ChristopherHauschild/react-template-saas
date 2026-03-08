import { createBrowserClient } from "@supabase/ssr";

import { clientEnv } from "@/config/env.client";

export function createClient() {
  return createBrowserClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
