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
  // The filter form (a client component) reads the router; nothing navigates here.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string; email?: string | null } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => auth);

// Guard: the page must not build its own Supabase client (the overview service is
// mocked below; keeping the original module for its status helpers must not pull
// in the cookie-based client either).
const infra = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// The page reads through the overview service; the button imports the portal
// action (server-only env, Stripe). Neither is exercised by a render.
const billing = vi.hoisted(() => ({
  getSubscriptionOverview:
    vi.fn<
      (
        userId: string,
      ) => Promise<
        import("@/features/billing/services/get-subscription-overview").SubscriptionOverview
      >
    >(),
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
vi.mock("@/features/billing/actions/create-portal-session", () => ({
  createPortalSession: vi.fn(),
}));
vi.mock("@/features/billing/actions/load-more-invoices", () => ({
  loadMoreInvoices: vi.fn(),
}));

// The subscription as Stripe holds it, read off the same overview (see the
// dashboard): the status it carries is the one shown.
type CurrentPlan = import("@/features/billing/services/current-plan").CurrentPlan;
const plan = vi.hoisted(() => ({
  getCurrentPlan:
    vi.fn<
      (
        userId: string,
        options?: { overview?: unknown },
      ) => Promise<import("@/features/billing/services/current-plan").CurrentPlan>
    >(),
}));
vi.mock("@/features/billing/services/get-current-plan", () => plan);

// The invoice list talks to Stripe; the page only hands it the user and the
// overview it already read.
const invoices = vi.hoisted(() => ({
  getInvoiceHistory:
    vi.fn<
      (
        userId: string,
        overview?: import("@/features/billing/services/get-subscription-overview").SubscriptionOverview,
      ) => Promise<
        import("@/features/billing/services/get-invoice-history").InvoiceHistory
      >
    >(),
}));
vi.mock("@/features/billing/services/get-invoice-history", () => invoices);

import BillingPage from "./page";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

type Overview =
  import("@/features/billing/services/get-subscription-overview").SubscriptionOverview;

const row = (status: string, stripeCustomerId: string | null = "cus_1") => ({
  stripeSubscriptionId: "sub_1",
  stripeCustomerId,
  status,
  rowCount: 1,
  statusConflict: false,
  customerConflict: false,
  isServicing: ["active", "trialing", "past_due", "unpaid", "paused"].includes(status),
});

/** An overview with one subscription whose customer is clear (or absent). */
const single = (status: string, stripeCustomerId: string | null = "cus_1"): Overview => {
  const current = row(status, stripeCustomerId);

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

const render = async (search: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue(USER);
  billing.getSubscriptionOverview.mockResolvedValue({
    ok: true,
    stripeCustomerId: null,
    customerResolution: { kind: "none" },
    current: null,
    isServicing: false,
    subscriptions: [],
  });
  invoices.getInvoiceHistory.mockResolvedValue({ kind: "none" });
  plan.getCurrentPlan.mockResolvedValue({ kind: "none" });
});

/** Stripe's own view of `single(...)`'s subscription. */
const stripeSays = (
  status: Exclude<
    CurrentPlan,
    { kind: "none" | "unavailable" }
  >["subscription"]["status"],
  facts: Partial<
    Exclude<CurrentPlan, { kind: "none" | "unavailable" }>["subscription"]
  > = {},
): CurrentPlan => ({
  kind: "ok",
  plan: { id: "pro", name: "Pro", features: [], billing: null },
  subscription: { status, cancellation: null, collectionPaused: null, ...facts },
});

describe("/billing page – data flow", () => {
  it("reads the overview for the signed-in user only", async () => {
    await render();

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER.id);
    expect(infra.createClient).not.toHaveBeenCalled();
  });

  it("lists invoices for the signed-in user from the same read of the records", async () => {
    const overview = single("active");
    billing.getSubscriptionOverview.mockResolvedValue(overview);

    await render();

    expect(invoices.getInvoiceHistory).toHaveBeenCalledTimes(1);
    expect(invoices.getInvoiceHistory).toHaveBeenCalledWith(USER.id, {
      overview,
      filters: { status: null, from: null, to: null, number: null },
    });
    // Both cards come from one read: the invoice service must not read again.
    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
  });

  it("reads the current subscription from Stripe off the same read of the records", async () => {
    const overview = single("active");
    billing.getSubscriptionOverview.mockResolvedValue(overview);

    await render();

    expect(plan.getCurrentPlan).toHaveBeenCalledTimes(1);
    expect(plan.getCurrentPlan).toHaveBeenCalledWith(USER.id, { overview });
    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
  });

  it("redirects anonymous visitors to /login without reading anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(BillingPage({})).rejects.toMatchObject({ url: "/login" });
    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
    expect(invoices.getInvoiceHistory).not.toHaveBeenCalled();
    expect(plan.getCurrentPlan).not.toHaveBeenCalled();
  });

  it("lets an unexpected failure of the lookup reach the error boundary", async () => {
    billing.getSubscriptionOverview.mockRejectedValue(new Error("cookies unavailable"));

    await expect(BillingPage({})).rejects.toThrow("cookies unavailable");
  });
});

describe("/billing page – what is shown", () => {
  it("has a Billing heading inside the dashboard shell's content area", async () => {
    const html = await render();

    expect(html).toMatch(/<h2[^>]*>Billing<\/h2>/);
  });

  it("shows the free plan with a link to pricing when there is no subscription", async () => {
    const html = await render();

    expect(html).toMatch(/data-billing-state="none"/);
    expect(html).toMatch(/free Starter plan/);
    expect(html).toMatch(/href="\/pricing"/);
    expect(html).not.toMatch(/Manage billing/);
  });

  it("shows the status and the Manage billing button for an active subscription", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/>Active</);
    expect(html).toMatch(/subscription is active/);
    expect(html).toMatch(/<form[^>]*>[\s\S]*Manage billing/);
    expect(html).not.toMatch(/href="\/pricing"/); // checkout would be refused
    expect(html).not.toMatch(/role="alert"/);
  });

  it("flags a payment problem and still offers the portal", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("past_due"));

    const html = await render();

    expect(html).toMatch(/data-subscription-status="past_due"/);
    expect(html).toMatch(/Payment past due/);
    expect(html).toMatch(/Update your payment method/);
    expect(html).toMatch(/Manage billing/);
  });

  it("offers pricing again after cancellation, with the portal for past invoices", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("canceled"));

    const html = await render();

    expect(html).toMatch(/data-subscription-status="canceled"/);
    expect(html).toMatch(/href="\/pricing"/);
    expect(html).toMatch(/Manage billing/);
  });

  it("reports unavailability (not 'no subscription') when the records cannot be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });

    const html = await render();

    expect(html).toMatch(/data-billing-state="unavailable"/);
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/load your subscription details/); // (apostrophes are escaped in static markup)
    expect(html).toMatch(/href="\/billing"/); // try again
    expect(html).not.toMatch(/free Starter plan/);
    expect(html).not.toMatch(/Manage billing/);
    expect(html).not.toMatch(/permission denied/); // internals stay in the logs
  });

  it("never leaks Stripe identifiers into the page", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active", "cus_secret"));
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      nextCursor: "b3BhcXVl",
      examined: 1,
      invoices: [
        {
          key: "a2V5",
          number: "ABCD-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: false, pdf: false },
        },
      ],
    });

    const html = await render();

    expect(html).not.toMatch(/cus_secret|sub_1|in_/);
    expect(html).toMatch(/ABCD-0001/); // the customer-facing number is fine
    expect(html).toMatch(/Load more invoices/); // paging is offered without exposing ids
  });

  it("refuses to offer the portal when the records point at several billing accounts", async () => {
    const a = { ...row("active", "cus_A"), stripeSubscriptionId: "sub_a" };
    const b = { ...row("active", "cus_B"), stripeSubscriptionId: "sub_b" };
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: null,
      customerResolution: {
        kind: "ambiguous",
        reason: "multiple_customers",
        customers: 2,
      },
      current: a,
      isServicing: true,
      subscriptions: [a, b],
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/data-billing-customer="ambiguous"/);
    expect(html).toMatch(/more than one billing account/);
    expect(html).not.toMatch(/Manage billing/);
    expect(html).not.toMatch(/href="\/pricing"/); // still serviced: checkout would refuse
    expect(html).not.toMatch(/cus_A|cus_B|sub_a|sub_b|multiple_customers/);
  });

  it("shows a subscription whose records disagree as needing review", async () => {
    const conflicting = { ...row("active"), status: null, statusConflict: true };
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: "cus_1",
      customerResolution: { kind: "single", stripeCustomerId: "cus_1" },
      current: conflicting,
      isServicing: true,
      subscriptions: [conflicting],
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="conflicting"/);
    expect(html).toMatch(/Needs review/);
    expect(html).toMatch(/Manage billing/);
  });
});

