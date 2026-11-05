// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

type ListParams = {
  customer: string;
  limit: number;
  starting_after?: string;
  status?: string;
  created?: { gte?: number; lte?: number };
};

const stripe = vi.hoisted(() => ({
  invoicesList: vi.fn<(params: ListParams) => Promise<unknown>>(),
  portalCreate: vi.fn(),
  checkoutCreate: vi.fn(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({
    invoices: { list: stripe.invoicesList },
    billingPortal: { sessions: { create: stripe.portalCreate } },
    checkout: { sessions: { create: stripe.checkoutCreate } },
  }),
}));

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
  clampPageSize,
  getInvoiceHistory,
  type InvoiceHistory,
} from "./get-invoice-history";
import { decodeInvoiceCursor, encodeInvoiceCursor } from "./invoice-cursor";
import { EMPTY_INVOICE_FILTERS, type InvoiceFilters } from "./invoice-filters";
import {
  decodeInvoiceKey,
  encodeInvoiceKey,
  INVOICE_FETCH_BATCH_SIZE,
  INVOICE_HISTORY_PAGE_SIZE,
  INVOICE_MAX_FETCHES_PER_PAGE,
  INVOICE_SEARCH_BATCH_SIZE,
  INVOICE_SEARCH_MAX_FETCHES_PER_PAGE,
  type InvoiceSummary,
} from "./invoice-history";

// ------------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "cus_existing";

type Overview = import("./get-subscription-overview").SubscriptionOverview;
type OkOverview = Extract<Overview, { ok: true }>;
type Consolidated = import("./get-subscription-overview").ConsolidatedSubscription;

const consolidated = (
  stripeSubscriptionId: string,
  stripeCustomerId: string | null,
  status: string,
): Consolidated => ({
  stripeSubscriptionId,
  stripeCustomerId,
  status,
  rowCount: 1,
  statusConflict: false,
  customerConflict: false,
  isServicing: status === "active" || status === "past_due",
});

/** An overview whose records point at exactly one customer (or none). */
const withCustomer = (stripeCustomerId: string | null, status = "active"): OkOverview => {
  const current = consolidated("sub_1", stripeCustomerId, status);

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

type AmbiguousReason = Extract<
  import("./get-subscription-overview").CustomerResolution,
  { kind: "ambiguous" }
>["reason"];

const ambiguous = (reason: AmbiguousReason): OkOverview => {
  const a = consolidated("sub_a", "cus_A", "active");
  const b = consolidated("sub_b", "cus_B", "active");

  return {
    ok: true,
    stripeCustomerId: null,
    customerResolution: { kind: "ambiguous", reason, customers: 2 },
    current: a,
    isServicing: true,
    subscriptions: [a, b],
  };
};

/** A Stripe invoice as the list endpoint returns it (the fields we read). */
const stripeInvoice = (
  id: string,
  overrides: Record<string, unknown> = {},
  customer = CUSTOMER,
) => ({
  id,
  object: "invoice",
  customer,
  created: 1_772_323_200,
  currency: "usd",
  total: 2900,
  number: id.toUpperCase(),
  status: "paid",
  ...overrides,
});

const stripeList = (data: unknown[], has_more = false) => ({
  object: "list",
  url: "/v1/invoices",
  has_more,
  data,
});

/**
 * A stand-in for `GET /v1/invoices`: honours `limit` and `starting_after` over
 * a fixed, newest-first dataset, exactly as Stripe's cursor paging does.
 */
function stripeHolding(dataset: ReturnType<typeof stripeInvoice>[]) {
  stripe.invoicesList.mockImplementation(
    async ({ limit, starting_after, status, created }) => {
      // Stripe applies the filters first, then pages through what is left.
      const filtered = dataset.filter(
        (invoice) =>
          (status === undefined || invoice.status === status) &&
          (created?.gte === undefined || invoice.created >= created.gte) &&
          (created?.lte === undefined || invoice.created <= created.lte),
      );
      const start =
        starting_after === undefined
          ? 0
          : filtered.findIndex((invoice) => invoice.id === starting_after) + 1;

      if (start === 0 && starting_after !== undefined) {
        throw stripeError({
          name: "StripeInvalidRequestError",
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          param: "starting_after",
          statusCode: 400,
          message: `No such invoice: '${starting_after}'`,
        });
      }

      const data = filtered.slice(start, start + limit);

      return stripeList(data, start + data.length < filtered.length);
    },
  );
}

/** `n` invoices `in_<prefix><i>`, newest first; `draftAt` marks which indexes are drafts. */
const invoicesNamed = (
  n: number,
  prefix: string,
  draftAt: (i: number) => boolean = () => false,
) =>
  Array.from({ length: n }, (_, i) =>
    stripeInvoice(`in_${prefix}${String(i).padStart(3, "0")}`, {
      created: 1_772_323_200 - i * 86_400,
      status: draftAt(i) ? "draft" : "paid",
    }),
  );

/** Shape of a stripe-node error, without constructing the SDK. */
const stripeError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? "stripe error")), fields);

const idsOf = (history: InvoiceHistory) =>
  history.kind === "ok" ? history.invoices.map((i) => decodeInvoiceKey(i.key)) : history;

