// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

/** Next's redirect() throws; model that so tests can assert the destination. */
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string | null } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

const stripe = vi.hoisted(() => ({
  create: vi.fn<(params: unknown) => Promise<{ url: string | null }>>(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripe.create } } }),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  },
}));

// Mutable so individual tests can remove price configuration.
const env = vi.hoisted(() => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    STRIPE_PRICE_PRO: "price_1ProAbc123" as string | undefined,
    STRIPE_PRICE_ENTERPRISE: "price_1EntXyz789" as string | undefined,
  },
}));
vi.mock("@/config/env.server", () => env);

const billing = vi.hoisted(() => ({
  getUserBillingState:
    vi.fn<() => Promise<import("../services/get-user-billing-state").UserBillingState>>(),
}));
vi.mock("../services/get-user-billing-state", () => billing);

import { createCheckoutSession } from "./create-checkout-session";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

const expectRedirect = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  return promise.catch((e: RedirectSignal) => e.url);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue(USER);
  stripe.create.mockResolvedValue({
    url: "https://checkout.stripe.com/c/pay/cs_test_123",
  });
  env.serverEnv.STRIPE_PRICE_PRO = "price_1ProAbc123";
  env.serverEnv.STRIPE_PRICE_ENTERPRISE = "price_1EntXyz789";
  billing.getUserBillingState.mockResolvedValue({
    ok: true,
    stripeCustomerId: null,
    hasBlockingSubscription: false,
    statuses: [],
  });
});

describe("createCheckoutSession – valid paid plan", () => {
  it("creates a subscription checkout for the configured Stripe price and redirects to it", async () => {
    expect(await expectRedirect(createCheckoutSession("pro"))).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(stripe.create.mock.calls[0][0]).toMatchObject({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: "price_1ProAbc123", quantity: 1 }],
      success_url: "https://app.example.com/dashboard?checkout=success",
      cancel_url: "https://app.example.com/pricing?checkout=canceled",
    });
  });

  it("uses the price of the plan that was selected, not another one", async () => {
    await expectRedirect(createCheckoutSession("enterprise"));

    expect(stripe.create.mock.calls[0][0]).toMatchObject({
      line_items: [{ price: "price_1EntXyz789", quantity: 1 }],
    });
  });

  it("associates the session with the authenticated user (email, client_reference_id, metadata)", async () => {
    await expectRedirect(createCheckoutSession("pro"));

    expect(stripe.create.mock.calls[0][0]).toMatchObject({
      customer_email: USER.email,
      client_reference_id: USER.id,
      metadata: { userId: USER.id, planId: "pro" },
    });
  });

  it("propagates userId (and planId) to subscription_data.metadata for lifecycle webhooks", async () => {
    await expectRedirect(createCheckoutSession("pro"));

    expect(stripe.create.mock.calls[0][0]).toMatchObject({
      subscription_data: { metadata: { userId: USER.id, planId: "pro" } },
    });
  });

  it("fails loudly if Stripe returns no checkout URL", async () => {
    stripe.create.mockResolvedValue({ url: null });

    await expect(createCheckoutSession("pro")).rejects.toThrow(/checkout URL/);
  });
});

