// @vitest-environment node
/**
 * End-to-end through the real reconciliation: rows in the database → real
 * `getSubscriptionOverview` → real `getInvoiceHistory`, next to the real
 * `createPortalSession` on the same rows. Only the boundaries are substituted
 * (database client, session, Stripe, `redirect`). The unit tests mock the
 * overview; this file proves that the invoice list and the portal agree on
 * which customer is the user's — and that whenever the portal refuses to open,
 * no customer's invoices are listed either.
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
  invoicesList:
    vi.fn<(params: { customer: string; limit: number }) => Promise<unknown>>(),
  portalCreate:
    vi.fn<(params: { customer: string; return_url: string }) => Promise<unknown>>(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({
    invoices: { list: stripe.invoicesList },
    billingPortal: { sessions: { create: stripe.portalCreate } },
  }),
}));

vi.mock("@/config/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  },
}));

const db = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<
    typeof import("@/shared/test/supabase").createFakeSupabase
  >,
}));
vi.mock("@/infrastructure/auth/supabase/server", () => ({
  createClient: vi.fn(async () => db.current.client),
}));

import { createPortalSession } from "../actions/create-portal-session";

import { getInvoiceHistory } from "./get-invoice-history";
import { getSubscriptionOverview } from "./get-subscription-overview";
import { encodeInvoiceKey } from "./invoice-history";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };

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

function givenUnreadableRows() {
  db.current = createFakeSupabase(() => ({
    ...OK_RESPONSE,
    status: 401,
    data: null,
    error: { message: "permission denied for table subscriptions", code: "42501" },
  }));
}

/** Stripe's answer: one paid invoice for whichever customer was asked about. */
const invoiceFor = (customer: string) => ({
  object: "list",
  has_more: false,
  data: [
    {
      id: `in_${customer.replace(/_/g, "")}`,
      object: "invoice",
      customer,
      created: 1_772_323_200,
      currency: "usd",
      total: 2900,
      number: `${customer.toUpperCase()}-0001`,
      status: "paid",
    },
  ],
});

/** Runs the invoice list and returns the customer it asked Stripe about, or null. */
const listedFor = async () => {
  const history = await getInvoiceHistory(USER.id);

  if (stripe.invoicesList.mock.calls.length === 0) return { history, customer: null };

  expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
  return { history, customer: stripe.invoicesList.mock.calls[0][0].customer };
};

/** Runs the portal action and returns the customer it opened, or null if refused. */
const openedFor = async () => {
  try {
    await createPortalSession();
  } catch (error) {
    if (!(error instanceof RedirectSignal)) throw error;
    return stripe.portalCreate.mock.calls[0][0].customer;
  }

  expect(stripe.portalCreate).not.toHaveBeenCalled();
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  stripe.invoicesList.mockImplementation(async ({ customer }) => invoiceFor(customer));
  stripe.portalCreate.mockImplementation(async ({ customer }) => ({
    id: "bps_1",
    object: "billing_portal.session",
    customer,
    url: "https://billing.stripe.com/p/session/test_abc",
  }));
});

describe("invoices + reconciliation – the records point at one customer", () => {
  it("one subscription, one customer: lists that customer's invoices", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    const { history, customer } = await listedFor();

    expect(customer).toBe("cus_1");
    expect(history).toEqual({
      kind: "ok",
      nextCursor: null,
      examined: 1,
      invoices: [
        {
          key: encodeInvoiceKey("in_cus1"),
          number: "CUS_1-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: false, pdf: false },
        },
      ],
    });
  });

  it("live subscription plus ended ones on other customers: lists the live one's", async () => {
    givenRows([
      row("sub_old", "canceled", "cus_old"),
      row("sub_live", "active", "cus_live"),
      row("sub_x", "incomplete_expired", "cus_x"),
    ]);

    expect((await listedFor()).customer).toBe("cus_live");
  });

  it("only ended subscriptions, one customer: still lists its invoices (history stays relevant)", async () => {
    givenRows([row("sub_a", "canceled", "cus_1"), row("sub_b", "incomplete", null)]);

    expect((await listedFor()).customer).toBe("cus_1");
  });

  it("duplicate or status-conflicting rows for one subscription, one customer: lists it", async () => {
    for (const rows of [
      [row("sub_1", "active", "cus_1"), row("sub_1", "active", "cus_1")],
      [row("sub_1", "active", "cus_1"), row("sub_1", "past_due", "cus_1")],
      [row("sub_1", "active", "cus_1"), row("sub_1", "canceled", "cus_1")],
    ]) {
      vi.clearAllMocks();
      givenRows(rows);

      expect((await listedFor()).customer).toBe("cus_1");
    }
  });
});

describe("invoices + reconciliation – no customer", () => {
  it("no rows at all: nothing to list, Stripe is not asked", async () => {
    givenRows([]);

    const { history, customer } = await listedFor();

    expect(customer).toBeNull();
    expect(history).toEqual({ kind: "none" });
  });

  it("rows that never reached Stripe (no customer id anywhere): nothing to list", async () => {
    givenRows([row("sub_1", "incomplete", null), row(null, null, null)]);

    expect(await listedFor()).toEqual({ history: { kind: "none" }, customer: null });
  });

  it("records unreadable: unavailable, never 'none', and Stripe is not asked", async () => {
    givenUnreadableRows();

    expect(await listedFor()).toEqual({
      history: { kind: "unavailable", reason: "records_unreadable" },
      customer: null,
    });
  });
});

