// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCsv } from "@/shared/test/csv";
import {
  stripeError,
  type StripeInvoiceFixture,
  stripeInvoiceList,
  type StripeInvoiceListParams,
  stripeList,
} from "@/shared/test/stripe-invoices";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";

// --- boundaries ---------------------------------------------------------------

type ListParams = StripeInvoiceListParams;

const stripe = vi.hoisted(() => ({
  invoicesList: vi.fn<(params: ListParams) => Promise<unknown>>(),
  getStripe: vi.fn(),
}));
vi.mock("@/infrastructure/stripe", () => ({ getStripe: stripe.getStripe }));

// The export allowance (database-backed in production): allowed unless a test says otherwise.
const limiter = vi.hoisted(() => ({
  consumeRateLimit:
    vi.fn<
      (
        userId: string,
        policy: import("@/infrastructure/rate-limit/consume-rate-limit").RateLimitPolicy,
      ) => Promise<
        import("@/infrastructure/rate-limit/consume-rate-limit").RateLimitDecision
      >
    >(),
}));
vi.mock("@/infrastructure/rate-limit/consume-rate-limit", () => limiter);

const billing = vi.hoisted(() => ({
  getSubscriptionOverview:
    vi.fn<
      (
        userId: string,
      ) => Promise<import("./get-subscription-overview").SubscriptionOverview>
    >(),
}));
vi.mock("./get-subscription-overview", () => billing);

import {
  collectInvoicesForExport,
  INVOICE_EXPORT_BATCH_SIZE,
  INVOICE_EXPORT_MAX_FETCHES,
  INVOICE_EXPORT_RATE_LIMIT,
  type InvoiceExportCollection,
  stripeCreatedRange,
} from "./collect-invoice-export";
import { buildInvoiceExportCsv } from "./invoice-export";
import { decodeInvoiceKey } from "./invoice-history";

// ------------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "cus_existing";
const OTHER_CUSTOMER = "cus_someoneElse";

type Overview = import("./get-subscription-overview").SubscriptionOverview;
type Resolution = import("./get-subscription-overview").CustomerResolution;

const overviewWith = (customerResolution: Resolution): Overview => ({
  ok: true,
  stripeCustomerId:
    customerResolution.kind === "single" ? customerResolution.stripeCustomerId : null,
  customerResolution,
  current: null,
  isServicing: false,
  subscriptions: [],
});

const single = (stripeCustomerId = CUSTOMER) =>
  overviewWith({ kind: "single", stripeCustomerId });

type StripeInvoice = StripeInvoiceFixture;

/**
 * `n` objects of `customer`, newest first, ids `in_<prefix><i>`; every index
 * for which `draftAt` holds is a draft (no number, as in Stripe).
 */
const invoices = (
  n: number,
  {
    prefix = "x",
    customer = CUSTOMER,
    draftAt = () => false,
  }: { prefix?: string; customer?: string; draftAt?: (i: number) => boolean } = {},
): StripeInvoice[] =>
  Array.from({ length: n }, (_, i) => {
    const id = `in_${prefix}${String(i).padStart(5, "0")}`;
    const draft = draftAt(i);
    return {
      id,
      object: "invoice",
      customer,
      created: 1_772_323_200 - i * 3_600,
      currency: "usd",
      total: 2900,
      number: draft ? null : `${prefix.toUpperCase()}-${String(i).padStart(5, "0")}`,
      status: draft ? "draft" : "paid",
      hosted_invoice_url: draft
        ? null
        : `https://invoice.stripe.com/i/acct_1/${id}_TOKEN`,
      invoice_pdf: draft ? null : `https://pay.stripe.com/invoice/acct_1/${id}_TOKEN/pdf`,
    };
  });

/** Routes the mocked `invoices.list` to the shared stand-in over `store`. */
function stripeHolding(
  store: StripeInvoice[],
  options: { ignoreCreated?: boolean } = {},
) {
  stripe.invoicesList.mockImplementation(stripeInvoiceList(store, options));
}

const idsOf = (result: InvoiceExportCollection) => {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.invoices.map((invoice) => decodeInvoiceKey(invoice.key));
};

const issuedIds = (store: StripeInvoice[]) =>
  store.filter((i) => i.status !== "draft").map((i) => i.id);

const requests = () => stripe.invoicesList.mock.calls.map(([params]) => params);