describe("createCheckoutSession – invalid or tampered selections", () => {
  it.each(["price_1ProAbc123", "price_pro", "Pro", "", "enterprise ", "../pro"])(
    "returns an inline error for %j without contacting Stripe",
    async (input) => {
      await expect(createCheckoutSession(input)).resolves.toEqual({
        error: expect.stringMatching(/plan does not exist/),
      });
      expect(stripe.create).not.toHaveBeenCalled();
    },
  );

  it("returns an inline error for non-string input smuggled through the action boundary", async () => {
    await expect(
      createCheckoutSession({ id: "pro" } as unknown as string),
    ).resolves.toMatchObject({
      error: expect.any(String),
    });
    await expect(
      createCheckoutSession(undefined as unknown as string),
    ).resolves.toMatchObject({
      error: expect.any(String),
    });
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession – missing configuration", () => {
  it("refuses a paid plan whose Stripe price is not configured", async () => {
    env.serverEnv.STRIPE_PRICE_PRO = undefined;

    await expect(createCheckoutSession("pro")).resolves.toEqual({
      error: "The Pro plan is not available right now.",
    });
    expect(stripe.create).not.toHaveBeenCalled();

    // Other plans are unaffected.
    await expectRedirect(createCheckoutSession("enterprise"));
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a paid plan whose configured value is not a Stripe price id", async () => {
    env.serverEnv.STRIPE_PRICE_ENTERPRISE = "sk_live_leaked_secret";

    await expect(createCheckoutSession("enterprise")).resolves.toMatchObject({
      error: /not available/,
    });
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession – authentication", () => {
  it("redirects unauthenticated requests to /login before looking at the plan", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    expect(await expectRedirect(createCheckoutSession("pro"))).toBe("/login");
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated requests to /login even for tampered input (no information leak)", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    expect(await expectRedirect(createCheckoutSession("price_pro"))).toBe("/login");
  });

  it("requires an email address on the account to start a paid checkout", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    await expect(createCheckoutSession("pro")).resolves.toMatchObject({
      error: expect.stringMatching(/email address is required/),
    });
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession – free plan", () => {
  it("does not create a Stripe session and sends the user to the dashboard", async () => {
    expect(await expectRedirect(createCheckoutSession("starter"))).toBe("/dashboard");
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("still requires authentication", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    expect(await expectRedirect(createCheckoutSession("starter"))).toBe("/login");
  });

  it("does not need an email address (nothing is billed)", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    expect(await expectRedirect(createCheckoutSession("starter"))).toBe("/dashboard");
  });
});

describe("createCheckoutSession – existing Stripe customer and subscriptions", () => {
  it("reuses the user's Stripe customer instead of creating another one", async () => {
    billing.getUserBillingState.mockResolvedValue({
      ok: true,
      stripeCustomerId: "cus_existing",
      hasBlockingSubscription: false,
      statuses: ["canceled"],
    });

    await expectRedirect(createCheckoutSession("pro"));

    const params = stripe.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.customer).toBe("cus_existing");
    expect(params).not.toHaveProperty("customer_email"); // Stripe rejects both together
    expect(params).toMatchObject({ client_reference_id: USER.id });
  });

  it("refuses to start a second, parallel subscription", async () => {
    billing.getUserBillingState.mockResolvedValue({
      ok: true,
      stripeCustomerId: "cus_existing",
      hasBlockingSubscription: true,
      statuses: ["active"],
    });

    await expect(createCheckoutSession("enterprise")).resolves.toEqual({
      error: expect.stringMatching(/already have an active subscription/),
    });
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("looks up billing state for the authenticated user only", async () => {
    await expectRedirect(createCheckoutSession("pro"));

    expect(billing.getUserBillingState).toHaveBeenCalledWith(USER.id);
  });

  it("does not consult billing state for the free plan", async () => {
    await expectRedirect(createCheckoutSession("starter"));

    expect(billing.getUserBillingState).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession – fails closed when the subscription state is unknown", () => {
  // Regression: a failed lookup used to be treated as "no subscription", which
  // could start a second paid subscription for a user who already has one.

  it("refuses the checkout (no Stripe call) when the billing state cannot be read", async () => {
    billing.getUserBillingState.mockResolvedValue({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });

    await expect(createCheckoutSession("pro")).resolves.toEqual({
      error: expect.stringMatching(/couldn't verify your current subscription/),
    });
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("refuses the checkout when the lookup itself throws (unexpected failure → error boundary)", async () => {
    billing.getUserBillingState.mockRejectedValue(new Error("cookies unavailable"));

    await expect(createCheckoutSession("pro")).rejects.toThrow("cookies unavailable");
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("the free plan is unaffected: nothing can be double-billed", async () => {
    billing.getUserBillingState.mockResolvedValue({
      ok: false,
      error: { message: "down" },
    });

    expect(await expectRedirect(createCheckoutSession("starter"))).toBe("/dashboard");
  });
});

describe("createCheckoutSession – unexpected failures still surface", () => {
  it("propagates Stripe API errors (handled by the route's error boundary)", async () => {
    stripe.create.mockRejectedValue(new Error("Stripe is down"));

    await expect(createCheckoutSession("pro")).rejects.toThrow("Stripe is down");
  });
});
