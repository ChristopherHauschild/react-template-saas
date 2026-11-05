import "server-only";

import { getStripe } from "@/infrastructure/stripe";

import {
  type CurrentPlan,
  isStripeSubscriptionId,
  readSubscriptionPlan,
} from "./current-plan";
import {
  getSubscriptionOverview,
  type SubscriptionOverview,
} from "./get-subscription-overview";
import { findPlanByStripePrice } from "./plan-catalog";
import { summarizePortalErrorForLog } from "./portal-errors";

const LOG_PREFIX = "[billing]";

export type CurrentPlanOptions = {
  /**
   * The user's records, when the caller already read them (the dashboard,
   * which shows the status from the same read), so both agree on the same
   * rows. Without it, the rows are read here.
   */
  overview?: SubscriptionOverview;
};

/**
 * Reads which catalog plan the signed-in user's current subscription is for.
 *
 * Which subscription to ask about is exactly the one the records present as
 * current (`SubscriptionOverview.current`, from the user's OWN rows read
 * under RLS) — so the plan shown is always the plan of the subscription whose
 * status is shown next to it. Stripe's answer is used only if it is that
 * subscription, on the customer the records name for it.
 *
 * No subscription means no request: a user on the free plan never costs a
 * Stripe call. Every step fails closed and nothing is thrown: the plan is one
 * line on a card whose status does not depend on Stripe, so a Stripe failure
 * is returned as `unavailable` (and logged — ids never, only the error's
 * stable fields) rather than taking the page down.
 */
export async function getCurrentPlan(
  userId: string,
  options: CurrentPlanOptions = {},
): Promise<CurrentPlan> {
  const records = options.overview ?? (await getSubscriptionOverview(userId));

  if (!records.ok) {
    // Already logged by the overview. We do not know which subscription to ask about.
    return { kind: "unavailable", reason: "records_unreadable" };
  }

  const { current } = records;

  if (current === null) {
    return { kind: "none" };
  }

  if (current.stripeSubscriptionId === null) {
    console.error(`${LOG_PREFIX} current subscription has no Stripe id; plan not read`, {
      userId,
    });

    return { kind: "unavailable", reason: "missing_subscription_id" };
  }

  if (!isStripeSubscriptionId(current.stripeSubscriptionId)) {
    console.error(
      `${LOG_PREFIX} stored subscription id is not a Stripe subscription id`,
      {
        userId,
      },
    );

    return { kind: "unavailable", reason: "invalid_subscription_id" };
  }

  let answer: unknown;

  try {
    answer = await getStripe().subscriptions.retrieve(current.stripeSubscriptionId);
  } catch (error) {
    if (isMissingSubscriptionError(error)) {
      console.error(`${LOG_PREFIX} Stripe does not know the user's subscription`, {
        userId,
        error: summarizePortalErrorForLog(error),
      });

      return { kind: "unavailable", reason: "subscription_missing" };
    }

    console.error(`${LOG_PREFIX} could not read the user's subscription`, {
      userId,
      error: summarizePortalErrorForLog(error),
    });

    return { kind: "unavailable", reason: "stripe_error" };
  }

  const reading = readSubscriptionPlan(
    answer,
    {
      stripeSubscriptionId: current.stripeSubscriptionId,
      stripeCustomerId: current.stripeCustomerId,
    },
    findPlanByStripePrice,
  );

  if (!reading.ok) {
    console.error(`${LOG_PREFIX} Stripe returned an unusable subscription`, {
      userId,
      reason: reading.reason,
    });

    return { kind: "unavailable", reason: "unusable_response" };
  }

  if (reading.result.kind === "unrecognized") {
    // Worth noticing (a price changed in the Dashboard? an env mismatch?), but
    // not a failure: the status is still shown, the plan is not guessed.
    console.warn(`${LOG_PREFIX} subscription is on a price outside the catalog`, {
      userId,
    });
  }

  return reading.result;
}

/**
 * Stripe does not know the subscription we asked for: deleted, or an id from
 * the other mode (test/live) than the API key. Not transient — the records
 * are out of step with Stripe, which needs attention rather than a retry.
 */
export function isMissingSubscriptionError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  const { type, code, param } = error as {
    type?: unknown;
    code?: unknown;
    param?: unknown;
  };

  return (
    type === "StripeInvalidRequestError" &&
    code === "resource_missing" &&
    (param === "id" || param === "subscription")
  );
}
