// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- boundaries ---------------------------------------------------------------

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

const billing = vi.hoisted(() => ({
  getInvoiceHistory:
    vi.fn<
      (
        userId: string,
        options?: import("../services/get-invoice-history").InvoiceHistoryOptions,
      ) => Promise<import("../services/get-invoice-history").InvoiceHistory>
    >(),
}));
vi.mock("../services/get-invoice-history", () => billing);

import { encodeInvoiceCursor } from "../services/invoice-cursor";
import { EMPTY_INVOICE_FILTERS, type InvoiceFilters } from "../services/invoice-filters";
import {
  encodeInvoiceKey,
  type InvoiceSummary,
  LOAD_MORE_INVOICES_COPY,
} from "../services/invoice-history";

import { loadMoreInvoices } from "./load-more-invoices";

// ------------------------------------------------------------------------------

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "jane@example.com" };
const CURSOR = encodeInvoiceCursor({
  afterId: "in_last",
  filters: EMPTY_INVOICE_FILTERS,
});
const FILTERS: InvoiceFilters = {
  status: "paid",
  from: "2026-01-01",
  to: "2026-06-30",
  number: "ABCD",
};
const FILTERED_CURSOR = encodeInvoiceCursor({ afterId: "in_last", filters: FILTERS });

const invoice = (id: string): InvoiceSummary => ({
  key: encodeInvoiceKey(id),
  number: id.toUpperCase(),
  createdAt: "2026-03-01T00:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue(USER);
  billing.getInvoiceHistory.mockResolvedValue({
    kind: "ok",
    invoices: [invoice("in_2"), invoice("in_1")],
    nextCursor: encodeInvoiceCursor({ afterId: "in_1", filters: EMPTY_INVOICE_FILTERS }),
    examined: 2,
  });
});

describe("loadMoreInvoices – happy path", () => {
  it("decodes the cursor and asks for the page after it, for the signed-in user only", async () => {
    const result = await loadMoreInvoices(CURSOR);

    expect(billing.getInvoiceHistory).toHaveBeenCalledTimes(1);
    expect(billing.getInvoiceHistory).toHaveBeenCalledWith(USER.id, {
      startingAfter: "in_last",
      filters: EMPTY_INVOICE_FILTERS,
    });
    expect(result).toEqual({
      ok: true,
      cursor: CURSOR,
      invoices: [invoice("in_2"), invoice("in_1")],
      nextCursor: encodeInvoiceCursor({
        afterId: "in_1",
        filters: EMPTY_INVOICE_FILTERS,
      }),
      examined: 2,
    });
  });

  it("continues a filtered listing with the filters the cursor carries — the client cannot substitute others", async () => {
    await loadMoreInvoices(FILTERED_CURSOR);

    expect(billing.getInvoiceHistory).toHaveBeenCalledWith(USER.id, {
      startingAfter: "in_last",
      filters: FILTERS,
    });
  });

  it("does not hand the service an overview: ownership is resolved afresh on every page", async () => {
    await loadMoreInvoices(CURSOR);

    expect(billing.getInvoiceHistory.mock.calls[0][1]).not.toHaveProperty("overview");
  });

  it("passes the end of the list through", async () => {
    billing.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [],
      nextCursor: null,
      examined: 40,
    });

    await expect(loadMoreInvoices(CURSOR)).resolves.toEqual({
      ok: true,
      cursor: CURSOR,
      invoices: [],
      nextCursor: null,
      examined: 40,
    });
  });

  it("echoes the cursor it was asked for, so the client can match the answer to its request", async () => {
    const other = encodeInvoiceCursor({
      afterId: "in_other",
      filters: EMPTY_INVOICE_FILTERS,
    });

    await expect(loadMoreInvoices(other)).resolves.toMatchObject({ cursor: other });
  });
});

describe("loadMoreInvoices – client input", () => {
  it("redirects anonymous callers to /login without touching anything", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    await expect(loadMoreInvoices(CURSOR)).rejects.toMatchObject({ url: "/login" });
    expect(billing.getInvoiceHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["a raw Stripe id", "in_last"],
    ["an invoice key (not a cursor)", encodeInvoiceKey("in_last")],
    [
      "a customer id in disguise",
      encodeInvoiceCursor({
        afterId: "cus_victim" as "in_x",
        filters: EMPTY_INVOICE_FILTERS,
      }),
    ],
    [
      "a cursor with invalid filters",
      encodeInvoiceCursor({
        afterId: "in_last",
        filters: { ...EMPTY_INVOICE_FILTERS, from: "2026-13-40" },
      }),
    ],
    ["garbage", "!!!not-a-cursor!!!"],
    ["an empty string", ""],
    ["a number", 42],
    ["an object", { cursor: CURSOR }],
    ["an array", [CURSOR]],
    ["null", null],
    ["undefined", undefined],
  ])(
    "refuses %s without asking for anything, and asks the user to reload",
    async (_name, cursor) => {
      const result = await loadMoreInvoices(cursor);

      expect(result).toEqual({
        ok: false,
        cursor: typeof cursor === "string" ? cursor : "",
        error: LOAD_MORE_INVOICES_COPY.restart,
        restart: true,
      });
      expect(billing.getInvoiceHistory).not.toHaveBeenCalled();
      // Logged as a shape only; the value is whatever the client sent.
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
        /victim|in_last|not-a-cursor/,
      );
    },
  );

  it("takes nothing else from the client: extra arguments are ignored", async () => {
    const action = loadMoreInvoices as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;

    await action(CURSOR, { userId: "22222222-2222-4222-8222-222222222222" });
    await action(CURSOR, "cus_victim");

    for (const [userId, options] of billing.getInvoiceHistory.mock.calls) {
      expect(userId).toBe(USER.id);
      expect(options).toEqual({
        startingAfter: "in_last",
        filters: EMPTY_INVOICE_FILTERS,
      });
    }
  });
});

describe("loadMoreInvoices – failures keep the rows on screen", () => {
  it.each([
    ["records_unreadable", false],
    ["invalid_customer_id", false],
    ["customer_missing", false],
    ["stripe_error", false],
    ["unusable_response", false],
    ["cursor_invalid", true],
  ] as const)(
    "turns an unavailable page (%s) into an inline message; restart = %s",
    async (reason, restart) => {
      billing.getInvoiceHistory.mockResolvedValue({ kind: "unavailable", reason });

      await expect(loadMoreInvoices(CURSOR)).resolves.toEqual({
        ok: false,
        cursor: CURSOR,
        error: restart ? LOAD_MORE_INVOICES_COPY.restart : LOAD_MORE_INVOICES_COPY.retry,
        restart,
      });
    },
  );

  it.each(["none", "ambiguous"] as const)(
    "asks for a reload when the records no longer point at one customer (%s)",
    async (kind) => {
      billing.getInvoiceHistory.mockResolvedValue({ kind });

      await expect(loadMoreInvoices(CURSOR)).resolves.toEqual({
        ok: false,
        cursor: CURSOR,
        error: LOAD_MORE_INVOICES_COPY.restart,
        restart: true,
      });
    },
  );

  it("never echoes internals in the message", async () => {
    billing.getInvoiceHistory.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    const result = await loadMoreInvoices(CURSOR);

    expect(JSON.stringify(result)).not.toMatch(/stripe_error|in_last|cus_/);
  });

  it("lets an unexpected failure propagate (the client shows a retry for it)", async () => {
    billing.getInvoiceHistory.mockRejectedValue(new Error("cookies unavailable"));

    await expect(loadMoreInvoices(CURSOR)).rejects.toThrow("cookies unavailable");
  });
});
