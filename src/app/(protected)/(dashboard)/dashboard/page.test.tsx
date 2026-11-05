// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Guards: the page must not build its own Supabase client; the only Stripe
// call it may cause is reading the current subscription (invoices live on the
// billing page), and none at all for a user without one.
const infra = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);
const stripe = vi.hoisted(() => ({
  subscriptionsRetrieve: vi.fn<(id: string) => Promise<unknown>>(),
  invoicesList: vi.fn(() => {
    throw new Error("the dashboard must not list invoices");
  }),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: stripe.subscriptionsRetrieve },
    invoices: { list: stripe.invoicesList },
  }),
}));

// The billing barrel pulls in the checkout action (server-only env); not used here.
vi.mock("@/features/billing/actions/create-checkout-session", () => ({
  createCheckoutSession: vi.fn(),
}));
vi.mock("@/features/billing/actions/create-portal-session", () => ({
  createPortalSession: vi.fn(),
}));
vi.mock("@/config/env.server", () => ({
  serverEnv: {
    NODE_ENV: "test",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    STRIPE_PRICE_PRO: "price_1ProAbc123",
    STRIPE_PRICE_ENTERPRISE: "price_1EntXyz789",
  },
}));

type Overview =
  import("@/features/billing/services/get-subscription-overview").SubscriptionOverview;
type Plan = import("@/features/billing/types/plan").Plan;

const billing = vi.hoisted(() => ({
  getSubscriptionOverview: vi.fn<(userId: string) => Promise<Overview>>(),
  getPlans: vi.fn<() => Promise<Plan[]>>(),
}));
vi.mock(
  "@/features/billing/services/get-subscription-overview",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/billing/services/get-subscription-overview")
    >()),
    getSubscriptionOverview: billing.getSubscriptionOverview,
  }),
);
vi.mock("@/features/billing/services/get-plans", () => ({ getPlans: billing.getPlans }));

// The newest invoice comes through the history service (Stripe's invoice list);
// the page only hands it the user and the overview it already read.
type LatestInvoice =
  import("@/features/billing/services/get-latest-invoice").LatestInvoice;
const invoices = vi.hoisted(() => ({
  getLatestInvoice:
    vi.fn<(userId: string, options?: { overview?: unknown }) => Promise<LatestInvoice>>(),
}));
vi.mock("@/features/billing/services/get-latest-invoice", () => invoices);

import DashboardPage from "./page";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

const PLANS: Plan[] = [
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
    available: true,
    features: ["Unlimited projects"],
  },
  { id: "enterprise", name: "Enterprise", price: 99, available: false },
];

const NO_SUBSCRIPTION: Overview = {
  ok: true,
  stripeCustomerId: null,
  customerResolution: { kind: "none" },
  current: null,
  isServicing: false,
  subscriptions: [],
};

/** An overview with one subscription whose customer is clear. */
const single = (status: string, stripeCustomerId = "cus_1"): Overview => {
  const current = {
    stripeSubscriptionId: "sub_1",
    stripeCustomerId,
    status,
    rowCount: 1,
    statusConflict: false,
    customerConflict: false,
    isServicing: ["active", "trialing", "past_due", "unpaid", "paused"].includes(status),
  };

  return {
    ok: true,
    stripeCustomerId,
    customerResolution: { kind: "single", stripeCustomerId },
    current,
    isServicing: current.isServicing,
    subscriptions: [current],
  };
};

/** What Stripe holds for `single(...)`'s subscription: a Pro subscription on its customer. */
const stripeSubscription = (priceId = "price_1ProAbc123", customer = "cus_1") => ({
  id: "sub_1",
  object: "subscription",
  customer,
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  ended_at: null,
  discounts: [],
  items: {
    object: "list",
    data: [
      {
        quantity: 1,
        discounts: [],
        price: {
          id: priceId,
          unit_amount: 2900,
          currency: "usd",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1 },
        },
      },
    ],
  },
});

