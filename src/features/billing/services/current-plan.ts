import type { Plan, PlanId } from "../types/plan";

import {
  isSubscriptionStatus,
  type SubscriptionStatus,
} from "./get-subscription-overview";
import { formatInvoiceDate, minorUnitDigits } from "./invoice-history";

/**
 * What the dashboard shows about the plan a subscription is for — and nothing
 * more. This module is pure: it turns what Stripe answered about a subscription
 * into the display model. Talking to Stripe (and deciding WHICH subscription to
 * ask about) is `getCurrentPlan`. Like `BillingSummary`, the model crosses into
 * components, so it carries no Stripe identifiers: not the subscription, the
 * customer, nor the price.
 *
 * Our own records hold a subscription's status but not what it is for; the
 * plan is read from the subscription's items, by matching each item's price
 * against the catalog (`findPlanByStripePrice`). The price is the truth about
 * what is billed and follows plan changes made in the Customer Portal. The
 * `planId` the checkout stamps into the subscription's metadata is deliberately
 * NOT used: it is frozen at checkout and would misreport a later change.
 *
 * The subscription's own status, and what Stripe says about it ending or
 * pausing, are read along with the plan (`SubscriptionFacts`): they are more
 * current than our records, which the webhook updates after a change in the
 * Customer Portal — usually promptly, but possibly late or not at all.
 */

/** Stripe subscription ids are `sub_` followed by alphanumerics. */
const STRIPE_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

export function isStripeSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && STRIPE_SUBSCRIPTION_ID.test(value);
}

/** Stripe's recurring intervals. */
export const BILLING_INTERVALS = ["day", "week", "month", "year"] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return (
    typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value)
  );
}

/**
 * The plan's recurring price, when it is a plain per-unit one: `amount` is
 * `unit_amount × quantity` in the currency's minor unit (cents for USD),
 * before discounts and tax. Tiered, metered or custom-priced items have no
 * single amount and are reported as `null` by the reader.
 */
export type PlanBilling = {
  amount: number;
  /** Lower-case ISO 4217 code, as Stripe reports it. */
  currency: string;
  interval: BillingInterval;
  /** `1` for "every month", `3` for "every 3 months", … */
  intervalCount: number;
  /**
   * A discount applies to the subscription or to the plan's item, so `amount`
   * is NOT what is charged. What the discount takes off, and for how long, is
   * not read (it would take expanding the coupon and its schedule): the figure
   * is labelled as the price before discounts and the portal shows the rest.
   */
  discounted: boolean;
};

/**
 * What Stripe says about the subscription ending, read from the subscription
 * itself (our records hold the status only):
 * - `scheduled`: it is still serviced but set to cancel — at period end
 *   (`cancel_at_period_end`) or at a date (`cancel_at`); `at` is that date as
 *   an ISO 8601 timestamp, `null` if Stripe gave none;
 * - `ended`: Stripe has it as `canceled`; `at` is when (`ended_at`).
 */
export type PlanCancellation =
  | { kind: "scheduled"; at: string | null }
  | { kind: "ended"; at: string | null };

/**
 * What Stripe itself says about the subscription, as of the read. Our records
 * (written by the webhook) say the same once it has been applied; until then
 * these are the current truth, and the pages show them (`reconcileOverviewStatus`).
 */
export type SubscriptionFacts = {
  /** Stripe's status, or `"unknown"` for a value this code does not know. */
  status: SubscriptionStatus | "unknown";
  /** Whether the subscription is set to end, or has; `null` when neither. */
  cancellation: PlanCancellation | null;
  /**
   * Payment collection is paused (`pause_collection`, e.g. from the portal):
   * the subscription stays serviced but is not charged. `resumesAt` is when
   * Stripe will resume (ISO 8601), `null` for "until resumed by hand".
   */
  collectionPaused: { resumesAt: string | null } | null;
};

/** The catalog plan a subscription is for, as shown on the dashboard. */
export type CurrentPlanDetails = {
  id: PlanId;
  name: string;
  features: string[];
  /**
   * The plan's recurring price, when it could be read unambiguously: the
   * plan's item is the subscription's only item, has a plain per-unit
   * recurring price, and the discounts on both could be seen. `null`
   * otherwise (other items on the subscription, tiered/metered pricing) — the
   * billing portal shows the real figure.
   */
  billing: PlanBilling | null;
};

/**
 * Four shapes the dashboard must never confuse with each other:
 * - `ok`: the plan, read from the subscription Stripe holds;
 * - `none`: there is no subscription to look up (the free plan);
 * - `unrecognized`: Stripe holds the subscription, but its items name no
 *   catalog plan, or several — nothing is claimed about which plan it is;
 * - `unavailable`: the plan could not be read. The dashboard must say so,
 *   never show a plan it did not read.
 */
