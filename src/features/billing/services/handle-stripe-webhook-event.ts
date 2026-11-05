import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

/**
 * Persistence for Stripe subscription lifecycle events.
 *
 * Every event that concerns a subscription is reduced to one "change":
 * `{ subscription, customer, userId, status }` plus its position in Stripe's
 * timeline `(event.created, rank)`, and handed to a single Postgres function (see
 * `supabase/migrations/*_stripe_subscription_lifecycle.sql`). That function, in one
 * transaction: claims the event id (idempotency), serialises per subscription
 * (advisory lock), refuses to let an older position overwrite a newer status
 * (ordering), fills in the user association, and writes `subscriptions`.
 *
 * This module decides *what* an event says; the database decides *whether* it is
 * new information. No ordering or deduplication state is kept in memory.
 */

/** Contract with the SQL function. Names must match the migration exactly. */
export const STRIPE_RPC = {
  applySubscriptionEvent: {
    fn: "stripe_apply_subscription_event",
    params: [
      "p_event_id",
      "p_event_type",
      "p_event_created",
      "p_type_rank",
      "p_stripe_subscription_id",
      "p_stripe_customer_id",
      "p_user_id",
      "p_status",
    ],
  },
  /** Values the function returns. */
  results: ["applied", "stale", "duplicate"],
} as const;

export type StripeRpcResult = (typeof STRIPE_RPC.results)[number];

/**
 * Tie-break rank for events created in the same second (Stripe `created` has
 * second resolution). Higher rank = more authoritative about `status`.
 *
 * - checkout completion carries no subscription status; its status is derived
 *   from the payment outcome, so anything Stripe says about the subscription wins.
 * - payment (invoice) outcomes imply a status; the subscription object itself
 *   is the source of truth and wins ties.
 * - deletion is terminal.
 */
export const EVENT_TYPE_RANK = {
  "checkout.session.completed": 10,
  "customer.subscription.created": 20,
  "invoice.paid": 25,
  "invoice.payment_succeeded": 25,
  "invoice.payment_failed": 25,
  "customer.subscription.updated": 30,
  "customer.subscription.deleted": 40,
} as const satisfies Partial<Record<Stripe.Event.Type, number>>;

export type HandledEventType = keyof typeof EVENT_TYPE_RANK;

export const HANDLED_EVENT_TYPES = Object.keys(EVENT_TYPE_RANK) as HandledEventType[];

/** Error shape returned by supabase-js (PostgREST or transport failure). */
export type PersistenceError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

export type SkipReason =
  /** Event type this handler does not act on. Acknowledge so Stripe stops sending it. */
  | "unhandled_event_type"
  /** The event does not reference a subscription (one-off payment/invoice). */
  | "missing_subscription_id"
  /** A payment event whose billing reason does not imply a subscription status. */
  | "payment_event_not_mapped";

export type StripeWebhookOutcome =
  /** The event's status was written to the subscription. */
  | { kind: "processed"; eventType: Stripe.Event.Type; status: string }
  /** Newer information was already applied; identity fields were merged, status untouched. */
  | { kind: "stale"; eventType: Stripe.Event.Type; eventId: string }
  /** The database already holds this event id: its effect was committed earlier. */
  | { kind: "duplicate"; eventType: Stripe.Event.Type; eventId: string }
  | { kind: "skipped"; eventType: Stripe.Event.Type; reason: SkipReason; detail?: string }
  | { kind: "failed"; eventType: Stripe.Event.Type; error: PersistenceError };

/** What an event says about a subscription. */
export type SubscriptionChange = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  /** Application user id, when the event carries one. */
  userId: string | null;
  status: Stripe.Subscription.Status;
};

type Extraction =
  | { change: SubscriptionChange }
  | { skip: Exclude<SkipReason, "unhandled_event_type">; detail: string };

/**
 * Applies a verified Stripe event to the database and reports what happened.
 *
 * supabase-js does not throw on database errors; it resolves `{ data, error }`.
 * Every call checks `error` and surfaces it as a `failed` outcome so the caller
 * can refuse to acknowledge the event and let Stripe retry it.
 */
