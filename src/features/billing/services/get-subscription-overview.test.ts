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
  getSubscriptionOverview,
  isServicingStatus,
  isSubscriptionStatus,
  SUBSCRIPTION_OVERVIEW_COLUMNS,
  SUBSCRIPTION_STATUS_PRIORITY,
  type SubscriptionRecord,
  summarizeSubscriptions,
} from "./get-subscription-overview";
import { BLOCKING_SUBSCRIPTION_STATUSES } from "./get-user-billing-state";

const rows = (data: unknown) => ({ ...OK_RESPONSE, status: 200, data });

type DbRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
};

const row = (
  stripe_subscription_id: string | null,
  status: string | null,
  stripe_customer_id: string | null = "cus_1",
): DbRow => ({ stripe_customer_id, stripe_subscription_id, status });

afterEach(() => vi.restoreAllMocks());

describe("getSubscriptionOverview – query", () => {
  it("reads only the user's rows and only the columns the app already relies on", async () => {
    const db = createFakeSupabase(() => rows([]));

    await getSubscriptionOverview("user_1", db.client);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].table).toBe("subscriptions");
    expect(db.methodsOf(db.queries[0])).toEqual(["select", "eq"]);
    expect(db.argsOf(db.queries[0], "select")).toEqual([SUBSCRIPTION_OVERVIEW_COLUMNS]);
    expect(db.argsOf(db.queries[0], "eq")).toEqual(["userId", "user_1"]);
  });

  it("selects exactly the three columns the webhook writes (no plan, dates or ids we do not store)", () => {
    expect(SUBSCRIPTION_OVERVIEW_COLUMNS.split(/,\s*/).sort()).toEqual([
      "status",
      "stripe_customer_id",
      "stripe_subscription_id",
    ]);
  });

  it("uses the injected client for the read (never the service role)", async () => {
    const db = createFakeSupabase(() => rows([]));
    const { createClient } = await import("@/infrastructure/auth/supabase/server");

    await getSubscriptionOverview("user_1", db.client);

    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("getSubscriptionOverview – no rows", () => {
  it("reports no customer, no current subscription and nothing servicing for a new user", async () => {
    const db = createFakeSupabase(() => rows([]));

    expect(await getSubscriptionOverview("user_1", db.client)).toEqual({
      ok: true,
      stripeCustomerId: null,
      customerResolution: { kind: "none" },
      current: null,
      isServicing: false,
      subscriptions: [],
    });
  });

  it("treats a null payload like an empty one", async () => {
    const db = createFakeSupabase(() => rows(null));

    expect(await getSubscriptionOverview("user_1", db.client)).toMatchObject({
      ok: true,
      current: null,
      subscriptions: [],
    });
  });
});

describe("getSubscriptionOverview – a single row", () => {
  it("maps the row to the application's field names", async () => {
    const db = createFakeSupabase(() => rows([row("sub_1", "active", "cus_1")]));

    const consolidated = {
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: "cus_1",
      status: "active",
      rowCount: 1,
      statusConflict: false,
      customerConflict: false,
      isServicing: true,
    };

    expect(await getSubscriptionOverview("user_1", db.client)).toEqual({
      ok: true,
      stripeCustomerId: "cus_1",
      customerResolution: { kind: "single", stripeCustomerId: "cus_1" },
      current: consolidated,
      isServicing: true,
      subscriptions: [consolidated],
    });
  });

  it.each(["active", "trialing", "past_due", "unpaid", "paused"] as const)(
    "%s is a servicing status (Stripe still bills or retries)",
    async (status) => {
      const db = createFakeSupabase(() => rows([row("sub_1", status)]));

      expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
        ok: true,
        isServicing: true,
      });
    },
  );

  it.each(["incomplete", "incomplete_expired", "canceled", "bogus", null] as const)(
    "%s is not a servicing status",
    async (status) => {
      const db = createFakeSupabase(() => rows([row("sub_1", status)]));

      expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
        ok: true,
        isServicing: false,
      });
    },
  );

  it("keeps the customer of a canceled subscription so the portal (invoices, card) can still be opened", async () => {
    const db = createFakeSupabase(() => rows([row("sub_old", "canceled", "cus_old")]));

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: "cus_old",
      current: { status: "canceled" },
      isServicing: false,
    });
  });

  it("passes an unrecognised status through unchanged rather than guessing", async () => {
    const db = createFakeSupabase(() => rows([row("sub_1", "something_new")]));

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      current: { status: "something_new" },
      isServicing: false,
    });
  });

  it("normalises empty strings to null (an empty id is not an id)", async () => {
    const db = createFakeSupabase(() => rows([row("", "", "")]));

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: null,
      customerResolution: { kind: "none" },
      current: { stripeSubscriptionId: null, stripeCustomerId: null, status: null },
      isServicing: false,
      subscriptions: [
        { stripeSubscriptionId: null, stripeCustomerId: null, status: null },
      ],
    });
  });
});

