// @vitest-environment node
/**
 * The invoice download, end to end through the route: the real guard, range
 * parsing, customer resolution from the user's subscription rows, collector,
 * CSV builder and response. Only the boundaries are stand-ins — the session
 * lookup, the user's Supabase client (an in-memory `subscriptions` table that
 * honours the owner filter, as RLS would) and Stripe's invoice list (filters
 * by customer and `created`, pages like Stripe).
 */
import { NextRequest } from "next/server";

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const supabase = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => supabase);

// The export allowance's database function, behind the real limiter and the
// (service-role) admin client it uses.
const limiterDb = vi.hoisted(() => ({
  current: null as null | { client: unknown },
}));
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => limiterDb.current!.client,
}));

const stripe = vi.hoisted(() => ({
  invoicesList:
    vi.fn<
      (
        params: import("@/shared/test/stripe-invoices").StripeInvoiceListParams,
      ) => Promise<unknown>
    >(),
}));
vi.mock("@/infrastructure/stripe", () => ({
  getStripe: () => ({ invoices: { list: stripe.invoicesList } }),
}));

import { INVOICE_DOWNLOAD_PATH } from "@/features/billing/services/invoice-download";
import { parseCsv } from "@/shared/test/csv";
import { createFakeRateLimitDatabase } from "@/shared/test/rate-limit";
import {
  stripeError,
  type StripeInvoiceFixture,
  stripeInvoiceList,
  stripeList,
} from "@/shared/test/stripe-invoices";
import { createFakeSupabase, type FakeQuery, OK_RESPONSE } from "@/shared/test/supabase";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

import { GET } from "./route";

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "cus_jane";
const OTHER_CUSTOMER = "cus_someoneElse";
const NOW = new Date("2026-04-05T12:00:00Z");
const MARCH_START = Date.UTC(2026, 2, 1) / 1000;
const APRIL_START = Date.UTC(2026, 3, 1) / 1000;

type SubscriptionRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  userId: string;
};

/** The user's own row plus another user's, who has a different customer. */
const DEFAULT_SUBSCRIPTIONS: SubscriptionRow[] = [
  {
    stripe_customer_id: CUSTOMER,
    stripe_subscription_id: "sub_jane",
    status: "active",
    userId: USER.id,
  },
  {
    stripe_customer_id: OTHER_CUSTOMER,
    stripe_subscription_id: "sub_other",
    status: "active",
    userId: OTHER_USER,
  },
];

let db: ReturnType<typeof createFakeSupabase>;

/** `public.subscriptions` as the user's client sees it: filtered on the owner (as RLS would). */
function subscriptionsHolding(
  rows: SubscriptionRow[],
  failure?: { message: string; code: string },
) {
  db = createFakeSupabase((query: FakeQuery) => {
    if (query.table !== "subscriptions")
      throw new Error(`unexpected table ${query.table}`);
    if (failure) return { ...OK_RESPONSE, status: 401, data: null, error: failure };
    const [column, owner] = query.calls.find((c) => c.method === "eq")?.args ?? [];
    if (column !== "userId")
      throw new Error("subscriptions read without the owner filter");
    return {
      ...OK_RESPONSE,
      status: 200,
      data: rows
        .filter((row) => row.userId === owner)
        .map(({ stripe_customer_id, stripe_subscription_id, status }) => ({
          stripe_customer_id,
          stripe_subscription_id,
          status,
        })),
    };
  });
  supabase.createClient.mockResolvedValue(db.client);
}

