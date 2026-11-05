// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";

// The default (cookie-based) client is never used here: every test injects a fake.
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("default client must not be created when one is injected");
  }),
}));

import {
  BLOCKING_SUBSCRIPTION_STATUSES,
  getUserBillingState,
} from "./get-user-billing-state";

const rows = (data: unknown) => ({ ...OK_RESPONSE, status: 200, data });

afterEach(() => vi.restoreAllMocks());

describe("getUserBillingState", () => {
  it("reads only the user's rows and only the columns the app already uses", async () => {
    const db = createFakeSupabase(() => rows([]));

    await getUserBillingState("user_1", db.client);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].table).toBe("subscriptions");
    expect(db.methodsOf(db.queries[0])).toEqual(["select", "eq"]);
    expect(db.argsOf(db.queries[0], "select")).toEqual(["stripe_customer_id, status"]);
    expect(db.argsOf(db.queries[0], "eq")).toEqual(["userId", "user_1"]);
  });

  it("reports no customer and no blocking subscription for a new user", async () => {
    const db = createFakeSupabase(() => rows([]));

    expect(await getUserBillingState("user_1", db.client)).toEqual({
      ok: true,
      stripeCustomerId: null,
      hasBlockingSubscription: false,
      statuses: [],
    });
  });

  it("returns the existing customer and flags servicing subscriptions", async () => {
    const db = createFakeSupabase(() =>
      rows([
        { stripe_customer_id: "cus_1", status: "canceled" },
        { stripe_customer_id: "cus_1", status: "active" },
      ]),
    );

    expect(await getUserBillingState("user_1", db.client)).toEqual({
      ok: true,
      stripeCustomerId: "cus_1",
      hasBlockingSubscription: true,
      statuses: ["canceled", "active"],
    });
  });

  it.each(BLOCKING_SUBSCRIPTION_STATUSES)("treats %s as blocking", async (status) => {
    const db = createFakeSupabase(() => rows([{ stripe_customer_id: "cus_1", status }]));
    expect(await getUserBillingState("u", db.client)).toMatchObject({
      ok: true,
      hasBlockingSubscription: true,
    });
  });

  it.each(["canceled", "incomplete", "incomplete_expired", null])(
    "does not treat %s as blocking",
    async (status) => {
      const db = createFakeSupabase(() =>
        rows([{ stripe_customer_id: "cus_1", status }]),
      );
      expect(await getUserBillingState("u", db.client)).toMatchObject({
        ok: true,
        hasBlockingSubscription: false,
      });
    },
  );

  it("still returns the customer id from a canceled subscription (for reuse)", async () => {
    const db = createFakeSupabase(() =>
      rows([{ stripe_customer_id: "cus_old", status: "canceled" }]),
    );
    expect(await getUserBillingState("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: "cus_old",
    });
  });

  it("FAILS CLOSED when the read is denied or fails: reports unknown state, never 'no subscription'", async () => {
    // Regression: this used to return { hasBlockingSubscription: false }, which let a
    // user with an active plan start a second paid checkout whenever the lookup failed.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      data: null,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    }));

    const state = await getUserBillingState("user_1", db.client);

    expect(state).toEqual({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });
    expect(state).not.toHaveProperty("hasBlockingSubscription");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toMatchObject({
      userId: "user_1",
      error: { code: "42501" },
    });
  });

  it("fails closed on transport failures too (supabase-js reports them as errors, not throws)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      data: null,
      error: { message: "TypeError: fetch failed", code: "" },
    }));

    expect(await getUserBillingState("user_1", db.client)).toMatchObject({ ok: false });
  });
});
