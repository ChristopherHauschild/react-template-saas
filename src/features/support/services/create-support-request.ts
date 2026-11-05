import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/auth/supabase/server";

import {
  NEW_SUPPORT_REQUEST_SCHEMA,
  SUPPORT_REQUESTS_TABLE,
  type SupportRequestFieldError,
} from "./support-request";
import {
  summarizeSupportRequestError,
  type SupportRequestFailure,
  toSupportRequestFailure,
} from "./support-request-errors";
import {
  SUPPORT_REQUEST_SELECT,
  type SupportRequest,
  toSupportRequest,
} from "./support-request-row";

/** Fields of the form; `field` in an invalid result names the one at fault. */
export type SupportRequestField = "category" | "subject" | "message";

export type CreateSupportRequestResult =
  /**
   * The request was filed. `request` is the stored row; `null` when it was
   * written but could not be read back (see below) — the caller must then
   * reload the list rather than report a failure.
   */
  | { ok: true; request: SupportRequest | null }
  /** Nothing was written. Already logged where it matters. */
  | {
      ok: false;
      failure: SupportRequestFailure;
      /** Set when one input is at fault, with the message to show beside it. */
      field?: SupportRequestField;
      error?: SupportRequestFieldError;
    };

export type CreateSupportRequestOptions = {
  /** Injectable for tests; production callers use the cookie-based client. */
  supabase?: SupabaseClient;
};

const FIELDS: readonly SupportRequestField[] = ["category", "subject", "message"];

const isField = (value: unknown): value is SupportRequestField =>
  FIELDS.includes(value as SupportRequestField);

/**
 * Files one support request for the signed-in user.
 *
 * Performed AS THE USER (cookie-based client), never with the service role:
 * sending a request is the user's own action, so their session is the right
 * credential and the database enforces ownership. The insert names only the
 * three columns the user may supply — `user_id` comes from `auth.uid()`,
 * `status`, `created_at` and `id` from their defaults — so nothing in `input`
 * can decide who a request belongs to, when it arrived or whether it is
 * already closed. `userId` is used for logging and to read the row back; it
 * must be the id the request was verified for (`requireAuth()`).
 *
 * `input` is untrusted: it is parsed with the shared schema first, which trims
 * the text and accepts only what the database's CHECK constraints accept, so a
 * valid form submission cannot fail on a constraint. The first failing field
 * is reported with the message the form shows next to it.
 *
 * Never throws: every failure — including a lost session, the flood limit and
 * an unreachable database — is returned, so the page can show it inline
 * instead of replacing itself with an error screen.
 */
export async function createSupportRequest(
  userId: string,
  input: unknown,
  options: CreateSupportRequestOptions = {},
): Promise<CreateSupportRequestResult> {
  const parsed = NEW_SUPPORT_REQUEST_SCHEMA.safeParse(input);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];

    return {
      ok: false,
      failure: "invalid",
      // A schema issue always names one of the three fields; should a future
      // rule be added at the object level, the subject is the safest place to
      // show it (it is the first input of the form).
      field: isField(field) ? field : "subject",
      error: issue.message as SupportRequestFieldError,
    };
  }

  const { category, subject, message } = parsed.data;

  try {
    const client = options.supabase ?? (await createClient());

    const { data, error } = await client
      .from(SUPPORT_REQUESTS_TABLE)
      // Exactly the insertable columns, listed one by one: never a spread of
      // caller input, which could carry user_id or status.
      .insert({ category, subject, message })
      .select(SUPPORT_REQUEST_SELECT)
      .single();

    if (error) {
      const failure = toSupportRequestFailure(error);

      // The flood limit and an expired session are ordinary outcomes the user
      // is told about; the rest is worth a log line for operators. What the
      // user wrote is never logged.
      if (failure === "unavailable" || failure === "invalid") {
        console.error("[support] could not file a request", {
          userId,
          failure,
          error: summarizeSupportRequestError(error),
        });
      }

      // A database-side `invalid` carries no field: the constraint does not say
      // which input it was, so the generic "check your request" wording is used.
      return { ok: false, failure };
    }

    const request = toSupportRequest(data);

    if (!request) {
      // The row was written (no error) but the echo does not parse — a changed
      // projection, say. Reporting a failure here would be wrong and harmful:
      // the user would send the request again and support would see it twice.
      // The caller reports success and reloads the list from the server.
      console.error("[support] request was filed but could not be read back", {
        userId,
      });
    }

    return { ok: true, request };
  } catch (thrown) {
    // Client construction (missing env), a network failure, or a bug. Only the
    // error's class is logged: its message could echo the request.
    console.error("[support] filing a request threw unexpectedly", {
      userId,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });

    return { ok: false, failure: "unavailable" };
  }
}
