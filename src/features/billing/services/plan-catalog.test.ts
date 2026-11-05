// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// The catalog reads defaults from the validated server env; tests inject env explicitly.
vi.mock("@/config/env.server", () => ({
  serverEnv: { NODE_ENV: "test", SUPABASE_SERVICE_ROLE_KEY: "x" },
}));

import { PLAN_IDS } from "../types/plan";

import {
  findFreePlan,
  findPlanByStripePrice,
  isPlanId,
  listPlans,
  PLAN_PRICE_ENV_KEYS,
  resolvePlan,
} from "./plan-catalog";

const fullEnv = {
  STRIPE_PRICE_PRO: "price_1ProAbc123",
  STRIPE_PRICE_ENTERPRISE: "price_1EntXyz789",
};

describe("listPlans – client-safe catalog", () => {
  it("keeps the existing pricing content (names, prices, features, popular flag)", () => {
    expect(listPlans(fullEnv)).toEqual([
      {
        id: "starter",
        name: "Starter",
        price: 0,
        available: true,
        features: ["Basic features", "Up to 3 projects", "Community support"],
      },
      {
        id: "pro",
        name: "Pro",
        price: 29,
        popular: true,
        available: true,
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
        available: true,
        features: [
          "Everything in Pro",
          "Dedicated support",
          "Custom integrations",
          "SLA guarantee",
        ],
      },
    ]);
  });

  it("never exposes Stripe identifiers", () => {
    const serialised = JSON.stringify(listPlans());

    expect(serialised).not.toMatch(/price_/);
    expect(serialised).not.toMatch(/stripe/i);
    for (const plan of listPlans()) expect(Object.keys(plan)).not.toContain("priceId");
  });

  it("returns fresh copies so callers cannot mutate the catalog", () => {
    const a = listPlans();
    a[1].features?.push("tampered");
    a[1].name = "Tampered";

    expect(listPlans()[1]).toMatchObject({ name: "Pro" });
    expect(listPlans()[1].features).not.toContain("tampered");
  });

  it("every paid plan has an environment key; free plans have none", () => {
    for (const plan of listPlans()) {
      const hasKey = plan.id in PLAN_PRICE_ENV_KEYS;
      expect(hasKey, plan.id).toBe(plan.price > 0);
    }
  });
});

describe("findFreePlan – the plan a user without a subscription is on", () => {
  it("is the catalog's free plan, whether or not paid plans are configured", () => {
    expect(findFreePlan(listPlans(fullEnv))).toMatchObject({ id: "starter", price: 0 });
    expect(findFreePlan(listPlans({}))).toMatchObject({
      id: "starter",
      price: 0,
      available: true,
    });
  });

  it("is null when the catalog has no free plan (callers then name no plan)", () => {
    expect(findFreePlan(listPlans(fullEnv).filter((plan) => plan.price > 0))).toBeNull();
    expect(findFreePlan([])).toBeNull();
  });

  it("takes the first free plan when there are several", () => {
    const [starter, pro] = listPlans(fullEnv);
    const second = { ...pro, price: 0 };

    expect(findFreePlan([second, starter])).toBe(second);
  });
});

describe("findPlanByStripePrice – reading a subscription back", () => {
  it("is the inverse of resolvePlan for every configured paid plan", () => {
    for (const plan of listPlans(fullEnv).filter((p) => p.price > 0)) {
      const resolution = resolvePlan(plan.id, fullEnv);
      if (resolution.kind !== "paid") throw new Error(`${plan.id} should be paid`);

      expect(findPlanByStripePrice(resolution.stripePriceId, fullEnv)).toEqual(plan);
    }
  });

  it("is null for a price no configured plan uses", () => {
    expect(findPlanByStripePrice("price_1Legacy", fullEnv)).toBeNull();
    expect(findPlanByStripePrice("price_1ProAbc123", {})).toBeNull(); // not configured
    expect(
      findPlanByStripePrice("price_1ProAbc123", { STRIPE_PRICE_PRO: "not-a-price" }),
    ).toBeNull();
  });

  it("never resolves a malformed or empty id, even if the env held the same junk", () => {
    expect(findPlanByStripePrice("", { STRIPE_PRICE_PRO: "" })).toBeNull();
    expect(findPlanByStripePrice("junk", { STRIPE_PRICE_PRO: "junk" })).toBeNull();
  });

  it("returns a client-safe plan: no Stripe identifiers", () => {
    const plan = findPlanByStripePrice("price_1ProAbc123", fullEnv);

    expect(JSON.stringify(plan)).not.toMatch(/price_/);
  });
});

describe("resolvePlan – server-side validation of a checkout selection", () => {
  it("resolves configured paid plans to their Stripe price from the environment", () => {
    expect(resolvePlan("pro", fullEnv)).toEqual({
      kind: "paid",
      plan: expect.objectContaining({ id: "pro", price: 29 }),
      stripePriceId: "price_1ProAbc123",
    });
    expect(resolvePlan("enterprise", fullEnv)).toMatchObject({
      kind: "paid",
      stripePriceId: "price_1EntXyz789",
    });
  });

  it("resolves the free plan without any Stripe price, regardless of configuration", () => {
    expect(resolvePlan("starter", fullEnv)).toEqual({
      kind: "free",
      plan: expect.objectContaining({ id: "starter", price: 0 }),
    });
    expect(resolvePlan("starter", {})).toMatchObject({ kind: "free" });
  });

  it.each([
    ["a Stripe price id sent directly", "price_1ProAbc123"],
    ["the old stub id", "price_pro"],
    ["a different casing", "Pro"],
    ["whitespace padding", " pro "],
    ["an empty string", ""],
    ["a plan-looking string", "pro; drop table"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { id: "pro" }],
    ["an array", ["pro"]],
  ])("rejects %s as unknown", (_label, input) => {
    expect(resolvePlan(input, fullEnv)).toEqual({ kind: "unknown", input });
  });

  it("reports a paid plan as unavailable when its price is not configured", () => {
    expect(resolvePlan("pro", { STRIPE_PRICE_ENTERPRISE: "price_1EntXyz789" })).toEqual({
      kind: "unavailable",
      plan: expect.objectContaining({ id: "pro" }),
      envKey: "STRIPE_PRICE_PRO",
    });
    expect(resolvePlan("enterprise", {})).toMatchObject({
      kind: "unavailable",
      envKey: "STRIPE_PRICE_ENTERPRISE",
    });
  });

  it.each(["", "   ", "prod_123", "price_", "price_with-dash", "sk_live_secret", "1234"])(
    "treats a malformed configured value %j as unavailable rather than forwarding it to Stripe",
    (value) => {
      expect(resolvePlan("pro", { STRIPE_PRICE_PRO: value })).toMatchObject({
        kind: "unavailable",
      });
    },
  );

  it("isPlanId accepts exactly the catalog ids", () => {
    for (const id of PLAN_IDS) expect(isPlanId(id)).toBe(true);
    expect(isPlanId("price_pro")).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
  });
});
