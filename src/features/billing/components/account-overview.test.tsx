import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type BillingSummary,
  SUBSCRIPTION_STATUS_CONTENT,
} from "../services/billing-summary";
import type { CurrentPlan, SubscriptionFacts } from "../services/current-plan";
import type { LatestInvoice } from "../services/get-latest-invoice";
import { isSubscriptionStatus } from "../services/get-subscription-overview";
import type { Plan } from "../types/plan";

import {
  AccountOverview,
  DOWNLOAD_PDF_LABEL,
  GO_TO_BILLING_LABEL,
} from "./account-overview";
import { PRICING_PATH } from "./subscription-status-card";

// The summary module imports the overview service for its status helpers, which
// would pull in the cookie-based Supabase client (and the validated env) for a
// purely presentational test.
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(),
}));
// `subscription-status-card` (imported for `PRICING_PATH`) embeds the portal
// button, which imports the server action; it is never invoked here.
vi.mock("../actions/create-portal-session", () => ({
  createPortalSession: vi.fn(),
}));

type Ok = Exclude<BillingSummary, { ok: false }>;

const STARTER: Plan = {
  id: "starter",
  name: "Starter",
  price: 0,
  available: true,
  features: ["Basic features", "Up to 3 projects", "Community support"],
};

const NO_PLAN: CurrentPlan = { kind: "none" };

/** No billing account: nothing to look for (the free plan's case). */
const NO_INVOICE: LatestInvoice = { kind: "none" };

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

type OkPlan = Extract<CurrentPlan, { kind: "ok" }>;

const PRO_DETAILS: OkPlan["plan"] = {
  id: "pro",
  name: "Pro",
  features: ["Everything in Starter", "Unlimited projects"],
  billing: {
    amount: 2900,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    discounted: false,
  },
};

/** A Pro subscription as Stripe answers it, with Stripe's own `status`. */
const pro = (
  status: SubscriptionFacts["status"],
  overrides: { plan?: Partial<OkPlan["plan"]>; facts?: Partial<SubscriptionFacts> } = {},
): CurrentPlan => ({
  kind: "ok",
  plan: { ...PRO_DETAILS, ...overrides.plan },
  subscription: {
    status,
    cancellation: null,
    collectionPaused: null,
    ...overrides.facts,
  },
});

const noSubscription = (overrides: Partial<Ok> = {}): BillingSummary => ({
  ok: true,
  status: null,
  customerState: "none",
  canManage: false,
  canSubscribe: true,
  ...overrides,
});

const subscription = (
  status: Exclude<Ok["status"], null>,
  overrides: Partial<Ok> = {},
): BillingSummary => ({
  ok: true,
  status,
  customerState: "single",
  canManage: true,
  canSubscribe: false,
  ...overrides,
});

const section = () => screen.getByRole("region", { name: "Account overview" });
const planCard = () =>
  document.querySelector('[data-overview-card="plan"]') as HTMLElement;
const billingCard = () =>
  document.querySelector('[data-overview-card="billing"]') as HTMLElement;
const pricingLink = () => screen.queryByRole("link", { name: "Choose a plan" });
const billingLinks = () => screen.queryAllByRole("link", { name: GO_TO_BILLING_LABEL });