/** The cursor a page would hand out for "after this id". */
const cursorAfter = (afterId: string, filters: InvoiceFilters = EMPTY_INVOICE_FILTERS) =>
  encodeInvoiceCursor({ afterId, filters });

const numbersOf = (invoices: InvoiceSummary[]) => invoices.map((i) => i.number);

/** Walks every page from the top, as the UI would (decoding each cursor like the action does), and returns them. */
async function walkPages(max = 50, filters: InvoiceFilters = EMPTY_INVOICE_FILTERS) {
  const pages: Extract<InvoiceHistory, { kind: "ok" }>[] = [];
  let cursor: string | null = null;

  for (let i = 0; i < max; i++) {
    const decoded = cursor === null ? null : decodeInvoiceCursor(cursor);
    if (cursor !== null && decoded === null) throw new Error(`page ${i}: bad cursor`);

    const page = await getInvoiceHistory(USER_ID, {
      filters: decoded?.filters ?? filters,
      ...(decoded !== null && { startingAfter: decoded.afterId }),
    });

    if (page.kind !== "ok") throw new Error(`page ${i} was ${JSON.stringify(page)}`);

    pages.push(page);
    cursor = page.nextCursor;

    if (cursor === null) break;
  }

  return pages;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  billing.getSubscriptionOverview.mockResolvedValue(withCustomer(CUSTOMER));
  stripeHolding([stripeInvoice("in_1")]);
});

