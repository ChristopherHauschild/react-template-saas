// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

const stripe = vi.hoisted(() => ({
  subscriptionsRetrieve: vi.fn<(id: string) => Promise<unknown>>(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({ subscriptions: { retrieve: stripe.subscriptionsRetrieve } }),
}));

// The catalog resolves prices from the validated server env; pin them here.
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    STRIPE_PRICE_PRO: "price_1ProAbc123",
    STRIPE_PRICE_ENTERPRISE: "price_1EntXyz789",
  },
}));

const billing = vi.hoisted(() => ({
  getSubscriptionOverview:
    vi.fn<
      (
        userId: string,
      ) => Promise<import("./get-subscription-overview").SubscriptionOverview>
    >(),
}));
// Partial: the status helpers the reader uses stay real; only the read is mocked.
vi.mock("./get-subscription-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-subscription-overview")>()),
  getSubscriptionOverview: billing.getSubscriptionOverview,
}));
// The overview module pulls in the cookie-based Supabase client; never built here.
vi.mock("@/infrastructure/auth/supabase/server", () => ({ createClient: vi.fn() }));

import { getCurrentPlan, isMissingSubscriptionError } from "./get-current-plan";

// ------------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "sub_existing";
const CUSTOMER = "cus_existing";

type Overview = import("./get-subscription-overview").SubscriptionOverview;
type Consolidated = import("./get-subscription-overview").ConsolidatedSubscription;

const consolidated = (
  stripeSubscriptionId: string | null,
  stripeCustomerId: string | null,
  status: string,
): Consolidated => ({
  stripeSubscriptionId,
  stripeCustomerId,
  status,
  rowCount: 1,
  statusConflict: false,
  customerConflict: false,
  isServicing: ["active", "trialing", "past_due", "unpaid", "paused"].includes(status),
});

const overviewOf = (current: Consolidated | null): Overview => ({
  ok: true,
  stripeCustomerId: current?.stripeCustomerId ?? null,
  customerResolution: current?.stripeCustomerId
    ? { kind: "single", stripeCustomerId: current.stripeCustomerId }
    : { kind: "none" },
  current,
  isServicing: current?.isServicing ?? false,
  subscriptions: current ? [current] : [],
});

const ACTIVE_PRO = overviewOf(consolidated(SUBSCRIPTION, CUSTOMER, "active"));

const stripeSubscription = (
  priceId: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: SUBSCRIPTION,
  object: "subscription",
  customer: CUSTOMER,
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  ended_at: null,
  discounts: [],
  items: {
    object: "list",
    data: [
      {
        id: "si_1",
        object: "subscription_item",
        quantity: 1,
        discounts: [],
        price: {
          id: priceId,
          object: "price",
          unit_amount: 2900,
          currency: "usd",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1 },
        },
      },
    ],
  },
  ...overrides,
});

const stripeError = (fields: Record<string, unknown>) =>
  Object.assign(new Error("stripe"), { name: "StripeError", ...fields });

let logs: { error: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> };

beforeEach(() => {
  vi.clearAllMocks();
  billing.getSubscriptionOverview.mockResolvedValue(ACTIVE_PRO);
  stripe.subscriptionsRetrieve.mockResolvedValue(stripeSubscription("price_1ProAbc123"));
  logs = {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("getCurrentPlan – which subscription is asked about", () => {
  it("retrieves the current subscription from the caller's read of the records", async () => {
    await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO });

    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledWith(SUBSCRIPTION);
    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
  });

  it("reads the records itself when no overview is given", async () => {
    await getCurrentPlan(USER_ID);

    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER_ID);
    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledWith(SUBSCRIPTION);
  });

  it("makes no request for a user without a subscription", async () => {
    expect(await getCurrentPlan(USER_ID, { overview: overviewOf(null) })).toEqual({
      kind: "none",
    });
    expect(stripe.subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("asks about the subscription the records present as current, ended or not", async () => {
    const canceled = overviewOf(consolidated(SUBSCRIPTION, CUSTOMER, "canceled"));
    stripe.subscriptionsRetrieve.mockResolvedValue(
      stripeSubscription("price_1ProAbc123", { status: "canceled" }),
    );

    expect(await getCurrentPlan(USER_ID, { overview: canceled })).toMatchObject({
      kind: "ok",
      plan: { id: "pro" },
    });
  });
});

describe("getCurrentPlan – the plan", () => {
  it("names the catalog plan of the subscription's price, with what is billed", async () => {
    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "ok",
      plan: {
        id: "pro",
        name: "Pro",
        features: [
          "Everything in Starter",
          "Unlimited projects",
          "Priority support",
          "Advanced analytics",
        ],
        billing: {
          amount: 2900,
          currency: "usd",
          interval: "month",
          intervalCount: 1,
          discounted: false,
        },
      },
      subscription: { status: "active", cancellation: null, collectionPaused: null },
    });
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("resolves the other configured paid plan too", async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(
      stripeSubscription("price_1EntXyz789"),
    );

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toMatchObject({
      kind: "ok",
      plan: { id: "enterprise", name: "Enterprise" },
    });
  });

  it("reports a price outside the catalog as unrecognized, and notices it in the log", async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(stripeSubscription("price_1Legacy"));

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "unrecognized",
      subscription: { status: "active", cancellation: null, collectionPaused: null },
    });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toMatch(/price_|sub_|cus_/);
  });
});