describe("AccountOverview – records unavailable", () => {
  const summary: BillingSummary = { ok: false };

  it("says the overview is unavailable and names no plan", () => {
    render(
      <AccountOverview
        summary={summary}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(section()).toHaveAttribute("data-overview-state", "unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't load your plan and billing details/,
    );
    // A failed read says nothing about the account's state: no such claim.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/changed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/try again/);
    // Never "free plan" / "Starter": the records could not be read.
    expect(screen.queryByText(/free/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Starter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Status/)).not.toBeInTheDocument();
    expect(planCard()).toBeNull();
    expect(billingCard()).toBeNull();
  });

  it("offers a retry of the dashboard and nothing that depends on the records", () => {
    render(
      <AccountOverview
        summary={summary}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(pricingLink()).not.toBeInTheDocument();
    expect(billingLinks()).toEqual([]);
  });
});

describe("AccountOverview – no subscription", () => {
  it("presents the catalog's free plan as the current plan", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(section()).toHaveAttribute("data-overview-state", "none");
    expect(section()).not.toHaveAttribute("data-subscription-status");

    const plan = within(planCard());
    expect(
      plan.getByRole("heading", { level: 3, name: "Current plan" }),
    ).toBeInTheDocument();
    expect(plan.getByText(/free Starter plan/)).toBeInTheDocument();
    expect(plan.getByText("Starter")).toBeInTheDocument();
    expect(plan.getByText("Free")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists what the free plan includes, from the catalog (never hard-coded)", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={{ ...STARTER, features: ["Two projects", "Email support"] }}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    const included = screen.getByRole("list", { name: "Included in your plan" });
    expect(
      within(included)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["• Two projects", "• Email support"]);
  });

  it("omits the feature list when the plan has none", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={{ ...STARTER, features: [] }}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(screen.queryByRole("list", { name: "Included in your plan" })).toBeNull();
  });

  it("offers the pricing page as the primary action", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(pricingLink()).toHaveAttribute("href", PRICING_PATH);
    expect(
      within(planCard()).getByText(/Choose a paid plan to unlock more/),
    ).toBeInTheDocument();
  });

  it("warns that a just-completed checkout may take a moment to show up", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(screen.getByText(/just completed a checkout/)).toHaveTextContent(
      /may not appear here yet/,
    );
    // No promise about when it will: that depends on the webhook.
    expect(screen.queryByText(/seconds/)).not.toBeInTheDocument();
  });

  it("hides the pricing link when the checkout action would refuse (a serviced row remains)", () => {
    render(
      <AccountOverview
        summary={noSubscription({ canSubscribe: false })}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(pricingLink()).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose a paid plan/)).not.toBeInTheDocument();
    // The delay note still applies — the subscription may be about to appear.
    expect(screen.getByText(/just completed a checkout/)).toBeInTheDocument();
  });

  it("says there is no subscription, without naming a plan, when the catalog has no free plan", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={null}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    const plan = within(planCard());
    expect(plan.getByText(/don't have a subscription/)).toBeInTheDocument();
    expect(plan.queryByText(/Starter/)).not.toBeInTheDocument();
    expect(plan.queryByText("Free")).not.toBeInTheDocument();
    expect(pricingLink()).toHaveAttribute("href", PRICING_PATH);
  });

  it("explains that there is no billing account yet and points to the billing page", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    const billing = within(billingCard());
    expect(billingCard()).toHaveAttribute("data-billing-customer", "none");
    expect(
      billing.getByRole("heading", { level: 3, name: "Billing" }),
    ).toBeInTheDocument();
    expect(billing.getByText(/No billing account yet/)).toBeInTheDocument();
    expect(billing.getByText(/once you subscribe to a paid plan/)).toBeInTheDocument();
    expect(billing.getByRole("link", { name: GO_TO_BILLING_LABEL })).toHaveAttribute(
      "href",
      "/billing",
    );
    expect(billing.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("acknowledges an existing billing account (a Stripe customer without a subscription)", () => {
    render(
      <AccountOverview
        summary={noSubscription({ customerState: "single", canManage: true })}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    const billing = within(billingCard());
    expect(billingCard()).toHaveAttribute("data-billing-customer", "single");
    expect(billing.getByText(/latest invoice/)).toBeInTheDocument();
    expect(billing.getByRole("link", { name: GO_TO_BILLING_LABEL })).toHaveAttribute(
      "href",
      "/billing",
    );
    // The portal itself is opened from the billing page, not from the dashboard.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
  });

  it("lays the cards out side by side from `md`, each sized to its own content", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    // Stretching (the grid default) would pad the shorter Billing card with
    // empty space below its button on desktop; on phones each card is its own
    // row, so only the `md` variant is needed.
    expect(section()).toHaveClass("grid", "md:grid-cols-2", "md:items-start");
    expect(section()).not.toHaveClass("items-start");
  });

  it("does not embed the portal action or any form: the dashboard only links out", () => {
    render(
      <AccountOverview
        summary={noSubscription()}
        freePlan={STARTER}
        currentPlan={NO_PLAN}
        latestInvoice={NO_INVOICE}
      />,
    );

    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("AccountOverview – a subscription", () => {
  /** Unless told otherwise, Stripe's status agrees with the records' (no lag). */
  const renderSub = (
    summary: BillingSummary,
    currentPlan: CurrentPlan = pro(
      summary.ok && summary.status && isSubscriptionStatus(summary.status)
        ? summary.status
        : "active",
    ),
  ) =>
    render(
      <AccountOverview
        summary={summary}
        freePlan={STARTER}
        currentPlan={currentPlan}
        latestInvoice={NO_INVOICE}
      />,
    );

  it("shows the status from our records and points to the billing page", () => {
    renderSub(subscription("active"));

    expect(section()).toHaveAttribute("data-overview-state", "subscription");
    expect(section()).toHaveAttribute("data-subscription-status", "active");

    const plan = within(planCard());
    expect(plan.getByText("Status")).toBeInTheDocument();
    expect(plan.getByText(SUBSCRIPTION_STATUS_CONTENT.active.label)).toBeInTheDocument();
    expect(
      plan.getByText(SUBSCRIPTION_STATUS_CONTENT.active.description),
    ).toBeInTheDocument();
    expect(plan.getByRole("link", { name: GO_TO_BILLING_LABEL })).toHaveAttribute(
      "href",
      "/billing",
    );
    // Never the free plan's content for a subscribed user.
    expect(plan.queryByText(/free Starter plan/)).not.toBeInTheDocument();
    expect(plan.queryByText("Starter")).not.toBeInTheDocument();
    expect(plan.queryByText(/free/i)).not.toBeInTheDocument();
    expect(plan.queryByText(/Basic features/)).not.toBeInTheDocument();
    expect(pricingLink()).not.toBeInTheDocument(); // checkout would be refused
  });

  it("names the plan the subscription is for, what it bills, and what it includes", () => {
    renderSub(subscription("active"));

    expect(planCard()).toHaveAttribute("data-plan-state", "ok");
    const plan = within(planCard());
    expect(plan.getByText(/on the Pro plan/)).toBeInTheDocument();
    expect(plan.getByText("Pro")).toBeInTheDocument();
    expect(plan.getByText("$29/month")).toBeInTheDocument();
    expect(
      within(plan.getByRole("list", { name: "Included in your plan" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["• Everything in Starter", "• Unlimited projects"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("omits the billed amount when it could not be read unambiguously", () => {
    renderSub(subscription("active"), pro("active", { plan: { billing: null } }));

    expect(within(planCard()).getByText("Pro")).toBeInTheDocument();
    expect(within(planCard()).queryByText(/\/month/)).not.toBeInTheDocument();
  });

  it("omits the feature list when the plan has none", () => {
    renderSub(subscription("active"), pro("active", { plan: { features: [] } }));

    expect(screen.queryByRole("list", { name: "Included in your plan" })).toBeNull();
  });

  it.each(["canceled", "incomplete_expired", "incomplete"] as const)(
    "names the plan but not a recurring charge once Stripe no longer services it (%s)",
    (status) => {
      renderSub(subscription(status, { canSubscribe: status !== "incomplete" }));

      expect(within(planCard()).getByText("Pro")).toBeInTheDocument();
      expect(within(planCard()).queryByText("$29/month")).not.toBeInTheDocument();
      // Past tense once Stripe has closed it; `incomplete` may still complete.
      expect(
        within(planCard()).getByText(
          status === "incomplete" ? /You're on the Pro plan/ : /You were on the Pro plan/,
        ),
      ).toBeInTheDocument();
    },
  );

  it.each(["trialing", "past_due", "paused"] as const)(
    "still shows the recurring charge while Stripe services the subscription (%s)",
    (status) => {
      renderSub(subscription(status));

      expect(within(planCard()).getByText("$29/month")).toBeInTheDocument();
    },
  );

  it("labels a discounted price as the price before discounts, never as what is charged", () => {
    renderSub(
      subscription("active"),
      pro("active", {
        plan: {
          billing: {
            amount: 2900,
            currency: "usd",
            interval: "month",
            intervalCount: 1,
            discounted: true,
          },
        },
      }),
    );

    const plan = within(planCard());
    expect(plan.getByText(/\$29\/month/)).toHaveTextContent("$29/month before discounts");
    expect(planCard().querySelector('[data-plan-billing="discounted"]')).not.toBeNull();
  });

  it("does not mention discounts when there are none", () => {
    renderSub(subscription("active"));

    expect(within(planCard()).queryByText(/discount/)).not.toBeInTheDocument();
    expect(planCard().querySelector("[data-plan-billing]")).toBeNull();
  });

  it("says when an active subscription is set to cancel, and on what date", () => {
    renderSub(
      subscription("active"),
      pro("active", {
        facts: { cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" } },
      }),
    );

    const note = planCard().querySelector('[data-plan-cancellation="scheduled"]');
    expect(note).toHaveTextContent("Set to cancel on Mar 31, 2026.");
    // Still serviced until then: the status and the plan's price stay.
    expect(
      within(planCard()).getByText(SUBSCRIPTION_STATUS_CONTENT.active.label),
    ).toBeInTheDocument();
    expect(within(planCard()).getByText(/\$29\/month/)).toBeInTheDocument();
  });

  it("says a subscription is set to cancel at period end when Stripe gave no date", () => {
    renderSub(
      subscription("trialing"),
      pro("trialing", { facts: { cancellation: { kind: "scheduled", at: null } } }),
    );

    expect(
      planCard().querySelector('[data-plan-cancellation="scheduled"]'),
    ).toHaveTextContent("Set to cancel at the end of the current billing period.");
  });

  it("says when a canceled subscription ended", () => {
    renderSub(
      subscription("canceled", { canSubscribe: true }),
      pro("canceled", {
        facts: { cancellation: { kind: "ended", at: "2026-03-31T00:00:00.000Z" } },
      }),
    );

    expect(
      planCard().querySelector('[data-plan-cancellation="ended"]'),
    ).toHaveTextContent("Ended on Mar 31, 2026.");
    expect(
      within(planCard()).getByText(SUBSCRIPTION_STATUS_CONTENT.canceled.label),
    ).toBeInTheDocument();
    expect(within(planCard()).queryByText(/\/month/)).not.toBeInTheDocument();
    expect(pricingLink()).toBeInTheDocument();
    expect(planCard().querySelector("[data-records-lag]")).toBeNull();
  });

  it("says payments are paused, and hides the recurring price meanwhile", () => {
    renderSub(
      subscription("active"),
      pro("active", {
        facts: { collectionPaused: { resumesAt: "2026-03-31T00:00:00.000Z" } },
      }),
    );

    expect(planCard().querySelector('[data-plan-collection="paused"]')).toHaveTextContent(
      "Payments are paused until Mar 31, 2026.",
    );
    expect(within(planCard()).getByText("Pro")).toBeInTheDocument();
    expect(within(planCard()).queryByText(/\/month/)).not.toBeInTheDocument();

    cleanup();

    renderSub(
      subscription("active"),
      pro("active", { facts: { collectionPaused: { resumesAt: null } } }),
    );
    expect(planCard().querySelector('[data-plan-collection="paused"]')).toHaveTextContent(
      "Payments are paused until you resume them.",
    );
  });

  describe("after a change in the Customer Portal, before the webhook has applied it", () => {
    it("shows Stripe's status (canceled now) over the records' (still active), and says why", () => {
      renderSub(
        subscription("active"), // records: not yet updated, checkout still refused
        pro("canceled", {
          facts: { cancellation: { kind: "ended", at: "2026-03-31T00:00:00.000Z" } },
        }),
      );

      expect(section()).toHaveAttribute("data-subscription-status", "canceled");
      expect(section()).toHaveAttribute("data-status-source", "stripe");
      const plan = within(planCard());
      expect(
        plan.getByText(SUBSCRIPTION_STATUS_CONTENT.canceled.label),
      ).toBeInTheDocument();
      expect(
        plan.queryByText(SUBSCRIPTION_STATUS_CONTENT.active.label),
      ).not.toBeInTheDocument();
      expect(plan.getByText(/You were on the Pro plan/)).toBeInTheDocument();
      expect(
        planCard().querySelector('[data-plan-cancellation="ended"]'),
      ).toHaveTextContent("Ended on Mar 31, 2026.");
      expect(plan.queryByText(/\/month/)).not.toBeInTheDocument();

      // The lag is explained, including why there is no "Choose a plan" yet —
      // without promising when (or that) the records will follow: the webhook
      // may be delayed or failing.
      const lag = plan.getByRole("status");
      expect(lag).toHaveTextContent(/Stripe's current status/);
      expect(lag).toHaveTextContent(/records don't reflect it yet/);
      expect(lag).toHaveTextContent(/Choosing a new plan isn't available until they do/);
      expect(lag).toHaveTextContent(/If this persists, contact support/);
      expect(lag).not.toHaveTextContent(
        /seconds|shortly|soon|will catch up|automatically/,
      );
      expect(pricingLink()).not.toBeInTheDocument(); // the checkout action would refuse
    });

    it("shows a scheduled cancellation as such while the records still say active (no lag: same status)", () => {
      renderSub(
        subscription("active"),
        pro("active", {
          facts: { cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" } },
        }),
      );

      expect(section()).toHaveAttribute("data-status-source", "stripe");
      expect(planCard().querySelector("[data-records-lag]")).toBeNull();
      expect(
        planCard().querySelector('[data-plan-cancellation="scheduled"]'),
      ).not.toBeNull();
    });

    it("shows a payment problem Stripe knows about before our records do", () => {
      renderSub(subscription("active"), pro("past_due"));

      const plan = within(planCard());
      expect(
        plan.getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.label),
      ).toBeInTheDocument();
      expect(
        plan.getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.description),
      ).toHaveClass("text-red-600");
      const lag = plan.getByRole("status");
      expect(lag).toHaveTextContent(/records don't reflect it yet/);
      expect(lag).not.toHaveTextContent(/new plan/); // still serviced
    });

    it("does not explain a lag when Stripe could not be read: the records are all there is", () => {
      renderSub(subscription("active"), { kind: "unavailable", reason: "stripe_error" });

      expect(section()).toHaveAttribute("data-status-source", "records");
      expect(planCard().querySelector("[data-records-lag]")).toBeNull();
      expect(within(planCard()).getAllByText(/from our records/)).toHaveLength(2); // description + the alert
    });

    it("does not explain a lag when Stripe and the records agree", () => {
      renderSub(subscription("active"), pro("active"));

      expect(planCard().querySelector("[data-records-lag]")).toBeNull();
      expect(within(planCard()).queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("says so, without naming a plan, when the subscription's price is not in the catalog", () => {
    renderSub(subscription("active"), {
      kind: "unrecognized",
      subscription: { status: "active", cancellation: null, collectionPaused: null },
    });

    expect(planCard()).toHaveAttribute("data-plan-state", "unrecognized");
    const plan = within(planCard());
    expect(plan.getByText(/isn't in the current catalog/)).toBeInTheDocument();
    expect(plan.getByText(SUBSCRIPTION_STATUS_CONTENT.active.label)).toBeInTheDocument();
    expect(plan.queryByText(/Pro\b/)).not.toBeInTheDocument();
    expect(plan.queryByText(/Starter/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports that the plan could not be read — still showing the status — when Stripe failed", () => {
    renderSub(subscription("active"), { kind: "unavailable", reason: "stripe_error" });

    expect(planCard()).toHaveAttribute("data-plan-state", "unavailable");
    const plan = within(planCard());
    expect(plan.getByRole("alert")).toHaveTextContent(/couldn't load your plan details/);
    expect(plan.getByRole("alert")).not.toHaveTextContent(/changed/i);
    expect(plan.getByRole("alert")).toHaveTextContent(/from our records/);
    expect(plan.getByText(SUBSCRIPTION_STATUS_CONTENT.active.label)).toBeInTheDocument();
    expect(plan.queryByText(/Pro\b/)).not.toBeInTheDocument();
    expect(plan.queryByText(/isn't in the current catalog/)).not.toBeInTheDocument();
    expect(plan.getByRole("link", { name: GO_TO_BILLING_LABEL })).toBeInTheDocument();
  });

  it("flags a payment problem in the attention tone", () => {
    renderSub(subscription("past_due"));

    const plan = within(planCard());
    expect(
      plan.getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.label),
    ).toBeInTheDocument();
    expect(plan.getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.description)).toHaveClass(
      "text-red-600",
    );
  });

  it("offers pricing again once the subscription has ended", () => {
    renderSub(subscription("canceled", { canSubscribe: true }));

    expect(pricingLink()).toHaveAttribute("href", PRICING_PATH);
    expect(within(billingCard()).getByText(/latest invoice/)).toBeInTheDocument();
  });

  it("warns, rather than guesses, when the records point at several billing accounts", () => {
    renderSub(subscription("active", { customerState: "ambiguous", canManage: false }));

    expect(billingCard()).toHaveAttribute("data-billing-customer", "ambiguous");
    expect(within(billingCard()).getByRole("alert")).toHaveTextContent(
      /more than one billing account/,
    );
    expect(
      within(billingCard()).getByRole("link", { name: GO_TO_BILLING_LABEL }),
    ).toHaveAttribute("href", "/billing");
  });
});

describe("AccountOverview – the latest invoice on the billing card", () => {
  const renderWith = (
    latestInvoice: LatestInvoice,
    customerState: Ok["customerState"] = "single",
  ) =>
    render(
      <AccountOverview
        summary={subscription("active", {
          customerState,
          canManage: customerState === "single",
        })}
        freePlan={STARTER}
        currentPlan={pro("active")}
        latestInvoice={latestInvoice}
      />,
    );

  it("summarises the newest issued invoice: date, number, amount, status — and its PDF", () => {
    renderWith(INVOICE);

    expect(billingCard()).toHaveAttribute("data-latest-invoice", "ok");
    const billing = within(billingCard());
    expect(billing.getByText(/latest invoice/)).toBeInTheDocument();
    expect(billing.getByText("Mar 1, 2026")).toBeInTheDocument();
    expect(billing.getByText(/ABCD-0001/)).toBeInTheDocument();
    expect(billing.getByText("$29.00")).toBeInTheDocument();
    expect(billing.getByText("Paid")).toBeInTheDocument();

    const pdf = billing.getByRole("link", { name: /Download PDF of invoice ABCD-0001/ });
    expect(pdf).toHaveAttribute("href", "/billing/invoices/a2V5/pdf");
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(pdf).toHaveAttribute("rel", "noopener noreferrer");
    expect(pdf).toHaveTextContent(DOWNLOAD_PDF_LABEL);
    // The full history stays on the billing page.
    expect(billing.getByRole("link", { name: GO_TO_BILLING_LABEL })).toHaveAttribute(
      "href",
      "/billing",
    );
    expect(billing.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("marks an unpaid invoice as needing attention", () => {
    renderWith({
      ...INVOICE,
      invoice: { ...INVOICE.invoice, status: "open", total: 9900 },
    });

    const billing = within(billingCard());
    expect(billing.getByText("Open")).toHaveClass("text-red-600");
    expect(billing.getByText("$99.00")).toBeInTheDocument();
  });

  it("says the PDF is not available rather than offering a dead link", () => {
    renderWith({
      ...INVOICE,
      invoice: {
        ...INVOICE.invoice,
        number: null,
        documents: { view: true, pdf: false },
      },
    });

    const billing = within(billingCard());
    expect(billing.queryByRole("link", { name: /PDF/ })).not.toBeInTheDocument();
    expect(billing.getByText(/PDF isn't available/)).toBeInTheDocument();
    expect(billing.queryByText(/·/)).not.toBeInTheDocument(); // no number to show
  });

  it("says no invoices have been issued yet for a billing account without any", () => {
    renderWith({ kind: "empty" });

    expect(billingCard()).toHaveAttribute("data-latest-invoice", "empty");
    expect(
      within(billingCard()).getByText(/No invoices have been issued yet/),
    ).toBeInTheDocument();
    expect(
      within(billingCard()).queryByRole("link", { name: /PDF/ }),
    ).not.toBeInTheDocument();
    expect(within(billingCard()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not claim 'no invoices' when the scan stopped short", () => {
    renderWith({ kind: "undetermined" });

    const billing = within(billingCard());
    expect(
      billing.getByText(/couldn't find your latest invoice quickly/),
    ).toBeInTheDocument();
    expect(billing.queryByText(/No invoices/)).not.toBeInTheDocument();
    expect(billing.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a failure as such, never as 'no invoices', with no claim about the account", () => {
    renderWith({ kind: "unavailable", reason: "stripe_error" });

    expect(billingCard()).toHaveAttribute("data-latest-invoice", "unavailable");
    const alert = within(billingCard()).getByRole("alert");
    expect(alert).toHaveTextContent(/couldn't load your latest invoice/);
    expect(alert).toHaveTextContent(/try again/);
    expect(alert).not.toHaveTextContent(/changed/i);
    expect(within(billingCard()).queryByText(/No invoices/)).not.toBeInTheDocument();
  });

  it("shows no invoice for a user without a billing account, whatever the lookup says", () => {
    renderWith({ kind: "none" }, "none");

    expect(billingCard()).not.toHaveAttribute("data-latest-invoice");
    expect(within(billingCard()).getByText(/No billing account yet/)).toBeInTheDocument();
    expect(within(billingCard()).queryByText(/invoice/i)).toHaveTextContent(
      /Invoices and payment details appear here/,
    );
  });

  it("keeps the ambiguous-account warning and shows no invoice for it", () => {
    renderWith({ kind: "ambiguous" }, "ambiguous");

    expect(billingCard()).not.toHaveAttribute("data-latest-invoice");
    expect(within(billingCard()).getByRole("alert")).toHaveTextContent(
      /more than one billing account/,
    );
    expect(within(billingCard()).queryByText(/\$/)).not.toBeInTheDocument();
  });
});