describe("/billing page – invoice history", () => {
  const paid = (number: string, createdAt: string, total = 2900) => ({
    key: `key-${number}`,
    number,
    createdAt,
    total,
    currency: "usd",
    status: "paid" as const,
    documents: { view: true, pdf: true },
  });

  it("lists the invoices below the subscription card, with date, amount and status", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      nextCursor: null,
      examined: 2,
      invoices: [
        paid("ABCD-0002", "2026-04-01T00:00:00.000Z"),
        { ...paid("ABCD-0001", "2026-03-01T00:00:00.000Z", 9900), status: "open" },
      ],
    });

    const html = await render();

    expect(html).toMatch(/data-invoice-state="list"/);
    expect(html.indexOf('data-billing-state="subscription"')).toBeLessThan(
      html.indexOf('data-invoice-state="list"'),
    );
    expect(html).toMatch(/Apr 1, 2026[\s\S]*ABCD-0002[\s\S]*\$29\.00[\s\S]*>Paid</);
    expect(html).toMatch(/Mar 1, 2026[\s\S]*ABCD-0001[\s\S]*\$99\.00[\s\S]*>Open</);
    expect(html).toMatch(/datetime="2026-04-01T00:00:00\.000Z"/i);
  });

  it("says there are no invoices yet for a user without a billing account", async () => {
    invoices.getInvoiceHistory.mockResolvedValue({ kind: "none" });

    const html = await render();

    expect(html).toMatch(/data-billing-state="none"/);
    expect(html).toMatch(/data-invoice-state="none"/);
    expect(html).toMatch(/any invoices yet/);
  });

  it("says none have been issued when Stripe holds no invoices for the account", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [],
      nextCursor: null,
      examined: 0,
    });

    const html = await render();

    expect(html).toMatch(/data-invoice-state="empty"/);
    expect(html).toMatch(/No invoices have been issued yet/);
    expect(html).not.toMatch(/Load more invoices/);
  });

  it("does not declare the history empty when the first page found nothing but more remains", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [],
      nextCursor: "b3BhcXVl",
      examined: 300,
    });

    const html = await render();

    expect(html).toMatch(/data-invoice-state="list"/);
    expect(html).not.toMatch(/No invoices have been issued yet/);
    expect(html).toMatch(/there may be older ones/);
    expect(html).toMatch(/Load more invoices/);
  });

  it("explains an ambiguous billing account on both cards and lists nothing", async () => {
    const a = { ...row("active", "cus_A"), stripeSubscriptionId: "sub_a" };
    const b = { ...row("active", "cus_B"), stripeSubscriptionId: "sub_b" };
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: null,
      customerResolution: {
        kind: "ambiguous",
        reason: "multiple_customers",
        customers: 2,
      },
      current: a,
      isServicing: true,
      subscriptions: [a, b],
    });
    invoices.getInvoiceHistory.mockResolvedValue({ kind: "ambiguous" });

    const html = await render();

    expect(html).toMatch(/data-billing-customer="ambiguous"/);
    expect(html).toMatch(/data-invoice-state="ambiguous"/);
    expect(html).toMatch(/invoices can&#x27;t be shown safely/);
    expect(html).not.toMatch(/<table/);
    expect(html).not.toMatch(/cus_A|cus_B|sub_a|sub_b|multiple_customers/);
  });

  it("reports the invoice history as unavailable (not empty) when it cannot be listed, while the subscription still shows", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/); // the page still renders
    expect(html).toMatch(/Manage billing/);
    expect(html).toMatch(/data-invoice-state="unavailable"/);
    expect(html).toMatch(/load your invoices/);
    expect(html).not.toMatch(/No invoices/);
    expect(html).not.toMatch(/stripe_error/);
  });

  it("lets an unexpected failure of the invoice lookup reach the error boundary", async () => {
    invoices.getInvoiceHistory.mockRejectedValue(new Error("cookies unavailable"));

    await expect(BillingPage({})).rejects.toThrow("cookies unavailable");
  });
});

