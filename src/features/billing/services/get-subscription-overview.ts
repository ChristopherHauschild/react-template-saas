import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/auth/supabase/server";

/**
 * Read model of a user's subscriptions for the billing area (status display and
 * the Customer Portal). Built from the rows the webhook writes; nothing here
 * talks to Stripe, so it is as fresh as the last webhook that was applied.
 *
 * Deliberately separate from `getUserBillingState`, which is the checkout
 * action's guard: that function, its column list and its logging are part of the
 * checkout contract and stay untouched.
 */

/**
 * Which row represents the user's subscription when there are several — an old
 * `canceled` one next to the current `active` one, an orphan `incomplete` from an
 * abandoned checkout, … Earlier entries win. `subscriptions` has no timestamps
 * the application may rely on, so status is the only ordering available:
 *
 * - rows Stripe is still servicing (billing or trying to bill) come first; they
 *   are exactly `BLOCKING_SUBSCRIPTION_STATUSES` from the checkout guard;
 * - then an `incomplete` one, whose first payment may still succeed;
 * - then the finished ones.
 */
export const SUBSCRIPTION_STATUS_PRIORITY = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
  "incomplete_expired",
  "canceled",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS_PRIORITY)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUS_PRIORITY as readonly string[]).includes(value)
  );
}

/** Statuses under which Stripe still services the subscription (bills or retries). */
const SERVICING_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
];

/** Statuses Stripe never leaves; a row saying so is the truth about that subscription. */
const TERMINAL_STATUSES: readonly SubscriptionStatus[] = [
  "canceled",
  "incomplete_expired",
];

/** One row of `public.subscriptions`, as the application reads it. */
export type SubscriptionRecord = {
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  /**
   * Stripe's status as stored. `null` when the column is empty; a string outside
   * `SUBSCRIPTION_STATUS_PRIORITY` is passed through unchanged (it is displayed
   * as "unknown" and ranked last, never guessed at).
   */
  status: string | null;
};

/**
 * One subscription, consolidated from every row that carries its id. The table
 * has no uniqueness on `stripe_subscription_id`, so legacy data can hold
 * duplicates that agree, disagree, or lack the id altogether (then each such
 * row is its own entry).
 */
export type ConsolidatedSubscription = SubscriptionRecord & {
  /** Rows that were merged into this entry. */
  rowCount: number;
  /**
   * Rows disagreed on the status and none of them was terminal, so `status` is
   * `null` and nothing about it may be asserted. (A terminal status among
   * disagreeing rows wins instead: Stripe never leaves `canceled` or
   * `incomplete_expired`.)
   */
  statusConflict: boolean;
  /** Rows named different Stripe customers for one subscription — impossible in Stripe, so `stripeCustomerId` is `null`. */
  customerConflict: boolean;
  /**
   * Stripe still services this subscription: its resolved status is one of
   * `SERVICING_STATUSES`, or the status is unresolved and any candidate is.
   * (A terminal row settles it as ended, whatever a stale duplicate says.)
   */
  isServicing: boolean;
};

/**
 * Which Stripe customer the user's records point at. The Customer Portal is
 * only opened for `single`; `ambiguous` means the records name several, or
 * name none for a subscription that is still being billed, and guessing could
 * manage the wrong account.
 */
export type CustomerResolution =
  | { kind: "single"; stripeCustomerId: string }
  | { kind: "none" }
  | {
      kind: "ambiguous";
      reason: /** Serviced subscriptions name more than one customer. */
        | "multiple_customers"
        /** A serviced subscription has no customer; the customer of an ended one must not stand in. */
        | "unknown_customer"
        /** One subscription's rows name different customers. */
        | "customer_conflict"
        /** Only ended subscriptions, but on several customers. */
        | "multiple_past_customers";
      /** Distinct customers seen, for logs. Never the ids themselves. */
      customers: number;
    };

export type SubscriptionOverview =
  | {
      ok: true;
      /**
       * The Stripe customer to open the Customer Portal for, when — and only
       * when — the records point at exactly one (see `customerResolution`).
       */
      stripeCustomerId: string | null;
      customerResolution: CustomerResolution;
      /** The subscription that best represents the user's state; `null` when there is none. */
      current: ConsolidatedSubscription | null;
      /**
       * Whether ANY row carries a status Stripe services. Deliberately the
       * checkout guard's view (`getUserBillingState` reads every row), so a page
       * that hides "choose a plan" on this never offers a checkout the action
       * would refuse — even when a stale duplicate row is what blocks it.
       */
      isServicing: boolean;
      /** Every consolidated subscription, most relevant first. */
      subscriptions: ConsolidatedSubscription[];
    }
  /** The rows could not be read. Callers must treat this as "unknown", never as "none". */
  | { ok: false; error: { message: string; code?: string } };

/** Column list sent to PostgREST; only the columns the application already relies on. */
export const SUBSCRIPTION_OVERVIEW_COLUMNS =
  "stripe_customer_id, stripe_subscription_id, status";

type Row = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
};

/**
 * Reads the user's own subscription rows as the user (cookie-based client,
 * subject to RLS) and reduces them to one overview.
 *
 * Fails CLOSED: if the read is denied or fails, the result is `ok: false`. A
 * caller that showed "no subscription" instead would misinform the user, and one
 * that opened the Customer Portal would be guessing at a customer. The failure is
 * logged; no row data is.
 */
