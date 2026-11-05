// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  INVOICE_CURSOR_MAX_LENGTH,
} from "./invoice-cursor";
import { EMPTY_INVOICE_FILTERS, type InvoiceFilters } from "./invoice-filters";
import { encodeInvoiceKey, encodeToken } from "./invoice-history";

const FILTERS: InvoiceFilters = {
  status: "paid",
  from: "2026-01-01",
  to: "2026-06-30",
  number: "ABCD-0042",
};

describe("invoice cursors", () => {
  it("round-trips the position and the filters through an opaque token", () => {
    for (const filters of [EMPTY_INVOICE_FILTERS, FILTERS]) {
      const cursor = encodeInvoiceCursor({ afterId: "in_1NXWPnCRMbs6FrXv", filters });

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cursor).not.toMatch(/in_1NXW|paid|ABCD/);
      expect(decodeInvoiceCursor(cursor)).toEqual({
        afterId: "in_1NXWPnCRMbs6FrXv",
        filters,
      });
    }
  });

  it("stays within the accepted length for the longest valid filters", () => {
    const cursor = encodeInvoiceCursor({
      afterId: "in_" + "a".repeat(40),
      filters: {
        status: "uncollectible",
        from: "2026-01-01",
        to: "2026-12-31",
        number: "x".repeat(40),
      },
    });

    expect(cursor.length).toBeLessThanOrEqual(INVOICE_CURSOR_MAX_LENGTH);
    expect(decodeInvoiceCursor(cursor)).not.toBeNull();
  });

  it("is not interchangeable with an invoice key", () => {
    expect(decodeInvoiceCursor(encodeInvoiceKey("in_1"))).toBeNull();
    expect(
      encodeInvoiceCursor({ afterId: "in_1", filters: EMPTY_INVOICE_FILTERS }),
    ).not.toBe(encodeInvoiceKey("in_1"));
  });

  it("decodes nothing that is not exactly what it would emit", () => {
    const rejected: unknown[] = [
      null,
      undefined,
      "",
      42,
      {},
      "in_1",
      "!!!",
      "a".repeat(INVOICE_CURSOR_MAX_LENGTH + 1),
      encodeToken("not json"),
      encodeToken("[]"),
      encodeToken("null"),
      encodeToken(JSON.stringify({ a: "cus_1", f: "" })), // not an invoice id
      encodeToken(JSON.stringify({ a: "in_1" })), // no filters field
      encodeToken(JSON.stringify({ a: "in_1", f: "status=draft" })), // invalid filters
      encodeToken(JSON.stringify({ a: "in_1", f: "from=2026-02-30" })),
      encodeToken(JSON.stringify({ a: "in_1", f: "q=%3Cb%3E" })),
      encodeToken(JSON.stringify({ a: "in_1", f: "from=2026-01-01&status=paid" })), // not canonical order
      encodeToken(JSON.stringify({ a: "in_1", f: "status=paid&" })),
      encodeToken(JSON.stringify({ a: "in_1", f: "", extra: 1 })), // extra fields change the token
      encodeToken(JSON.stringify({ f: "", a: "in_1" })), // key order changes the token
      encodeInvoiceCursor({ afterId: "in_1", filters: EMPTY_INVOICE_FILTERS }) + "=",
    ];

    for (const value of rejected) {
      expect(decodeInvoiceCursor(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("binds the filters to the cursor: two listings never share a cursor", () => {
    const a = encodeInvoiceCursor({ afterId: "in_1", filters: EMPTY_INVOICE_FILTERS });
    const b = encodeInvoiceCursor({ afterId: "in_1", filters: FILTERS });

    expect(a).not.toBe(b);
    expect(decodeInvoiceCursor(a)?.filters).toEqual(EMPTY_INVOICE_FILTERS);
    expect(decodeInvoiceCursor(b)?.filters).toEqual(FILTERS);
  });
});