describe("getSubscriptionOverview – multiple rows", () => {
  it("picks the active subscription over an older canceled one, whatever the row order", async () => {
    for (const order of [
      [row("sub_old", "canceled"), row("sub_new", "active")],
      [row("sub_new", "active"), row("sub_old", "canceled")],
    ]) {
      const db = createFakeSupabase(() => rows(order));

      expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
        ok: true,
        current: { stripeSubscriptionId: "sub_new", status: "active" },
        isServicing: true,
      });
    }
  });

  it("ranks a past_due subscription (still serviced) above an orphan incomplete one", async () => {
    const db = createFakeSupabase(() =>
      rows([row("sub_orphan", "incomplete"), row("sub_live", "past_due")]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      current: { stripeSubscriptionId: "sub_live", status: "past_due" },
      isServicing: true,
    });
  });

  it("ranks an incomplete subscription (first payment may still succeed) above finished ones", async () => {
    const db = createFakeSupabase(() =>
      rows([
        row("sub_a", "canceled"),
        row("sub_b", "incomplete_expired"),
        row("sub_c", "incomplete"),
      ]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      current: { stripeSubscriptionId: "sub_c", status: "incomplete" },
      isServicing: false,
    });
  });

  it("orders every row by priority and ranks unknown / missing statuses last", async () => {
    const db = createFakeSupabase(() =>
      rows([
        row("sub_null", null),
        row("sub_canceled", "canceled"),
        row("sub_weird", "weird"),
        row("sub_trialing", "trialing"),
        row("sub_incomplete", "incomplete"),
        row("sub_active", "active"),
      ]),
    );

    const overview = await getSubscriptionOverview("u", db.client);

    expect(
      overview.ok && overview.subscriptions.map((s) => s.stripeSubscriptionId),
    ).toEqual([
      "sub_active",
      "sub_trialing",
      "sub_incomplete",
      "sub_canceled",
      "sub_null",
      "sub_weird",
    ]);
  });

  it("keeps the database's order between rows of equal status (stable sort)", async () => {
    const db = createFakeSupabase(() =>
      rows([
        row("sub_1", "canceled"),
        row("sub_2", "canceled"),
        row("sub_3", "canceled"),
      ]),
    );

    const overview = await getSubscriptionOverview("u", db.client);

    expect(
      overview.ok && overview.subscriptions.map((s) => s.stripeSubscriptionId),
    ).toEqual(["sub_1", "sub_2", "sub_3"]);
    expect(overview).toMatchObject({ current: { stripeSubscriptionId: "sub_1" } });
  });

  it("opens the portal for the customer of the current subscription when rows disagree", async () => {
    const db = createFakeSupabase(() =>
      rows([row("sub_old", "canceled", "cus_old"), row("sub_new", "active", "cus_new")]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: "cus_new",
    });
  });

  it("does NOT borrow an ended subscription's customer for a live one without a customer", async () => {
    // Regression: this used to open the portal for cus_old — a portal that would
    // not even show the subscription that is actually being billed.
    const db = createFakeSupabase(() =>
      rows([row("sub_old", "canceled", "cus_old"), row("sub_new", "active", null)]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: null,
      customerResolution: { kind: "ambiguous", reason: "unknown_customer", customers: 1 },
      current: { stripeSubscriptionId: "sub_new", stripeCustomerId: null },
    });
  });

  it("uses the only customer among ended subscriptions when nothing is being billed", async () => {
    const db = createFakeSupabase(() =>
      rows([
        row("sub_a", "canceled", "cus_old"),
        row("sub_b", "incomplete_expired", null),
      ]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      customerResolution: { kind: "single", stripeCustomerId: "cus_old" },
    });
  });

  it("reports no customer when no row has one (e.g. rows written before the customer was known)", async () => {
    const db = createFakeSupabase(() =>
      rows([row("sub_1", "incomplete", null), row("sub_2", "canceled", null)]),
    );

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: null,
      current: { stripeSubscriptionId: "sub_1" },
    });
  });

  it("keeps a row without a subscription id if it still carries the customer", async () => {
    const db = createFakeSupabase(() => rows([row(null, null, "cus_only")]));

    expect(await getSubscriptionOverview("u", db.client)).toMatchObject({
      ok: true,
      stripeCustomerId: "cus_only",
      current: { stripeSubscriptionId: null, status: null },
      isServicing: false,
    });
  });
});

