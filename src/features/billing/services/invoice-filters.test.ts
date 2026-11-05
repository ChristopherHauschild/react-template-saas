// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  EMPTY_INVOICE_FILTERS,
  INVOICE_FILTER_ERRORS,
  INVOICE_NUMBER_MAX_LENGTH,
  INVOICE_STATUS_FILTER_OPTIONS,
  invoiceCreatedRange,
  type InvoiceFilters,
  invoiceFiltersFromQuery,
  invoiceFiltersToQuery,
  isCalendarDate,
  isEmptyInvoiceFilters,
  matchesInvoiceFilters,
  normalizeInvoiceNumber,
  parseInvoiceFilters,
} from "./invoice-filters";
import {
  encodeInvoiceKey,
  type InvoiceSummary,
  LISTED_INVOICE_STATUSES,
} from "./invoice-history";

const invoice = (overrides: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  key: encodeInvoiceKey("in_1"),
  number: "ABCD-0042",
  createdAt: "2026-03-15T12:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
  ...overrides,
});

describe("parseInvoiceFilters – valid input", () => {
  it("reads no parameters as no filters", () => {
    expect(parseInvoiceFilters(undefined)).toEqual({
      ok: true,
      filters: EMPTY_INVOICE_FILTERS,
      active: false,
    });
    expect(parseInvoiceFilters({})).toMatchObject({ active: false });
    expect(parseInvoiceFilters({ status: "", from: "", to: "", q: "  " })).toMatchObject({
      ok: true,
      active: false,
    });
  });

  it("reads every field, trimmed", () => {
    expect(
      parseInvoiceFilters({
        status: "paid",
        from: " 2026-01-01",
        to: "2026-06-30 ",
        q: " ABCD-0042 ",
      }),
    ).toEqual({
      ok: true,
      active: true,
      filters: {
        status: "paid",
        from: "2026-01-01",
        to: "2026-06-30",
        number: "ABCD-0042",
      },
    });
  });

  it.each(LISTED_INVOICE_STATUSES)("accepts the %s status", (status) => {
    expect(parseInvoiceFilters({ status })).toMatchObject({
      ok: true,
      filters: { status },
    });
  });

  it("takes the first value of a repeated parameter", () => {
    expect(parseInvoiceFilters({ status: ["paid", "void"] })).toMatchObject({
      filters: { status: "paid" },
    });
  });

  it("ignores unrelated parameters", () => {
    expect(parseInvoiceFilters({ document: "missing", utm_source: "x" })).toMatchObject({
      ok: true,
      active: false,
    });
  });
});

