/** Stable identifiers for the plans in the catalog; these are what the client sends. */
export const PLAN_IDS = ["starter", "pro", "enterprise"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

/**
 * Client-safe description of a plan. Deliberately carries no Stripe identifiers:
 * the server resolves a plan id to a Stripe price (see `services/plan-catalog.ts`).
 */
export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in USD; `0` marks a free plan that needs no Stripe subscription. */
  price: number;
  features?: string[];
  popular?: boolean;
  /**
   * Whether the plan can be selected right now. Free plans always are; a paid plan
   * is available only when its Stripe price is configured on the server. The UI
   * must not offer checkout for unavailable plans.
   */
  available: boolean;
};
