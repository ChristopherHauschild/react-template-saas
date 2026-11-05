import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type BillingSummary,
  SUBSCRIPTION_STATUS_CONTENT,
} from "../services/billing-summary";
import type { CurrentPlan, SubscriptionFacts } from "../services/current-plan";
import { SUBSCRIPTION_STATUS_PRIORITY } from "../services/get-subscription-overview";

import { MANAGE_BILLING_LABEL } from "./manage-billing-button";
import { PRICING_PATH, SubscriptionStatusCard } from "./subscription-status-card";

// The embedded button imports the server action; it is never invoked here.
vi.mock("../actions/create-portal-session", () => ({
  createPortalSession: vi.fn(),
}));
// The summary module imports the overview service for its status helpers, which
// would pull in the cookie-based Supabase client (and the validated env) for a
// purely presentational test.
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(),
}));

type Ok = Exclude<BillingSummary, { ok: false }>;

const subscription = (
  status: Ok["status"],
  overrides: Partial<{
    canManage: boolean;
    canSubscribe: boolean;
    customerState: Ok["customerState"];
  }> = {},
): BillingSummary => {
  const customerState =
    overrides.customerState ?? (overrides.canManage === false ? "none" : "single");

  return {
    ok: true,
    status,
    customerState,
    canManage: customerState === "single",
    canSubscribe: false,
    ...(overrides.canSubscribe !== undefined && { canSubscribe: overrides.canSubscribe }),
  };
};

/** Stripe could not be read: the records are all there is (the card's older behaviour). */
const NOT_READ: CurrentPlan = { kind: "unavailable", reason: "stripe_error" };

/** Stripe's own view of the subscription, as `getCurrentPlan` hands it over. */
const stripeSays = (
  status: SubscriptionFacts["status"],
  facts: Partial<SubscriptionFacts> = {},
): CurrentPlan => ({
  kind: "ok",
  plan: { id: "pro", name: "Pro", features: [], billing: null },
  subscription: { status, cancellation: null, collectionPaused: null, ...facts },
});

const manageButton = () => screen.queryByRole("button", { name: MANAGE_BILLING_LABEL });
const pricingLink = () => screen.queryByRole("link", { name: "Choose a plan" });

describe("SubscriptionStatusCard – records unavailable", () => {
  const summary: BillingSummary = { ok: false };

  it("says the information is unavailable, never that there is no subscription", () => {
    const { container } = render(
      <SubscriptionStatusCard summary={summary} currentPlan={NOT_READ} />,
    );

    expect(container.querySelector("[data-billing-state]")).toHaveAttribute(
      "data-billing-state",
      "unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't load your subscription/,
    );
    // A failed read says nothing about the account's state: no such claim.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/changed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/try again/);
    expect(screen.queryByText(/free Starter plan/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Status/)).not.toBeInTheDocument();
  });

  it("offers a retry of the page and no actions that depend on the records", () => {
    render(<SubscriptionStatusCard summary={summary} currentPlan={NOT_READ} />);

    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/billing",
    );
    expect(manageButton()).not.toBeInTheDocument();
    expect(pricingLink()).not.toBeInTheDocument();
  });
});

describe("SubscriptionStatusCard – no subscription", () => {
  it("presents the free plan with a way to the pricing page", () => {
    const { container } = render(
      <SubscriptionStatusCard
        summary={subscription(null, { canManage: false, canSubscribe: true })}
        currentPlan={NOT_READ}
      />,
    );

    expect(container.querySelector("[data-billing-state]")).toHaveAttribute(
      "data-billing-state",
      "none",
    );
    expect(screen.getByText(/free Starter plan/)).toBeInTheDocument();
    expect(pricingLink()).toHaveAttribute("href", PRICING_PATH);
    expect(manageButton()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns that a just-completed checkout may not show up yet, promising no timing", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription(null, { canManage: false, canSubscribe: true })}
        currentPlan={NOT_READ}
      />,
    );

    expect(screen.getByText(/just completed a checkout/)).toHaveTextContent(
      /may not appear here yet/,
    );
    expect(screen.queryByText(/seconds/)).not.toBeInTheDocument();
  });

  it("still offers the portal when a Stripe customer exists (invoices, payment method)", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription(null, { canManage: true, canSubscribe: true })}
        currentPlan={NOT_READ}
      />,
    );

    expect(manageButton()).toBeEnabled();
    expect(pricingLink()).toBeInTheDocument();
  });
});

