import { clientEnv } from "@/config/env.client";
import { ROUTES } from "@/config/routes";

/**
 * Absolute URL of this app's confirmation callback, sent to Supabase as
 * `emailRedirectTo` by sign-up, resend and email change so every kind of
 * confirmation email lands in the same place. Must be allow-listed in Supabase
 * (`auth.additional_redirect_urls` locally, "Redirect URLs" when hosted).
 */
export function confirmationRedirectUrl(): string {
  return new URL(ROUTES.authCallback, clientEnv.NEXT_PUBLIC_APP_URL).href;
}
