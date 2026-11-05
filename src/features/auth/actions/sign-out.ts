"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/infrastructure/auth/supabase/server";

import { isSupabaseAuthCookie } from "../services/auth-cookies";
import { summarizeAuthErrorForLog } from "../services/auth-error-log";

/**
 * Signs the user out of THIS device and sends them to the login page.
 *
 * `scope: "local"` revokes only the current session; other devices stay signed in.
 *
 * Failures are contained, never thrown: a thrown error would land in the error
 * boundary instead of signing the user out. When Supabase cannot be reached,
 * supabase-js returns an error and deliberately keeps the session, which would
 * leave the auth cookies in place — the login page's guest guard would then see a
 * valid session and bounce the user straight back to the dashboard. So, whatever
 * happened above, every Supabase auth cookie is removed before redirecting. The
 * server-side session may outlive this in that one failure case (it expires on
 * its own), but the browser is signed out either way.
 */
export async function signOut() {
  const cookieStore = await cookies();

  try {
    const supabase = await createClient();

    const { error } = await supabase.auth.signOut({ scope: "local" });

    if (error) {
      console.warn(
        "[auth] sign-out not confirmed by Supabase; clearing the session locally",
        {
          error: summarizeAuthErrorForLog(error),
        },
      );
    }
  } catch (thrown) {
    console.error("[auth] sign-out threw unexpectedly; clearing the session locally", {
      error: summarizeAuthErrorForLog(thrown),
    });
  }

  // On success supabase-js has already expired these; this makes the failure
  // paths end in the same place. Cookie names only — never values — are touched.
  for (const { name } of cookieStore.getAll()) {
    if (isSupabaseAuthCookie(name)) {
      cookieStore.delete(name);
    }
  }

  redirect("/login");
}