describe("parseInvoiceFilters – invalid input (untrusted URL)", () => {
  it("refuses a status that is not listed, drafts included", () => {
    for (const status of ["draft", "PAID", "paid,open", "<script>", "all"]) {
      expect(parseInvoiceFilters({ status })).toEqual({
        ok: false,
        errors: { status: INVOICE_FILTER_ERRORS.status },
        input: { status, from: "", to: "", number: "" },
      });
    }
  });

  it("refuses dates that are not real YYYY-MM-DD days", () => {
    for (const value of [
      "yesterday",
      "2026-1-1",
      "01/01/2026",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "1999-12-31",
      "2101-01-01",
      "2026-03-15T00:00:00Z",
      "2026-03-15'",
    ]) {
      expect(parseInvoiceFilters({ from: value }), value).toMatchObject({
        ok: false,
        errors: { from: INVOICE_FILTER_ERRORS.date },
      });
      expect(parseInvoiceFilters({ to: value }), value).toMatchObject({
        ok: false,
        errors: { to: INVOICE_FILTER_ERRORS.date },
      });
    }
  });

  it("accepts leap days and the range limits", () => {
    for (const value of ["2024-02-29", "2000-01-01", "2100-12-31"]) {
      expect(isCalendarDate(value), value).toBe(true);
    }
    expect(isCalendarDate("2023-02-29")).toBe(false);
  });

  it("refuses a range whose start is after its end (the same day is fine)", () => {
    expect(parseInvoiceFilters({ from: "2026-06-30", to: "2026-01-01" })).toMatchObject({
      ok: false,
      errors: { range: INVOICE_FILTER_ERRORS.range },
    });
    expect(parseInvoiceFilters({ from: "2026-06-30", to: "2026-06-30" })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a number search with other characters, too long, or without anything to match", () => {
    for (const q of [
      "ABCD_0042",
      "ABCD/0042",
      "<b>x</b>",
      "ABCD;drop",
      "é",
      "-",
      " - - ",
      "x".repeat(INVOICE_NUMBER_MAX_LENGTH + 1),
    ]) {
      expect(parseInvoiceFilters({ q }), q).toMatchObject({
        ok: false,
        errors: { number: INVOICE_FILTER_ERRORS.number },
      });
    }
    expect(
      parseInvoiceFilters({ q: "x".repeat(INVOICE_NUMBER_MAX_LENGTH) }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("reports every offending field at once and echoes the input back", () => {
    const parsed = parseInvoiceFilters({
      status: "nope",
      from: "bad",
      to: "worse",
      q: "!",
    });

    expect(parsed).toEqual({
      ok: false,
      errors: {
        status: INVOICE_FILTER_ERRORS.status,
        from: INVOICE_FILTER_ERRORS.date,
        to: INVOICE_FILTER_ERRORS.date,
        number: INVOICE_FILTER_ERRORS.number,
      },
      input: { status: "nope", from: "bad", to: "worse", number: "!" },
    });
  });

  it("never treats an invalid field as 'no filter' (which would list everything)", () => {
    expect(parseInvoiceFilters({ status: "paid", q: "!!" })).toMatchObject({ ok: false });
  });
});

describe("matchesInvoiceFilters", () => {
  it("matches everything with no filters", () => {
    expect(matchesInvoiceFilters(invoice(), EMPTY_INVOICE_FILTERS)).toBe(true);
    expect(
      matchesInvoiceFilters(
        invoice({ number: null, status: "unknown" }),
        EMPTY_INVOICE_FILTERS,
      ),
    ).toBe(true);
  });

  it("matches the status exactly; an unknown status matches no status filter", () => {
    const paid = { ...EMPTY_INVOICE_FILTERS, status: "paid" as const };

    expect(matchesInvoiceFilters(invoice({ status: "paid" }), paid)).toBe(true);
    expect(matchesInvoiceFilters(invoice({ status: "open" }), paid)).toBe(false);
    expect(matchesInvoiceFilters(invoice({ status: "unknown" }), paid)).toBe(false);
  });

  it("matches the creation date inclusively, by UTC calendar day", () => {
    const march = { ...EMPTY_INVOICE_FILTERS, from: "2026-03-01", to: "2026-03-31" };

    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2026-03-01T00:00:00.000Z" }), march),
    ).toBe(true);
    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2026-03-31T23:59:59.000Z" }), march),
    ).toBe(true);
    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2026-02-28T23:59:59.000Z" }), march),
    ).toBe(false);
    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2026-04-01T00:00:00.000Z" }), march),
    ).toBe(false);

    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2030-01-01T00:00:00.000Z" }), {
        ...EMPTY_INVOICE_FILTERS,
        from: "2026-03-01",
      }),
    ).toBe(true);
    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2020-01-01T00:00:00.000Z" }), {
        ...EMPTY_INVOICE_FILTERS,
        to: "2026-03-01",
      }),
    ).toBe(true);
  });

  it("matches the number as a case-insensitive substring with separators ignored", () => {
    const search = (number: string) => ({ ...EMPTY_INVOICE_FILTERS, number });

    for (const q of [
      "ABCD-0042",
      "abcd-0042",
      "0042",
      "ABCD",
      "abcd0042",
      "CD-00",
      "ABCD 0042",
    ]) {
      expect(matchesInvoiceFilters(invoice(), search(q)), q).toBe(true);
    }
    for (const q of ["0043", "ABCE", "ABCD-00421"]) {
      expect(matchesInvoiceFilters(invoice(), search(q)), q).toBe(false);
    }
    expect(matchesInvoiceFilters(invoice({ number: null }), search("42"))).toBe(false);
  });

  it("requires every set filter to match", () => {
    const filters: InvoiceFilters = {
      status: "paid",
      from: "2026-03-01",
      to: "2026-03-31",
      number: "42",
    };

    expect(matchesInvoiceFilters(invoice(), filters)).toBe(true);
    expect(matchesInvoiceFilters(invoice({ status: "open" }), filters)).toBe(false);
    expect(
      matchesInvoiceFilters(invoice({ createdAt: "2026-05-01T00:00:00.000Z" }), filters),
    ).toBe(false);
    expect(matchesInvoiceFilters(invoice({ number: "ABCD-0001" }), filters)).toBe(false);
  });

  it("normalises numbers to upper-case letters and digits", () => {
    expect(normalizeInvoiceNumber(" ab-cd 00_42 ")).toBe("ABCD0042");
    expect(normalizeInvoiceNumber("---")).toBe("");
  });
});

