import Stripe from "stripe";

let stripe: Stripe | undefined;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  stripe ??= new Stripe(secretKey, {
    apiVersion: "2026-02-25.clover",
  });

  return stripe;
}