export async function getSubscriptionOverview(
  userId: string,
  supabase?: SupabaseClient,
): Promise<SubscriptionOverview> {
  const client = supabase ?? (await createClient());

  const { data, error } = await client
    .from("subscriptions")
    .select(SUBSCRIPTION_OVERVIEW_COLUMNS)
    .eq("userId", userId);

  if (error) {
    console.error("[billing] could not read the user's subscriptions", {
      userId,
      error: { message: error.message, code: error.code },
    });
    return { ok: false, error: { message: error.message, code: error.code } };
  }

  return summarizeSubscriptions(((data ?? []) as Row[]).map(toRecord));
}

/** Pure reduction of the user's rows; exported for tests of the data shapes. */
export function summarizeSubscriptions(
  rows: SubscriptionRecord[],
): Extract<SubscriptionOverview, { ok: true }> {
  const subscriptions = consolidate(rows)
    .sort((a, b) => a.rank - b.rank)
    .map(({ subscription }) => subscription);
  const current = subscriptions[0] ?? null;
  const customerResolution = resolveCustomer(
    subscriptions,
    distinct(rows.map((row) => row.stripeCustomerId)).length,
  );

  return {
    ok: true,
    stripeCustomerId:
      customerResolution.kind === "single" ? customerResolution.stripeCustomerId : null,
    customerResolution,
    current,
    isServicing: rows.some((row) => isServicingStatus(row.status)),
    subscriptions,
  };
}

/**
 * Groups rows by subscription id; rows without one stay separate. Each group
 * is ranked by its best status (a conflicting but still-serviced subscription
 * outranks an ended one), ties keep the database's order.
 */
function consolidate(
  rows: SubscriptionRecord[],
): { subscription: ConsolidatedSubscription; rank: number }[] {
  const groups = new Map<string | symbol, SubscriptionRecord[]>();

  for (const row of rows) {
    const key = row.stripeSubscriptionId ?? Symbol("no subscription id");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((group) => {
    const statuses = distinct(group.map((row) => row.status));
    const customers = distinct(group.map((row) => row.stripeCustomerId));
    // Deterministic: by TERMINAL_STATUSES order, not by row order.
    const terminal = TERMINAL_STATUSES.find((status) => statuses.includes(status));
    const status = statuses.length === 1 ? statuses[0] : (terminal ?? null);

    return {
      subscription: {
        stripeSubscriptionId: group[0].stripeSubscriptionId,
        stripeCustomerId: customers.length === 1 ? customers[0] : null,
        status,
        rowCount: group.length,
        statusConflict: statuses.length > 1 && terminal === undefined,
        customerConflict: customers.length > 1,
        isServicing:
          status !== null ? isServicingStatus(status) : statuses.some(isServicingStatus),
      },
      // A resolved status ranks as itself (terminal wins → ranks as ended); an
      // unresolved conflict ranks by its best candidate so it is not hidden.
      rank:
        status !== null
          ? rankOf(status)
          : Math.min(...statuses.map(rankOf), rankOf(null)),
    };
  });
}

/** `customersSeen`: distinct customer ids across the raw rows, for the log counts. */
function resolveCustomer(
  subscriptions: ConsolidatedSubscription[],
  customersSeen: number,
): CustomerResolution {
  if (subscriptions.some((s) => s.customerConflict)) {
    return { kind: "ambiguous", reason: "customer_conflict", customers: customersSeen };
  }

  const servicing = subscriptions.filter((s) => s.isServicing);

  if (servicing.length > 0) {
    // What is being billed decides. An ended subscription's customer must not
    // stand in for it: that portal would not even show the live subscription.
    if (servicing.some((s) => s.stripeCustomerId === null)) {
      return { kind: "ambiguous", reason: "unknown_customer", customers: customersSeen };
    }

    const customers = distinct(servicing.map((s) => s.stripeCustomerId));

    return customers.length === 1
      ? { kind: "single", stripeCustomerId: customers[0] }
      : { kind: "ambiguous", reason: "multiple_customers", customers: customers.length };
  }

  const all = distinct(subscriptions.map((s) => s.stripeCustomerId));

  if (all.length === 0) return { kind: "none" };
  if (all.length === 1) return { kind: "single", stripeCustomerId: all[0] };

  return { kind: "ambiguous", reason: "multiple_past_customers", customers: all.length };
}

function distinct<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null))];
}

export function isServicingStatus(status: string | null): boolean {
  return isSubscriptionStatus(status) && SERVICING_STATUSES.includes(status);
}

/** Statuses Stripe never leaves (see `TERMINAL_STATUSES`). */
export function isTerminalStatus(status: string | null): boolean {
  return isSubscriptionStatus(status) && TERMINAL_STATUSES.includes(status);
}

/** Position in `SUBSCRIPTION_STATUS_PRIORITY`; unknown or missing statuses rank last. */
function rankOf(status: string | null): number {
  const index = isSubscriptionStatus(status)
    ? SUBSCRIPTION_STATUS_PRIORITY.indexOf(status)
    : -1;

  return index === -1 ? SUBSCRIPTION_STATUS_PRIORITY.length : index;
}

function toRecord(row: Row): SubscriptionRecord {
  return {
    stripeSubscriptionId: nonEmpty(row.stripe_subscription_id),
    stripeCustomerId: nonEmpty(row.stripe_customer_id),
    status: nonEmpty(row.status),
  };
}

/** PostgREST returns `null` for NULL, but an empty string is just as unusable as an id. */
function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
