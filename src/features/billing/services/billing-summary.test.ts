// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// The overview module (imported for its status helpers) pulls in the cookie-based
// Supabase client and, through it, the validated client env. Nothing here reads
// the database, so keep that dependency out — like every other test that
// touches this module.
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("the summary must not touch the database");
  }),
}));

import {
  SUBSCRIPTION_STATUS_CONTENT,
  type SubscriptionStatusContent,
  toBillingSummary,
} from "./billing-summary";
import {
  type ConsolidatedSubscription,
  type CustomerResolution,
  isServicingStatus,
  SUBSCRIPTION_STATUS_PRIORITY,
  type SubscriptionOverview,
} from "./get-subscription-overview";
import { BLOCKING_SUBSCRIPTION_STATUSES } from "./get-user-billing-state";

const record = (
  status: string | null,
  stripeCustomerId: string | null = "cus_1",
  flags: Partial<
    Pick<ConsolidatedSubscription, "statusConflict" | "customerConflict">
  > = {},
): ConsolidatedSubscription => ({
  stripeSubscriptionId: "sub_1",
  stripeCustomerId,
  status,
  rowCount: 1,
  statusConflict: false,
  customerConflict: false,
  isServicing: isServicingStatus(status),
  ...flags,
});

const overviewWith = (
  current: ConsolidatedSubscription | null,
  stripeCustomerId: string | null = current?.stripeCustomerId ?? null,
  resolution: CustomerResolution = stripeCustomerId === null
    ? { kind: "none" }
    : { kind: "single", stripeCustomerId },
): Extract<SubscriptionOverview, { ok: true }> => ({
  ok: true,
  stripeCustomerId: resolution.kind === "single" ? resolution.stripeCustomerId : null,
  customerResolution: resolution,
  current,
  isServicing: current?.isServicing ?? false,
  subscriptions: current ? [current] : [],
});

describe("toBillingSummary – unreadable records", () => {
  it("reports ok: false and nothing else (no status to misread as 'free plan')", () => {
    const summary = toBillingSummary({
      ok: false,
      error: { message: "permission denied", code: "42501" },
    });

    expect(summary).toEqual({ ok: false });
    expect(summary).not.toHaveProperty("status");
    expect(summary).not.toHaveProperty("canManage");
    expect(summary).not.toHaveProperty("error"); // internals stay on the server
  });
});

describe("toBillingSummary – no subscription", () => {
  it("is the free plan: nothing to manage, checkout allowed", () => {
    expect(toBillingSummary(overviewWith(null))).toEqual({
      ok: true,
      status: null,
      customerState: "none",
      canManage: false,
      canSubscribe: true,
    });
  });

  it("still offers the portal when a Stripe customer exists without a subscription row", () => {
    expect(toBillingSummary(overviewWith(null, "cus_only"))).toMatchObject({
      status: null,
      canManage: true,
      canSubscribe: true,
    });
  });
});