export async function handleStripeWebhookEvent(
  event: Stripe.Event,
  supabase: SupabaseClient,
): Promise<StripeWebhookOutcome> {
  const extraction = extractSubscriptionChange(event);

  if (extraction === null) {
    return { kind: "skipped", eventType: event.type, reason: "unhandled_event_type" };
  }

  if ("skip" in extraction) {
    return {
      kind: "skipped",
      eventType: event.type,
      reason: extraction.skip,
      detail: extraction.detail,
    };
  }

  const { change } = extraction;

  const { data, error } = await supabase.rpc(STRIPE_RPC.applySubscriptionEvent.fn, {
    p_event_id: event.id,
    p_event_type: event.type,
    p_event_created: event.created,
    p_type_rank: EVENT_TYPE_RANK[event.type as HandledEventType],
    p_stripe_subscription_id: change.stripeSubscriptionId,
    p_stripe_customer_id: change.stripeCustomerId,
    p_user_id: change.userId,
    p_status: change.status,
  });

  if (error) {
    return { kind: "failed", eventType: event.type, error: toPersistenceError(error) };
  }

  switch (data as StripeRpcResult) {
    case "applied":
      return { kind: "processed", eventType: event.type, status: change.status };

    case "stale":
      return { kind: "stale", eventType: event.type, eventId: event.id };

    case "duplicate":
      return { kind: "duplicate", eventType: event.type, eventId: event.id };

    default:
      // The function exists but did not answer with a known result: treat as a
      // failure rather than acknowledging an event whose effect is unknown.
      return {
        kind: "failed",
        eventType: event.type,
        error: {
          message: `unexpected result from database function: ${JSON.stringify(data)}`,
        },
      };
  }
}

/**
 * Reduces a Stripe event to a subscription change. Returns `null` for event types
 * this handler does not act on.
 */
export function extractSubscriptionChange(event: Stripe.Event): Extraction | null {
  switch (event.type) {
    case "checkout.session.completed":
      return fromCheckoutSession(event.data.object);

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return fromSubscription(event.data.object);

    case "invoice.paid":
    case "invoice.payment_succeeded":
      return fromInvoice(event.data.object, "paid");

    case "invoice.payment_failed":
      return fromInvoice(event.data.object, "failed");

    default:
      return null;
  }
}

function fromCheckoutSession(session: Stripe.Checkout.Session): Extraction {
  const stripeSubscriptionId = stripeId(session.subscription);

  if (!stripeSubscriptionId) {
    return {
      skip: "missing_subscription_id",
      detail: `checkout session ${session.id} has no subscription`,
    };
  }

  return {
    change: {
      stripeSubscriptionId,
      stripeCustomerId: stripeId(session.customer),
      userId: session.metadata?.userId ?? null,
      status: provisionalStatusFromCheckout(session.payment_status),
    },
  };
}

/**
 * A Checkout Session does not carry the subscription's status. Derive a
 * provisional one from the payment outcome; the subscription events that Stripe
 * emits alongside (higher rank) replace it with the real status.
 */
export function provisionalStatusFromCheckout(
  paymentStatus: Stripe.Checkout.Session.PaymentStatus,
): Stripe.Subscription.Status {
  switch (paymentStatus) {
    case "paid":
      return "active";
    case "no_payment_required":
      return "trialing";
    case "unpaid":
      return "incomplete";
  }
}

function fromSubscription(subscription: Stripe.Subscription): Extraction {
  return {
    change: {
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: stripeId(subscription.customer),
      userId: subscription.metadata?.userId ?? null,
      status: subscription.status,
    },
  };
}

function fromInvoice(invoice: Stripe.Invoice, outcome: "paid" | "failed"): Extraction {
  const details = invoice.parent?.subscription_details ?? null;
  const stripeSubscriptionId = stripeId(details?.subscription);

  if (!stripeSubscriptionId) {
    return {
      skip: "missing_subscription_id",
      detail: `invoice ${invoice.id} is not for a subscription`,
    };
  }

  const status = statusFromInvoice(outcome, invoice.billing_reason, invoice.amount_paid);

  if (!status) {
    return {
      skip: "payment_event_not_mapped",
      detail: `invoice ${invoice.id} (${outcome}, billing_reason=${invoice.billing_reason}) implies no subscription status`,
    };
  }

  return {
    change: {
      stripeSubscriptionId,
      stripeCustomerId: stripeId(invoice.customer),
      userId: details?.metadata?.userId ?? null,
      status,
    },
  };
}

/**
 * Which subscription status a payment outcome implies, per Stripe's documented
 * behaviour. Stripe also emits `customer.subscription.updated` for these
 * transitions (higher rank), so this is a complementary signal, not the only one.
 *
 * Returns `null` when the outcome says nothing reliable about the status (e.g. a
 * $0 first invoice could be a trial or a 100% coupon).
 */
export function statusFromInvoice(
  outcome: "paid" | "failed",
  billingReason: Stripe.Invoice.BillingReason | null,
  amountPaid: number,
): Stripe.Subscription.Status | null {
  if (outcome === "paid") {
    switch (billingReason) {
      case "subscription_cycle":
      case "subscription_update":
        return "active";
      case "subscription_create":
        return amountPaid > 0 ? "active" : null;
      default:
        return null;
    }
  }

  switch (billingReason) {
    case "subscription_create":
      return "incomplete"; // first payment failed
    case "subscription_cycle":
    case "subscription_update":
    case "subscription_threshold":
      return "past_due"; // renewal / change payment failed
    default:
      return null;
  }
}

/** Stripe fields may be an id or an expanded object; normalise to the id. */
function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function toPersistenceError(error: PersistenceError): PersistenceError {
  return {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  };
}
