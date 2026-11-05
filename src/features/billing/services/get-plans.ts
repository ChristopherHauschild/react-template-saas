import "server-only";

import { Plan } from "../types/plan";

import { listPlans } from "./plan-catalog";

/** Plans for the pricing page. Client-safe: no Stripe identifiers are included. */
export async function getPlans(): Promise<Plan[]> {
  return listPlans();
}