describe("invoiceCreatedRange – what is sent to Stripe", () => {
  it("is null without dates", () => {
    expect(invoiceCreatedRange(EMPTY_INVOICE_FILTERS)).toBeNull();
  });

  it("covers the from-day from midnight and the to-day to its last second, UTC", () => {
    expect(
      invoiceCreatedRange({
        ...EMPTY_INVOICE_FILTERS,
        from: "2026-03-01",
        to: "2026-03-31",
      }),
    ).toEqual({
      gte: Date.UTC(2026, 2, 1) / 1000,
      lte: Date.UTC(2026, 2, 31, 23, 59, 59, 999) / 1000,
    });
    expect(invoiceCreatedRange({ ...EMPTY_INVOICE_FILTERS, from: "2026-03-01" })).toEqual(
      {
        gte: Date.UTC(2026, 2, 1) / 1000,
      },
    );
    expect(invoiceCreatedRange({ ...EMPTY_INVOICE_FILTERS, to: "2026-03-01" })).toEqual({
      lte: Date.UTC(2026, 2, 1, 23, 59, 59, 999) / 1000,
    });
  });
});

describe("invoiceFiltersToQuery / invoiceFiltersFromQuery", () => {
  it("is empty for no filters and canonical otherwise", () => {
    expect(invoiceFiltersToQuery(EMPTY_INVOICE_FILTERS)).toBe("");
    expect(
      invoiceFiltersToQuery({
        status: "void",
        from: "2026-01-01",
        to: null,
        number: "AB CD",
      }),
    ).toBe("status=void&from=2026-01-01&q=AB+CD");
  });

  it("round-trips every valid filter set", () => {
    const sets: InvoiceFilters[] = [
      EMPTY_INVOICE_FILTERS,
      { status: "paid", from: null, to: null, number: null },
      { status: null, from: "2026-01-01", to: "2026-12-31", number: null },
      { status: "open", from: "2026-01-01", to: "2026-12-31", number: "ABCD-0042" },
      {
        status: null,
        from: null,
        to: null,
        number: "x".repeat(INVOICE_NUMBER_MAX_LENGTH),
      },
    ];

    for (const filters of sets) {
      expect(invoiceFiltersFromQuery(invoiceFiltersToQuery(filters))).toEqual(filters);
    }
  });

  it("refuses a query that does not parse as valid filters", () => {
    expect(invoiceFiltersFromQuery("status=draft")).toBeNull();
    expect(invoiceFiltersFromQuery("from=2026-02-30")).toBeNull();
    expect(invoiceFiltersFromQuery("q=%3Cb%3E")).toBeNull();
  });

  it("knows when nothing is set", () => {
    expect(isEmptyInvoiceFilters(EMPTY_INVOICE_FILTERS)).toBe(true);
    expect(isEmptyInvoiceFilters({ ...EMPTY_INVOICE_FILTERS, number: "1" })).toBe(false);
  });

  it("offers every listed status plus 'all' in the form", () => {
    expect(INVOICE_STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "",
      ...LISTED_INVOICE_STATUSES,
    ]);
    expect(INVOICE_STATUS_FILTER_OPTIONS[0].label).toBe("All statuses");
  });
});