describe("getSubscriptionOverview – fails closed", () => {
  it("reports an unknown state (never 'no subscription') when the read is denied", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      data: null,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    }));

    const overview = await getSubscriptionOverview("user_1", db.client);

    expect(overview).toEqual({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });
    expect(overview).not.toHaveProperty("current");
    expect(overview).not.toHaveProperty("stripeCustomerId");
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

    expect(await getSubscriptionOverview("user_1", db.client)).toMatchObject({
      ok: false,
    });
  });

  it("ignores any data that accompanies an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      data: [row("sub_1", "active")],
      error: { message: "partial failure", code: "XX000" },
    }));

    expect(await getSubscriptionOverview("user_1", db.client)).toMatchObject({
      ok: false,
    });
  });

  it("lets an unexpected throw propagate (error boundary), instead of reporting a state", async () => {
    const db = createFakeSupabase(() => {
      throw new Error("cookies unavailable");
    });

    await expect(getSubscriptionOverview("user_1", db.client)).rejects.toThrow(
      "cookies unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial data. `subscriptions` has no uniqueness and predates this code;
// legacy rows can disagree with each other. The rule: the portal customer must
// be unambiguous, and a subscription's status must not be asserted when our own
// rows disagree about it. `summarizeSubscriptions` is the pure reduction.
// ---------------------------------------------------------------------------

const rec = (
  stripeSubscriptionId: string | null,
  status: string | null,
  stripeCustomerId: string | null = "cus_1",
): SubscriptionRecord => ({ stripeSubscriptionId, stripeCustomerId, status });

describe("summarizeSubscriptions – duplicate active subscriptions", () => {
  it("two live subscriptions on DIFFERENT customers: ambiguous, portal refused, whatever the row order", () => {
    for (const order of [
      [rec("sub_a", "active", "cus_A"), rec("sub_b", "active", "cus_B")],
      [rec("sub_b", "active", "cus_B"), rec("sub_a", "active", "cus_A")],
    ]) {
      const overview = summarizeSubscriptions(order);

      expect(overview.stripeCustomerId).toBeNull();
      expect(overview.customerResolution).toEqual({
        kind: "ambiguous",
        reason: "multiple_customers",
        customers: 2,
      });
      expect(overview.isServicing).toBe(true);
    }
  });

  it("two live subscriptions on the SAME customer: unambiguous (the portal shows both)", () => {
    const overview = summarizeSubscriptions([
      rec("sub_a", "active", "cus_A"),
      rec("sub_b", "trialing", "cus_A"),
    ]);

    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_A",
    });
    expect(overview.subscriptions).toHaveLength(2);
    expect(overview.isServicing).toBe(true);
  });

  it("a live subscription on one customer and a past-due one on another: ambiguous", () => {
    // Opening cus_A would hide the payment problem on cus_B.
    const overview = summarizeSubscriptions([
      rec("sub_a", "active", "cus_A"),
      rec("sub_b", "past_due", "cus_B"),
    ]);

    expect(overview.customerResolution).toMatchObject({
      kind: "ambiguous",
      reason: "multiple_customers",
    });
  });

  it("a live subscription plus ended ones on other customers: the live one's customer wins", () => {
    const overview = summarizeSubscriptions([
      rec("sub_old1", "canceled", "cus_old1"),
      rec("sub_live", "active", "cus_live"),
      rec("sub_old2", "incomplete_expired", "cus_old2"),
      rec("sub_orphan", "incomplete", "cus_orphan"),
    ]);

    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_live",
    });
    expect(overview.current).toMatchObject({ stripeSubscriptionId: "sub_live" });
  });
});