export type CurrentPlan =
  | { kind: "ok"; plan: CurrentPlanDetails; subscription: SubscriptionFacts }
  | { kind: "none" }
  | { kind: "unrecognized"; subscription: SubscriptionFacts }
  | {
      kind: "unavailable";
      /** For logs and tests. */
      reason: /** Our own records could not be read, so the subscription is unknown. */
        | "records_unreadable"
        /** The records name the subscription but hold no Stripe id for it. */
        | "missing_subscription_id"
        /** The stored subscription id is not a Stripe subscription id; never sent. */
        | "invalid_subscription_id"
        /** Stripe does not know the subscription (deleted, or a test/live mismatch). */
        | "subscription_missing"
        /** Stripe could not be asked (outage, rate limit, bad key, …). */
        | "stripe_error"
        /** Stripe answered with something other than this subscription. */
        | "unusable_response";
    };

/** What the reader must be able to verify about the answer before using it. */
export type ExpectedSubscription = {
  stripeSubscriptionId: string;
  /**
   * The customer our records name for it; `null` when they name none (then
   * the customer cannot be cross-checked, and the id — read from the user's
   * own rows — is the only ownership evidence).
   */
  stripeCustomerId: string | null;
};

export type SubscriptionPlanReading =
  | { ok: true; result: Extract<CurrentPlan, { kind: "ok" | "unrecognized" }> }
  /** The answer was refused; `reason` is for the log. */
  | { ok: false; reason: string };

/**
 * Reads the plan off what Stripe answered to `subscriptions.retrieve`.
 * Defensive on purpose: the answer is used only if it is the very subscription
 * asked about, for the customer the records name; a different object is refused
 * rather than trusted. Anything unexpected inside the items (no price, odd
 * quantity) downgrades the billing figure to `null`, never the plan to a guess.
 */
export function readSubscriptionPlan(
  answer: unknown,
  expected: ExpectedSubscription,
  findPlan: (stripePriceId: string) => Plan | null,
): SubscriptionPlanReading {
  if (answer === null || typeof answer !== "object") {
    return { ok: false, reason: "not_an_object" };
  }

  const subscription = answer as Record<string, unknown>;

  if (subscription.object !== "subscription") {
    return { ok: false, reason: "not_a_subscription" };
  }

  if (subscription.id !== expected.stripeSubscriptionId) {
    return { ok: false, reason: "different_subscription" };
  }

  const customer = stripeId(subscription.customer);

  if (expected.stripeCustomerId !== null && customer !== expected.stripeCustomerId) {
    return { ok: false, reason: "different_customer" };
  }

  const items = readItems(subscription.items);

  if (items === null) {
    return { ok: false, reason: "items_unreadable" };
  }

  const subscriptionDiscounted = readDiscounted(subscription.discounts);
  const facts = readFacts(subscription);

  const matches = items
    .map((item) => ({
      item,
      plan: item.priceId === null ? null : findPlan(item.priceId),
    }))
    .filter((entry): entry is { item: Item; plan: Plan } => entry.plan !== null);

  if (matches.length !== 1) {
    return { ok: true, result: { kind: "unrecognized", subscription: facts } };
  }

  const [{ item, plan }] = matches;
  // Either discount list being unreadable means the figure cannot be labelled
  // honestly, so none is shown.
  const billing =
    items.length === 1 &&
    item.billing !== null &&
    item.discounted !== null &&
    subscriptionDiscounted !== null
      ? { ...item.billing, discounted: item.discounted || subscriptionDiscounted }
      : null;

  return {
    ok: true,
    result: {
      kind: "ok",
      plan: {
        id: plan.id,
        name: plan.name,
        features: plan.features ? [...plan.features] : [],
        billing,
      },
      subscription: facts,
    },
  };
}

function readFacts(subscription: Record<string, unknown>): SubscriptionFacts {
  return {
    status: isSubscriptionStatus(subscription.status) ? subscription.status : "unknown",
    cancellation: readCancellation(subscription),
    collectionPaused: readPause(subscription.pause_collection),
  };
}

/** `pause_collection` is `null` or `{ behavior, resumes_at }`; any object means paused. */
function readPause(value: unknown): SubscriptionFacts["collectionPaused"] {
  if (value === null || typeof value !== "object") return null;

  const { resumes_at } = value as { resumes_at?: unknown };

  return { resumesAt: isoTimestamp(resumes_at) };
}