beforeEach(() => {
  vi.clearAllMocks();
  stripe.getStripe.mockReturnValue({ invoices: { list: stripe.invoicesList } });
  billing.getSubscriptionOverview.mockResolvedValue(single());
  limiter.consumeRateLimit.mockResolvedValue({ outcome: "allowed" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectInvoicesForExport – whose invoices", () => {
  it("reads the records once and asks Stripe about that one customer only", async () => {
    stripeHolding([
      ...invoices(150),
      ...invoices(40, { prefix: "o", customer: OTHER_CUSTOMER }),
    ]);

    const result = await collectInvoicesForExport(USER_ID);

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER_ID);
    expect(requests().every((params) => params.customer === CUSTOMER)).toBe(true);
    expect(idsOf(result)).toEqual(issuedIds(invoices(150)));
  });

  it("uses records the caller already read instead of reading them again", async () => {
    stripeHolding(invoices(3));

    await collectInvoicesForExport(USER_ID, { overview: single() });

    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
  });

  it.each<[string, Overview, InvoiceExportCollection]>([
    ["no billing account", overviewWith({ kind: "none" }), { kind: "none" }],
    [
      "an ambiguous customer",
      overviewWith({ kind: "ambiguous", reason: "multiple_customers", customers: 2 }),
      { kind: "ambiguous" },
    ],
    [
      "unreadable records",
      { ok: false, error: { message: "permission denied" } },
      { kind: "unavailable", reason: "records_unreadable" },
    ],
    [
      "a stored id that is not a Stripe customer id",
      single("not-a-customer"),
      { kind: "unavailable", reason: "invalid_customer_id" },
    ],
  ])(
    "with %s, exports nothing and never calls Stripe",
    async (_label, overview, expected) => {
      billing.getSubscriptionOverview.mockResolvedValue(overview);

      await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual(expected);
      expect(stripe.invoicesList).not.toHaveBeenCalled();
    },
  );

  it("refuses the whole export when a batch holds another customer's invoice", async () => {
    const store = invoices(250);
    store[230] = { ...store[230], customer: OTHER_CUSTOMER };
    // Serve the foreign invoice inside this customer's list, as a misbehaving API would.
    stripe.invoicesList.mockImplementation(async ({ limit, starting_after }) => {
      const start =
        starting_after === undefined
          ? 0
          : store.findIndex((i) => i.id === starting_after) + 1;
      const data = store.slice(start, start + limit);
      return stripeList(data, start + data.length < store.length);
    });

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[billing] Stripe returned an unusable invoice list",
      { userId: USER_ID, reason: "foreign_customer", fetch: 3 },
    );
  });
});

describe("collectInvoicesForExport – paging through everything", () => {
  it("asks for Stripe's maximum batch, continuing after each batch's last object", async () => {
    const store = invoices(250);
    stripeHolding(store);

    await collectInvoicesForExport(USER_ID);

    expect(INVOICE_EXPORT_BATCH_SIZE).toBe(100);
    expect(requests()).toEqual([
      { customer: CUSTOMER, limit: 100 },
      { customer: CUSTOMER, limit: 100, starting_after: store[99].id },
      { customer: CUSTOMER, limit: 100, starting_after: store[199].id },
    ]);
  });

  it("returns an empty history as ok with no invoices", async () => {
    stripeHolding([]);

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "ok",
      invoices: [],
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, 1],
    [99, 1],
    [100, 1], // exactly one batch: has_more is false
    [101, 2],
    [250, 3],
  ])("collects all %i invoices in %i requests, newest first", async (count, calls) => {
    const store = invoices(count);
    stripeHolding(store);

    expect(idsOf(await collectInvoicesForExport(USER_ID))).toEqual(issuedIds(store));
    expect(stripe.invoicesList).toHaveBeenCalledTimes(calls);
  });

  it("continues past batches holding only drafts (no invoices, more to come)", async () => {
    // 250 drafts first: the first two batches and half the third yield nothing.
    const store = invoices(400, { draftAt: (i) => i < 250 });
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID);

    expect(idsOf(result)).toEqual(issuedIds(store));
    expect(idsOf(result)).toHaveLength(150);
    expect(stripe.invoicesList).toHaveBeenCalledTimes(4);
  });

  it("continues after a batch whose last object is a draft", async () => {
    const store = invoices(150, { draftAt: (i) => i === 99 });
    stripeHolding(store);

    expect(idsOf(await collectInvoicesForExport(USER_ID))).toEqual(issuedIds(store));
    expect(requests()[1].starting_after).toBe(store[99].id);
  });

  it("exports nothing — but successfully — for a customer with only drafts", async () => {
    stripeHolding(invoices(215, { draftAt: () => true }));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "ok",
      invoices: [],
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(3);
  });

  it("collects a sandbox-sized history (2,500 issued, 300 drafts mixed in) completely", async () => {
    // Same shape as scripts/sandbox's `huge` customer: every 9th object from the 5th a draft.
    let drafts = 0;
    const store = invoices(2_800, {
      draftAt: (i) => i % 9 === 4 && drafts++ < 300,
    });
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID);

    expect(idsOf(result)).toHaveLength(2_500);
    expect(idsOf(result)).toEqual(issuedIds(store));
    expect(new Set(idsOf(result)).size).toBe(2_500);
    expect(stripe.invoicesList).toHaveBeenCalledTimes(28);
  });

  it("keeps invoices with a status this code does not know, as on the page", async () => {
    const store = invoices(3);
    store[1] = { ...store[1], status: "some_future_status" };
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID);

    expect(result.kind === "ok" && result.invoices.map((i) => i.status)).toEqual([
      "paid",
      "unknown",
      "paid",
    ]);
  });
});