describe("invoices + reconciliation – fails closed when the customer is ambiguous", () => {
  it.each([
    [
      "two live subscriptions on different customers",
      [row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")],
    ],
    [
      "two live subscriptions on different customers, other row order",
      [row("sub_b", "active", "cus_B"), row("sub_a", "active", "cus_A")],
    ],
    [
      "a live subscription without a customer next to an ended one with a customer",
      [row("sub_old", "canceled", "cus_old"), row("sub_new", "active", null)],
    ],
    [
      "one subscription id naming two customers, even with a clean live one",
      [
        row("sub_1", "canceled", "cus_A"),
        row("sub_1", "canceled", "cus_B"),
        row("sub_2", "active", "cus_A"),
      ],
    ],
    [
      "only ended subscriptions on several customers",
      [row("sub_a", "canceled", "cus_A"), row("sub_b", "canceled", "cus_B")],
    ],
    [
      "a live legacy row without a subscription id or customer next to a good row",
      [row("sub_1", "active", "cus_1"), row(null, "active", null)],
    ],
    [
      "a live subscription on one customer and a past-due one on another",
      [row("sub_a", "active", "cus_A"), row("sub_b", "past_due", "cus_B")],
    ],
  ])("%s: lists nothing and asks Stripe about no one", async (_name, rows) => {
    givenRows(rows);

    expect(await listedFor()).toEqual({ history: { kind: "ambiguous" }, customer: null });
  });

  it("logs counts only — no customer or subscription ids", async () => {
    givenRows([row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")]);

    await listedFor();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/customer is ambiguous; invoices not listed/),
      { userId: USER.id, reason: "multiple_customers", customers: 2, subscriptions: 2 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/cus_|sub_/);
  });

  it("refuses a stored customer id that is not a Stripe customer id, like the portal", async () => {
    givenRows([row("sub_1", "active", "not a customer id")]);

    expect(await listedFor()).toEqual({
      history: { kind: "unavailable", reason: "invalid_customer_id" },
      customer: null,
    });
    expect(await openedFor()).toBeNull();
  });
});

describe("invoices + reconciliation – later pages", () => {
  it("re-resolves the customer for a later page and pages inside that customer's list only", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    const history = await getInvoiceHistory(USER.id, { startingAfter: "in_cus1" });

    expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
    expect(stripe.invoicesList.mock.calls[0][0]).toMatchObject({
      customer: "cus_1",
      starting_after: "in_cus1",
    });
    expect(history).toMatchObject({ kind: "ok" });
  });

  it("refuses a later page the moment the records become ambiguous, cursor or not", async () => {
    givenRows([row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")]);

    await expect(
      getInvoiceHistory(USER.id, { startingAfter: "in_cusA" }),
    ).resolves.toEqual({ kind: "ambiguous" });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("invoices + reconciliation – filters change nothing about ownership", () => {
  const filters = {
    status: "paid" as const,
    from: "2026-01-01",
    to: "2026-12-31",
    number: "1",
  };

  it("a filtered listing is still the resolved customer's list, with the filters forwarded", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    const history = await getInvoiceHistory(USER.id, { filters });

    expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
    expect(stripe.invoicesList.mock.calls[0][0]).toMatchObject({
      customer: "cus_1",
      status: "paid",
      created: { gte: expect.any(Number), lte: expect.any(Number) },
    });
    expect(history).toMatchObject({ kind: "ok" });
  });

  it("refuses a filtered answer that contains another customer's invoice, keeping none of it", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);
    stripe.invoicesList.mockImplementation(async () => ({
      object: "list",
      has_more: false,
      data: [
        invoiceFor("cus_1").data[0],
        { ...invoiceFor("cus_2").data[0], id: "in_foreign" },
      ],
    }));

    await expect(getInvoiceHistory(USER.id, { filters })).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
  });

  it("refuses to list anything for an ambiguous or missing customer, filters or not", async () => {
    givenRows([row("sub_a", "active", "cus_A"), row("sub_b", "active", "cus_B")]);
    await expect(getInvoiceHistory(USER.id, { filters })).resolves.toEqual({
      kind: "ambiguous",
    });

    givenRows([]);
    await expect(getInvoiceHistory(USER.id, { filters })).resolves.toEqual({
      kind: "none",
    });

    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("invoices + reconciliation – the invoice list and the portal agree", () => {
  it("the page hands the same read of the records to both, so they cannot diverge", async () => {
    givenRows([row("sub_1", "active", "cus_1")]);

    const overview = await getSubscriptionOverview(USER.id);
    const history = await getInvoiceHistory(USER.id, { overview });

    expect(db.current.queries).toHaveLength(1); // one read, not one per card
    expect(history).toMatchObject({ kind: "ok" });
    expect(stripe.invoicesList.mock.calls[0][0].customer).toBe(
      overview.ok ? overview.stripeCustomerId : null,
    );
  });

  it("across many row shapes: invoices are listed for exactly the customer the portal opens, or for none", async () => {
    const ids = ["sub_a", "sub_b", null];
    const statuses = ["active", "past_due", "canceled", "incomplete", null];
    const customers = ["cus_1", "cus_2", null];
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];

    let agreedOnACustomer = 0;
    let agreedOnRefusal = 0;

    for (let i = 0; i < 150; i++) {
      vi.clearAllMocks();
      const rows = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
        row(pick(ids), pick(statuses), pick(customers)),
      );
      givenRows(rows);

      const opened = await openedFor();
      const { history, customer: listed } = await listedFor();
      const shape = JSON.stringify(rows);

      expect(listed, shape).toBe(opened);

      if (opened === null) {
        expect(history.kind, shape).not.toBe("ok");
        agreedOnRefusal++;
      } else {
        expect(history, shape).toMatchObject({ kind: "ok" });
        agreedOnACustomer++;
      }
    }

    // The generator must have exercised both outcomes, or the test proves little.
    expect(agreedOnACustomer).toBeGreaterThan(10);
    expect(agreedOnRefusal).toBeGreaterThan(10);
  });
});