type Item = {
  priceId: string | null;
  billing: Omit<PlanBilling, "discounted"> | null;
  /** `null` when the item's discount list could not be read. */
  discounted: boolean | null;
};

/** `items` is a Stripe list object: `{ object: "list", data: [...] }`. */
function readItems(value: unknown): Item[] | null {
  if (value === null || typeof value !== "object") return null;

  const { data } = value as { data?: unknown };

  if (!Array.isArray(data)) return null;

  const items: Item[] = [];

  for (const entry of data) {
    if (entry === null || typeof entry !== "object") return null;

    const { price, quantity, discounts } = entry as {
      price?: unknown;
      quantity?: unknown;
      discounts?: unknown;
    };
    const priceId = stripeId(price);

    items.push({
      priceId,
      billing: readBilling(price, quantity),
      discounted: readDiscounted(discounts),
    });
  }

  return items;
}

/**
 * Stripe lists a subscription's (or item's) discounts as an array — of ids, or
 * of discount objects when expanded. Any entry means a discount applies; an
 * absent or malformed list is `null` (unknown), never "no discount".
 */
function readDiscounted(discounts: unknown): boolean | null {
  return Array.isArray(discounts) ? discounts.length > 0 : null;
}

/**
 * `canceled` is the one status Stripe never leaves, so it is the truth about
 * an ending even when our records lag behind; otherwise a scheduled
 * cancellation is whatever `cancel_at_period_end` / `cancel_at` say. Both
 * fields are consulted: `cancel_at` alone is set for a cancellation at a
 * chosen date, and a period-end one may or may not carry a date.
 */
function readCancellation(
  subscription: Record<string, unknown>,
): PlanCancellation | null {
  if (subscription.status === "canceled") {
    return { kind: "ended", at: isoTimestamp(subscription.ended_at) };
  }

  const cancelAt = isoTimestamp(subscription.cancel_at);

  if (subscription.cancel_at_period_end === true || cancelAt !== null) {
    return { kind: "scheduled", at: cancelAt };
  }

  return null;
}

/** A Stripe unix timestamp (seconds) as ISO 8601; anything else is `null`. */
function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;

  return new Date(value * 1000).toISOString();
}

/** A plain recurring per-unit price with a known quantity; anything else is `null`. */
function readBilling(
  price: unknown,
  quantity: unknown,
): Omit<PlanBilling, "discounted"> | null {
  if (price === null || typeof price !== "object") return null;

  const { unit_amount, currency, recurring, billing_scheme } = price as {
    unit_amount?: unknown;
    currency?: unknown;
    recurring?: unknown;
    billing_scheme?: unknown;
  };

  if (billing_scheme !== "per_unit") return null;
  if (typeof unit_amount !== "number" || !Number.isInteger(unit_amount)) return null;
  if (typeof currency !== "string" || currency.length === 0) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
    return null;
  }
  if (recurring === null || typeof recurring !== "object") return null;

  const { interval, interval_count } = recurring as {
    interval?: unknown;
    interval_count?: unknown;
  };

  if (!isBillingInterval(interval)) return null;
  if (typeof interval_count !== "number" || !Number.isInteger(interval_count)) {
    return null;
  }
  if (interval_count < 1) return null;

  return {
    amount: unit_amount * quantity,
    currency: currency.toLowerCase(),
    interval,
    intervalCount: interval_count,
  };
}

/** Stripe fields that are an id or an expanded object with one. */
function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;

  if (value !== null && typeof value === "object") {
    const { id } = value as { id?: unknown };

    return typeof id === "string" && id.length > 0 ? id : null;
  }

  return null;
}

/**
 * "$29/month", "$290/year", "$87 every 3 months". Whole amounts drop the
 * cents; amounts with cents keep them. Falls back to the bare code for a
 * currency `Intl` does not know. The discount flag is the caller's to show:
 * the figure is the price before discounts either way.
 */
export function formatPlanBilling(billing: Omit<PlanBilling, "discounted">): string {
  const digits = minorUnitDigits(billing.currency);
  const amount = billing.amount / 10 ** digits;
  const whole = Number.isInteger(amount);

  let money: string;

  try {
    money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: billing.currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    money = `${whole ? amount.toFixed(0) : amount.toFixed(digits)} ${billing.currency.toUpperCase()}`;
  }

  return billing.intervalCount === 1
    ? `${money}/${billing.interval}`
    : `${money} every ${billing.intervalCount} ${billing.interval}s`;
}

/** A subscription date as shown to the user, e.g. `Mar 31, 2026` (UTC calendar date). */
export function formatSubscriptionDate(at: string): string {
  return formatInvoiceDate(at);
}
