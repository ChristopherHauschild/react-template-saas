import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/auth/supabase/server";

/**
 * Stripe statuses that mean "this user already has a subscription we are
 * servicing". Starting another checkout would create a second, parallel Stripe
 * subscription (double billing). `incomplete` / `incomplete_expired` / `canceled`
 * are not blocking: the user may legitimately try again.
 */
export const BLOCKING_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "unpaid",
] as const;

export type UserBillingState =
  | {
      ok: true;
      /** An existing Stripe customer for this user, to reuse instead of creating another. */
      stripeCustomerId: string | null;
      /** Whether the user already has a subscription that should not be duplicated. */
      hasBlockingSubscription: boolean;
      /** The statuses found, for messaging/logging. */
      statuses: string[];
    }
  /** The state could not be read. Callers must treat this as "unknown", never as "none". */
  | { ok: false; error: { message: string; code?: string } };

/**
 * Reads the user's own subscription rows, performed as the user (cookie-based
 * client, subject to RLS). It only reads the four columns the application already
 * relies on.
 *
 * Fails CLOSED: if the read is denied or fails, the result is `ok: false` and the
 * caller must not start a checkout, because it cannot rule out an existing paid
 * subscription (which would be billed twice). The failure is logged.
 */
export async function getUserBillingState(
  userId: string,
  supabase?: SupabaseClient,
): Promise<UserBillingState> {
  const client = supabase ?? (await createClient());

  const { data, error } = await client
    .from("subscriptions")
    .select("stripe_customer_id, status")
    .eq("userId", userId);

  if (error) {
    console.error(
      "[billing] could not read the user's subscriptions; checkout must not proceed",
      {
        userId,
        error: { message: error.message, code: error.code },
      },
    );
    return { ok: false, error: { message: error.message, code: error.code } };
  }

  const rows = (data ?? []) as {
    stripe_customer_id: string | null;
    status: string | null;
  }[];
  const statuses = rows.map((row) => row.status ?? "").filter(Boolean);

  return {
    ok: true,
    stripeCustomerId:
      rows.find((row) => row.stripe_customer_id)?.stripe_customer_id ?? null,
    hasBlockingSubscription: statuses.some((status) =>
      (BLOCKING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status),
    ),
    statuses,
  };
}
