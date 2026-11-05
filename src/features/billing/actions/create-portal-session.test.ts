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
  portalCreate:
    vi.fn<(params: { customer: string; return_url: string }) => Promise<unknown>>(),
  checkoutCreate: vi.fn(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({
    billingPortal: { sessions: { create: stripe.portalCreate } },
    checkout: { sessions: { create: stripe.checkoutCreate } },
  }),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  },
}));

const billing = vi.hoisted(() => ({
  getSubscriptionOverview:
    vi.fn<
      () => Promise<import("../services/get-subscription-overview").SubscriptionOverview>
    >(),
}));
vi.mock("../services/get-subscription-overview", () => billing);

import { createPortalSession } from "./create-portal-session";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";

/** What Stripe answers: a session for the customer that was asked for. */
const portalSession = (customer: string, url: string | null = PORTAL_URL) => ({
  id: "bps_test_1",
  object: "billing_portal.session",
  customer,
  return_url: "https://app.example.com/billing",
  url,
});

/** Shape of a stripe-node error, without constructing the SDK. */
const stripeError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? "stripe error")), fields);

type Overview = import("../services/get-subscription-overview").SubscriptionOverview;
type Consolidated =
  import("../services/get-subscription-overview").ConsolidatedSubscription;

const consolidated = (
  stripeSubscriptionId: string,
  stripeCustomerId: string | null,
  status: string,
): Consolidated => ({
  stripeSubscriptionId,
  stripeCustomerId,
  status,
  rowCount: 1,
  statusConflict: false,
  customerConflict: false,
  isServicing: status === "active" || status === "past_due",
});

/** An overview whose records point at exactly one customer (or none). */
const withCustomer = (stripeCustomerId: string | null, status = "active"): Overview => {
  const current = consolidated("sub_1", stripeCustomerId, status);

  return {
    ok: true,
    stripeCustomerId,
    customerResolution:
      stripeCustomerId === null ? { kind: "none" } : { kind: "single", stripeCustomerId },
    current,
    isServicing: current.isServicing,
    subscriptions: [current],
  };
};

const expectRedirect = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  return promise.catch((e: RedirectSignal) => e.url);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  stripe.portalCreate.mockImplementation(async ({ customer }) => portalSession(customer));
  billing.getSubscriptionOverview.mockResolvedValue(withCustomer("cus_existing"));
});

describe("createPortalSession – happy path", () => {
  it("creates a portal session for the user's customer and redirects to it", async () => {
    expect(await expectRedirect(createPortalSession())).toBe(PORTAL_URL);

    expect(stripe.portalCreate).toHaveBeenCalledTimes(1);
    expect(stripe.portalCreate.mock.calls[0][0]).toEqual({
      customer: "cus_existing",
      return_url: "https://app.example.com/billing",
    });
  });

  it("follows the URL Stripe returned for that customer, and nothing else", async () => {
    stripe.portalCreate.mockImplementation(async ({ customer }) =>
      portalSession(customer, "https://billing.example-custom-domain.com/p/session/xyz"),
    );

    expect(await expectRedirect(createPortalSession())).toBe(
      "https://billing.example-custom-domain.com/p/session/xyz",
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("resolves the customer from the authenticated user's own rows", async () => {
    await expectRedirect(createPortalSession());

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER.id);
  });

  it("opens the portal even when the only subscription is canceled (invoices, payment method)", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(
      withCustomer("cus_old", "canceled"),
    );

    await expectRedirect(createPortalSession());

    expect(stripe.portalCreate.mock.calls[0][0]).toMatchObject({ customer: "cus_old" });
  });

  it("never touches Checkout", async () => {
    await expectRedirect(createPortalSession());

    expect(stripe.checkoutCreate).not.toHaveBeenCalled();
  });
});

describe("createPortalSession – client input is ignored", () => {
  // `useActionState` calls the action with (prevState, formData); a tampered form
  // or a hand-crafted request could put anything there. None of it may decide
  // which customer's portal opens.

  it("uses the database customer, not a customer id smuggled through the arguments", async () => {
    const formData = new FormData();
    formData.set("customer", "cus_victim");
    formData.set("return_url", "https://evil.example/phish");

    const action = createPortalSession as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await expectRedirect(action(null, formData));
    await expectRedirect(action("cus_victim"));
    await expectRedirect(action({ customer: "cus_victim" }, { customer: "cus_victim" }));

    for (const [params] of stripe.portalCreate.mock.calls) {
      expect(params).toEqual({
        customer: "cus_existing",
        return_url: "https://app.example.com/billing",
      });
    }
    expect(JSON.stringify(stripe.portalCreate.mock.calls)).not.toMatch(/cus_victim|evil/);
  });

  it("still refuses when the user has no customer, regardless of what the client sends", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(withCustomer(null, "incomplete"));

    const action = createPortalSession as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await expect(action("cus_victim")).resolves.toMatchObject({
      error: expect.any(String),
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });
});

describe("createPortalSession – authentication", () => {
  it("redirects unauthenticated requests to /login before reading anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    expect(await expectRedirect(createPortalSession())).toBe("/login");
    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it("does not need an email address (the customer already exists in Stripe)", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: USER.id, email: null });

    expect(await expectRedirect(createPortalSession())).toBe(PORTAL_URL);
  });
});

