import Stripe from "stripe";

import {
  handleStripeWebhookEvent,
  type StripeWebhookOutcome,
} from "@/features/billing/services/handle-stripe-webhook-event";
import { getStripe } from "@/infrastructure/stripe";
import { createAdminClient } from "@/infrastructure/supabase/admin";

const LOG_PREFIX = "[stripe-webhook]";

export async function POST(req: Request) {
  const body = await req.text();

  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return new Response("Webhook error", { status: 400 });
  }

  // Stripe's request carries no user session, so persistence runs through the
  // privileged server-side client rather than the cookie-based one.
  let outcome: StripeWebhookOutcome;

  try {
    outcome = await handleStripeWebhookEvent(event, createAdminClient());
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected error while processing event`, {
      eventId: event.id,
      eventType: event.type,
      error,
    });

    // Non-2xx: Stripe will retry the event.
    return new Response("Webhook processing error", { status: 500 });
  }

  switch (outcome.kind) {
    case "failed":
      console.error(`${LOG_PREFIX} persistence failed; event not acknowledged`, {
        eventId: event.id,
        eventType: outcome.eventType,
        error: outcome.error,
      });

      // Non-2xx: Stripe will retry the event. Details stay in server logs.
      return new Response("Persistence error", { status: 500 });

    case "skipped":
      if (outcome.reason !== "unhandled_event_type") {
        console.warn(`${LOG_PREFIX} event acknowledged without a write`, {
          eventId: event.id,
          eventType: outcome.eventType,
          reason: outcome.reason,
          detail: outcome.detail,
        });
      }

      return new Response("ok");

    case "duplicate":
      // Already applied by an earlier delivery (e.g. our response was lost, or a
      // concurrent delivery won). Acknowledge so Stripe stops retrying.
      console.info(`${LOG_PREFIX} duplicate delivery acknowledged`, {
        eventId: outcome.eventId,
        eventType: outcome.eventType,
      });

      return new Response("ok");

    case "stale":
      // Delivered out of order: a newer position was already applied to this
      // subscription, so its status was left alone. Nothing to retry.
      console.info(
        `${LOG_PREFIX} out-of-order event acknowledged without status change`,
        {
          eventId: outcome.eventId,
          eventType: outcome.eventType,
        },
      );

      return new Response("ok");

    case "processed":
      return new Response("ok");
  }
}