describe("summarizeSubscriptions – different customers, nothing live", () => {
  it("only ended subscriptions on several customers: ambiguous (which invoices?)", () => {
    const overview = summarizeSubscriptions([
      rec("sub_a", "canceled", "cus_A"),
      rec("sub_b", "canceled", "cus_B"),
    ]);

    expect(overview.customerResolution).toEqual({
      kind: "ambiguous",
      reason: "multiple_past_customers",
      customers: 2,
    });
    expect(overview.isServicing).toBe(false);
  });

  it("only ended subscriptions on one customer: that customer", () => {
    const overview = summarizeSubscriptions([
      rec("sub_a", "canceled", "cus_A"),
      rec("sub_b", "incomplete_expired", "cus_A"),
      rec("sub_c", "incomplete", null),
    ]);

    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_A",
    });
  });

  it("rows with no customer at all: none (not ambiguous, not a guess)", () => {
    const overview = summarizeSubscriptions([
      rec("sub_a", "canceled", null),
      rec("sub_b", "incomplete", null),
    ]);

    expect(overview.customerResolution).toEqual({ kind: "none" });
  });
});

describe("summarizeSubscriptions – conflicting statuses for one subscription id", () => {
  it("merges exact duplicates into one subscription", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", "cus_1"),
      rec("sub_1", "active", "cus_1"),
    ]);

    expect(overview.subscriptions).toHaveLength(1);
    expect(overview.current).toMatchObject({
      stripeSubscriptionId: "sub_1",
      status: "active",
      rowCount: 2,
      statusConflict: false,
      customerConflict: false,
    });
    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_1",
    });
  });

  it.each(["canceled", "incomplete_expired"])(
    "a terminal row (%s) wins over a live one: Stripe never leaves a terminal status",
    (terminal) => {
      for (const order of [
        [rec("sub_1", "active"), rec("sub_1", terminal)],
        [rec("sub_1", terminal), rec("sub_1", "active")],
      ]) {
        const overview = summarizeSubscriptions(order);

        expect(overview.current).toMatchObject({
          stripeSubscriptionId: "sub_1",
          status: terminal,
          statusConflict: false,
          rowCount: 2,
        });
      }
    },
  );

  it("two non-terminal statuses: the status is a conflict, not the better one", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active"),
      rec("sub_1", "past_due"),
    ]);

    expect(overview.current).toMatchObject({
      stripeSubscriptionId: "sub_1",
      status: null,
      statusConflict: true,
      isServicing: true, // either way Stripe is still billing
    });
    expect(overview.isServicing).toBe(true);
  });

  it("a conflicting live subscription still outranks an ended one", () => {
    const overview = summarizeSubscriptions([
      rec("sub_old", "canceled"),
      rec("sub_1", "active"),
      rec("sub_1", "unpaid"),
    ]);

    expect(overview.current).toMatchObject({
      stripeSubscriptionId: "sub_1",
      statusConflict: true,
    });
  });

  it("a conflict between live and non-terminal-ended statuses is still treated as live", () => {
    // active vs incomplete: we do not know, so we assume the safer "still billed".
    const overview = summarizeSubscriptions([
      rec("sub_1", "incomplete"),
      rec("sub_1", "active"),
    ]);

    expect(overview.current).toMatchObject({ statusConflict: true, isServicing: true });
  });

  it("a terminal status resolved from a conflict ranks as ended, below a genuinely live one", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", "cus_1"),
      rec("sub_1", "canceled", "cus_1"),
      rec("sub_2", "active", "cus_2"),
    ]);

    expect(overview.current).toMatchObject({ stripeSubscriptionId: "sub_2" });
    // sub_1 is settled as ended by its terminal row, so it does not compete for
    // the customer: only sub_2 is being billed.
    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_2",
    });
  });

  it("a terminal-resolved conflict still counts as serviced for checkout purposes", () => {
    // The checkout guard (`getUserBillingState`) reads every row and would
    // refuse a new checkout because of the stale `active` row, so the page must
    // not offer one either — even though the status shown is `canceled`.
    const overview = summarizeSubscriptions([
      rec("sub_1", "active"),
      rec("sub_1", "canceled"),
    ]);

    expect(overview.current).toMatchObject({ status: "canceled", isServicing: false });
    expect(overview.isServicing).toBe(true); // page-level: mirrors the checkout guard
  });

  it("one subscription naming two customers: corrupt, ambiguous, no status guess either", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", "cus_A"),
      rec("sub_1", "active", "cus_B"),
    ]);

    expect(overview.current).toMatchObject({
      stripeSubscriptionId: "sub_1",
      stripeCustomerId: null,
      customerConflict: true,
      status: "active",
    });
    expect(overview.customerResolution).toEqual({
      kind: "ambiguous",
      reason: "customer_conflict",
      customers: 2,
    });
  });

  it("a customer conflict on an ENDED subscription still blocks the portal", () => {
    const overview = summarizeSubscriptions([
      rec("sub_old", "canceled", "cus_A"),
      rec("sub_old", "canceled", "cus_B"),
      rec("sub_live", "active", "cus_A"),
    ]);

    expect(overview.customerResolution).toMatchObject({ reason: "customer_conflict" });
  });

  it("a customer known on one duplicate and missing on another is not a conflict", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", null),
      rec("sub_1", "active", "cus_1"),
    ]);

    expect(overview.current).toMatchObject({
      stripeCustomerId: "cus_1",
      customerConflict: false,
    });
    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_1",
    });
  });
});