describe("getCurrentPlan – failures (closed, logged without ids, never thrown)", () => {
  it("is unavailable when the records could not be read", async () => {
    const overview: Overview = { ok: false, error: { message: "denied", code: "42501" } };

    expect(await getCurrentPlan(USER_ID, { overview })).toEqual({
      kind: "unavailable",
      reason: "records_unreadable",
    });
    expect(stripe.subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("is unavailable when the current subscription has no Stripe id", async () => {
    const overview = overviewOf(consolidated(null, CUSTOMER, "active"));

    expect(await getCurrentPlan(USER_ID, { overview })).toEqual({
      kind: "unavailable",
      reason: "missing_subscription_id",
    });
    expect(stripe.subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("never sends a stored id that is not a Stripe subscription id", async () => {
    const overview = overviewOf(consolidated("sub_1/../customers", CUSTOMER, "active"));

    expect(await getCurrentPlan(USER_ID, { overview })).toEqual({
      kind: "unavailable",
      reason: "invalid_subscription_id",
    });
    expect(stripe.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.error.mock.calls)).not.toMatch(/sub_/);
  });

  it("is unavailable when Stripe does not know the subscription", async () => {
    stripe.subscriptionsRetrieve.mockRejectedValue(
      stripeError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "id",
        statusCode: 404,
        requestId: "req_1",
      }),
    );

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "unavailable",
      reason: "subscription_missing",
    });
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining("does not know"),
      expect.objectContaining({
        userId: USER_ID,
        error: expect.objectContaining({ requestId: "req_1" }),
      }),
    );
  });

  it("is unavailable when Stripe cannot be reached, without rethrowing", async () => {
    stripe.subscriptionsRetrieve.mockRejectedValue(
      stripeError({ type: "StripeConnectionError", statusCode: 503 }),
    );

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
    // The message is never logged (it can echo request parameters); ids never.
    const logged = JSON.stringify(logs.error.mock.calls);
    expect(logged).not.toMatch(/sub_|cus_/);
    expect(logged).not.toContain('"message"');
  });

  it("refuses an answer that is not the subscription asked about, on the records' customer", async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(
      stripeSubscription("price_1ProAbc123", { customer: "cus_other" }),
    );

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining("unusable"),
      expect.objectContaining({ reason: "different_customer" }),
    );
  });

  it("refuses something that is not a subscription at all", async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue({ object: "list", data: [] });

    expect(await getCurrentPlan(USER_ID, { overview: ACTIVE_PRO })).toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
  });
});

describe("isMissingSubscriptionError", () => {
  it("recognises Stripe's resource_missing on the subscription id", () => {
    expect(
      isMissingSubscriptionError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "id",
      }),
    ).toBe(true);
    expect(
      isMissingSubscriptionError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "subscription",
      }),
    ).toBe(true);
  });

  it("does not match other errors", () => {
    expect(
      isMissingSubscriptionError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "customer",
      }),
    ).toBe(false);
    expect(isMissingSubscriptionError({ type: "StripeAPIError" })).toBe(false);
    expect(isMissingSubscriptionError(new Error("x"))).toBe(false);
    expect(isMissingSubscriptionError(null)).toBe(false);
  });
});