/** `count` objects of `customer`, one hour apart, newest first, the newest at `newest` (seconds). */
const hourlyBack = (
  newest: number,
  count: number,
  {
    prefix = "j",
    customer = CUSTOMER,
    draftAt = (() => false) as (i: number) => boolean,
  } = {},
): StripeInvoiceFixture[] =>
  Array.from({ length: count }, (_, i) => {
    const id = `in_${prefix}${String(i).padStart(5, "0")}`;
    const draft = draftAt(i);
    return {
      id,
      object: "invoice",
      customer,
      created: newest - i * 3_600,
      currency: "usd",
      total: 1000 + i,
      number: draft ? null : `${prefix.toUpperCase()}-${String(i).padStart(5, "0")}`,
      status: draft ? "draft" : "paid",
      hosted_invoice_url: draft
        ? null
        : `https://invoice.stripe.com/i/acct_1/${id}_TOKEN`,
      invoice_pdf: draft ? null : `https://pay.stripe.com/invoice/acct_1/${id}_TOKEN/pdf`,
    };
  });

const stripeHolding = (store: StripeInvoiceFixture[]) =>
  stripe.invoicesList.mockImplementation(stripeInvoiceList(store));

const requests = () => stripe.invoicesList.mock.calls.map(([params]) => params);

const download = (query = "") =>
  GET(new NextRequest(`https://app.example.com${INVOICE_DOWNLOAD_PATH}${query}`));

const csvOf = async (response: Response) => {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await response.arrayBuffer(),
  );
  expect(text.startsWith(CSV_UTF8_BOM)).toBe(true);
  return parseCsv(text.slice(CSV_UTF8_BOM.length));
};

const HEADER = ["Date (UTC)", "Invoice number", "Status", "Total", "Currency"];