describe("summarizeSubscriptions – missing subscription ids", () => {
  it("rows without a subscription id are never merged with each other", () => {
    const overview = summarizeSubscriptions([
      rec(null, "canceled", "cus_1"),
      rec(null, "active", "cus_1"),
    ]);

    expect(overview.subscriptions).toHaveLength(2);
    expect(overview.subscriptions.map((s) => s.statusConflict)).toEqual([false, false]);
  });

  it("a live row without a subscription id and without a customer makes the customer unknown", () => {
    // Legacy junk next to a good row: we cannot tell what it is, so we do not
    // pretend the good row's customer covers it.
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", "cus_1"),
      rec(null, "active", null),
    ]);

    expect(overview.customerResolution).toMatchObject({ reason: "unknown_customer" });
  });

  it("a live row without a subscription id but with the same customer is fine", () => {
    const overview = summarizeSubscriptions([
      rec("sub_1", "active", "cus_1"),
      rec(null, "active", "cus_1"),
    ]);

    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_1",
    });
  });

  it("an ended row without a subscription id does not disturb a live subscription", () => {
    const overview = summarizeSubscriptions([
      rec(null, "canceled", null),
      rec("sub_1", "active", "cus_1"),
    ]);

    expect(overview.current).toMatchObject({ stripeSubscriptionId: "sub_1" });
    expect(overview.customerResolution).toEqual({
      kind: "single",
      stripeCustomerId: "cus_1",
    });
  });

  it("a customer-only row (no id, no status) is a usable billing account when nothing is live", () => {
    expect(
      summarizeSubscriptions([rec(null, null, "cus_only")]).customerResolution,
    ).toEqual({ kind: "single", stripeCustomerId: "cus_only" });
  });
});

