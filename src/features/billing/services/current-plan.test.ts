// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// The status helpers come from the overview module, which pulls in the
// cookie-based Supabase client (and the validated env). Nothing here reads the
// database.
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("the reader must not touch the database");
  }),
}));

import type { Plan } from "../types/plan";

import {
  type ExpectedSubscription,
  formatPlanBilling,
  formatSubscriptionDate,
  isStripeSubscriptionId,
  type PlanBilling,
  readSubscriptionPlan,
} from "./current-plan";

const PRO: Plan = {
  id: "pro",
  name: "Pro",
  price: 29,
  popular: true,
  available: true,
  features: ["Everything in Starter", "Unlimited projects"],
};
const ENTERPRISE: Plan = {
  id: "enterprise",
  name: "Enterprise",
  price: 99,
  available: true,
  features: ["Everything in Pro"],
};

/** The catalog lookup, as `findPlanByStripePrice` would answer for a configured env. */
const CATALOG: Record<string, Plan> = { price_pro: PRO, price_ent: ENTERPRISE };
const findPlan = (priceId: string) => CATALOG[priceId] ?? null;

const EXPECTED: ExpectedSubscription = {
  stripeSubscriptionId: "sub_1",
  stripeCustomerId: "cus_1",
};

type ItemInput = {
  price?: unknown;
  quantity?: unknown;
  discounts?: unknown;
};

const price = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  object: "price",
  unit_amount: 2900,
  currency: "usd",
  billing_scheme: "per_unit",
  recurring: { interval: "month", interval_count: 1 },
  ...overrides,
});

/** Items carry an (empty) discount list unless the test says otherwise, as Stripe's do. */
const item = (input: ItemInput) => ({ discounts: [], ...input });

const subscription = (
  items: ItemInput[] = [{ price: price("price_pro"), quantity: 1 }],
  overrides: Record<string, unknown> = {},
) => ({
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  discounts: [],
  metadata: { userId: "u1", planId: "enterprise" }, // stale on purpose: must be ignored
  items: { object: "list", data: items.map(item) },
  ...overrides,
});

const MONTHLY_PRO: PlanBilling = {
  amount: 2900,
  currency: "usd",
  interval: "month",
  intervalCount: 1,
  discounted: false,
};

describe("readSubscriptionPlan – the plan of a subscription", () => {
  it("matches the item's price against the catalog and reads what is billed", () => {
    expect(readSubscriptionPlan(subscription(), EXPECTED, findPlan)).toEqual({
      ok: true,
      result: {
        kind: "ok",
        plan: {
          id: "pro",
          name: "Pro",
          features: ["Everything in Starter", "Unlimited projects"],
          billing: MONTHLY_PRO,
        },
        subscription: { status: "active", cancellation: null, collectionPaused: null },
      },
    });
  });

  it("uses the price, not the planId stamped into metadata at checkout", () => {
    // A portal plan change moves the price but leaves the metadata behind.
    const answer = subscription(
      [{ price: price("price_ent", { unit_amount: 9900 }), quantity: 1 }],
      {
        metadata: { planId: "pro" },
      },
    );

    const reading = readSubscriptionPlan(answer, EXPECTED, findPlan);

    expect(reading).toMatchObject({
      ok: true,
      result: { kind: "ok", plan: { id: "enterprise", billing: { amount: 9900 } } },
    });
  });

  it("accepts an expanded price/customer object as well as a bare id", () => {
    const answer = subscription([{ price: price("price_pro"), quantity: 1 }], {
      customer: { id: "cus_1", object: "customer" },
    });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      ok: true,
      result: { kind: "ok", plan: { id: "pro" } },
    });
  });

  it("carries no Stripe identifiers into the result", () => {
    const reading = readSubscriptionPlan(subscription(), EXPECTED, findPlan);
    const serialised = JSON.stringify(reading);

    expect(serialised).not.toMatch(/sub_/);
    expect(serialised).not.toMatch(/cus_/);
    expect(serialised).not.toMatch(/price_/);
  });

  it("copies the features so the catalog cannot be mutated through the result", () => {
    const reading = readSubscriptionPlan(subscription(), EXPECTED, findPlan);

    if (!reading.ok || reading.result.kind !== "ok") throw new Error("expected ok");
    reading.result.plan.features.push("tampered");

    expect(PRO.features).not.toContain("tampered");
  });

  it("multiplies the unit amount by the quantity", () => {
    const answer = subscription([{ price: price("price_pro"), quantity: 3 }]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { plan: { billing: { amount: 8700 } } },
    });
  });
});