const render = async (checkout?: string) =>
  renderToStaticMarkup(
    await DashboardPage({ searchParams: Promise.resolve({ checkout }) }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue(USER);
  billing.getSubscriptionOverview.mockResolvedValue(NO_SUBSCRIPTION);
  billing.getPlans.mockResolvedValue(PLANS);
  stripe.subscriptionsRetrieve.mockResolvedValue(stripeSubscription());
  invoices.getLatestInvoice.mockResolvedValue({ kind: "none" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("/dashboard page – data flow", () => {
  it("reads the subscription records for the signed-in user only", async () => {
    await render();

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER.id);
    expect(infra.createClient).not.toHaveBeenCalled();
  });

  it("reads the plan catalog once, and calls Stripe not at all for a user without a subscription", async () => {
    await render();

    expect(billing.getPlans).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("reads the current subscription from Stripe — that one, once — for a subscribed user", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));

    await render();

    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledWith("sub_1");
    // The plan is asked about from the same read of the records as the status.
    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
  });

  it("asks for the newest invoice off the same read of the records, once", async () => {
    const overview = single("active");
    billing.getSubscriptionOverview.mockResolvedValue(overview);

    await render();

    expect(invoices.getLatestInvoice).toHaveBeenCalledTimes(1);
    expect(invoices.getLatestInvoice).toHaveBeenCalledWith(USER.id, { overview });
    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    // Never the full list directly: the history service is the only way to Stripe's invoices.
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("redirects anonymous visitors to /login without reading anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(
      DashboardPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({ url: "/login" });
    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
    expect(billing.getPlans).not.toHaveBeenCalled();
    expect(invoices.getLatestInvoice).not.toHaveBeenCalled();
  });

  it("lets an unexpected failure of the lookup reach the error boundary", async () => {
    billing.getSubscriptionOverview.mockRejectedValue(new Error("cookies unavailable"));

    await expect(DashboardPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "cookies unavailable",
    );
  });

  it("never leaks Stripe identifiers into the markup", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active", "cus_Secret123"));
    stripe.subscriptionsRetrieve.mockResolvedValue(
      stripeSubscription("price_1ProAbc123", "cus_Secret123"),
    );

    const html = await render();

    expect(html).toMatch(/>Pro</); // the plan was read …
    expect(html).not.toMatch(/cus_/); // … but no id came through
    expect(html).not.toMatch(/sub_/);
    expect(html).not.toMatch(/price_/);
  });
});

describe("/dashboard page – no subscription", () => {
  it("greets the user and names the account that is signed in", async () => {
    const html = await render();

    expect(html).toMatch(/<h2[^>]*>Welcome back/);
    expect(html).toContain("Logged in as jane@example.com");
  });

  it("shows the catalog's free plan as the current plan, with a link to pricing", async () => {
    const html = await render();

    expect(html).toMatch(/data-overview-state="none"/);
    expect(html).toMatch(/free Starter plan/);
    expect(html).toMatch(/Basic features/);
    expect(html).toMatch(/Up to 3 projects/);
    expect(html).toMatch(/href="\/pricing"/);
    expect(html).not.toMatch(/role="alert"/);
  });

  it("explains that there is no billing account yet and links to the billing page", async () => {
    const html = await render();

    expect(html).toMatch(/data-billing-customer="none"/);
    expect(html).toMatch(/No billing account yet/);
    expect(html).toMatch(/href="\/billing"/);
    expect(html).not.toMatch(/Manage billing/); // the portal is opened from /billing
    expect(html).not.toMatch(/<form/);
  });

  it("shows no invoice and makes no invoice lookup claim for a user without a billing account", async () => {
    const html = await render();

    expect(html).toMatch(/data-billing-customer="none"/);
    expect(html).not.toMatch(/data-latest-invoice/);
    expect(html).not.toMatch(/Download PDF/);
  });

  it("no longer shows the placeholder metrics", async () => {
    const html = await render();

    expect(html).not.toMatch(/Revenue/);
    expect(html).not.toMatch(/Customers/);
    expect(html).not.toMatch(/Active users/);
    expect(html).not.toMatch(/Conversion rate/);
  });

  it("copes with a catalog that has no free plan", async () => {
    billing.getPlans.mockResolvedValue(PLANS.filter((plan) => plan.price > 0));

    const html = await render();

    expect(html).toMatch(/data-overview-state="none"/);
    expect(html).toMatch(/have a subscription/);
    expect(html).not.toMatch(/Starter/);
    expect(html).toMatch(/href="\/pricing"/);
  });
});

describe("/dashboard page – other states", () => {
  it("reports unavailability (not 'free plan') when the records cannot be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });

    const html = await render();

    expect(html).toMatch(/data-overview-state="unavailable"/);
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/load your plan and billing details/);
    expect(html).not.toMatch(/Starter/);
    expect(html).not.toMatch(/href="\/pricing"/);
    expect(html).toMatch(/href="\/dashboard"/); // try again
    expect(html).not.toMatch(/permission denied/); // internals stay on the server
  });

  it("shows the plan, what it bills, the status and a link to billing for a subscription", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));

    const html = await render();

    expect(html).toMatch(/data-overview-state="subscription"/);
    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/data-plan-state="ok"/);
    expect(html).toMatch(/on the Pro plan/);
    expect(html).toMatch(/>Pro</);
    expect(html).toMatch(/\$29\/month/);
    expect(html).toMatch(/Unlimited projects/);
    expect(html).toMatch(/>Active</);
    expect(html).toMatch(/href="\/billing"/);
    expect(html).not.toMatch(/href="\/pricing"/); // checkout would be refused
    expect(html).not.toMatch(/free Starter plan/);
    expect(html).not.toMatch(/role="alert"/);
  });

  it("keeps the status and says the plan could not be read when Stripe fails", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    stripe.subscriptionsRetrieve.mockRejectedValue(
      Object.assign(new Error("boom"), { type: "StripeAPIError", statusCode: 500 }),
    );

    const html = await render();

    expect(html).toMatch(/data-plan-state="unavailable"/);
    expect(html).toMatch(/>Active</);
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/load your plan details/);
    expect(html).not.toMatch(/>Pro</);
    expect(html).not.toMatch(/boom/);
  });

  it("shows Stripe's status, and explains the lag, right after a cancellation in the portal", async () => {
    // Records still say active (the webhook has not applied the deletion yet).
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    stripe.subscriptionsRetrieve.mockResolvedValue({
      ...stripeSubscription(),
      status: "canceled",
      ended_at: 1_774_915_200,
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="canceled"/);
    expect(html).toMatch(/data-status-source="stripe"/);
    expect(html).toMatch(/>Canceled</);
    expect(html).not.toMatch(/>Active</);
    expect(html).toMatch(/Ended on Mar 31, 2026/);
    expect(html).toMatch(/You were on the Pro plan/);
    expect(html).toMatch(/records don&#x27;t reflect it yet/);
    expect(html).not.toMatch(/few seconds|shortly|will catch up/);
    expect(html).not.toMatch(/\$29\/month/);
    expect(html).not.toMatch(/href="\/pricing"/); // the checkout guard reads the records
  });

  it("shows a scheduled cancellation made in the portal, with no lag to explain", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    stripe.subscriptionsRetrieve.mockResolvedValue({
      ...stripeSubscription(),
      cancel_at_period_end: true,
      cancel_at: 1_774_915_200,
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/Set to cancel on Mar 31, 2026/);
    expect(html).not.toMatch(/data-records-lag/);
  });

  it("names no plan when the subscription's price is not in the catalog", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    stripe.subscriptionsRetrieve.mockResolvedValue(stripeSubscription("price_1Legacy"));

    const html = await render();

    expect(html).toMatch(/data-plan-state="unrecognized"/);
    expect(html).toMatch(/in the current catalog/);
    expect(html).toMatch(/>Active</);
    expect(html).not.toMatch(/>Pro</);
    expect(html).not.toMatch(/>Enterprise</);
    expect(html).not.toMatch(/role="alert"/);
  });
});

