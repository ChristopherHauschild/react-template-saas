/**
 * Password bounds, shared by every form that sets a password (sign-up, change
 * password). The minimum is this app's policy — stricter than the Supabase
 * project's `minimum_password_length`, which only needs to be <= 8. The maximum
 * is bcrypt's 72-byte input limit, which GoTrue enforces with an error that
 * would otherwise surface as a confusing "validation failed".
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