describe("readSubscriptionPlan – a plan it cannot name", () => {
  it("is unrecognized when the price is not in the catalog (never guessed from metadata)", () => {
    const answer = subscription([{ price: price("price_legacy"), quantity: 1 }]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toEqual({
      ok: true,
      result: { kind: "unrecognized", subscription: expect.any(Object) },
    });
  });

  it("is unrecognized when the subscription has no items or no priced items", () => {
    expect(readSubscriptionPlan(subscription([]), EXPECTED, findPlan)).toEqual({
      ok: true,
      result: { kind: "unrecognized", subscription: expect.any(Object) },
    });
    expect(
      readSubscriptionPlan(subscription([{ quantity: 1 }]), EXPECTED, findPlan),
    ).toEqual({
      ok: true,
      result: { kind: "unrecognized", subscription: expect.any(Object) },
    });
  });

  it("is unrecognized when several items name catalog plans", () => {
    const answer = subscription([
      { price: price("price_pro"), quantity: 1 },
      { price: price("price_ent"), quantity: 1 },
    ]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toEqual({
      ok: true,
      result: { kind: "unrecognized", subscription: expect.any(Object) },
    });
  });
});

describe("readSubscriptionPlan – what is billed", () => {
  it("names the plan but not the amount when other items are on the subscription", () => {
    const answer = subscription([
      { price: price("price_pro"), quantity: 1 },
      { price: price("price_addon", { unit_amount: 500 }), quantity: 1 },
    ]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { kind: "ok", plan: { id: "pro", billing: null } },
    });
  });

  it.each([
    ["tiered pricing", { billing_scheme: "tiered", unit_amount: null }],
    ["a custom amount", { unit_amount: null }],
    ["a non-integer amount", { unit_amount: 29.5 }],
    ["no recurrence", { recurring: null }],
    ["an unknown interval", { recurring: { interval: "fortnight", interval_count: 1 } }],
    ["a zero interval count", { recurring: { interval: "month", interval_count: 0 } }],
    ["no currency", { currency: "" }],
  ])("names the plan but not the amount for %s", (_, overrides) => {
    const answer = subscription([{ price: price("price_pro", overrides), quantity: 1 }]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { kind: "ok", plan: { id: "pro", billing: null } },
    });
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5],
    ["a string", "1"],
  ])("names the plan but not the amount when the quantity is %s", (_, quantity) => {
    const answer = subscription([{ price: price("price_pro"), quantity }]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { kind: "ok", plan: { id: "pro", billing: null } },
    });
  });

  it("normalises the currency code to lower case", () => {
    const answer = subscription([
      { price: price("price_pro", { currency: "USD" }), quantity: 1 },
    ]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { plan: { billing: { currency: "usd" } } },
    });
  });
});

describe("readSubscriptionPlan – discounts", () => {
  it("flags a discount on the subscription: the figure is the price before discounts", () => {
    const answer = subscription(undefined, { discounts: ["di_1"] });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { plan: { billing: { amount: 2900, discounted: true } } },
    });
  });

  it("flags a discount on the plan's item", () => {
    const answer = subscription([
      {
        price: price("price_pro"),
        quantity: 1,
        discounts: [{ id: "di_1", object: "discount" }],
      },
    ]);

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { plan: { billing: { discounted: true } } },
    });
  });

  it("shows no figure when the discount list cannot be read (unknown is not 'no discount')", () => {
    expect(
      readSubscriptionPlan(
        subscription(undefined, { discounts: undefined }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { kind: "ok", plan: { id: "pro", billing: null } } });
    expect(
      readSubscriptionPlan(
        subscription(undefined, { discounts: "di_1" }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { kind: "ok", plan: { id: "pro", billing: null } } });
    expect(
      readSubscriptionPlan(
        subscription([{ price: price("price_pro"), quantity: 1, discounts: null }]),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { kind: "ok", plan: { id: "pro", billing: null } } });
  });

  it("never carries the discount's id", () => {
    const answer = subscription(undefined, { discounts: ["di_secret"] });

    expect(JSON.stringify(readSubscriptionPlan(answer, EXPECTED, findPlan))).not.toMatch(
      /di_/,
    );
  });
});

