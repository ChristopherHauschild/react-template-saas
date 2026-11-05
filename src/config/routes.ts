export const ROUTES = {
  login: "/login",
  signUp: "/signup",
  dashboard: "/dashboard",
  billing: "/billing",
  settings: "/settings",
  exports: "/exports",
  /** `/support` – contact support, and track requests. */
  support: "/support",
  /**
   * Where Supabase sends the user after they click the confirmation link in a
   * sign-up email (the `emailRedirectTo` of `auth.signUp`). The route handler
   * that exchanges the code for a session and forwards to the dashboard lives at
   * this path. Must be allow-listed in Supabase (`auth.additional_redirect_urls`
   * locally, "Redirect URLs" in the hosted dashboard).
   */
  authCallback: "/auth/callback",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];
