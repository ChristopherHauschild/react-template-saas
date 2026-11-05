import { type NextRequest, NextResponse } from "next/server";

import { createServerClient } from "@supabase/ssr";

import { clientEnv } from "@/config/env.client";
import {
  isServerActionRequest,
  keepDeadSessionCookies,
} from "@/infrastructure/auth/supabase/action-session-cookies";

/**
 * Where the proxy runs. Its only job is to refresh the Supabase session cookie,
 * so it is skipped for requests that cannot carry a session worth refreshing:
 *
 * - `_next/static`, `_next/image`: build output and the image optimiser;
 * - `favicon.ico` and any request for a file with a static extension (the
 *   contents of `public/`, fonts, source maps, …);
 * - `api/stripe/webhook`: Stripe's server calls carry no browser cookies; the
 *   route authenticates the request by signature and uses the service-role client.
 *
 * Everything else — pages, route groups, Server Action POSTs (which go to the
 * page's own URL) and other API routes — still passes through.
 *
 * Without this the proxy ran for every asset: a single dashboard navigation made
 * eight `GET /auth/v1/user` calls to Supabase, and at token expiry every asset
 * request raced to refresh the same refresh token.
 *
 * Must stay a plain string literal: Next reads this export statically at build
 * time and rejects anything it cannot evaluate.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|api/stripe/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|xml|json|webmanifest|woff|woff2|ttf)$).*)",
  ],
};

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  const isAction = isServerActionRequest(request.headers);

  const supabase = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // A dead session is not cleared during a Server Action request:
          // Next would refresh the route and its guard would navigate the tab
          // away mid-action (see action-session-cookies.ts). The next page
          // request clears it.
          if (keepDeadSessionCookies(isAction, cookiesToSet)) return;

          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);

            response.cookies.set({ name, value, ...options });
          });
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}
