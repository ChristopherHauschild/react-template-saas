import "server-only";

import { serverEnv } from "@/config/env.server";

import { type Plan, PLAN_IDS, type PlanId } from "../types/plan";

/**
 * Authoritative plan catalog.
 *
 * Plan content (names, prices, features) lives here; the Stripe Price id of each
 * paid plan comes from server-side environment variables so that no Stripe
 * identifiers are hard-coded or shipped to the client. Every checkout selection is
 * resolved against this catalog on the server — a client can only ever name a
 * plan id, never a price.
 */

/** Environment keys that provide the Stripe Price id for each paid plan. */
export const PLAN_PRICE_ENV_KEYS = {
  pro: "STRIPE_PRICE_PRO",
  enterprise: "STRIPE_PRICE_ENTERPRISE",
} as const satisfies Partial<Record<PlanId, string>>;

export type PlanPriceEnv = Partial<
  Record<(typeof PLAN_PRICE_ENV_KEYS)[keyof typeof PLAN_PRICE_ENV_KEYS], string>
>;

/** Stripe Price ids are `price_` followed by alphanumerics. */
const STRIPE_PRICE_ID = /^price_[A-Za-z0-9]+$/;

/** Plan content. Kept identical to the previous static list so the pricing UI is unchanged. */
const PLAN_CONTENT: readonly Omit<Plan, "available">[] = [
  {
    id: "starter",
    name: "Starter",
    price: 0,
    features: ["Basic features", "Up to 3 projects", "Community support"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 29,
    popular: true,
    features: [
      "Everything in Starter",
      "Unlimited projects",
      "Priority support",
      "Advanced analytics",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: 99,
    features: [
      "Everything in Pro",
      "Dedicated support",
      "Custom integrations",
      "SLA guarantee",
    ],
  },
];

type PlanContent = Omit<Plan, "available">;

export type PlanResolution =
  /** Not a plan id at all (tampered or stale client). */
  | { kind: "unknown"; input: unknown }
  /** A free plan: nothing to buy, no Stripe subscription is created. */
  | { kind: "free"; plan: PlanContent }
  /** A paid plan whose Stripe price is not (validly) configured; cannot be sold right now. */
  | { kind: "unavailable"; plan: PlanContent; envKey: string }
  /** A paid plan ready for checkout. */
  | { kind: "paid"; plan: PlanContent; stripePriceId: string };

function defaultPriceEnv(): PlanPriceEnv {
  return {
    STRIPE_PRICE_PRO: serverEnv.STRIPE_PRICE_PRO,
    STRIPE_PRICE_ENTERPRISE: serverEnv.STRIPE_PRICE_ENTERPRISE,
  };
}

/**
 * Client-safe plan list, in display order. Contains no Stripe identifiers, but
 * tells the UI which plans can actually be purchased (see `Plan.available`).
 */
export function listPlans(env: PlanPriceEnv = defaultPriceEnv()): Plan[] {
  return PLAN_CONTENT.map((plan) => ({
    ...plan,
    features: plan.features ? [...plan.features] : undefined,
    available: resolvePlan(plan.id, env).kind !== "unavailable",
  }));
}

/**
 * The plan a user without a subscription is on: the catalog's free plan (the
 * first, should there be several). `null` when the catalog has none — callers
 * then say "no subscription" rather than naming a plan.
 */
export function findFreePlan(plans: readonly Plan[]): Plan | null {
  return plans.find((plan) => plan.price === 0) ?? null;
}

/**
 * The catalog plan a Stripe price belongs to — the inverse of `resolvePlan`, for
 * reading a subscription back. `null` when no configured paid plan uses that
 * price (a price changed in the Stripe Dashboard, a legacy one, or an env
 * mismatch); callers then say "not in the catalog" rather than guess.
 * Free plans have no price and are never returned.
 */
export function findPlanByStripePrice(
  stripePriceId: string,
  env: PlanPriceEnv = defaultPriceEnv(),
): Plan | null {
  if (!STRIPE_PRICE_ID.test(stripePriceId)) return null;

  const plan = listPlans(env).find((candidate) => {
    const resolution = resolvePlan(candidate.id, env);

    return resolution.kind === "paid" && resolution.stripePriceId === stripePriceId;
  });

  return plan ?? null;
}

export function isPlanId(input: unknown): input is PlanId {
  return typeof input === "string" && (PLAN_IDS as readonly string[]).includes(input);
}

/**
 * Resolves an untrusted plan selection to something the checkout action may act on.
 * `env` is injectable for tests; it defaults to the validated server environment.
 */
export function resolvePlan(
  input: unknown,
  env: PlanPriceEnv = defaultPriceEnv(),
): PlanResolution {
  if (!isPlanId(input)) {
    return { kind: "unknown", input };
  }

  const plan = PLAN_CONTENT.find((candidate) => candidate.id === input)!;

  if (plan.price === 0) {
    return { kind: "free", plan };
  }

  const envKey = PLAN_PRICE_ENV_KEYS[input as keyof typeof PLAN_PRICE_ENV_KEYS];
  const stripePriceId = envKey ? env[envKey] : undefined;

  if (!envKey || !stripePriceId || !STRIPE_PRICE_ID.test(stripePriceId)) {
    return { kind: "unavailable", plan, envKey: envKey ?? "(none)" };
  }

  return { kind: "paid", plan, stripePriceId };
}
