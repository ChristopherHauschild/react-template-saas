"use server";

import { redirect } from "next/navigation";

import { clientEnv } from "@/config/env.client";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { getStripe } from "@/infrastructure/stripe";

import { getUserBillingState } from "../services/get-user-billing-state";
import { resolvePlan } from "../services/plan-catalog";

/**
 * Result of a checkout attempt that did NOT redirect. Expected, user-actionable
 * problems are returned (so the pricing page can show them inline); unexpected
 * failures (Stripe/API errors) are thrown and land in the route's error boundary.
 */
export type CheckoutActionResult = { error: string } | null;

/**
 * Starts a Stripe Checkout for a plan chosen on the pricing page.
 *
 * `planId` is untrusted client input: it is resolved against the server-side plan
 * catalog and only a configured, paid plan reaches Stripe. The session is tied to
 * the authenticated user three ways — `client_reference_id`, the session's
 * `metadata.userId`, and `subscription_data.metadata.userId`, which Stripe copies
 * onto the subscription so every later lifecycle webhook can identify the user.
 *
 * Compatible with `useActionState`: once bound to a plan id, React calls it with
 * `(prevState, formData)`, which this action does not need.
 */
export async function createCheckoutSession(
  planId: string,
): Promise<CheckoutActionResult> {
  // Redirects to /login when there is no session.
  const user = await requireAuth();

  const resolution = resolvePlan(planId);

  if (resolution.kind === "unknown") {
    return { error: "That plan does not exist. Please refresh the page and try again." };
  }

  if (resolution.kind === "unavailable") {
    return { error: `The ${resolution.plan.name} plan is not available right now.` };
  }

  if (resolution.kind === "free") {
    // Nothing to bill: no Stripe subscription is created for a free plan.
    redirect("/dashboard");
  }

  if (!user.email) {
    return { error: "An email address is required on your account to start a checkout." };
  }

  // Reuse the user's Stripe customer and refuse to create a second, parallel
  // subscription. If the current state cannot be read we cannot rule out an
  // existing paid subscription, so the checkout is refused (fail closed).
  const billing = await getUserBillingState(user.id);

  if (!billing.ok) {
    return {
      error:
        "We couldn't verify your current subscription, so no checkout was started. Please try again in a moment.",
    };
  }

  if (billing.hasBlockingSubscription) {
    return {
      error: "You already have an active subscription. Manage it from your dashboard.",
    };
  }

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    // Stripe accepts either an existing customer or an email to create one, not both.
    ...(billing.stripeCustomerId
      ? { customer: billing.stripeCustomerId }
      : { customer_email: user.email }),
    client_reference_id: user.id,
    line_items: [{ price: resolution.stripePriceId, quantity: 1 }],
    success_url: `${clientEnv.NEXT_PUBLIC_APP_URL}/dashboard?checkout=success`,
    cancel_url: `${clientEnv.NEXT_PUBLIC_APP_URL}/pricing?checkout=canceled`,
    metadata: { userId: user.id, planId: resolution.plan.id },
    subscription_data: {
      metadata: { userId: user.id, planId: resolution.plan.id },
    },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  redirect(session.url);
}
