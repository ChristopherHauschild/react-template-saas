import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/infrastructure/supabase/admin";

import {
  ACCOUNT_ACTIVITY_EVENT_SCHEMA,
  type AccountActivityEvent,
  RECORD_ACCOUNT_ACTIVITY_RPC,
} from "./events";

export type RecordAccountActivityResult =
  | { ok: true; id: number }
  /** Nothing was recorded. Already logged; callers need not log again. */
  | { ok: false };

/**
 * Appends one event to the user's account activity history.
 *
 * Runs with the service-role key through `public.record_account_activity`, the
 * only write path the database allows (see the migration). This is the one
 * deliberate use of the service role for a user-initiated request: a user's own
 * session token cannot be allowed to write, because the browser holds that same
 * token and could forge entries through `/rest/v1/rpc`. The trade-off is that
 * `userId` is trusted as given, so callers MUST pass the id of the user the
 * request was verified for (`requireAuth()`), never an id taken from input.
 *
 * The event is validated against the catalogue first: what is stored must be
 * readable back by `listAccountActivity`.
 *
 * Never throws. Recording is a side effect of a change that has already been
 * made; a failure here must not undo or hide that change, so it is logged
 * (without the event's details, which can hold profile data) and reported as
 * `ok: false`.
 *
 * `supabase` is injectable for tests; production callers use the default.
 */
export async function recordAccountActivity(
  userId: string,
  event: AccountActivityEvent,
  supabase?: SupabaseClient,
): Promise<RecordAccountActivityResult> {
  const parsed = ACCOUNT_ACTIVITY_EVENT_SCHEMA.safeParse(event);

  if (!parsed.success) {
    // A programming error: the TypeScript type should have caught it. Issue
    // paths name fields, not values.
    console.error("[account-activity] event does not match its schema; not recorded", {
      type: event?.type,
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return { ok: false };
  }

  try {
    const client = supabase ?? createAdminClient();

    const { data, error } = await client.rpc(RECORD_ACCOUNT_ACTIVITY_RPC, {
      p_user_id: userId,
      p_event_type: parsed.data.type,
      p_details: parsed.data.details,
    });

    if (error) {
      // `details`/`hint` of a Postgres error can quote the failing row; the
      // message and SQLSTATE are enough to diagnose.
      console.error("[account-activity] could not record event", {
        type: event.type,
        userId,
        error: { message: error.message, code: error.code },
      });
      return { ok: false };
    }

    // PostgREST serialises the bigint as a JSON number; tolerate a digit string.
    const id =
      typeof data === "number"
        ? data
        : typeof data === "string" && /^\d+$/.test(data)
          ? Number(data)
          : NaN;

    if (!Number.isSafeInteger(id)) {
      console.error("[account-activity] unexpected response from record function", {
        type: event.type,
        userId,
        data: typeof data,
      });
      return { ok: false };
    }

    return { ok: true, id };
  } catch (thrown) {
    // Client construction (missing env) or a non-PostgREST failure. Only the
    // error's class is logged: the message could echo request details.
    console.error("[account-activity] recording threw unexpectedly", {
      type: event.type,
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false };
  }
}