describe("createPortalSession – no billing account", () => {
  it("returns an inline error and does not contact Stripe when the user has no customer", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: null,
      customerResolution: { kind: "none" },
      current: null,
      isServicing: false,
      subscriptions: [],
    });

    await expect(createPortalSession()).resolves.toEqual({
      error: expect.stringMatching(/don't have a billing account/),
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it("treats rows without a customer id the same way (no customer to open)", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(withCustomer(null, "incomplete"));

    await expect(createPortalSession()).resolves.toEqual({
      error: expect.stringMatching(/don't have a billing account/),
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });
});

describe("createPortalSession – fails closed when the subscription state is unknown", () => {
  it("refuses to open the portal (no Stripe call) when the rows cannot be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });

    await expect(createPortalSession()).resolves.toEqual({
      error: expect.stringMatching(/couldn't load your billing information/),
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it("does not mistake an unknown state for 'no billing account'", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "down" },
    });

    const result = await createPortalSession();

    expect(result?.error).not.toMatch(/billing account/);
    expect(result?.error).toMatch(/try again/);
  });

  it("lets an unexpected throw from the lookup propagate (error boundary), without calling Stripe", async () => {
    billing.getSubscriptionOverview.mockRejectedValue(new Error("cookies unavailable"));

    await expect(createPortalSession()).rejects.toThrow("cookies unavailable");
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });
});

describe("createPortalSession – the customer must be one of the user's own", () => {
  it("uses the customer the overview chose, even when other rows carry other customers", async () => {
    // Several records, different customers (legacy data): the overview's choice
    // is authoritative; the action does not pick through the rows itself.
    const current = consolidated("sub_new", "cus_current", "active");
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: "cus_current",
      customerResolution: { kind: "single", stripeCustomerId: "cus_current" },
      current,
      isServicing: true,
      subscriptions: [
        current,
        consolidated("sub_old", "cus_old", "canceled"),
        consolidated("sub_x", "cus_other", "incomplete"),
      ],
    });

    await expectRedirect(createPortalSession());

    expect(stripe.portalCreate).toHaveBeenCalledTimes(1);
    expect(stripe.portalCreate.mock.calls[0][0].customer).toBe("cus_current");
  });

  it("relies on the resolution, not on `stripeCustomerId` alone (defence in depth)", async () => {
    // An overview that somehow carries an id while the resolution is not
    // `single` must not open anything.
    const current = consolidated("sub_1", "cus_leak", "active");
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: "cus_leak",
      customerResolution: {
        kind: "ambiguous",
        reason: "multiple_customers",
        customers: 2,
      },
      current,
      isServicing: true,
      subscriptions: [current, consolidated("sub_2", "cus_other", "active")],
    });

    await expect(createPortalSession()).resolves.toMatchObject({
      error: expect.any(String),
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  type AmbiguityReason = Extract<
    import("../services/get-subscription-overview").CustomerResolution,
    { kind: "ambiguous" }
  >["reason"];

  const ambiguous: [reason: AmbiguityReason, description: string][] = [
    ["multiple_customers", "two live subscriptions on different customers"],
    ["unknown_customer", "a live subscription without a customer"],
    ["customer_conflict", "one subscription naming two customers"],
    ["multiple_past_customers", "only ended subscriptions on several customers"],
  ];

  it.each(ambiguous)(
    "fails closed when the customer is ambiguous (%s: %s)",
    async (reason) => {
      const a = consolidated("sub_a", "cus_A", "active");
      const b = consolidated("sub_b", "cus_B", "active");
      billing.getSubscriptionOverview.mockResolvedValue({
        ok: true,
        stripeCustomerId: null,
        customerResolution: { kind: "ambiguous", reason, customers: 2 },
        current: a,
        isServicing: true,
        subscriptions: [a, b],
      });

      await expect(createPortalSession()).resolves.toEqual({
        error: expect.stringMatching(/more than one billing account.*contact support/),
      });
      expect(stripe.portalCreate).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/customer is ambiguous/),
        { userId: USER.id, reason, customers: 2, subscriptions: 2 },
      );
      // Counts only: no customer or subscription ids reach the logs.
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
        /cus_|sub_/,
      );
    },
  );

  it("distinguishes the ambiguous message from 'no billing account' and 'unknown state'", async () => {
    const a = consolidated("sub_a", "cus_A", "canceled");
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: null,
      customerResolution: {
        kind: "ambiguous",
        reason: "multiple_past_customers",
        customers: 2,
      },
      current: a,
      isServicing: false,
      subscriptions: [a, consolidated("sub_b", "cus_B", "canceled")],
    });

    const result = await createPortalSession();

    expect(result?.error).not.toMatch(/don't have a billing account|try again/);
  });

  it.each([
    "jane@example.com",
    " cus_123",
    "cus_",
    "sub_123",
    "cus_123; drop",
    "price_1",
  ])(
    "refuses a stored value that is not a Stripe customer id (%j) without calling Stripe",
    async (stored) => {
      billing.getSubscriptionOverview.mockResolvedValue(withCustomer(stored));

      await expect(createPortalSession()).resolves.toEqual({
        error: expect.stringMatching(/could not be identified.*contact support/),
      });
      expect(stripe.portalCreate).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/not a Stripe customer id/),
        { userId: USER.id },
      );
      // The bad value itself is not logged (it could be anything).
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(stored);
    },
  );
});