describe("/dashboard page – return from checkout", () => {
  it("acknowledges the return from checkout without confirming payment or activation", async () => {
    const html = await render("success");

    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/waiting for Stripe to confirm/);
    expect(html).not.toMatch(/Payment received/i);
    expect(html).not.toMatch(/is (now )?active/i);
    // The overview still comes from the records, which the webhook has not
    // updated yet: the free plan, with the note that this may take a moment.
    expect(html).toMatch(/data-overview-state="none"/);
    expect(html).toMatch(/just completed a checkout/);
    // Neither the banner nor the card promises when that will be: the webhook
    // may be delayed or failing.
    expect(html).not.toMatch(/few seconds|shortly|soon/);
  });

  it("shows no banner on a normal visit or for unknown values", async () => {
    expect(await render()).not.toMatch(/role="status"/);
    expect(await render("hacked")).not.toMatch(/role="status"/);
  });
});

describe("/dashboard page – the latest invoice", () => {
  const INVOICE: LatestInvoice = {
    kind: "ok",
    invoice: {
      key: "a2V5",
      number: "ABCD-0001",
      createdAt: "2026-03-01T00:00:00.000Z",
      total: 2900,
      currency: "usd",
      status: "paid",
      documents: { view: true, pdf: true },
    },
  };

  it("summarises it on the billing card with a PDF link through the per-user document route", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getLatestInvoice.mockResolvedValue(INVOICE);

    const html = await render();

    expect(html).toMatch(/data-latest-invoice="ok"/);
    expect(html).toMatch(/Mar 1, 2026/);
    expect(html).toMatch(/ABCD-0001/);
    expect(html).toMatch(/\$29\.00/);
    expect(html).toMatch(/>Paid</);
    expect(html).toMatch(/href="\/billing\/invoices\/a2V5\/pdf"/);
    expect(html).toMatch(/Download PDF/);
    expect(html).not.toMatch(/in_|cus_|sub_/); // no Stripe ids, only the opaque key
    expect(html).toMatch(/href="\/billing"/); // the full history stays there
  });

  it("says no invoices have been issued yet for a billing account without any", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getLatestInvoice.mockResolvedValue({ kind: "empty" });

    const html = await render();

    expect(html).toMatch(/data-latest-invoice="empty"/);
    expect(html).toMatch(/No invoices have been issued yet/);
    expect(html).not.toMatch(/Download PDF/);
  });

  it("reports a failed lookup as such (never 'no invoices'), while the rest of the page stands", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getLatestInvoice.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    const html = await render();

    expect(html).toMatch(/data-latest-invoice="unavailable"/);
    expect(html).toMatch(/load your latest invoice/);
    expect(html).not.toMatch(/No invoices/);
    expect(html).toMatch(/>Active</); // the plan card is unaffected
    expect(html).toMatch(/>Pro</);
  });
});