describe("summarizeSubscriptions – invariants", () => {
  const pool: SubscriptionRecord[] = [];
  for (const id of ["sub_a", "sub_b", null]) {
    for (const status of [
      "active",
      "past_due",
      "canceled",
      "incomplete",
      null,
      "weird",
    ]) {
      for (const customer of ["cus_1", "cus_2", null]) {
        pool.push(rec(id, status, customer));
      }
    }
  }

  /** Deterministic pseudo-random subsets of the pool. */
  function* subsets(count: number) {
    let seed = 1234567;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < count; i++) {
      const size = 1 + Math.floor(next() * 5);
      yield Array.from({ length: size }, () => pool[Math.floor(next() * pool.length)]);
    }
  }

  it("never names a customer that no row of the user carries", () => {
    for (const rows of subsets(400)) {
      const { stripeCustomerId } = summarizeSubscriptions(rows);
      if (stripeCustomerId !== null) {
        expect(rows.map((r) => r.stripeCustomerId)).toContain(stripeCustomerId);
      }
    }
  });

  it("names a customer only when every live subscription agrees on it", () => {
    for (const rows of subsets(400)) {
      const overview = summarizeSubscriptions(rows);
      if (overview.stripeCustomerId === null) continue;

      for (const subscription of overview.subscriptions.filter((s) => s.isServicing)) {
        expect(subscription.stripeCustomerId).toBe(overview.stripeCustomerId);
      }
    }
  });

  it("resolves the same customer and the same consolidated subscriptions in any row order", () => {
    // `current` may legitimately differ between equally-ranked subscriptions
    // (ties keep the database's order); the decisions must not.
    const canonical = (overview: ReturnType<typeof summarizeSubscriptions>) =>
      [...overview.subscriptions].map((s) => JSON.stringify(s)).sort();

    for (const rows of subsets(200)) {
      const a = summarizeSubscriptions(rows);
      const b = summarizeSubscriptions([...rows].reverse());

      expect(b.customerResolution).toEqual(a.customerResolution);
      expect(b.isServicing).toBe(a.isServicing);
      expect(canonical(b)).toEqual(canonical(a));
    }
  });

  it("reports page-level isServicing exactly like the checkout guard (any row)", () => {
    for (const rows of subsets(400)) {
      const expected = rows.some((r) =>
        (BLOCKING_SUBSCRIPTION_STATUSES as readonly string[]).includes(r.status ?? ""),
      );

      expect(summarizeSubscriptions(rows).isServicing).toBe(expected);
    }
  });

  it("marks a status conflict only when rows for one id disagree without a terminal one", () => {
    for (const rows of subsets(400)) {
      for (const subscription of summarizeSubscriptions(rows).subscriptions) {
        const own = rows.filter(
          (r) =>
            subscription.stripeSubscriptionId !== null &&
            r.stripeSubscriptionId === subscription.stripeSubscriptionId,
        );
        if (own.length === 0) continue;
        const statuses = new Set(own.map((r) => r.status).filter((s) => s !== null));
        const hasTerminal =
          statuses.has("canceled") || statuses.has("incomplete_expired");

        expect(subscription.statusConflict).toBe(statuses.size > 1 && !hasTerminal);
      }
    }
  });
});

describe("status vocabulary", () => {
  it("covers all eight Stripe subscription statuses, once each", () => {
    expect([...SUBSCRIPTION_STATUS_PRIORITY].sort()).toEqual([
      "active",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ]);
  });

  it("ranks the checkout guard's blocking statuses first, and nothing else as servicing", () => {
    // Both modules must agree on what "Stripe is still servicing this" means,
    // or a user could be refused a checkout while being told they have no plan.
    const head = SUBSCRIPTION_STATUS_PRIORITY.slice(
      0,
      BLOCKING_SUBSCRIPTION_STATUSES.length,
    );

    expect([...head].sort()).toEqual([...BLOCKING_SUBSCRIPTION_STATUSES].sort());
    expect(SUBSCRIPTION_STATUS_PRIORITY.filter(isServicingStatus)).toEqual([...head]);
  });

  it("recognises only those statuses", () => {
    for (const status of SUBSCRIPTION_STATUS_PRIORITY) {
      expect(isSubscriptionStatus(status)).toBe(true);
    }
    for (const value of ["Active", "", null, undefined, 1, {}]) {
      expect(isSubscriptionStatus(value)).toBe(false);
    }
  });
});