describe("createPortalSession – Stripe rejects the customer", () => {
  const missing = () =>
    stripeError({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      param: "customer",
      statusCode: 404,
      requestId: "req_123",
      message: "No such customer: 'cus_existing'",
    });

  it("returns an inline, non-retry message when Stripe no longer knows the customer", async () => {
    stripe.portalCreate.mockRejectedValue(missing());

    await expect(createPortalSession()).resolves.toEqual({
      error: expect.stringMatching(
        /couldn't find your billing account in Stripe.*contact support/,
      ),
    });
  });

  it("logs it with the user id and Stripe's code/request id, never the message or customer", async () => {
    stripe.portalCreate.mockRejectedValue(missing());

    await createPortalSession();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/does not know the user's customer/),
      {
        userId: USER.id,
        error: {
          name: "Error",
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          statusCode: 404,
          requestId: "req_123",
        },
      },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /No such customer|cus_existing/,
    );
  });

  it("treats resource_missing on another parameter as unexpected (error boundary)", async () => {
    stripe.portalCreate.mockRejectedValue(
      stripeError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "configuration",
        message: "No such configuration",
      }),
    );

    await expect(createPortalSession()).rejects.toThrow(/No such configuration/);
  });
});

describe("createPortalSession – unexpected failures still surface", () => {
  it("propagates Stripe API errors (handled by the route's error boundary) and logs a summary", async () => {
    stripe.portalCreate.mockRejectedValue(
      stripeError({
        type: "StripeInvalidRequestError",
        statusCode: 400,
        requestId: "req_cfg",
        message:
          "No configuration provided and your test mode default configuration has not been created",
      }),
    );

    await expect(createPortalSession()).rejects.toThrow(/default configuration/);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/could not create a customer portal session/),
      {
        userId: USER.id,
        error: expect.objectContaining({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          requestId: "req_cfg",
        }),
      },
    );
  });

  it("propagates transport failures (outage) for the boundary's retry", async () => {
    stripe.portalCreate.mockRejectedValue(
      stripeError({ type: "StripeConnectionError", message: "socket hang up" }),
    );

    await expect(createPortalSession()).rejects.toThrow("socket hang up");
  });

  const unusable: [label: string, make: (customer: string) => unknown][] = [
    ["no URL", (c) => portalSession(c, null)],
    ["an empty URL", (c) => portalSession(c, "")],
    ["a non-string URL", (c) => ({ ...portalSession(c), url: 42 })],
    ["a plain-http URL", (c) => portalSession(c, "http://billing.stripe.com/p/x")],
    ["a javascript: URL", (c) => portalSession(c, "javascript:alert(1)")],
    ["a relative URL", (c) => portalSession(c, "/p/session/x")],
    ["no session at all", () => null],
    ["a session for a different customer", () => portalSession("cus_someone_else")],
    [
      "a session without a customer",
      (c) => ({ ...portalSession(c), customer: undefined }),
    ],
  ];

  it.each(unusable)(
    "refuses to redirect when Stripe returns %s",
    async (_label, make) => {
      stripe.portalCreate.mockImplementation(async ({ customer }) => make(customer));

      await expect(createPortalSession()).rejects.toThrow(
        /usable billing portal session/,
      );

      const { redirect } = await import("next/navigation");
      expect(redirect).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/unusable portal session/),
        expect.objectContaining({ userId: USER.id }),
      );
    },
  );

  it("never writes a returned URL to the logs", async () => {
    stripe.portalCreate.mockImplementation(async ({ customer }) =>
      portalSession(customer, "javascript:alert(1)"),
    );

    await createPortalSession().catch(() => {});

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /javascript:/,
    );
  });
});
