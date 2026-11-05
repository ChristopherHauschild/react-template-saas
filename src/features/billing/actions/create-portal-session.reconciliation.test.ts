// @vitest-environment node
/**
 * End-to-end through the real reconciliation: rows in the database → real
 * `getSubscriptionOverview` → real `createPortalSession`. Only the boundaries
 * are substituted (database client, session, Stripe, `redirect`). The unit
 * tests mock the overview; this file proves the two agree on what "ambiguous"
 * means and that an ambiguous customer never reaches Stripe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";

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
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({ billingPortal: { sessions: { create: stripe.portalCreate } } }),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  },
}));

// The overview reads through the cookie-based client; hand it a recording fake
// whose rows each test chooses.
const db = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<
    typeof import("@/shared/test/supabase").createFakeSupabase
  >,
}));
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(async () => db.current.client),
}));

import { getSubscriptionOverview } from "../services/get-subscription-overview";

import { createPortalSession } from "./create-portal-session";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";

type DbRow = {
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  status: string | null;
};

const row = (
  stripe_subscription_id: string | null,
  status: string | null,
  stripe_customer_id: string | null = "cus_1",
): DbRow => ({ stripe_subscription_id, stripe_customer_id, status });

function givenRows(rows: DbRow[]) {
  db.current = createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: rows }));
}

const openedFor = async () => {
  await expect(createPortalSession()).rejects.toBeInstanceOf(RedirectSignal);
  expect(stripe.portalCreate).toHaveBeenCalledTimes(1);
  return stripe.portalCreate.mock.calls[0][0].customer;
};

const refused = async () => {
  const result = await createPortalSession();
  expect(result).toEqual({ error: expect.any(String) });
  expect(stripe.portalCreate).not.toHaveBeenCalled();
  const { redirect } = await import("next/navigation");
  expect(redirect).not.toHaveBeenCalled();
  return result!.error;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  stripe.portalCreate.mockImplementation(async ({ customer }) => ({
    id: "bps_1",
    object: "billing_portal.session",
    customer,
    url: PORTAL_URL,
  }));
});

describe("portal + reconciliation – the records point at one customer", () => {
  it("one subscription, one customer: opens it", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    expect(await openedFor()).toBe("cus_1");
  });

  it("live subscription plus ended ones on other customers: opens the live one's", async () => {
    givenRows([
      row("sub_old", "canceled", "cus_old"),
      row("sub_live", "active", "cus_live"),
      row("sub_x", "incomplete_expired", "cus_x"),
    ]);

    expect(await openedFor()).toBe("cus_live");
  });

  it("exact duplicate rows for one subscription: opens it once, for its customer", async () => {
    givenRows([row("sub_1", "active", "cus_1"), row("sub_1", "active", "cus_1")]);

    expect(await openedFor()).toBe("cus_1");
  });

  it("conflicting non-terminal statuses but one customer: the portal is where to sort it out", async () => {
    givenRows([row("sub_1", "active", "cus_1"), row("sub_1", "past_due", "cus_1")]);

    expect(await openedFor()).toBe("cus_1");
  });

  it("a stale active row next to a canceled one for the same id: still one customer", async () => {
    givenRows([row("sub_1", "active", "cus_1"), row("sub_1", "canceled", "cus_1")]);

    expect(await openedFor()).toBe("cus_1");
  });

  it("only ended subscriptions, one customer: opens it (invoices, payment method)", async () => {
    givenRows([row("sub_a", "canceled", "cus_1"), row("sub_b", "incomplete", null)]);

    expect(await openedFor()).toBe("cus_1");
  });

  it("the live subscription's customer wins even when a dead one on another customer comes first", async () => {
    givenRows([
      row("sub_dead", "canceled", "cus_dead"),
      row("sub_dead2", "canceled", "cus_dead"),
      row("sub_live", "trialing", "cus_live"),
    ]);

    expect(await openedFor()).toBe("cus_live");
  });
});

describe("portal + reconciliation – fails closed when the customer is ambiguous", () => {
  const AMBIGUOUS = /more than one billing account.*contact support/;

  it("two live subscriptions on different customers, in either row order", async () => {
    for (const rows of [
      [row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")],
      [row("sub_b", "active", "cus_B"), row("sub_a", "active", "cus_A")],
    ]) {
      vi.clearAllMocks();
      givenRows(rows);

      expect(await refused()).toMatch(AMBIGUOUS);
    }
  });

  it("a live subscription without a customer next to an ended one with a customer", async () => {
    // Regression: this used to open the portal for cus_old.
    givenRows([row("sub_old", "canceled", "cus_old"), row("sub_new", "active", null)]);

    expect(await refused()).toMatch(AMBIGUOUS);
  });

  it("one subscription id naming two customers (corrupt), even with a clean live one", async () => {
    givenRows([
      row("sub_1", "canceled", "cus_A"),
      row("sub_1", "canceled", "cus_B"),
      row("sub_2", "active", "cus_A"),
    ]);

    expect(await refused()).toMatch(AMBIGUOUS);
  });

  it("only ended subscriptions on several customers", async () => {
    givenRows([row("sub_a", "canceled", "cus_A"), row("sub_b", "canceled", "cus_B")]);

    expect(await refused()).toMatch(AMBIGUOUS);
  });

  it("a live legacy row without a subscription id or customer next to a good row", async () => {
    givenRows([row("sub_1", "active", "cus_1"), row(null, "active", null)]);

    expect(await refused()).toMatch(AMBIGUOUS);
  });

  it("a live subscription on one customer and a past-due one on another", async () => {
    givenRows([row("sub_a", "active", "cus_A"), row("sub_b", "past_due", "cus_B")]);

    expect(await refused()).toMatch(AMBIGUOUS);
  });

  it("logs counts only — no customer or subscription ids", async () => {
    givenRows([row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")]);

    await refused();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/customer is ambiguous/),
      { userId: USER.id, reason: "multiple_customers", customers: 2, subscriptions: 2 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/cus_|sub_/);
  });

  it("never opens a customer that is not on a live subscription, across many shapes", async () => {
    const ids = ["sub_a", "sub_b", null];
    const statuses = ["active", "past_due", "canceled", "incomplete", null];
    const customers = ["cus_1", "cus_2", null];
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];

    for (let i = 0; i < 150; i++) {
      vi.clearAllMocks();
      const rows = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
        row(pick(ids), pick(statuses), pick(customers)),
      );
      givenRows(rows);

      let opened: string | null = null;
      try {
        await createPortalSession();
      } catch (error) {
        if (!(error instanceof RedirectSignal)) throw error;
        opened = stripe.portalCreate.mock.calls[0][0].customer;
      }

      if (opened === null) continue;

      const shape = JSON.stringify(rows);
      const terminal = (r: DbRow) =>
        r.status === "canceled" || r.status === "incomplete_expired";
      // A row is live if its status is serviced and no duplicate row of the same
      // subscription is terminal (Stripe never leaves a terminal status).
      const serviced = ["active", "trialing", "past_due", "unpaid", "paused"];
      const live = rows.filter(
        (r) =>
          serviced.includes(r.status ?? "") &&
          !(
            r.stripe_subscription_id !== null &&
            rows.some(
              (o) => o.stripe_subscription_id === r.stripe_subscription_id && terminal(o),
            )
          ),
      );
      // The opened customer is one of the user's own …
      expect(
        rows.map((r) => r.stripe_customer_id),
        shape,
      ).toContain(opened);
      // … and every live row names it — directly, or through a duplicate row of
      // the same subscription that does (a subscription has exactly one customer).
      for (const r of live) {
        const namesIt =
          r.stripe_customer_id === opened ||
          (r.stripe_customer_id === null &&
            r.stripe_subscription_id !== null &&
            rows.some(
              (other) =>
                other.stripe_subscription_id === r.stripe_subscription_id &&
                other.stripe_customer_id === opened,
            ));

        expect(namesIt, shape).toBe(true);
      }
    }
  });
});

describe("portal + reconciliation – changes between page render and click", () => {
  // The page and the action each read the rows; nothing is cached in between.
  // Whatever the webhook wrote after the page rendered is what the click sees.
  function givenRowsPerRead(...reads: DbRow[][]) {
    let call = 0;
    db.current = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      status: 200,
      data: reads[Math.min(call++, reads.length - 1)],
    }));
  }

  it("a second live subscription on another customer appearing after render: refused", async () => {
    givenRowsPerRead(
      [row("sub_1", "active", "cus_1")],
      [row("sub_1", "active", "cus_1"), row("sub_2", "active", "cus_2")],
    );

    const rendered = await getSubscriptionOverview(USER.id); // what the page showed
    expect(rendered).toMatchObject({ stripeCustomerId: "cus_1" });

    expect(await refused()).toMatch(/more than one billing account/);
  });

  it("records cleaned up after render: the click opens the now-unambiguous customer", async () => {
    givenRowsPerRead(
      [row("sub_1", "active", "cus_1"), row("sub_2", "active", "cus_2")],
      [row("sub_1", "active", "cus_1"), row("sub_2", "canceled", "cus_2")],
    );

    const rendered = await getSubscriptionOverview(USER.id);
    expect(rendered).toMatchObject({ customerResolution: { kind: "ambiguous" } });

    expect(await openedFor()).toBe("cus_1");
  });

  it("a cancellation after render keeps the portal available for the same customer", async () => {
    givenRowsPerRead(
      [row("sub_1", "active", "cus_1")],
      [row("sub_1", "canceled", "cus_1")],
    );

    await getSubscriptionOverview(USER.id);

    expect(await openedFor()).toBe("cus_1");
  });

  it("a session that expired between render and click goes to /login, reading nothing", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);
    await getSubscriptionOverview(USER.id);
    db.current.queries.length = 0;
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(createPortalSession()).rejects.toMatchObject({ url: "/login" });
    expect(db.current.queries).toHaveLength(0);
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });
});

describe("portal + reconciliation – other refusals stay distinct", () => {
  it("no rows: no billing account (not ambiguous)", async () => {
    givenRows([]);

    expect(await refused()).toMatch(/don't have a billing account/);
  });

  it("rows without any customer: no billing account", async () => {
    givenRows([row("sub_1", "canceled", null), row(null, null, null)]);

    expect(await refused()).toMatch(/don't have a billing account/);
  });

  it("unreadable rows: unknown state, not 'no account' and not 'ambiguous'", async () => {
    db.current = createFakeSupabase(() => ({
      ...OK_RESPONSE,
      data: null,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    }));

    const error = await refused();

    expect(error).toMatch(/couldn't load your billing information/);
    expect(error).not.toMatch(/billing account|more than one/);
  });

  it("reads the rows as the signed-in user only", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    await openedFor();

    expect(db.current.queries).toHaveLength(1);
    expect(db.current.argsOf(db.current.queries[0], "eq")).toEqual(["userId", USER.id]);
  });
});