describe("/billing page – invoice document notices", () => {
  it("shows nothing without a notice", async () => {
    const html = await render();

    expect(html).not.toMatch(/data-invoice-document-notice/);
  });

  it("explains a document that could not be found, above the invoice list", async () => {
    const html = await render({ document: "missing" });

    expect(html).toMatch(/data-invoice-document-notice="missing"/);
    expect(html).toMatch(/isn&#x27;t available/);
    expect(html.indexOf("data-invoice-document-notice")).toBeLessThan(
      html.indexOf("data-invoice-state"),
    );
  });

  it("explains a document that could not be opened", async () => {
    const html = await render({ document: "unavailable" });

    expect(html).toMatch(/data-invoice-document-notice="unavailable"/);
    expect(html).toMatch(/couldn&#x27;t be opened/);
  });

  it("ignores any other value of the parameter (it is untrusted input)", async () => {
    for (const document of ["ok", "<script>", "", ["missing"]]) {
      const html = await render({ document });

      expect(html).not.toMatch(/data-invoice-document-notice/);
      expect(html).not.toMatch(/<script>/);
    }
  });

  it("still renders without search params at all", async () => {
    expect(renderToStaticMarkup(await BillingPage({}))).toMatch(/<h2[^>]*>Billing<\/h2>/);
  });
});

describe("/billing page – invoice filters", () => {
  const active = (overrides = {}) =>
    billing.getSubscriptionOverview.mockResolvedValue({
      ...single("active"),
      ...overrides,
    });

  it("passes valid filters from the URL to the service and shows them in the form", async () => {
    active();
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      nextCursor: "b3BhcXVl",
      examined: 40,
      invoices: [],
    });

    const html = await render({
      status: "paid",
      from: "2026-01-01",
      to: "2026-06-30",
      q: "ABCD",
    });

    expect(invoices.getInvoiceHistory).toHaveBeenCalledWith(USER.id, {
      overview: expect.objectContaining({ ok: true }),
      filters: { status: "paid", from: "2026-01-01", to: "2026-06-30", number: "ABCD" },
    });
    expect(html).toMatch(/data-invoice-filters="active"/);
    expect(html).toMatch(
      /<option[^>]*selected[^>]*value="paid"|value="paid"[^>]*selected/,
    );
    expect(html).toMatch(
      /name="from"[^>]*value="2026-01-01"|value="2026-01-01"[^>]*name="from"/,
    );
    expect(html).toMatch(/value="ABCD"/);
    expect(html).toMatch(/Clear filters/);
    expect(html).toMatch(/Search older invoices/);
    expect(html).toMatch(/No matching invoices among the 40 checked so far/);
  });

  it("lists nothing and explains the problem when the filters are invalid", async () => {
    active();

    const html = await render({ from: "2026-02-30", q: "<script>alert(1)</script>" });

    expect(invoices.getInvoiceHistory).not.toHaveBeenCalled();
    expect(html).toMatch(/data-invoice-state="invalid-filters"/);
    expect(html).toMatch(/Enter a date as YYYY-MM-DD/);
    expect(html).toMatch(/letters, digits or hyphens/);
    expect(html).not.toMatch(/<script>alert/); // echoed input is escaped
    expect(html).toMatch(/data-billing-state="subscription"/); // the rest of the page still renders
  });

  it("says 'no matches' — not 'no invoices' — for an empty filtered result", async () => {
    active();
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      nextCursor: null,
      examined: 12,
      invoices: [],
    });

    const html = await render({ status: "void" });

    expect(html).toMatch(/data-invoice-state="no-matches"/);
    expect(html).not.toMatch(/No invoices have been issued/);
  });

  it("keeps document links and the filter form together in a filtered list", async () => {
    active();
    invoices.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      nextCursor: null,
      examined: 1,
      invoices: [
        {
          key: "a2V5",
          number: "ABCD-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: true, pdf: true },
        },
      ],
    });

    const html = await render({ status: "paid" });

    expect(html).toMatch(/data-invoice-state="list"/);
    expect(html).toMatch(/href="\/billing\/invoices\/a2V5\/pdf"/);
    expect(html).toMatch(/href="\/billing\/invoices\/a2V5\/view"/);
    // A GET form (HTML's default method) that works without JavaScript too.
    const form = html.match(/<form[^>]*aria-label="Filter invoices"[^>]*>/)?.[0] ?? "";
    expect(form).toMatch(/action="\/billing"/);
    expect(form).not.toMatch(/method="post"/i);
  });

  it("ignores the filters for a user without a billing account", async () => {
    invoices.getInvoiceHistory.mockResolvedValue({ kind: "none" });

    const html = await render({ status: "paid" });

    expect(html).toMatch(/data-invoice-state="none"/);
    expect(html).not.toMatch(/data-invoice-filters/);
  });
});