describe("collectInvoicesForExport – all or nothing", () => {
  it("fails, with no invoices, when a later request fails", async () => {
    const store = invoices(250);
    stripeHolding(store);
    const holding = stripe.invoicesList.getMockImplementation()!;
    stripe.invoicesList.mockImplementation(async (params) => {
      if (stripe.invoicesList.mock.calls.length === 3) {
        throw stripeError({ type: "StripeRateLimitError", statusCode: 429 });
      }
      return holding(params);
    });

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
  });

  it("fails when Stripe no longer knows the object it was asked to continue after", async () => {
    // A draft at the end of batch 1 is deleted before batch 2 is requested.
    const store = invoices(150, { draftAt: (i) => i === 99 });
    stripeHolding(store);
    const holding = stripe.invoicesList.getMockImplementation()!;
    stripe.invoicesList.mockImplementation(async (params) => {
      const answer = await holding(params);
      if (params.starting_after === undefined) store.splice(99, 1);
      return answer;
    });

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "cursor_invalid",
    });
  });

  it("fails when Stripe does not know the customer", async () => {
    stripe.invoicesList.mockRejectedValue(
      stripeError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "customer",
        statusCode: 400,
      }),
    );

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "customer_missing",
    });
  });

  it("fails when Stripe cannot even be configured", async () => {
    stripe.getStripe.mockImplementation(() => {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    });

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
  });

  it("fails on an answer that is not a list of invoices", async () => {
    stripe.invoicesList.mockResolvedValue({ object: "list", data: "nope" });

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
  });

  it("fails when an empty batch claims there is more (it cannot be the end)", async () => {
    const store = invoices(100);
    stripe.invoicesList
      .mockResolvedValueOnce(stripeList(store, true))
      .mockResolvedValueOnce(stripeList([], true));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "inconsistent_paging",
    });
  });

  it("treats an empty batch that says it is the last as the end", async () => {
    stripe.invoicesList
      .mockResolvedValueOnce(stripeList(invoices(100), true))
      .mockResolvedValueOnce(stripeList([], false));

    expect(idsOf(await collectInvoicesForExport(USER_ID))).toHaveLength(100);
  });

  it("fails when Stripe ignores the cursor and serves the same batch again", async () => {
    const store = invoices(150);
    stripe.invoicesList.mockImplementation(async () =>
      stripeList(store.slice(0, 100), true),
    );

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "inconsistent_paging",
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(2);
  });

  it("fails when a batch of drafts repeats (nothing issued to compare, only the position)", async () => {
    const drafts = invoices(100, { draftAt: () => true });
    stripe.invoicesList.mockResolvedValue(stripeList(drafts, true));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "inconsistent_paging",
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(2);
  });

  it("fails when an invoice reappears in a later batch", async () => {
    const store = invoices(150);
    stripe.invoicesList
      .mockResolvedValueOnce(stripeList(store.slice(0, 100), true))
      .mockResolvedValueOnce(stripeList([store[42], ...store.slice(100)], false));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "inconsistent_paging",
    });
  });

  it("refuses a list longer than the request budget as a whole, and accepts one that just fits", async () => {
    stripeHolding(invoices(301));
    await expect(collectInvoicesForExport(USER_ID, { maxFetches: 3 })).resolves.toEqual({
      kind: "unavailable",
      reason: "too_large",
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(3);

    vi.mocked(stripe.invoicesList).mockClear();
    stripeHolding(invoices(300));
    expect(
      idsOf(await collectInvoicesForExport(USER_ID, { maxFetches: 3 })),
    ).toHaveLength(300);
  });

  it("has a default budget of 100 requests (10,000 objects)", () => {
    expect(INVOICE_EXPORT_MAX_FETCHES * INVOICE_EXPORT_BATCH_SIZE).toBe(10_000);
  });

  it("logs refusals without Stripe ids", async () => {
    stripe.invoicesList.mockResolvedValue(stripeList(invoices(100), true));

    await collectInvoicesForExport(USER_ID);

    expect(console.error).toHaveBeenCalledWith("[billing] invoice export refused", {
      userId: USER_ID,
      reason: "inconsistent_paging",
      fetch: 2,
    });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("in_");
    expect(logged).not.toContain(CUSTOMER);
  });
});

