"use server";

import { redirect } from "next/navigation";

import { clientEnv } from "@/config/env.client";
import { ROUTES } from "@/config/routes";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { getStripe } from "@/infrastructure/stripe";

import { getSubscriptionOverview } from "../services/get-subscription-overview";
import {
  isMissingCustomerError,
  isStripeCustomerId,
  isUsablePortalSession,
  summarizePortalErrorForLog,
} from "../services/portal-errors";

const LOG_PREFIX = "[billing]";

/**
 * Result of a portal attempt that did NOT redirect. Expected, user-actionable
 * problems are returned (so the billing page can show them inline); unexpected
 * failures (Stripe/API errors) are thrown and land in the route's error boundary.
 * Same contract as `createCheckoutSession`.
 */
export type PortalActionResult = { error: string } | null;

/**
 * Opens the Stripe Customer Portal for the signed-in user.
 *
 * The customer is resolved from the user's OWN subscription rows (read as the
 * user, under RLS) — never from anything the client sends. The action therefore
 * takes no meaningful parameters: `useActionState` calls it with
 * `(prevState, formData)`, and both are ignored.
 *
 * Every step fails closed. An unreadable state opens nothing rather than
 * guessing; records that point at several customers (or at none for a live
 * subscription) open nothing either; a user without a Stripe customer, or with
 * one Stripe no longer knows, gets an inline message; a stored id that is not a
 * customer id is never sent; and Stripe's answer is followed only if it is a
 * secure URL for the very customer we asked about. Anything unexpected is
 * logged (ids, never messages) and thrown to the route's error boundary.
 *
 * The portal's own actions (cancel, resume, switch plan, update card) come back
 * as `customer.subscription.*` / `invoice.*` webhooks, which are already handled.
 */
export async function createPortalSession(): Promise<PortalActionResult> {
  // Redirects to /login when there is no session.
  const user = await requireAuth();

  const overview = await getSubscriptionOverview(user.id);

  if (!overview.ok) {
    // The table could not be read: we do not know which customer to open.
    return {
      error:
        "We couldn't load your billing information, so the billing portal was not opened. Please try again in a moment.",
    };
  }

  const { customerResolution } = overview;

  if (customerResolution.kind === "none") {
    // The user has never reached Stripe, so there is no customer to manage.
    return {
      error:
        "You don't have a billing account yet. Choose a plan on the pricing page to get started.",
    };
  }

  if (customerResolution.kind === "ambiguous") {
    // The records name several customers, or none for a subscription that is
    // still billed. Opening one would be a guess that may manage the wrong
    // account, so none is opened. Counts only: no ids in the logs.
    console.error(`${LOG_PREFIX} customer is ambiguous; portal not opened`, {
      userId: user.id,
      reason: customerResolution.reason,
      customers: customerResolution.customers,
      subscriptions: overview.subscriptions.length,
    });

    return {
      error:
        "Your records point at more than one billing account, or at one we can't identify, so the billing portal can't be opened safely. Please contact support.",
    };
  }

  const customer = customerResolution.stripeCustomerId;

  if (!isStripeCustomerId(customer)) {
    // Corrupt data: whatever is stored is not a Stripe customer id. Sending it
    // would fail anyway; refuse without a Stripe call and make it visible.
    console.error(`${LOG_PREFIX} stored customer id is not a Stripe customer id`, {
      userId: user.id,
    });

    return {
      error:
        "We couldn't open the billing portal because your billing account could not be identified. Please contact support.",
    };
  }

  // Only the Stripe call is wrapped: `redirect()` below works by throwing and
  // must not be caught.
  let session: unknown;

  try {
    session = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${clientEnv.NEXT_PUBLIC_APP_URL}${ROUTES.billing}`,
    });
  } catch (error) {
    if (isMissingCustomerError(error)) {
      // The customer exists in our records but not in Stripe (deleted, or a
      // test/live mode mismatch). Not transient: a retry will not help.
      console.error(`${LOG_PREFIX} Stripe does not know the user's customer`, {
        userId: user.id,
        error: summarizePortalErrorForLog(error),
      });

      return {
        error: "We couldn't find your billing account in Stripe. Please contact support.",
      };
    }

    // Outage, rate limit, missing portal configuration, …: the error boundary
    // offers a retry. Log enough to correlate with Stripe's dashboard.
    console.error(`${LOG_PREFIX} could not create a customer portal session`, {
      userId: user.id,
      error: summarizePortalErrorForLog(error),
    });

    throw error;
  }

  if (!isUsablePortalSession(session, customer)) {
    console.error(`${LOG_PREFIX} Stripe returned an unusable portal session`, {
      userId: user.id,
      // Shape only: a URL would be the thing we refused to trust.
      received:
        session === null || typeof session !== "object" ? typeof session : "object",
    });

    throw new Error("Stripe did not return a usable billing portal session");
  }

  redirect(session.url);
}