describe("/billing page – agrees with the dashboard while the webhook lags", () => {
  it("shows Stripe's status (canceled in the portal) over the records' (still active)", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    plan.getCurrentPlan.mockResolvedValue(
      stripeSays("canceled", {
        cancellation: { kind: "ended", at: "2026-03-31T00:00:00.000Z" },
      }),
    );

    const html = await render();

    expect(html).toMatch(/data-subscription-status="canceled"/);
    expect(html).toMatch(/data-status-source="stripe"/);
    expect(html).toMatch(/>Canceled</);
    expect(html).not.toMatch(/>Active</);
    expect(html).toMatch(/Ended on Mar 31, 2026/);
    expect(html).toMatch(/records don&#x27;t reflect it yet/);
    expect(html).toMatch(/If this persists, contact support/);
    // No promise about when (or whether) the records will follow.
    expect(html).not.toMatch(/few seconds|shortly|will catch up/);
    // The portal still opens (the customer is clear); checkout is still refused.
    expect(html).toMatch(/Manage billing/);
    expect(html).not.toMatch(/href="\/pricing"/);
  });

  it("shows a scheduled cancellation made in the portal", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    plan.getCurrentPlan.mockResolvedValue(
      stripeSays("active", {
        cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" },
      }),
    );

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/Set to cancel on Mar 31, 2026/);
    expect(html).not.toMatch(/role="status"/); // same status: nothing to explain
  });

  it("falls back to the records, and says so, when Stripe could not be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(single("active"));
    plan.getCurrentPlan.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    const html = await render();

    expect(html).toMatch(/data-subscription-status="active"/);
    expect(html).toMatch(/data-status-source="records"/);
    expect(html).toMatch(/from our records/);
  });
});