const expectNoFile = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("x-export-error")).toBe(code);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).not.toContain(CSV_UTF8_BOM);
  expect(body).not.toContain("Invoice number");
  expect(body).not.toMatch(/J-\d{5}|in_|cus_/);
  return body;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  limiterDb.current = createFakeRateLimitDatabase();
  subscriptionsHolding(DEFAULT_SUBSCRIPTIONS);
  stripeHolding([
    ...hourlyBack(APRIL_START - 1, 3),
    ...hourlyBack(APRIL_START - 1, 3, { prefix: "o", customer: OTHER_CUSTOMER }),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("is served at INVOICE_DOWNLOAD_PATH", () => {
  const segments = __dirname.split(path.sep);
  const url = segments
    .slice(segments.lastIndexOf("app") + 1)
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .join("/");

  expect(`/${url}`).toBe(INVOICE_DOWNLOAD_PATH);
});

describe("GET /billing/export/invoices – who", () => {
  it("sends a visitor without a session to /login before reading anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(download("?from=2026-03-01")).rejects.toMatchObject({ url: "/login" });
    expect(supabase.createClient).not.toHaveBeenCalled();
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("exports the invoices of the customer on the user's own records, and only those", async () => {
    const response = await download();

    const rows = (await csvOf(response)).slice(1);
    expect(rows.map((row) => row[1])).toEqual(["J-00000", "J-00001", "J-00002"]);
    expect(db.argsOf(db.queries[0], "eq")).toEqual(["userId", USER.id]);
    expect(requests().every((params) => params.customer === CUSTOMER)).toBe(true);
  });

  it("ignores any user or customer named in the query string", async () => {
    const response = await download(
      `?userId=${OTHER_USER}&customer=${OTHER_CUSTOMER}&stripeCustomerId=${OTHER_CUSTOMER}`,
    );

    expect((await csvOf(response)).slice(1).map((row) => row[1])).toEqual([
      "J-00000",
      "J-00001",
      "J-00002",
    ]);
    expect(db.argsOf(db.queries[0], "eq")).toEqual(["userId", USER.id]);
    expect(requests().every((params) => params.customer === CUSTOMER)).toBe(true);
  });

  it("refuses to guess between two billing accounts — no file, Stripe never asked", async () => {
    subscriptionsHolding([
      ...DEFAULT_SUBSCRIPTIONS,
      {
        stripe_customer_id: "cus_second",
        stripe_subscription_id: "sub_2",
        status: "active",
        userId: USER.id,
      },
    ]);

    const body = await expectNoFile(await download(), 409, "ambiguous");

    expect(body).toMatch(/more than one billing account/);
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("answers a user without a billing account with a header-only file", async () => {
    subscriptionsHolding(DEFAULT_SUBSCRIPTIONS.filter((row) => row.userId !== USER.id));

    const response = await download();

    expect(response.status).toBe(200);
    expect(await csvOf(response)).toEqual([HEADER]);
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("GET /billing/export/invoices – a complete file", () => {
  it("answers every issued invoice across many Stripe pages as a CSV attachment, never cached", async () => {
    const store = hourlyBack(APRIL_START - 1, 260, { draftAt: (i) => i % 5 === 0 });
    stripeHolding(store);

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="invoices-2026-04-05.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);

    const rows = await csvOf(response);
    expect(rows[0]).toEqual(HEADER);
    expect(rows.slice(1).map((row) => row[1])).toEqual(
      store.filter((i) => i.status !== "draft").map((i) => i.number),
    );
    expect(rows[1]).toEqual(["2026-03-31", "J-00001", "Paid", "10.01", "USD"]);
    expect(requests()).toHaveLength(3);
  });

  it("carries no Stripe ids, document URLs or tokens", async () => {
    const text = new TextDecoder().decode(await (await download()).arrayBuffer());

    expect(text).not.toMatch(/in_|cus_|TOKEN|stripe\.com|acct_/);
  });
});

describe("GET /billing/export/invoices – date range, applied on the server", () => {
  beforeEach(() => {
    stripeHolding([
      ...hourlyBack(APRIL_START + 9 * 3_600, 10, { prefix: "a" }), // 1 Apr: out
      ...hourlyBack(APRIL_START - 1, 744, { prefix: "m", draftAt: (i) => i % 8 === 0 }), // March
      ...hourlyBack(MARCH_START - 1, 24, { prefix: "f" }), // 28 Feb: out
    ]);
  });

  it("exports exactly the days asked for, and says so in the file name", async () => {
    const response = await download("?from=2026-03-01&to=2026-03-31");

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="invoices-2026-03-01-to-2026-03-31.csv"',
    );
    const rows = (await csvOf(response)).slice(1);
    expect(rows).toHaveLength(651);
    expect(rows.every(([date]) => date >= "2026-03-01" && date <= "2026-03-31")).toBe(
      true,
    );
    expect(rows.every(([, number]) => number.startsWith("M-"))).toBe(true);

    for (const params of requests()) {
      expect(params.created).toEqual({ gte: MARCH_START, lte: APRIL_START - 1 });
    }
  });

  it.each([
    ["?from=2026-04-01", "invoices-from-2026-04-01.csv", 10],
    ["?to=2026-02-28", "invoices-to-2026-02-28.csv", 24],
    ["?from=2026-03-31&to=2026-03-31", "invoices-2026-03-31-to-2026-03-31.csv", 21],
  ])("%s → %s with %i rows", async (query, fileName, count) => {
    const response = await download(query);

    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${fileName}"`,
    );
    expect((await csvOf(response)).slice(1)).toHaveLength(count);
  });

  it("answers a range with nothing in it as a header-only file", async () => {
    const response = await download("?from=2025-01-01&to=2025-12-31");

    expect(response.status).toBe(200);
    expect(await csvOf(response)).toEqual([HEADER]);
  });
});

describe("GET /billing/export/invoices – an invalid range reads nothing", () => {
  it.each([
    ["?from=2026-02-29", { From: DATE_RANGE_ERRORS.day }],
    ["?to=2026-3-31", { To: DATE_RANGE_ERRORS.date }],
    ["?to=2101-01-01", { To: DATE_RANGE_ERRORS.year }],
    ["?from=2026-03-31&to=2026-03-01", { Dates: DATE_RANGE_ERRORS.range }],
    ["?to=2026-03-31&to=2026-04-30", { To: DATE_RANGE_ERRORS.multiple }],
    ["?from=1772323200", { From: DATE_RANGE_ERRORS.date }],
  ])("%s", async (query, fields) => {
    const body = await expectNoFile(await download(query), 400, "invalid_range");

    expect(body).toBe(
      [
        "Check the dates of your export.",
        ...Object.entries(fields).map(([label, message]) => `${label}: ${message}`),
        "",
      ].join("\n"),
    );
    expect(supabase.createClient).not.toHaveBeenCalled();
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

describe("GET /billing/export/invoices – a failed export answers no file, never part of one", () => {
  it("when a later Stripe request fails", async () => {
    stripeHolding(hourlyBack(APRIL_START - 1, 250));
    const holding = stripe.invoicesList.getMockImplementation()!;
    stripe.invoicesList.mockImplementation(async (params) => {
      if (stripe.invoicesList.mock.calls.length === 3) {
        throw stripeError({ type: "StripeRateLimitError", statusCode: 429 });
      }
      return holding(params);
    });

    const body = await expectNoFile(await download(), 503, "unavailable");

    expect(body).toMatch(/^We couldn't export your invoices right now\./);
    expect(stripe.invoicesList).toHaveBeenCalledTimes(3);
  });

  it("when a later Stripe request fails within a range", async () => {
    stripeHolding(hourlyBack(APRIL_START - 1, 250));
    const holding = stripe.invoicesList.getMockImplementation()!;
    stripe.invoicesList.mockImplementation(async (params) => {
      if (stripe.invoicesList.mock.calls.length === 2) throw new Error("ECONNRESET");
      return holding(params);
    });

    await expectNoFile(
      await download("?from=2026-03-01&to=2026-03-31"),
      503,
      "unavailable",
    );
  });

  it("when Stripe slips another customer's invoice into a page", async () => {
    const store = hourlyBack(APRIL_START - 1, 150);
    store[120] = { ...store[120], customer: OTHER_CUSTOMER };
    stripe.invoicesList.mockImplementation(async ({ limit, starting_after }) => {
      const start = starting_after
        ? store.findIndex((i) => i.id === starting_after) + 1
        : 0;
      const data = store.slice(start, start + limit);
      return stripeList(data, start + data.length < store.length);
    });

    await expectNoFile(await download(), 503, "unavailable");
  });

  it("when Stripe's paging contradicts itself", async () => {
    stripe.invoicesList
      .mockResolvedValueOnce(stripeList(hourlyBack(APRIL_START - 1, 100), true))
      .mockResolvedValueOnce(stripeList([], true));

    await expectNoFile(await download(), 503, "unavailable");
  });

  it("when the user's records cannot be read", async () => {
    subscriptionsHolding([], { message: "JWT expired", code: "PGRST301" });

    await expectNoFile(await download(), 503, "unavailable");
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });

  it("when there are more invoices than one export may hold", async () => {
    // 10,050 objects: the 100-request budget runs out with more to come.
    stripeHolding(hourlyBack(APRIL_START - 1, 10_050));

    const body = await expectNoFile(await download(), 422, "too_large");

    expect(body).toMatch(/Choose a shorter date range/);
    expect(stripe.invoicesList).toHaveBeenCalledTimes(100);
  });
});

describe("GET /billing/export/invoices – what the exports page relies on", () => {
  const asPage = (query = "") =>
    GET(
      new NextRequest(`https://app.example.com${INVOICE_DOWNLOAD_PATH}${query}`, {
        headers: { accept: "application/json, text/csv;q=0.9" },
      }),
    );

  it("states how many invoices the file holds (zero for a header-only file)", async () => {
    stripeHolding(hourlyBack(APRIL_START - 1, 130, { draftAt: (i) => i % 10 === 0 }));

    const response = await asPage();

    expect(response.headers.get("x-export-row-count")).toBe("117");
    expect((await csvOf(response)).slice(1)).toHaveLength(117);

    subscriptionsHolding([]);
    expect((await asPage()).headers.get("x-export-row-count")).toBe("0");
  });

  it("still answers the file itself, not JSON, when it succeeds", async () => {
    const response = await asPage();

    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("answers field errors as JSON keyed by field", async () => {
    const response = await asPage("?from=2026-02-30&to=2026-01-01");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_range",
        message: "Check the dates of your export.",
        fields: { from: DATE_RANGE_ERRORS.day },
      },
    });
  });

  it("answers a failed export as JSON with no file", async () => {
    stripe.invoicesList.mockRejectedValue(stripeError({ type: "StripeAPIError" }));

    const response = await asPage();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "unavailable",
        message:
          "We couldn't export your invoices right now. Please try again in a moment; if this keeps happening, contact support.",
      },
    });
  });
});

describe("GET /billing/export/invoices – rate limit (Stripe protection)", () => {
  const limiter = () =>
    limiterDb.current as ReturnType<typeof createFakeRateLimitDatabase>;
  const asPage = (query = "") =>
    GET(
      new NextRequest(`https://app.example.com${INVOICE_DOWNLOAD_PATH}${query}`, {
        headers: { accept: "application/json, text/csv;q=0.9" },
      }),
    );

  it("allows five exports in a row, then answers 429 with Retry-After — and Stripe is not asked", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await download()).status).toBe(200);
    }
    const stripeCallsBefore = stripe.invoicesList.mock.calls.length;

    const response = await download();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-export-error")).toBe("rate_limited");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).toBe(
      "You've exported invoices several times in a short while. To avoid overloading our billing provider, please wait a minute before exporting again.\n",
    );
    expect(stripe.invoicesList.mock.calls.length).toBe(stripeCallsBefore);
  });

  it("tells the exports page how long to wait, as JSON", async () => {
    for (let i = 0; i < 5; i++) await asPage();

    const response = await asPage();

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limited",
        message:
          "You've exported invoices several times in a short while. To avoid overloading our billing provider, please wait a minute before exporting again.",
        retryAfterSeconds: 60,
      },
    });
  });

  it("allows one more export a minute later, and then says how long again", async () => {
    for (let i = 0; i < 6; i++) await download();

    vi.setSystemTime(NOW.getTime() + 30_000);
    const early = await download();
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("30");

    vi.setSystemTime(NOW.getTime() + 60_000);
    expect((await download()).status).toBe(200);
    expect((await download()).status).toBe(429);
  });

  it("keeps a separate allowance per user", async () => {
    for (let i = 0; i < 6; i++) await download();
    expect((await download()).status).toBe(429);

    auth.getCurrentUser.mockResolvedValue({ id: OTHER_USER, email: "other@example.com" });
    const other = await download();

    expect(other.status).toBe(200);
    expect(requests().at(-1)!.customer).toBe(OTHER_CUSTOMER);
  });

  it("does not count exports that never reach Stripe: invalid dates, or no billing account", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await download("?from=2026-02-30")).status).toBe(400);
    }
    subscriptionsHolding(DEFAULT_SUBSCRIPTIONS.filter((row) => row.userId !== USER.id));
    for (let i = 0; i < 10; i++) {
      expect((await download()).status).toBe(200); // header-only
    }
    expect(limiter().calls()).toBe(0);

    subscriptionsHolding(DEFAULT_SUBSCRIPTIONS);
    for (let i = 0; i < 5; i++) {
      expect((await download()).status).toBe(200);
    }
    expect((await download()).status).toBe(429);
  });

  it("counts a date-filtered export like any other", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await download("?from=2026-03-01&to=2026-03-31")).status).toBe(200);
    }
    expect((await download("?from=2026-01-01")).status).toBe(429);
  });

  it("refuses the export with 503, without asking Stripe, when the allowance cannot be checked", async () => {
    limiterDb.current = {
      client: createFakeSupabaseFailing(),
    } as unknown as ReturnType<typeof createFakeRateLimitDatabase>;

    const response = await asPage();

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("unavailable");
    expect(stripe.invoicesList).not.toHaveBeenCalled();
  });
});

/** A service-role client whose every call fails (the limiter's table or function missing). */
function createFakeSupabaseFailing() {
  return createFakeSupabase(() => ({
    ...OK_RESPONSE,
    status: 404,
    data: null,
    error: {
      message: "Could not find the function public.consume_rate_limit",
      code: "PGRST202",
    },
  })).client;
}
