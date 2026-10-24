import { headers } from "next/headers";

import Stripe from "stripe";

import { createClient } from "@/infrastructure/auth/supabase/server";
import { getStripe } from "@/infrastructure/stripe";

export async function POST(req: Request) {
  const body = await req.text();

  const signature = (await headers()).get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(
      body,
      signature,
      webhookSecret,
    );
  } catch {
    return new Response("Webhook error", { status: 400 });
  }

  const supabase = await createClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      const subscriptionId = session.subscription as string;
      const customerId = session.customer as string;
      const userId = session.metadata?.userId as string;

      await supabase.from("subscriptions").insert({
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: "active",
        userId,
      });

      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;

      await supabase
        .from("subscriptions")
        .update({ status: "canceled" })
        .eq("stripe_subscription_id", subscription.id);

      break;
    }
  }

  return new Response("ok");
}