describe("toBillingSummary – a subscription", () => {
  it.each(SUBSCRIPTION_STATUS_PRIORITY)("passes %s through as the status", (status) => {
    expect(toBillingSummary(overviewWith(record(status)))).toMatchObject({
      ok: true,
      status,
    });
  });

  it.each(["something_new", "ACTIVE", ""])(
    "maps an unrecognised stored status (%j) to 'unknown' rather than guessing",
    (status) => {
      expect(toBillingSummary(overviewWith(record(status)))).toMatchObject({
        status: "unknown",
      });
    },
  );

  it("maps a row with a null status to 'unknown' (a row exists, so it is not the free plan)", () => {
    expect(toBillingSummary(overviewWith(record(null)))).toMatchObject({
      status: "unknown",
      canSubscribe: true,
    });
  });

  it.each(BLOCKING_SUBSCRIPTION_STATUSES)(
    "does not offer a new checkout while %s (the checkout action would refuse it)",
    (status) => {
      expect(toBillingSummary(overviewWith(record(status)))).toMatchObject({
        canSubscribe: false,
      });
    },
  );

  it.each(["incomplete", "incomplete_expired", "canceled", "unknown_value"])(
    "offers a new checkout when the subscription is %s (not serviced by Stripe)",
    (status) => {
      expect(toBillingSummary(overviewWith(record(status)))).toMatchObject({
        canSubscribe: true,
      });
    },
  );

  it("can manage exactly when a Stripe customer is known", () => {
    expect(toBillingSummary(overviewWith(record("active", "cus_1")))).toMatchObject({
      canManage: true,
    });
    expect(toBillingSummary(overviewWith(record("active", null)))).toMatchObject({
      canManage: false,
    });
  });

  it("uses the overview's customer, which may come from another row than the current one", () => {
    expect(
      toBillingSummary(overviewWith(record("active", null), "cus_other")),
    ).toMatchObject({ canManage: true });
  });

  it("reports a conflicting subscription as such, whatever its stored status", () => {
    expect(
      toBillingSummary(overviewWith(record(null, "cus_1", { statusConflict: true }))),
    ).toMatchObject({ status: "conflicting" });
    expect(
      toBillingSummary(overviewWith(record("active", "cus_1", { statusConflict: true }))),
    ).toMatchObject({ status: "conflicting" });
  });

  it("offers no checkout while ANY subscription is serviced, not just the current one", () => {
    const ended = record("canceled", "cus_1");
    const overview: SubscriptionOverview = {
      ...overviewWith(ended),
      isServicing: true, // some other subscription is live
    };

    expect(toBillingSummary(overview)).toMatchObject({ canSubscribe: false });
  });

  it("exposes an ambiguous customer as such: no portal, and not 'none' either", () => {
    const summary = toBillingSummary(
      overviewWith(record("active", null), null, {
        kind: "ambiguous",
        reason: "multiple_customers",
        customers: 2,
      }),
    );

    expect(summary).toMatchObject({
      ok: true,
      customerState: "ambiguous",
      canManage: false,
    });
    // The reason stays server-side; the page only needs to know it is ambiguous.
    expect(JSON.stringify(summary)).not.toMatch(/multiple_customers|cus_/);
  });

  it("carries no Stripe identifiers into the view model", () => {
    const summary = toBillingSummary(overviewWith(record("active", "cus_secret")));

    expect(JSON.stringify(summary)).not.toMatch(/cus_|sub_/);
  });
});

describe("SUBSCRIPTION_STATUS_CONTENT", () => {
  const entries = Object.entries(SUBSCRIPTION_STATUS_CONTENT) as [
    string,
    SubscriptionStatusContent,
  ][];

  it("has copy for every Stripe status plus 'unknown' and 'conflicting', and nothing else", () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_CONTENT).sort()).toEqual(
      [...SUBSCRIPTION_STATUS_PRIORITY, "unknown", "conflicting"].sort(),
    );
  });

  it("gives every status a non-empty label, description and a known tone", () => {
    for (const [status, content] of entries) {
      expect(content.label, status).toMatch(/\S/);
      expect(content.description, status).toMatch(/\S/);
      expect(["neutral", "attention"], status).toContain(content.tone);
    }
  });

  it("asks for attention exactly where the user must act on a payment problem", () => {
    const attention = entries
      .filter(([, content]) => content.tone === "attention")
      .map(([status]) => status);

    expect(attention.sort()).toEqual([
      "conflicting",
      "incomplete",
      "past_due",
      "unknown",
      "unpaid",
    ]);
  });

  it("does not claim renewal, cancellation, trial or expiry behaviour the stored status cannot support", () => {
    // Only `status` is stored. Whether an active subscription renews or is set
    // to cancel at period end, what a trial turns into, when an incomplete one
    // expires, whether a paused one can be resumed, or what dunning does next
    // is known to Stripe alone — and a user reads such sentences as promises.
    const unsupported =
      /renew|cancel(?!ed\b)|expire(?!d\b)|resume|restore|keep your|on hold|ends on|until|\bwill\b/i;

    for (const [status, content] of entries) {
      expect(content.description, status).not.toMatch(unsupported);
    }
  });

  it("never promises details it does not have (plan name, amounts, dates)", () => {
    for (const [status, content] of entries) {
      expect(content.description, status).not.toMatch(
        /\$\d|\bPro\b|\bEnterprise\b|\d{4}/,
      );
    }
  });
});