describe("SubscriptionStatusCard – a subscription", () => {
  it.each([...SUBSCRIPTION_STATUS_PRIORITY, "unknown", "conflicting"] as const)(
    "shows the label and description for %s",
    (status) => {
      const { container } = render(
        <SubscriptionStatusCard summary={subscription(status)} currentPlan={NOT_READ} />,
      );
      const { label, description } = SUBSCRIPTION_STATUS_CONTENT[status];

      expect(container.querySelector("[data-billing-state]")).toHaveAttribute(
        "data-billing-state",
        "subscription",
      );
      expect(container.querySelector("[data-subscription-status]")).toHaveAttribute(
        "data-subscription-status",
        status,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(screen.queryByText(/free Starter plan/)).not.toBeInTheDocument();
    },
  );

  it("offers the portal when a Stripe customer exists", () => {
    render(
      <SubscriptionStatusCard summary={subscription("active")} currentPlan={NOT_READ} />,
    );

    expect(manageButton()).toBeEnabled();
    expect(
      screen.queryByText(/isn't linked to a billing account/),
    ).not.toBeInTheDocument();
  });

  it("explains instead of offering the portal when no Stripe customer is known", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription("active", { canManage: false })}
        currentPlan={NOT_READ}
      />,
    );

    expect(manageButton()).not.toBeInTheDocument();
    expect(screen.getByText(/isn't linked to a billing account/)).toBeInTheDocument();
  });

  it("hides 'Choose a plan' while Stripe services the subscription (checkout would refuse)", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription("active", { canSubscribe: false })}
        currentPlan={NOT_READ}
      />,
    );

    expect(pricingLink()).not.toBeInTheDocument();
  });

  it("offers 'Choose a plan' again once the subscription is over", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription("canceled", { canSubscribe: true })}
        currentPlan={NOT_READ}
      />,
    );

    expect(pricingLink()).toHaveAttribute("href", PRICING_PATH);
    expect(manageButton()).toBeEnabled(); // the portal still has the invoices
  });

  it("marks payment problems as needing attention, and the rest as neutral", () => {
    const { container: pastDue } = render(
      <SubscriptionStatusCard
        summary={subscription("past_due")}
        currentPlan={NOT_READ}
      />,
    );
    const badge = within(pastDue).getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.label);
    expect(badge.className).toMatch(/text-red-600/);
    expect(
      within(pastDue).getByText(SUBSCRIPTION_STATUS_CONTENT.past_due.description)
        .className,
    ).toMatch(/text-red-600/);

    const { container: active } = render(
      <SubscriptionStatusCard summary={subscription("active")} currentPlan={NOT_READ} />,
    );
    expect(
      within(active).getByText(SUBSCRIPTION_STATUS_CONTENT.active.label).className,
    ).not.toMatch(/red/);
  });

  it("explains an ambiguous billing account instead of guessing, and offers no portal", () => {
    const { container } = render(
      <SubscriptionStatusCard
        summary={subscription("active", { customerState: "ambiguous" })}
        currentPlan={NOT_READ}
      />,
    );

    expect(manageButton()).not.toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-billing-customer", "ambiguous");
    expect(alert).toHaveTextContent(/more than one billing account/);
    expect(alert).toHaveTextContent(/contact support/);
    expect(
      screen.queryByText(/isn't linked to a billing account/),
    ).not.toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
  });

  it("shows a conflicting subscription as needing review, with the portal if the customer is clear", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription("conflicting")}
        currentPlan={NOT_READ}
      />,
    );

    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(
      screen.getByText(/records for this subscription disagree/),
    ).toBeInTheDocument();
    expect(manageButton()).toBeEnabled();
  });

  it("does not render an error for a healthy subscription", () => {
    render(
      <SubscriptionStatusCard summary={subscription("active")} currentPlan={NOT_READ} />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SubscriptionStatusCard – Stripe's status, when read (the dashboard's rule)", () => {
  it("shows Stripe's status and says the records do not reflect it yet, promising no timing", () => {
    const { container } = render(
      <SubscriptionStatusCard
        summary={subscription("active")} // records: the webhook has not applied the cancel
        currentPlan={stripeSays("canceled", {
          cancellation: { kind: "ended", at: "2026-03-31T00:00:00.000Z" },
        })}
      />,
    );

    expect(container.querySelector("[data-subscription-status]")).toHaveAttribute(
      "data-subscription-status",
      "canceled",
    );
    expect(container.querySelector("[data-status-source]")).toHaveAttribute(
      "data-status-source",
      "stripe",
    );
    expect(screen.getByText("Canceled")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByText("Ended on Mar 31, 2026.")).toBeInTheDocument();

    const lag = screen.getByRole("status");
    expect(lag).toHaveTextContent(/records don't reflect it yet/);
    expect(lag).toHaveTextContent(/Choosing a new plan isn't available until they do/);
    expect(lag).toHaveTextContent(/If this persists, contact support/);
    expect(lag).not.toHaveTextContent(/seconds|shortly|soon|will catch up|automatically/);
    // What may be done still follows the records: checkout would be refused.
    expect(pricingLink()).not.toBeInTheDocument();
    expect(manageButton()).toBeEnabled();
  });

  it("shows what Stripe says about the subscription ending or pausing", () => {
    render(
      <SubscriptionStatusCard
        summary={subscription("active")}
        currentPlan={stripeSays("active", {
          cancellation: { kind: "scheduled", at: "2026-03-31T00:00:00.000Z" },
          collectionPaused: { resumesAt: null },
        })}
      />,
    );

    expect(screen.getByText("Set to cancel on Mar 31, 2026.")).toBeInTheDocument();
    expect(
      screen.getByText("Payments are paused until you resume them."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // same status: no lag
  });

  it("says the status is from our records only when Stripe could not be read", () => {
    const { container, rerender } = render(
      <SubscriptionStatusCard summary={subscription("active")} currentPlan={NOT_READ} />,
    );
    expect(screen.getByText(/from our records/)).toBeInTheDocument();
    expect(container.querySelector("[data-status-source]")).toHaveAttribute(
      "data-status-source",
      "records",
    );

    rerender(
      <SubscriptionStatusCard
        summary={subscription("active")}
        currentPlan={stripeSays("active")}
      />,
    );
    expect(screen.queryByText(/from our records/)).not.toBeInTheDocument();
  });
});
