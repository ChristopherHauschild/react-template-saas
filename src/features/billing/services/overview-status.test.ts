// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// Type-only imports of the summary/plan modules; nothing here reads the database.
vi.mock("@/infrastructure/auth/supabase/server", () => ({ createClient: vi.fn() }));

import type { CurrentPlan, SubscriptionFacts } from "./current-plan";
import { reconcileOverviewStatus } from "./overview-status";

type Records = Parameters<typeof reconcileOverviewStatus>[0];

const records = (status: Records["status"]): Records => ({
  ok: true,
  status,
  customerState: "single",
  canManage: true,
  canSubscribe: false,
});

const facts = (status: SubscriptionFacts["status"]): SubscriptionFacts => ({
  status,
  cancellation: null,
  collectionPaused: null,
});

const ok = (status: SubscriptionFacts["status"]): CurrentPlan => ({
  kind: "ok",
  plan: { id: "pro", name: "Pro", features: [], billing: null },
  subscription: facts(status),
});

describe("reconcileOverviewStatus", () => {
  it("shows Stripe's status when it was read, and notes nothing when the records agree", () => {
    expect(reconcileOverviewStatus(records("active"), ok("active"))).toEqual({
      status: "active",
      source: "stripe",
      recordsLag: false,
    });
  });

  it("shows Stripe's status over the records' when they differ, and says so (records lag)", () => {
    // Canceled in the portal just now; the webhook has not applied it yet.
    expect(reconcileOverviewStatus(records("active"), ok("canceled"))).toEqual({
      status: "canceled",
      source: "stripe",
      recordsLag: true,
    });
    // A payment problem Stripe knows about before we do.
    expect(reconcileOverviewStatus(records("active"), ok("past_due"))).toMatchObject({
      status: "past_due",
      recordsLag: true,
    });
  });

  it("does the same for a subscription whose plan is not in the catalog", () => {
    const unrecognized: CurrentPlan = {
      kind: "unrecognized",
      subscription: facts("canceled"),
    };

    expect(reconcileOverviewStatus(records("active"), unrecognized)).toEqual({
      status: "canceled",
      source: "stripe",
      recordsLag: true,
    });
  });

  it("falls back to the records when Stripe could not be read", () => {
    const unavailable: CurrentPlan = { kind: "unavailable", reason: "stripe_error" };

    expect(reconcileOverviewStatus(records("active"), unavailable)).toEqual({
      status: "active",
      source: "records",
      recordsLag: false,
    });
    expect(reconcileOverviewStatus(records("active"), { kind: "none" })).toMatchObject({
      source: "records",
    });
  });

  it("falls back to the records when Stripe's status is one this code does not know", () => {
    expect(reconcileOverviewStatus(records("active"), ok("unknown"))).toEqual({
      status: "active",
      source: "records",
      recordsLag: false,
    });
  });

  it("lets Stripe's status replace a records' status we could not trust", () => {
    for (const untrusted of ["conflicting", "unknown"] as const) {
      expect(reconcileOverviewStatus(records(untrusted), ok("active"))).toEqual({
        status: "active",
        source: "stripe",
        recordsLag: true,
      });
    }
  });

  it("leaves what may be done to the records (canSubscribe is not touched)", () => {
    const summary: Records = { ...records("active"), canSubscribe: false };
    const result = reconcileOverviewStatus(summary, ok("canceled"));

    expect(result).not.toHaveProperty("canSubscribe");
    expect(summary.canSubscribe).toBe(false);
  });
});