describe("collectInvoicesForExport → CSV", () => {
  it("writes one row per issued invoice, with no Stripe ids, keys or document URLs", async () => {
    const store = invoices(230, { draftAt: (i) => i % 10 === 0 });
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID);
    if (result.kind !== "ok") throw new Error("expected ok");

    const csv = buildInvoiceExportCsv(result.invoices);
    const [, ...rows] = parseCsv(csv.slice(CSV_UTF8_BOM.length));

    expect(rows).toHaveLength(207);
    expect(rows.map((row) => row[1])).toEqual(
      store.filter((i) => i.status !== "draft").map((i) => i.number),
    );
    for (const fragment of [
      "in_",
      CUSTOMER,
      "TOKEN",
      "stripe.com",
      result.invoices[0].key,
    ]) {
      expect(csv).not.toContain(fragment);
    }
  });
});

describe("stripeCreatedRange – what Stripe is asked for", () => {
  it("is whole seconds: midnight UTC of `from` through the last second before midnight after `to`", () => {
    expect(stripeCreatedRange({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      gte: Date.UTC(2026, 2, 1) / 1000,
      lte: Date.UTC(2026, 3, 1) / 1000 - 1,
    });
  });

  it.each([
    [{ from: "2026-03-01", to: "2026-03-01" }],
    [{ from: "2024-02-29", to: "2024-02-29" }],
    [{ from: "2026-12-31", to: "2027-01-01" }],
    [{ from: "2026-03-29", to: "2026-03-29" }], // a DST change in Europe
  ])("never sends a fraction of a second (%j)", (range) => {
    const created = stripeCreatedRange(range)!;

    expect(Number.isInteger(created.gte)).toBe(true);
    expect(Number.isInteger(created.lte)).toBe(true);
  });

  it("covers exactly 86,400 seconds for a one-day range", () => {
    const { gte, lte } = stripeCreatedRange({ from: "2026-03-15", to: "2026-03-15" })!;
    expect(lte! - gte! + 1).toBe(86_400);
  });

  it("sends only the bound that is set, and nothing for an open range", () => {
    expect(stripeCreatedRange({ from: "2026-03-01", to: null })).toEqual({
      gte: Date.UTC(2026, 2, 1) / 1000,
    });
    expect(stripeCreatedRange({ from: null, to: "2026-03-31" })).toEqual({
      lte: Date.UTC(2026, 3, 1) / 1000 - 1,
    });
    expect(stripeCreatedRange({ from: null, to: null })).toBeNull();
  });
});

describe("collectInvoicesForExport – date range", () => {
  const MARCH = { from: "2026-03-01", to: "2026-03-31" };
  const MARCH_START = Date.UTC(2026, 2, 1) / 1000;
  const APRIL_START = Date.UTC(2026, 3, 1) / 1000;

  /** One invoice per `created` second, newest first as given; drafts where `draftAt`. */
  const createdAt = (
    seconds: number[],
    draftAt: (i: number) => boolean = () => false,
  ): StripeInvoice[] =>
    invoices(seconds.length, { draftAt }).map((invoice, i) => ({
      ...invoice,
      created: seconds[i],
    }));

  /** `count` objects one hour apart, newest first, the newest at `newest` (seconds). */
  const hourlyBack = (
    newest: number,
    count: number,
    prefix: string,
    draftAt: (i: number) => boolean = () => false,
  ) =>
    invoices(count, { prefix, draftAt }).map((invoice, i) => ({
      ...invoice,
      created: newest - i * 3_600,
    }));

  it("asks Stripe for the range on every request, alongside the paging cursor", async () => {
    stripeHolding(hourlyBack(APRIL_START - 1, 250, "m"));

    await collectInvoicesForExport(USER_ID, { range: MARCH });

    expect(requests()).toHaveLength(3);
    for (const params of requests()) {
      expect(params.created).toEqual({ gte: MARCH_START, lte: APRIL_START - 1 });
      expect(params.customer).toBe(CUSTOMER);
    }
    expect(requests()[1].starting_after).toBeDefined();
  });

  it("sends no `created` filter without a range, or with an open one", async () => {
    stripeHolding(invoices(3));
    await collectInvoicesForExport(USER_ID);
    await collectInvoicesForExport(USER_ID, { range: { from: null, to: null } });

    expect(requests().every((params) => !("created" in params))).toBe(true);
  });

  it("includes the first and last second of the range and nothing either side", async () => {
    const store = createdAt([
      APRIL_START, // out: midnight after the last day
      APRIL_START - 1, // in: 31 Mar 23:59:59
      MARCH_START + 1,
      MARCH_START, // in: 1 Mar 00:00:00
      MARCH_START - 1, // out: 28 Feb 23:59:59
    ]);
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID, { range: MARCH });

    expect(idsOf(result)).toEqual([store[1].id, store[2].id, store[3].id]);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.invoices.map((i) => i.createdAt)).toEqual([
      "2026-03-31T23:59:59.000Z",
      "2026-03-01T00:00:01.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  it("collects every issued invoice in range across many batches, drafts mixed in, whatever lies either side", async () => {
    const store = [
      ...hourlyBack(APRIL_START + 200 * 3_600, 200, "after"),
      ...hourlyBack(APRIL_START - 1, 700, "mar", (i) => i % 7 === 3),
      ...hourlyBack(MARCH_START - 1, 150, "before"),
    ];
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID, { range: MARCH });

    const expected = store.filter(
      (i) => i.status !== "draft" && i.created >= MARCH_START && i.created < APRIL_START,
    );
    expect(idsOf(result)).toEqual(expected.map((i) => i.id));
    expect(idsOf(result)).toHaveLength(600);
    // Only March's 700 objects are paged through: 7 requests, not 11.
    expect(stripe.invoicesList).toHaveBeenCalledTimes(7);
  });

  it("continues past batches in the range that hold only drafts", async () => {
    const store = hourlyBack(APRIL_START - 1, 350, "m", (i) => i < 250);
    stripeHolding(store);

    const result = await collectInvoicesForExport(USER_ID, { range: MARCH });

    expect(idsOf(result)).toHaveLength(100);
    expect(idsOf(result)).toEqual(issuedIds(store));
  });

  it("returns a range that matches nothing as an empty, successful export", async () => {
    stripeHolding(hourlyBack(MARCH_START - 1, 300, "feb"));

    await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
      kind: "ok",
      invoices: [],
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
  });

  it("still never asks about another customer, range or not", async () => {
    stripeHolding([
      ...hourlyBack(APRIL_START - 1, 120, "m"),
      ...hourlyBack(APRIL_START - 1, 120, "o").map((i) => ({
        ...i,
        customer: OTHER_CUSTOMER,
      })),
    ]);

    const result = await collectInvoicesForExport(USER_ID, { range: MARCH });

    expect(idsOf(result)).toHaveLength(120);
    expect(idsOf(result).every((id) => id!.startsWith("in_m"))).toBe(true);
    expect(requests().every((params) => params.customer === CUSTOMER)).toBe(true);
  });

  it("returns `none` and `ambiguous` as before, without calling Stripe", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(overviewWith({ kind: "none" }));
    await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
      kind: "none",
    });

    billing.getSubscriptionOverview.mockResolvedValue(
      overviewWith({ kind: "ambiguous", reason: "multiple_customers", customers: 2 }),
    );
    await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
      kind: "ambiguous",
    });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  describe("when Stripe returns invoices outside the range anyway", () => {
    it("leaves them out but keeps paging — batches holding only such invoices do not end the export", async () => {
      const store = [
        ...hourlyBack(APRIL_START + 300 * 3_600, 250, "after"),
        ...hourlyBack(APRIL_START - 1, 40, "mar"),
      ];
      stripeHolding(store, { ignoreCreated: true });

      const result = await collectInvoicesForExport(USER_ID, { range: MARCH });

      expect(idsOf(result)).toEqual(store.slice(250).map((i) => i.id));
      expect(stripe.invoicesList).toHaveBeenCalledTimes(3);
      expect(console.warn).toHaveBeenCalledWith(
        "[billing] invoice export left out invoices outside the range",
        { userId: USER_ID, outOfRange: 250 },
      );
    });

    it("still counts their requests against the budget", async () => {
      stripeHolding(
        [
          ...hourlyBack(APRIL_START + 400 * 3_600, 350, "after"),
          ...hourlyBack(APRIL_START - 1, 5, "mar"),
        ],
        { ignoreCreated: true },
      );

      await expect(
        collectInvoicesForExport(USER_ID, { range: MARCH, maxFetches: 3 }),
      ).resolves.toEqual({ kind: "unavailable", reason: "too_large" });
    });
  });

  describe("failures still fail the whole export", () => {
    it("a later request that fails", async () => {
      stripeHolding(hourlyBack(APRIL_START - 1, 250, "m"));
      const holding = stripe.invoicesList.getMockImplementation()!;
      stripe.invoicesList.mockImplementation(async (params) => {
        if (stripe.invoicesList.mock.calls.length === 2) {
          throw stripeError({ type: "StripeAPIError", statusCode: 500 });
        }
        return holding(params);
      });

      await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
        kind: "unavailable",
        reason: "stripe_error",
      });
    });

    it("an empty batch that claims more", async () => {
      stripe.invoicesList
        .mockResolvedValueOnce(stripeList(hourlyBack(APRIL_START - 1, 100, "m"), true))
        .mockResolvedValueOnce(stripeList([], true));

      await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
        kind: "unavailable",
        reason: "inconsistent_paging",
      });
    });

    it("a batch that repeats", async () => {
      const batch = hourlyBack(APRIL_START - 1, 100, "m");
      stripe.invoicesList.mockResolvedValue(stripeList(batch, true));

      await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
        kind: "unavailable",
        reason: "inconsistent_paging",
      });
    });

    it("another customer's invoice in a batch, even one outside the range", async () => {
      const store = hourlyBack(APRIL_START + 10 * 3_600, 150, "m");
      store[3] = { ...store[3], customer: OTHER_CUSTOMER }; // created in April: out of range
      stripe.invoicesList.mockResolvedValue(stripeList(store.slice(0, 100), false));

      await expect(collectInvoicesForExport(USER_ID, { range: MARCH })).resolves.toEqual({
        kind: "unavailable",
        reason: "unusable_response",
      });
    });

    it("more in-range objects than the budget allows", async () => {
      stripeHolding(hourlyBack(APRIL_START - 1, 301, "m"));

      await expect(
        collectInvoicesForExport(USER_ID, { range: MARCH, maxFetches: 3 }),
      ).resolves.toEqual({ kind: "unavailable", reason: "too_large" });
    });
  });

  describe("an invalid range is refused before the records or Stripe are consulted", () => {
    it.each([
      ["swapped ends", { from: "2026-03-31", to: "2026-03-01" }],
      ["a day that does not exist", { from: null, to: "2026-02-29" }],
      ["a timestamp instead of a day", { from: "2026-03-01T00:00:00Z", to: null }],
      ["a year out of bounds", { from: "1970-01-01", to: null }],
      ["a missing field", { to: "2026-03-31" }],
      ["Unix seconds", { from: 1772323200, to: null }],
      ["not an object", null],
    ])("%s", async (_label, range) => {
      await expect(
        collectInvoicesForExport(USER_ID, {
          range: range as unknown as { from: string | null; to: string | null },
        }),
      ).resolves.toEqual({ kind: "invalid_range" });
      expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
      expect(stripe.invoicesList).not.toHaveBeenCalled();
    });
  });

  it("end to end: the CSV holds exactly the in-range invoices, dated inside the range", async () => {
    stripeHolding([
      ...hourlyBack(APRIL_START + 50 * 3_600, 50, "after"),
      ...hourlyBack(APRIL_START - 1, 130, "mar", (i) => i % 10 === 0),
      ...hourlyBack(MARCH_START - 1, 50, "before"),
    ]);

    const result = await collectInvoicesForExport(USER_ID, { range: MARCH });
    if (result.kind !== "ok") throw new Error("expected ok");

    const [, ...rows] = parseCsv(buildInvoiceExportCsv(result.invoices).slice(1));

    expect(rows).toHaveLength(117);
    expect(rows.every(([date]) => date >= "2026-03-01" && date <= "2026-03-31")).toBe(
      true,
    );
    expect(rows[0][0]).toBe("2026-03-31");
  });
});

