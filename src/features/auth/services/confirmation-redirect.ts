/**
 * The implementation moved to infrastructure so the settings feature (email
 * change) can send Supabase the same callback URL; re-exported here so the auth
 * feature's own imports and tests are unaffected.
 */
export { confirmationRedirectUrl } from "@/infrastructure/auth/confirmation-redirect";
