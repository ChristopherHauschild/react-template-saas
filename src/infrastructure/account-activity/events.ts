import { z } from "zod";

/**
 * Catalogue of account activity events: everything the application records in
 * `public.account_activity` (see `supabase/migrations/*_account_activity.sql`)
 * and later shows on the settings page.
 *
 * Lives in infrastructure because several features produce events (settings,
 * auth, billing) and features may not import each other. Each entry pairs a
 * `type` — the dotted identifier stored in `event_type` — with the schema of
 * its `details`. The writer validates against it before storing and the reader
 * after loading, so a row that was written can always be read back.
 *
 * Adding an event: add a member to `ACCOUNT_ACTIVITY_EVENT_SCHEMA`. Changing
 * the details of an existing event: keep the schema able to parse rows written
 * by older versions (make new fields optional), or rows become unreadable.
 * `details` must be a plain JSON object: no `undefined` (it vanishes on the
 * wire and the read-side schema would then reject the row), no `Date`.
 */
export const ACCOUNT_ACTIVITY_EVENT_SCHEMA = z.discriminatedUnion("type", [
  /** The display name was changed on the settings page. */
  z.object({
    type: z.literal("profile.updated"),
    details: z.object({
      changes: z.object({
        /** `from` is null when the account had no display name yet. */
        fullName: z.object({ from: z.string().nullable(), to: z.string() }),
      }),
    }),
  }),
  /**
   * The password was changed (current password verified, new one in effect).
   * Never carries a password. `otherSessionsSignedOut` is whether GoTrue also
   * confirmed revoking every other session as part of the change.
   */
  z.object({
    type: z.literal("password.changed"),
    details: z.object({ otherSessionsSignedOut: z.boolean() }),
  }),
  /**
   * Every other session of the account was revoked from the settings page
   * (GoTrue's confirmation; it does not report how many there were).
   */
  z.object({
    type: z.literal("sessions.others_signed_out"),
    details: z.object({}),
  }),
  /**
   * An email change was requested: Supabase accepted the new address and sent
   * the confirmation link(s). The account's address has NOT changed at this
   * point — that is `email.changed`, recorded only once a link completes the
   * change. `resend` marks a request for the address already pending (fresh
   * links), as opposed to a new request. `from` is null for an account
   * without an address.
   */
  z.object({
    type: z.literal("email.change_requested"),
    details: z.object({
      from: z.string().nullable(),
      to: z.string(),
      resend: z.boolean(),
    }),
  }),
  /**
   * The account's email address changed: a confirmation link completed the
   * change (the last one, when both addresses must confirm). `to` is the new
   * address as GoTrue returned it; null only if it did not.
   */
  z.object({
    type: z.literal("email.changed"),
    details: z.object({ to: z.string().nullable() }),
  }),
]);

/** One event as the application sees it: a `type` and its typed `details`. */
export type AccountActivityEvent = z.infer<typeof ACCOUNT_ACTIVITY_EVENT_SCHEMA>;

export type AccountActivityEventType = AccountActivityEvent["type"];

/** Database names; must match `supabase/migrations/*_account_activity.sql`. */
export const ACCOUNT_ACTIVITY_TABLE = "account_activity";
export const RECORD_ACCOUNT_ACTIVITY_RPC = "record_account_activity";

/** Matches the database's `account_activity_event_type_format` check. */
export const ACCOUNT_ACTIVITY_EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Upper bound the database enforces on `details` (serialised, in bytes). */
export const ACCOUNT_ACTIVITY_DETAILS_MAX_BYTES = 4096;
