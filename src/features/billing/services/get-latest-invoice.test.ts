// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({
  getInvoiceHistory:
    vi.fn<
      (
        userId: string,
        options?: import("./get-invoice-history").InvoiceHistoryOptions,
      ) => Promise<import("./get-invoice-history").InvoiceHistory>
    >(),
}));
vi.mock("./get-invoice-history", () => history);

import { getLatestInvoice } from "./get-latest-invoice";
import type { InvoiceSummary } from "./invoice-history";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const INVOICE: InvoiceSummary = {
  key: "a2V5",
  number: "ABCD-0001",
  createdAt: "2026-03-01T00:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
};

const OVERVIEW = {
  ok: true as const,
  stripeCustomerId: "cus_1",
  customerResolution: { kind: "single" as const, stripeCustomerId: "cus_1" },
  current: null,
  isServicing: false,
  subscriptions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLatestInvoice", () => {
  it("asks the history for one invoice, off the caller's read of the records", async () => {
    history.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [INVOICE],
      nextCursor: "next",
      examined: 1,
    });

    expect(await getLatestInvoice(USER_ID, { overview: OVERVIEW })).toEqual({
      kind: "ok",
      invoice: INVOICE,
    });
    expect(history.getInvoiceHistory).toHaveBeenCalledTimes(1);
    expect(history.getInvoiceHistory).toHaveBeenCalledWith(USER_ID, {
      overview: OVERVIEW,
      pageSize: 1,
    });
  });

  it("is the first invoice of the page, should the history hand over more", async () => {
    const older = { ...INVOICE, key: "b2V5", number: "ABCD-0000" };
    history.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [INVOICE, older],
      nextCursor: null,
      examined: 2,
    });

    expect(await getLatestInvoice(USER_ID)).toEqual({ kind: "ok", invoice: INVOICE });
  });

  it("is empty only when Stripe had nothing further to scan", async () => {
    history.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [],
      nextCursor: null,
      examined: 3,
    });

    expect(await getLatestInvoice(USER_ID)).toEqual({ kind: "empty" });
  });

  it("is undetermined, never empty, when the scan stopped with more to examine", async () => {
    history.getInvoiceHistory.mockResolvedValue({
      kind: "ok",
      invoices: [],
      nextCursor: "cursor-past-the-drafts",
      examined: 300,
    });

    expect(await getLatestInvoice(USER_ID)).toEqual({ kind: "undetermined" });
  });

  it.each(["none", "ambiguous"] as const)("passes %s through unchanged", async (kind) => {
    history.getInvoiceHistory.mockResolvedValue({ kind });

    expect(await getLatestInvoice(USER_ID)).toEqual({ kind });
  });

  it("passes a failure through with its reason, never as 'no invoices'", async () => {
    history.getInvoiceHistory.mockResolvedValue({
      kind: "unavailable",
      reason: "stripe_error",
    });

    expect(await getLatestInvoice(USER_ID)).toEqual({
      kind: "unavailable",
      reason: "stripe_error",
    });
  });
});