describe("getInvoiceHistory – the records point at one customer", () => {
  it("lists that customer's invoices, newest first, asking Stripe for one batch", async () => {
    stripeHolding([
      stripeInvoice("in_2", { created: 1_775_001_600, number: "ABCD-0002" }),
      stripeInvoice("in_1", { created: 1_772_323_200, number: "ABCD-0001" }),
    ]);

    const history = await getInvoiceHistory(USER_ID);

    expect(stripe.invoicesList).toHaveBeenCalledTimes(1);
    expect(stripe.invoicesList).toHaveBeenCalledWith({
      customer: CUSTOMER,
      limit: INVOICE_FETCH_BATCH_SIZE,
    });
    expect(history).toEqual({
      kind: "ok",
      nextCursor: null,
      examined: 2,
      invoices: [
        {
          key: encodeInvoiceKey("in_2"),
          number: "ABCD-0002",
          createdAt: "2026-04-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: false, pdf: false },
        },
        {
          key: encodeInvoiceKey("in_1"),
          number: "ABCD-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: false, pdf: false },
        },
      ],
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports an empty list as ok with no invoices and no next page (not as unavailable)", async () => {
    stripeHolding([]);

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "ok",
      invoices: [],
      nextCursor: null,
      examined: 0,
    });
  });

  it("resolves the customer from the user's own rows when no overview is given", async () => {
    await getInvoiceHistory(USER_ID);

    expect(billing.getSubscriptionOverview).toHaveBeenCalledTimes(1);
    expect(billing.getSubscriptionOverview).toHaveBeenCalledWith(USER_ID);
  });

  it("uses the overview it is handed instead of reading the rows again", async () => {
    stripeHolding([stripeInvoice("in_1", {}, "cus_given")]);

    const history = await getInvoiceHistory(USER_ID, {
      overview: withCustomer("cus_given"),
    });

    expect(billing.getSubscriptionOverview).not.toHaveBeenCalled();
    expect(stripe.invoicesList.mock.calls[0][0]).toMatchObject({ customer: "cus_given" });
    expect(history).toMatchObject({ kind: "ok" });
  });

  it("lists invoices even when the only subscription is canceled (past invoices stay relevant)", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(
      withCustomer("cus_old", "canceled"),
    );
    stripeHolding([stripeInvoice("in_1", {}, "cus_old")]);

    await expect(getInvoiceHistory(USER_ID)).resolves.toMatchObject({ kind: "ok" });
    expect(stripe.invoicesList.mock.calls[0][0]).toMatchObject({ customer: "cus_old" });
  });

  it("never touches Checkout or the portal", async () => {
    await getInvoiceHistory(USER_ID);

    expect(stripe.checkoutCreate).not.toHaveBeenCalled();
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it("carries no Stripe identifiers into the result (keys and cursors are opaque)", async () => {
    stripeHolding(invoicesNamed(INVOICE_HISTORY_PAGE_SIZE + 1, "x"));

    const history = await getInvoiceHistory(USER_ID);

    expect(history).toMatchObject({ kind: "ok", nextCursor: expect.any(String) });
    expect(JSON.stringify(history)).not.toMatch(/cus_|in_|sub_1/);
  });
});

describe("getInvoiceHistory – documents", () => {
  const HOSTED = "https://invoice.stripe.com/i/acct_1/test_abc?s=ap";
  const PDF = "https://pay.stripe.com/invoice/acct_1/test_abc/pdf?s=ap";

  it("marks the documents Stripe provides, keeping the URLs out of the result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stripeHolding([
      stripeInvoice("in_2", { hosted_invoice_url: HOSTED, invoice_pdf: PDF }),
      stripeInvoice("in_1", { hosted_invoice_url: HOSTED, invoice_pdf: null }),
    ]);

    const history = await getInvoiceHistory(USER_ID);

    expect(history.kind === "ok" && history.invoices.map((i) => i.documents)).toEqual([
      { view: true, pdf: true },
      { view: true, pdf: false },
    ]);
    expect(JSON.stringify(history)).not.toMatch(/stripe\.com|acct_/);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("treats a URL it will not follow as no document and warns with a count, never the URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stripeHolding([
      stripeInvoice("in_1", {
        hosted_invoice_url: "https://evil.example/i/x",
        invoice_pdf: "http://pay.stripe.com/x/pdf",
      }),
    ]);

    const history = await getInvoiceHistory(USER_ID);

    expect(history).toMatchObject({ kind: "ok" });
    expect(history.kind === "ok" && history.invoices[0].documents).toEqual({
      view: false,
      pdf: false,
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/not usable/), {
      userId: USER_ID,
      rejected: 2,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(
      /evil|pay\.stripe/,
    );
  });

  it("honours STRIPE_INVOICE_DOCUMENT_HOSTS for a custom invoice domain", async () => {
    vi.stubEnv("STRIPE_INVOICE_DOCUMENT_HOSTS", " invoices.example.com ,, 127.0.0.1 ");
    stripeHolding([
      stripeInvoice("in_1", {
        hosted_invoice_url: "https://invoices.example.com/i/x",
        invoice_pdf: "http://127.0.0.1:4242/invoice/x/pdf",
      }),
    ]);

    try {
      const history = await getInvoiceHistory(USER_ID);

      expect(history.kind === "ok" && history.invoices[0].documents).toEqual({
        view: true,
        pdf: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("getInvoiceHistory – drafts never hide issued invoices", () => {
  // Regression: the first version asked for 10 objects and dropped the drafts
  // among them, so 10 drafts at the top meant an (incorrectly) empty history,
  // and fewer drafts silently shortened the page while older invoices stayed
  // hidden behind "has more".

  it("finds the issued invoices behind a run of drafts longer than a page", async () => {
    const drafts = INVOICE_HISTORY_PAGE_SIZE + 5;
    stripeHolding([...invoicesNamed(drafts, "d", () => true), ...invoicesNamed(3, "p")]);

    const history = await getInvoiceHistory(USER_ID);

    expect(idsOf(history)).toEqual(["in_p000", "in_p001", "in_p002"]);
    expect(history).toMatchObject({ nextCursor: null });
  });

  it("fills a whole page with issued invoices although drafts are interleaved", async () => {
    // Every other object is a draft: 40 objects hold 20 issued invoices.
    stripeHolding(invoicesNamed(40, "m", (i) => i % 2 === 1));

    const history = await getInvoiceHistory(USER_ID);

    expect(history.kind === "ok" && history.invoices).toHaveLength(
      INVOICE_HISTORY_PAGE_SIZE,
    );
    expect(idsOf(history)).toEqual(
      Array.from({ length: 10 }, (_, i) => `in_m${String(i * 2).padStart(3, "0")}`),
    );
    expect(history).toMatchObject({ nextCursor: expect.any(String) });
  });

  it("keeps scanning across batches when a batch holds too few issued invoices", async () => {
    // First batch: all drafts but the last two. Second batch: the rest.
    const dataset = [
      ...invoicesNamed(INVOICE_FETCH_BATCH_SIZE - 2, "d", () => true),
      ...invoicesNamed(12, "p"),
    ];
    stripeHolding(dataset);

    const history = await getInvoiceHistory(USER_ID);

    expect(stripe.invoicesList).toHaveBeenCalledTimes(2);
    expect(stripe.invoicesList.mock.calls[1][0]).toMatchObject({
      starting_after: dataset[INVOICE_FETCH_BATCH_SIZE - 1].id,
    });
    expect(history.kind === "ok" && history.invoices).toHaveLength(
      INVOICE_HISTORY_PAGE_SIZE,
    );
    expect(idsOf(history)).toEqual(
      Array.from({ length: 10 }, (_, i) => `in_p${String(i).padStart(3, "0")}`),
    );
  });

  it("reports an empty history only when Stripe truly holds no issued invoice", async () => {
    stripeHolding(invoicesNamed(INVOICE_FETCH_BATCH_SIZE + 7, "d", () => true));

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "ok",
      invoices: [],
      nextCursor: null,
      examined: INVOICE_FETCH_BATCH_SIZE + 7,
    });
    expect(stripe.invoicesList).toHaveBeenCalledTimes(2);
  });

  it("stops at the scan bound with a cursor past everything examined, never claiming the history is empty", async () => {
    const examined = INVOICE_FETCH_BATCH_SIZE * INVOICE_MAX_FETCHES_PER_PAGE;
    const dataset = [
      ...invoicesNamed(examined + 20, "d", () => true),
      ...invoicesNamed(2, "p"),
    ];
    stripeHolding(dataset);

    const history = await getInvoiceHistory(USER_ID);

    expect(stripe.invoicesList).toHaveBeenCalledTimes(INVOICE_MAX_FETCHES_PER_PAGE);
    expect(history).toEqual({
      kind: "ok",
      invoices: [],
      nextCursor: cursorAfter(dataset[examined - 1].id),
      examined,
    });

    // Continuing from that cursor eventually reaches the issued invoices.
    const next = await getInvoiceHistory(USER_ID, {
      startingAfter: dataset[examined - 1].id,
    });

    expect(idsOf(next)).toEqual(["in_p000", "in_p001"]);
    expect(next).toMatchObject({ nextCursor: null });
  });
});

describe("getInvoiceHistory – page boundaries", () => {
  it("walks a long history page by page: every issued invoice exactly once, in order, no gaps", async () => {
    // 137 objects, a draft every third one → 92 issued invoices over 10 pages.
    const dataset = invoicesNamed(137, "w", (i) => i % 3 === 2);
    const issued = dataset.filter((i) => i.status !== "draft").map((i) => i.id);
    stripeHolding(dataset);

    const pages = await walkPages();
    const seen = pages.flatMap((page) =>
      page.invoices.map((i) => decodeInvoiceKey(i.key)),
    );

    expect(seen).toEqual(issued);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages.length).toBe(Math.ceil(issued.length / INVOICE_HISTORY_PAGE_SIZE));
    for (const page of pages.slice(0, -1)) {
      expect(page.invoices).toHaveLength(INVOICE_HISTORY_PAGE_SIZE);
    }
    expect(pages.at(-1)).toMatchObject({ nextCursor: null });
  });

  it("continues right after the cursor: the next page starts with the very next object", async () => {
    const dataset = invoicesNamed(25, "b");
    stripeHolding(dataset);

    const first = await getInvoiceHistory(USER_ID);
    expect(first.kind === "ok" && first.nextCursor).toBe(cursorAfter("in_b009"));
    expect(first).toMatchObject({ examined: INVOICE_HISTORY_PAGE_SIZE }); // not the whole batch

    const second = await getInvoiceHistory(USER_ID, { startingAfter: "in_b009" });

    expect(stripe.invoicesList.mock.calls[1][0]).toEqual({
      customer: CUSTOMER,
      limit: INVOICE_FETCH_BATCH_SIZE,
      starting_after: "in_b009",
    });
    expect(idsOf(second)).toEqual(
      Array.from({ length: 10 }, (_, i) => `in_b${String(10 + i).padStart(3, "0")}`),
    );
  });

  it("has no next page when the history ends exactly at a page boundary", async () => {
    stripeHolding(invoicesNamed(INVOICE_HISTORY_PAGE_SIZE, "e"));

    const history = await getInvoiceHistory(USER_ID);

    expect(history.kind === "ok" && history.invoices).toHaveLength(
      INVOICE_HISTORY_PAGE_SIZE,
    );
    expect(history).toMatchObject({ nextCursor: null });
  });

  it("has no next page when the history ends exactly at a batch boundary", async () => {
    stripeHolding(invoicesNamed(INVOICE_FETCH_BATCH_SIZE, "e"));

    const pages = await walkPages();

    expect(pages.flatMap((p) => p.invoices)).toHaveLength(INVOICE_FETCH_BATCH_SIZE);
    expect(stripe.invoicesList.mock.calls.length).toBe(pages.length);
    expect(pages.at(-1)).toMatchObject({ nextCursor: null });
  });

  it("offers a next page when the page filled and Stripe has more, even if only drafts follow", async () => {
    // The next page then comes back empty with no cursor: the end of the list.
    stripeHolding([
      ...invoicesNamed(INVOICE_HISTORY_PAGE_SIZE, "p"),
      ...invoicesNamed(3, "d", () => true),
    ]);

    const first = await getInvoiceHistory(USER_ID);
    expect(first).toMatchObject({ nextCursor: cursorAfter("in_p009") });

    const second = await getInvoiceHistory(USER_ID, { startingAfter: "in_p009" });
    expect(second).toEqual({ kind: "ok", invoices: [], nextCursor: null, examined: 3 });
  });

  it("drops a duplicate Stripe hands back across batches rather than listing it twice", async () => {
    // Stripe's paging does not overlap; if it ever did, the page must not.
    const dataset = invoicesNamed(INVOICE_FETCH_BATCH_SIZE + 5, "o", (i) => i > 2);
    stripe.invoicesList.mockImplementation(async ({ limit, starting_after }) => {
      if (starting_after === undefined) {
        return stripeList(dataset.slice(0, limit), true);
      }
      // The second batch overlaps: it starts with the first batch's issued ones again.
      return stripeList([dataset[0], dataset[1], ...dataset.slice(limit)], false);
    });

    const history = await getInvoiceHistory(USER_ID);

    expect(idsOf(history)).toEqual(["in_o000", "in_o001", "in_o002"]);
  });
});

describe("getInvoiceHistory – a smaller page (the dashboard's newest invoice)", () => {
  it("stops at the first issued invoice, with a cursor right after it", async () => {
    const dataset = invoicesNamed(25, "s");
    stripeHolding(dataset);

    const page = await getInvoiceHistory(USER_ID, { pageSize: 1 });

    expect(page).toMatchObject({ kind: "ok", examined: 1 });
    expect(numbersOf((page as Extract<InvoiceHistory, { kind: "ok" }>).invoices)).toEqual(
      ["IN_S000"],
    );
    expect((page as Extract<InvoiceHistory, { kind: "ok" }>).nextCursor).toBe(
      cursorAfter("in_s000"),
    );
    expect(stripe.invoicesList).toHaveBeenCalledTimes(1); // still one batch request
  });

  it("skips drafts to find it, like the first row of a full page", async () => {
    // Three drafts on top, then issued invoices.
    const dataset = invoicesNamed(8, "d", (i) => i < 3);
    stripeHolding(dataset);

    const page = await getInvoiceHistory(USER_ID, { pageSize: 1 });
    const full = await getInvoiceHistory(USER_ID);

    expect(page).toMatchObject({ kind: "ok", invoices: [{ number: "IN_D003" }] });
    expect(full).toMatchObject({ kind: "ok" });
    expect((full as Extract<InvoiceHistory, { kind: "ok" }>).invoices[0]).toEqual(
      (page as Extract<InvoiceHistory, { kind: "ok" }>).invoices[0],
    );
  });

  it("reports an empty page with no cursor when Stripe holds only drafts", async () => {
    stripeHolding(invoicesNamed(5, "o", () => true));

    expect(await getInvoiceHistory(USER_ID, { pageSize: 1 })).toMatchObject({
      kind: "ok",
      invoices: [],
      nextCursor: null,
    });
  });

  it("keeps the scan budget: a run of drafts past it yields no invoice but a cursor to go on from", async () => {
    const budget = INVOICE_FETCH_BATCH_SIZE * INVOICE_MAX_FETCHES_PER_PAGE;
    stripeHolding(invoicesNamed(budget + 5, "r", (i) => i < budget + 2));

    const page = await getInvoiceHistory(USER_ID, { pageSize: 1 });

    expect(page).toMatchObject({ kind: "ok", invoices: [], examined: budget });
    expect((page as Extract<InvoiceHistory, { kind: "ok" }>).nextCursor).not.toBeNull();
    expect(stripe.invoicesList).toHaveBeenCalledTimes(INVOICE_MAX_FETCHES_PER_PAGE);
  });

  it("clamps the page size to 1..INVOICE_HISTORY_PAGE_SIZE, defaulting otherwise", () => {
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(INVOICE_HISTORY_PAGE_SIZE)).toBe(INVOICE_HISTORY_PAGE_SIZE);
    for (const bad of [0, -1, 1.5, INVOICE_HISTORY_PAGE_SIZE + 1, NaN, undefined]) {
      expect(clampPageSize(bad)).toBe(INVOICE_HISTORY_PAGE_SIZE);
    }
  });
});

describe("getInvoiceHistory – no customer, or an ambiguous one (same rules as the portal)", () => {
  it("reports 'none' without asking Stripe when the user has no billing account", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(withCustomer(null, "incomplete"));

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({ kind: "none" });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports 'none' for a user with no rows at all", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: true,
      stripeCustomerId: null,
      customerResolution: { kind: "none" },
      current: null,
      isServicing: false,
      subscriptions: [],
    });

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({ kind: "none" });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it.each([
    "multiple_customers",
    "unknown_customer",
    "customer_conflict",
    "multiple_past_customers",
  ] as const)(
    "refuses to list anything when the customer is ambiguous (%s), and logs counts only",
    async (reason) => {
      billing.getSubscriptionOverview.mockResolvedValue(ambiguous(reason));

      await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({ kind: "ambiguous" });

      expect(stripe.invoicesList).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ambiguous/), {
        userId: USER_ID,
        reason,
        customers: 2,
        subscriptions: 2,
      });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
        /cus_A|cus_B|sub_a|sub_b/,
      );
    },
  );

  it("applies the same rules to a later page: a cursor does not bypass the ownership check", async () => {
    billing.getSubscriptionOverview.mockResolvedValue(ambiguous("multiple_customers"));

    await expect(
      getInvoiceHistory(USER_ID, { startingAfter: "in_anything" }),
    ).resolves.toEqual({ kind: "ambiguous" });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("getInvoiceHistory – failing closed", () => {
  it("is unavailable (never 'none') when the records cannot be read", async () => {
    billing.getSubscriptionOverview.mockResolvedValue({
      ok: false,
      error: { message: "permission denied for table subscriptions", code: "42501" },
    });

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "records_unreadable",
    });
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("refuses to send a stored id that is not a Stripe customer id", async () => {
    for (const bad of [
      "",
      " ",
      "cus_",
      "cus_abc def",
      "sub_123",
      "cus_1; drop",
      "CUS-1",
    ]) {
      billing.getSubscriptionOverview.mockResolvedValue({
        ...withCustomer("placeholder"),
        stripeCustomerId: bad,
        customerResolution: { kind: "single", stripeCustomerId: bad },
      });

      await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
        kind: "unavailable",
        reason: "invalid_customer_id",
      });
    }

    expect(stripe.invoicesList).not.toHaveBeenCalled();
    // Logged, but the corrupt value itself stays out of the logs.
    expect(console.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /drop|sub_123/,
    );
  });

  it("refuses a starting point that is not an invoice id, without asking Stripe", async () => {
    for (const bad of ["", "cus_1", "in_", "in_1; drop", "x".repeat(100)]) {
      await expect(getInvoiceHistory(USER_ID, { startingAfter: bad })).resolves.toEqual({
        kind: "unavailable",
        reason: "cursor_invalid",
      });
    }

    expect(stripe.invoicesList).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/drop|xxxx/);
  });

  it("is unavailable when Stripe does not know the customer, without throwing", async () => {
    stripe.invoicesList.mockRejectedValue(
      stripeError({
        name: "StripeInvalidRequestError",
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "customer",
        statusCode: 404,
        requestId: "req_123",
        message: "No such customer: 'cus_existing'",
      }),
    );

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "customer_missing",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/does not know/),
      expect.objectContaining({
        userId: USER_ID,
        error: {
          name: "StripeInvalidRequestError",
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          statusCode: 404,
          requestId: "req_123",
        },
      }),
    );
  });

  it("reports a cursor Stripe no longer knows (a deleted draft) as such, so the UI can ask for a reload", async () => {
    stripeHolding(invoicesNamed(3, "c"));

    await expect(
      getInvoiceHistory(USER_ID, { startingAfter: "in_deletedDraft" }),
    ).resolves.toEqual({ kind: "unavailable", reason: "cursor_invalid" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /in_deletedDraft/,
    );
  });

  it("is unavailable on any other Stripe failure, logging stable fields but never the message", async () => {
    stripe.invoicesList.mockRejectedValue(
      stripeError({
        name: "StripeRateLimitError",
        type: "StripeRateLimitError",
        code: "rate_limit",
        statusCode: 429,
        requestId: "req_429",
        message: "Too many requests for cus_existing",
      }),
    );

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toMatch(/req_429/);
    expect(logged).toMatch(/StripeRateLimitError/);
    expect(logged).not.toMatch(/Too many requests|cus_existing/);
  });

  it("is unavailable when the failure is not a Stripe error at all (network, misconfiguration)", async () => {
    stripe.invoicesList.mockRejectedValue(new TypeError("fetch failed"));

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toMatch(/TypeError/);
  });

  it("keeps no partial page when a later batch of the same page fails", async () => {
    const dataset = [
      ...invoicesNamed(INVOICE_FETCH_BATCH_SIZE - 3, "d", () => true),
      ...invoicesNamed(12, "p"),
    ];
    stripe.invoicesList.mockImplementation(async ({ limit, starting_after }) => {
      if (starting_after !== undefined) throw new TypeError("fetch failed");
      return stripeList(dataset.slice(0, limit), true);
    });

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
  });

  it("refuses an answer containing another customer's invoice, keeping none of it", async () => {
    stripeHolding([
      stripeInvoice("in_1"),
      stripeInvoice("in_2", { number: "VICTIM-0001" }, "cus_victim"),
    ]);

    const history = await getInvoiceHistory(USER_ID);

    expect(history).toEqual({ kind: "unavailable", reason: "unusable_response" });
    expect(JSON.stringify(history)).not.toMatch(/VICTIM|cus_/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unusable/), {
      userId: USER_ID,
      reason: "foreign_customer",
      fetch: 1,
    });
  });

  it("refuses a foreign invoice in a later batch too, keeping nothing from the earlier ones", async () => {
    const dataset = [
      ...invoicesNamed(INVOICE_FETCH_BATCH_SIZE + 3, "d", () => true),
      stripeInvoice("in_bad", {}, "cus_victim"),
    ];
    stripeHolding(dataset);

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unusable/), {
      userId: USER_ID,
      reason: "foreign_customer",
      fetch: 2,
    });
  });

  it("refuses an answer that is not an invoice list", async () => {
    for (const answer of [null, undefined, "ok", { object: "list" }, { data: "nope" }]) {
      stripe.invoicesList.mockResolvedValue(answer);

      await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
        kind: "unavailable",
        reason: "unusable_response",
      });
    }
  });

  it("refuses a list with a malformed invoice rather than showing a partial history", async () => {
    stripeHolding([stripeInvoice("in_1"), stripeInvoice("in_2", { total: "29" })]);

    await expect(getInvoiceHistory(USER_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "unusable_response",
    });
  });

  it("never lists invoice numbers of a refused page (sanity: refused results carry no data)", async () => {
    stripeHolding([stripeInvoice("in_1", { number: "LEAK-1" }), stripeInvoice("in_1")]);

    const history = await getInvoiceHistory(USER_ID);

    expect(history).toEqual({ kind: "unavailable", reason: "unusable_response" });
    expect(JSON.stringify(numbersOf([]))).not.toMatch(/LEAK/);
  });
});

