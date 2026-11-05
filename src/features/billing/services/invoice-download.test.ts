// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const collector = vi.hoisted(() => ({ collectInvoicesForExport: vi.fn() }));
vi.mock("./collect-invoice-export", () => collector);

import { parseCsv } from "@/shared/test/csv";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

import type {
  InvoiceExportCollection,
  InvoiceExportUnavailableReason,
} from "./collect-invoice-export";
import {
  INVOICE_DOWNLOAD_COPY,
  prepareInvoiceDownload,
  waitInWords,
} from "./invoice-download";
import { encodeInvoiceKey } from "./invoice-history";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-04-05T12:00:00Z");
const HEADER = ["Date (UTC)", "Invoice number", "Status", "Total", "Currency"];

const prepare = (query = "") =>
  prepareInvoiceDownload(USER, new URLSearchParams(query), { now: NOW });

const collected = (result: InvoiceExportCollection) =>
  collector.collectInvoicesForExport.mockResolvedValue(result);

beforeEach(() => {
  vi.clearAllMocks();
  collected({ kind: "ok", invoices: [] });
});

describe("prepareInvoiceDownload", () => {
  it("hands the collector the session user and the PARSED range", async () => {
    await prepare("to=2026-03-31&customer=cus_other");

    expect(collector.collectInvoicesForExport).toHaveBeenCalledWith(USER, {
      range: { from: null, to: "2026-03-31" },
    });
  });

  it("turns a complete collection into the file, named after the range", async () => {
    collected({
      kind: "ok",
      invoices: [
        {
          key: encodeInvoiceKey("in_1"),
          number: "ABCD-0001",
          createdAt: "2026-03-02T00:00:00.000Z",
          total: -550,
          currency: "eur",
          status: "paid",
          documents: { view: true, pdf: true },
        },
      ],
    });

    const download = await prepare("from=2026-03-01");

    if (!download.ok) throw new Error("expected a file");
    expect(download.fileName).toBe("invoices-from-2026-03-01.csv");
    expect(download.body.startsWith(CSV_UTF8_BOM)).toBe(true);
    expect(parseCsv(download.body.slice(1))).toEqual([
      HEADER,
      ["2026-03-02", "ABCD-0001", "Paid", "-5.50", "EUR"],
    ]);
  });

  it("answers a user without a billing account with a header-only file", async () => {
    collected({ kind: "none" });

    const download = await prepare();

    if (!download.ok) throw new Error("expected a file");
    expect(download.fileName).toBe("invoices-2026-04-05.csv");
    expect(parseCsv(download.body.slice(1))).toEqual([HEADER]);
  });

  it("refuses an invalid range with the field messages, without collecting anything", async () => {
    expect(await prepare("from=2026-03-31&to=2026-03-01")).toEqual({
      ok: false,
      code: "invalid_range",
      message: INVOICE_DOWNLOAD_COPY.invalidRange,
      fields: { range: DATE_RANGE_ERRORS.range },
    });
    expect(collector.collectInvoicesForExport).not.toHaveBeenCalled();
  });

  it("refuses to guess between billing accounts", async () => {
    collected({ kind: "ambiguous" });

    expect(await prepare()).toEqual({
      ok: false,
      code: "ambiguous",
      message: INVOICE_DOWNLOAD_COPY.ambiguous,
    });
  });

  it("maps a collector-side range refusal to invalid_range", async () => {
    collected({ kind: "invalid_range" });

    expect(await prepare()).toMatchObject({ ok: false, code: "invalid_range" });
  });

  it.each<[InvoiceExportUnavailableReason, string]>([
    ["too_large", "too_large"],
    ["records_unreadable", "unavailable"],
    ["invalid_customer_id", "unavailable"],
    ["customer_missing", "unavailable"],
    ["cursor_invalid", "unavailable"],
    ["stripe_error", "unavailable"],
    ["unusable_response", "unavailable"],
    ["inconsistent_paging", "unavailable"],
  ])("a collection unavailable for %s is %s, with no file", async (reason, code) => {
    collected({ kind: "unavailable", reason });

    const download = await prepare("from=2026-03-01");

    expect(download).toMatchObject({ ok: false, code });
    expect(download).not.toHaveProperty("body");
  });
});

describe("prepareInvoiceDownload – rate limited", () => {
  it("says how long to wait, and passes the wait on for Retry-After", async () => {
    collected({ kind: "rate_limited", retryAfterSeconds: 150 });

    const download = await prepareInvoiceDownload(USER, new URLSearchParams(), {
      now: NOW,
    });

    expect(download).toEqual({
      ok: false,
      code: "rate_limited",
      message:
        "You've exported invoices several times in a short while. To avoid overloading our billing provider, please wait 3 minutes before exporting again.",
      retryAfterSeconds: 150,
    });
  });

  it("maps a limiter that cannot be checked to unavailable, like any other failure", async () => {
    collected({ kind: "unavailable", reason: "rate_limit_unavailable" });

    expect(await prepareInvoiceDownload(USER, new URLSearchParams())).toMatchObject({
      ok: false,
      code: "unavailable",
      message: INVOICE_DOWNLOAD_COPY.unavailable,
    });
  });
});

describe("waitInWords", () => {
  it.each([
    [1, "a second"],
    [2, "2 seconds"],
    [59, "59 seconds"],
    [60, "a minute"],
    [61, "2 minutes"],
    [150, "3 minutes"],
    [3600, "60 minutes"],
  ])("%i s → %s (rounded up, never promising too short a wait)", (seconds, words) => {
    expect(waitInWords(seconds)).toBe(words);
  });
});
