/**
 * The implementation moved to infrastructure so other features (settings) can
 * apply the same logging policy; re-exported here so the auth feature's own
 * imports and tests are unaffected.
 */
export { summarizeAuthErrorForLog } from "@/infrastructure/auth/supabase/auth-error-log";