describe("readSubscriptionPlan – cancellation", () => {
  const MARCH_31 = 1_774_915_200; // 2026-03-31T00:00:00Z

  it("is null for a subscription that is neither set to cancel nor ended", () => {
    expect(readSubscriptionPlan(subscription(), EXPECTED, findPlan)).toMatchObject({
      result: { subscription: { cancellation: null } },
    });
  });

  it("reads a cancellation at period end, with the date Stripe gives for it", () => {
    const answer = subscription(undefined, {
      cancel_at_period_end: true,
      cancel_at: MARCH_31,
    });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: {
        subscription: {
          cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" },
        },
      },
    });
  });

  it("reads a cancellation at period end without a date", () => {
    const answer = subscription(undefined, { cancel_at_period_end: true });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { subscription: { cancellation: { kind: "scheduled", at: null } } },
    });
  });

  it("reads a cancellation at a chosen date (cancel_at alone)", () => {
    const answer = subscription(undefined, { cancel_at: MARCH_31 });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: {
        subscription: {
          cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" },
        },
      },
    });
  });

  it("reads an ended subscription from Stripe's canceled status, with when it ended", () => {
    const answer = subscription(undefined, {
      status: "canceled",
      canceled_at: MARCH_31 - 86_400,
      ended_at: MARCH_31,
      cancel_at_period_end: true, // may linger; the status wins
    });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: {
        subscription: { cancellation: { kind: "ended", at: "2026-03-31T00:00:00.000Z" } },
      },
    });
  });

  it("reads an ended subscription without a usable date", () => {
    expect(
      readSubscriptionPlan(
        subscription(undefined, { status: "canceled" }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({
      result: { subscription: { cancellation: { kind: "ended", at: null } } },
    });
    expect(
      readSubscriptionPlan(
        subscription(undefined, { status: "canceled", ended_at: "yesterday" }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({
      result: { subscription: { cancellation: { kind: "ended", at: null } } },
    });
  });

  it("ignores a malformed cancel_at rather than inventing a date", () => {
    const answer = subscription(undefined, { cancel_at_period_end: true, cancel_at: -5 });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: { subscription: { cancellation: { kind: "scheduled", at: null } } },
    });
  });
});

describe("readSubscriptionPlan – Stripe's own status and pause", () => {
  it.each([
    "active",
    "trialing",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
    "incomplete",
  ])(
    "carries Stripe's status %s, for both a recognised and an unrecognised plan",
    (status) => {
      expect(
        readSubscriptionPlan(subscription(undefined, { status }), EXPECTED, findPlan),
      ).toMatchObject({ result: { kind: "ok", subscription: { status } } });
      expect(
        readSubscriptionPlan(
          subscription([{ price: price("price_legacy"), quantity: 1 }], { status }),
          EXPECTED,
          findPlan,
        ),
      ).toMatchObject({ result: { kind: "unrecognized", subscription: { status } } });
    },
  );

  it("reports a status this code does not know as unknown, never as something else", () => {
    expect(
      readSubscriptionPlan(
        subscription(undefined, { status: "hibernating" }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { subscription: { status: "unknown" } } });
    expect(
      readSubscriptionPlan(
        subscription(undefined, { status: undefined }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { subscription: { status: "unknown" } } });
  });

  it("reads a paused payment collection, with when it resumes", () => {
    const answer = subscription(undefined, {
      pause_collection: { behavior: "void", resumes_at: 1_774_915_200 },
    });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({
      result: {
        subscription: {
          status: "active",
          collectionPaused: { resumesAt: "2026-03-31T00:00:00.000Z" },
        },
      },
    });
    expect(
      readSubscriptionPlan(
        subscription(undefined, {
          pause_collection: { behavior: "keep_as_draft", resumes_at: null },
        }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({
      result: { subscription: { collectionPaused: { resumesAt: null } } },
    });
  });

  it("is not paused when pause_collection is null or absent", () => {
    expect(
      readSubscriptionPlan(
        subscription(undefined, { pause_collection: null }),
        EXPECTED,
        findPlan,
      ),
    ).toMatchObject({ result: { subscription: { collectionPaused: null } } });
    expect(readSubscriptionPlan(subscription(), EXPECTED, findPlan)).toMatchObject({
      result: { subscription: { collectionPaused: null } },
    });
  });
});

describe("readSubscriptionPlan – answers it refuses", () => {
  it.each([
    ["nothing", null],
    ["a string", "sub_1"],
    ["a list", { object: "list", data: [] }],
    ["an invoice", { id: "sub_1", object: "invoice", customer: "cus_1" }],
  ])("refuses %s", (_, answer) => {
    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toMatchObject({ ok: false });
  });

  it("refuses a different subscription than the one asked about", () => {
    const answer = subscription([], { id: "sub_2" });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toEqual({
      ok: false,
      reason: "different_subscription",
    });
  });

  it("refuses a subscription on a different customer than the records name", () => {
    const answer = subscription([], { customer: "cus_2" });

    expect(readSubscriptionPlan(answer, EXPECTED, findPlan)).toEqual({
      ok: false,
      reason: "different_customer",
    });
    // A missing customer is just as much "not the one the records name".
    expect(
      readSubscriptionPlan(subscription([], { customer: null }), EXPECTED, findPlan),
    ).toEqual({ ok: false, reason: "different_customer" });
  });

  it("cannot cross-check the customer when the records name none, and says nothing about it", () => {
    const answer = subscription([], { customer: "cus_whatever" });

    expect(
      readSubscriptionPlan(answer, { ...EXPECTED, stripeCustomerId: null }, findPlan),
    ).toEqual({
      ok: true,
      result: { kind: "unrecognized", subscription: expect.any(Object) },
    });
  });

  it("refuses unreadable items rather than reporting 'unrecognized'", () => {
    expect(
      readSubscriptionPlan(subscription([], { items: null }), EXPECTED, findPlan),
    ).toEqual({ ok: false, reason: "items_unreadable" });
    expect(
      readSubscriptionPlan(
        subscription([], { items: { data: "x" } }),
        EXPECTED,
        findPlan,
      ),
    ).toEqual({ ok: false, reason: "items_unreadable" });
    expect(
      readSubscriptionPlan(
        subscription([], { items: { object: "list", data: [null] } }),
        EXPECTED,
        findPlan,
      ),
    ).toEqual({ ok: false, reason: "items_unreadable" });
  });
});

describe("formatPlanBilling", () => {
  it.each([
    [MONTHLY_PRO, "$29/month"],
    [{ ...MONTHLY_PRO, amount: 29000, interval: "year" as const }, "$290/year"],
    [{ ...MONTHLY_PRO, amount: 2950 }, "$29.50/month"],
    [
      { ...MONTHLY_PRO, amount: 8700, interval: "month" as const, intervalCount: 3 },
      "$87 every 3 months",
    ],
    [{ ...MONTHLY_PRO, amount: 1000, currency: "eur" }, "€10/month"],
    [{ ...MONTHLY_PRO, amount: 3000, currency: "jpy" }, "¥3,000/month"],
    [{ ...MONTHLY_PRO, amount: 500, interval: "week" as const }, "$5/week"],
  ])("formats %o as %s", (billing, text) => {
    expect(formatPlanBilling(billing)).toBe(text);
  });

  it("falls back to the bare code for a currency Intl cannot format", () => {
    expect(formatPlanBilling({ ...MONTHLY_PRO, currency: "xxx1" })).toBe("29 XXX1/month");
  });
});

describe("formatSubscriptionDate", () => {
  it("shows the UTC calendar date, like invoice dates", () => {
    expect(formatSubscriptionDate("2026-03-31T00:00:00.000Z")).toBe("Mar 31, 2026");
    expect(formatSubscriptionDate("2026-03-31T23:59:59.000Z")).toBe("Mar 31, 2026");
  });
});

describe("isStripeSubscriptionId", () => {
  it("accepts `sub_` ids and nothing else", () => {
    expect(isStripeSubscriptionId("sub_1AbC")).toBe(true);
    expect(isStripeSubscriptionId("cus_1")).toBe(false);
    expect(isStripeSubscriptionId("sub_")).toBe(false);
    expect(isStripeSubscriptionId("sub_1?x=1")).toBe(false);
    expect(isStripeSubscriptionId(null)).toBe(false);
  });
});