describe("getInvoiceHistory – filters", () => {
  const DAY = 86_400;
  /** 2026-03-01T00:00:00Z, the `created` of index 0 in `invoicesNamed`. */
  const TOP = 1_772_323_200;

  it("hands the status and the date range to Stripe, so the scan only ever sees candidates", async () => {
    stripeHolding(invoicesNamed(5, "f"));

    await getInvoiceHistory(USER_ID, {
      filters: { status: "paid", from: "2026-02-01", to: "2026-02-28", number: null },
    });

    expect(stripe.invoicesList).toHaveBeenCalledWith({
      customer: CUSTOMER,
      limit: INVOICE_FETCH_BATCH_SIZE,
      status: "paid",
      created: {
        gte: Date.UTC(2026, 1, 1) / 1000,
        lte: Date.UTC(2026, 1, 28, 23, 59, 59, 999) / 1000,
      },
    });
  });

  it("sends neither a status nor a range when none is set", async () => {
    await getInvoiceHistory(USER_ID, { filters: EMPTY_INVOICE_FILTERS });

    expect(stripe.invoicesList.mock.calls[0][0]).toEqual({
      customer: CUSTOMER,
      limit: INVOICE_FETCH_BATCH_SIZE,
    });
  });

  it("filters by status: only that status, and drafts never count", async () => {
    const dataset = invoicesNamed(30, "s", (i) => i % 5 === 0).map((invoice, i) => ({
      ...invoice,
      status: invoice.status === "draft" ? "draft" : i % 3 === 0 ? "open" : "paid",
    }));
    stripeHolding(dataset);

    const history = await getInvoiceHistory(USER_ID, {
      filters: { ...EMPTY_INVOICE_FILTERS, status: "open" },
    });

    expect(idsOf(history)).toEqual(
      dataset.filter((i) => i.status === "open").map((i) => i.id),
    );
    expect(
      history.kind === "ok" && history.invoices.every((i) => i.status === "open"),
    ).toBe(true);
  });

  it("filters by date range, inclusive of both days", async () => {
    stripeHolding(invoicesNamed(20, "d")); // one per day from 2026-03-01 backwards

    const history = await getInvoiceHistory(USER_ID, {
      filters: { ...EMPTY_INVOICE_FILTERS, from: "2026-02-20", to: "2026-02-25" },
    });

    // 2026-02-25 is index 4, 2026-02-20 is index 9.
    expect(idsOf(history)).toEqual(
      [4, 5, 6, 7, 8, 9].map((i) => `in_d${String(i).padStart(3, "0")}`),
    );
  });

  it("finds an invoice by number deep in the history, scanning with the search budget", async () => {
    const dataset = invoicesNamed(450, "n");
    stripeHolding(dataset);

    const history = await getInvoiceHistory(USER_ID, {
      filters: { ...EMPTY_INVOICE_FILTERS, number: "n437" },
    });

    expect(idsOf(history)).toEqual(["in_n437"]);
    expect(stripe.invoicesList).toHaveBeenCalledTimes(5);
    expect(stripe.invoicesList.mock.calls[0][0]).toMatchObject({
      limit: INVOICE_SEARCH_BATCH_SIZE,
    });
    expect(history).toMatchObject({ nextCursor: null, examined: 450 });
  });

  it("matches the number loosely: case, separators and partial numbers", async () => {
    stripeHolding([
      stripeInvoice("in_3", { number: "ABCD-0042" }),
      stripeInvoice("in_2", { number: "ABCD-0142" }),
      stripeInvoice("in_1", { number: "WXYZ-0042" }),
    ]);

    for (const [number, expected] of [
      ["abcd0042", ["in_3"]],
      ["0042", ["in_3", "in_1"]],
      ["abcd", ["in_3", "in_2"]],
      ["ABCD-0142", ["in_2"]],
      ["9999", []],
    ] as const) {
      const history = await getInvoiceHistory(USER_ID, {
        filters: { ...EMPTY_INVOICE_FILTERS, number },
      });

      expect(idsOf(history), number).toEqual([...expected]);
    }
  });

  it("stops a search at its budget with a cursor past everything checked, and says how far it got", async () => {
    const budget = INVOICE_SEARCH_BATCH_SIZE * INVOICE_SEARCH_MAX_FETCHES_PER_PAGE;
    const dataset = invoicesNamed(budget + 50, "b");
    stripeHolding(dataset);
    const filters = { ...EMPTY_INVOICE_FILTERS, number: "B1020" }; // beyond the first budget

    const first = await getInvoiceHistory(USER_ID, { filters });

    expect(first).toEqual({
      kind: "ok",
      invoices: [],
      nextCursor: cursorAfter(dataset[budget - 1].id, filters),
      examined: budget,
    });

    // The UI continues with that cursor (decoded as the action does) and finds it.
    const next = decodeInvoiceCursor(first.kind === "ok" ? first.nextCursor! : "")!;
    const second = await getInvoiceHistory(USER_ID, {
      startingAfter: next.afterId,
      filters: next.filters,
    });

    expect(idsOf(second)).toEqual(["in_b1020"]);
    expect(second).toMatchObject({ nextCursor: null, examined: 50 });
  });

  it("reports no matches (not 'unavailable', not 'empty history') when nothing matches", async () => {
    stripeHolding(invoicesNamed(30, "z"));

    await expect(
      getInvoiceHistory(USER_ID, {
        filters: { ...EMPTY_INVOICE_FILTERS, number: "NOPE" },
      }),
    ).resolves.toEqual({ kind: "ok", invoices: [], nextCursor: null, examined: 30 });
  });

  it("never shows a row its filters exclude, whatever Stripe returned", async () => {
    // A stand-in that ignores the status filter entirely.
    const dataset = invoicesNamed(6, "x").map((invoice, i) => ({
      ...invoice,
      status: i % 2 ? "void" : "paid",
    }));
    stripe.invoicesList.mockResolvedValue(stripeList(dataset, false));

    const history = await getInvoiceHistory(USER_ID, {
      filters: { ...EMPTY_INVOICE_FILTERS, status: "paid" },
    });

    expect(history.kind === "ok" && history.invoices.map((i) => i.status)).toEqual([
      "paid",
      "paid",
      "paid",
    ]);
  });

  it("the next-page cursor carries the filters of the listing", async () => {
    stripeHolding(invoicesNamed(30, "c"));
    const filters = { ...EMPTY_INVOICE_FILTERS, status: "paid" as const, number: "C" };

    const history = await getInvoiceHistory(USER_ID, { filters });

    expect(history.kind === "ok" && history.nextCursor).toBe(
      cursorAfter("in_c009", filters),
    );
    expect(decodeInvoiceCursor(history.kind === "ok" ? history.nextCursor! : "")).toEqual(
      {
        afterId: "in_c009",
        filters,
      },
    );
  });

  it("counts only what a page actually examined, even when it filled mid-batch", async () => {
    stripeHolding(invoicesNamed(40, "e", (i) => i === 3)); // one draft among the first page

    const history = await getInvoiceHistory(USER_ID);

    // 10 issued invoices plus the draft between them: 11 objects examined.
    expect(history).toMatchObject({ examined: 11, nextCursor: cursorAfter("in_e010") });
  });

  it("keeps document availability and keys intact in a filtered listing", async () => {
    const HOSTED = "https://invoice.stripe.com/i/acct_1/test_abc?s=ap";
    stripeHolding([
      stripeInvoice("in_2", {
        status: "open",
        hosted_invoice_url: HOSTED,
        invoice_pdf: null,
      }),
      stripeInvoice("in_1", { status: "paid", hosted_invoice_url: HOSTED }),
    ]);

    const history = await getInvoiceHistory(USER_ID, {
      filters: { ...EMPTY_INVOICE_FILTERS, status: "open" },
    });

    expect(history.kind === "ok" && history.invoices).toEqual([
      expect.objectContaining({
        key: encodeInvoiceKey("in_2"),
        documents: { view: true, pdf: false },
      }),
    ]);
  });

  it("across random filter sets and a draft-ridden history: every matching invoice exactly once, in order", async () => {
    // Deterministic pseudo-random dataset and filters.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
    const statuses = ["paid", "paid", "open", "void", "uncollectible", "draft"] as const;

    const dataset = Array.from({ length: 260 }, (_, i) =>
      stripeInvoice(`in_r${String(i).padStart(3, "0")}`, {
        created: TOP - i * DAY,
        status: pick(statuses),
        number: pick(["AB", "CD", "EF"]) + "-" + String(1000 + Math.floor(next() * 300)),
      }),
    );
    stripeHolding(dataset);

    const dayOf = (created: number) =>
      new Date(created * 1000).toISOString().slice(0, 10);
    const days = dataset.map((i) => dayOf(i.created));

    for (let round = 0; round < 25; round++) {
      const filters: InvoiceFilters = {
        status:
          next() < 0.5 ? pick(["paid", "open", "void", "uncollectible"] as const) : null,
        from: next() < 0.5 ? pick(days) : null,
        to: next() < 0.5 ? pick(days) : null,
        number: next() < 0.5 ? pick(["AB", "CD", "10", "12", "1234", "9"]) : null,
      };
      if (filters.from && filters.to && filters.from > filters.to) {
        [filters.from, filters.to] = [filters.to, filters.from];
      }

      const expected = dataset
        .filter((i) => i.status !== "draft")
        .filter((i) => filters.status === null || i.status === filters.status)
        .filter((i) => filters.from === null || dayOf(i.created) >= filters.from)
        .filter((i) => filters.to === null || dayOf(i.created) <= filters.to)
        .filter(
          (i) =>
            filters.number === null ||
            String(i.number)
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .includes(filters.number),
        )
        .map((i) => i.id);

      vi.clearAllMocks();
      const pages = await walkPages(100, filters);
      const seen = pages.flatMap((page) =>
        page.invoices.map((i) => decodeInvoiceKey(i.key)),
      );
      const label = JSON.stringify(filters);

      expect(seen, label).toEqual(expected);
      expect(new Set(seen).size, label).toBe(seen.length);
      for (const page of pages.slice(0, -1)) {
        // Every page but the last is full, or was cut by the scan budget (then it says so with a cursor).
        expect(page.invoices.length <= INVOICE_HISTORY_PAGE_SIZE, label).toBe(true);
      }
      expect(pages.at(-1), label).toMatchObject({ nextCursor: null });
      for (const [params] of stripe.invoicesList.mock.calls) {
        expect(params.customer, label).toBe(CUSTOMER); // never another customer's list
      }
    }
  });
});