describe("collectInvoicesForExport – rate limit", () => {
  it("allows five exports at once, then one a minute, per user", () => {
    expect(INVOICE_EXPORT_RATE_LIMIT).toEqual({
      bucket: "export.invoices",
      burst: 5,
      intervalSeconds: 60,
    });
  });

  it("takes one request from the user's allowance once the customer is known, before Stripe is asked", async () => {
    stripeHolding(invoices(250));

    await collectInvoicesForExport(USER_ID);

    expect(limiter.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(limiter.consumeRateLimit).toHaveBeenCalledWith(
      USER_ID,
      INVOICE_EXPORT_RATE_LIMIT,
    );
    const [consumed] = limiter.consumeRateLimit.mock.invocationCallOrder;
    const [resolved] = billing.getSubscriptionOverview.mock.invocationCallOrder;
    const [firstStripe] = stripe.invoicesList.mock.invocationCallOrder;
    expect(resolved).toBeLessThan(consumed);
    expect(consumed).toBeLessThan(firstStripe);
    // One export is one request from the allowance, however many pages it reads.
    expect(stripe.invoicesList).toHaveBeenCalledTimes(3);
  });

  it("answers rate_limited with the wait, and never asks Stripe, when the allowance is used up", async () => {
    limiter.consumeRateLimit.mockResolvedValue({
      outcome: "limited",
      retryAfterSeconds: 42,
    });
    stripeHolding(invoices(3));

    await expect(
      collectInvoicesForExport(USER_ID, { range: { from: "2026-03-01", to: null } }),
    ).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 42,
    });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[billing] invoice export rate limited", {
      userId: USER_ID,
      retryAfterSeconds: 42,
    });
  });

  it("refuses the export, without asking Stripe, when the allowance cannot be checked", async () => {
    limiter.consumeRateLimit.mockResolvedValue({ outcome: "unavailable" });
    stripeHolding(invoices(3));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "rate_limit_unavailable",
    });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, Parameters<typeof collectInvoicesForExport>[1]]>([
    ["an invalid range", () => {}, { range: { from: "2026-03-31", to: "2026-03-01" } }],
    [
      "no billing account",
      () =>
        billing.getSubscriptionOverview.mockResolvedValue(overviewWith({ kind: "none" })),
      {},
    ],
    [
      "an ambiguous account",
      () =>
        billing.getSubscriptionOverview.mockResolvedValue(
          overviewWith({ kind: "ambiguous", reason: "multiple_customers", customers: 2 }),
        ),
      {},
    ],
    [
      "unreadable records",
      () =>
        billing.getSubscriptionOverview.mockResolvedValue({
          ok: false,
          error: { message: "x" },
        }),
      {},
    ],
    [
      "an invalid customer id",
      () => billing.getSubscriptionOverview.mockResolvedValue(single("nope")),
      {},
    ],
  ])(
    "does not count an export that never reaches Stripe (%s)",
    async (_label, arrange, options) => {
      arrange();

      await collectInvoicesForExport(USER_ID, options);

      expect(limiter.consumeRateLimit).not.toHaveBeenCalled();
      expect(stripe.invoicesList).not.toHaveBeenCalled();
    },
  );

  it("still counts an export whose Stripe requests then fail (Stripe was asked)", async () => {
    stripe.invoicesList.mockRejectedValue(stripeError({ type: "StripeAPIError" }));

    await expect(collectInvoicesForExport(USER_ID)).resolves.toMatchObject({
      kind: "unavailable",
    });
    expect(limiter.consumeRateLimit).toHaveBeenCalledTimes(1);
  });
});
