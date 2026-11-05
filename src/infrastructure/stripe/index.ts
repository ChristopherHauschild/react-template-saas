import Stripe from "stripe";

let stripe: Stripe | undefined;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  stripe ??= new Stripe(secretKey, {
    apiVersion: "2026-02-25.clover",
    ...stripeStandInConfig(),
  });

  return stripe;
}

/**
 * Development only: `STRIPE_API_BASE_URL` (e.g. `http://127.0.0.1:4242`) points
 * the SDK at a Stripe stand-in such as `scripts/sandbox/fake-stripe.mjs`, so the
 * billing pages can be exercised without network access or a Stripe account.
 * Ignored in production builds, so the variable can never redirect live traffic;
 * webhook signature verification does not depend on it either way.
 */
export function stripeStandInConfig(
  env: { STRIPE_API_BASE_URL?: string; NODE_ENV?: string } = process.env,
): Pick<Stripe.StripeConfig, "host" | "port" | "protocol"> {
  const base = env.STRIPE_API_BASE_URL;

  if (!base || env.NODE_ENV === "production") return {};

  let url: URL;

  try {
    url = new URL(base);
  } catch {
    throw new Error("STRIPE_API_BASE_URL is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("STRIPE_API_BASE_URL must be an http(s) URL");
  }

  const protocol = url.protocol === "https:" ? "https" : "http";

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : protocol === "https" ? 443 : 80,
    protocol,
  };
}
