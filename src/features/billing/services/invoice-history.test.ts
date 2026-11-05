// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  appendInvoices,
  decodeInvoiceKey,
  decodeToken,
  encodeInvoiceKey,
  encodeToken,
  formatInvoiceAmount,
  formatInvoiceDate,
  INVOICE_DOCUMENT_FIELDS,
  INVOICE_DOCUMENT_KINDS,
  INVOICE_FETCH_BATCH_SIZE,
  INVOICE_HISTORY_PAGE_SIZE,
  INVOICE_MAX_FETCHES_PER_PAGE,
  INVOICE_STATUS_CONTENT,
  invoiceDocumentPath,
  type InvoiceSummary,
  isInvoiceDocumentKind,
  isInvoiceDocumentUrl,
  isListedInvoiceStatus,
  isStripeInvoiceId,
  LISTED_INVOICE_STATUSES,
  minorUnitDigits,
  readInvoiceList,
} from "./invoice-history";

const HOSTED_URL =
  "https://invoice.stripe.com/i/acct_1/test_YWNjdF8xLF9hYmM0200abcDEF?s=ap";
const PDF_URL =
  "https://pay.stripe.com/invoice/acct_1/test_YWNjdF8xLF9hYmM0200abcDEF/pdf?s=ap";

const CUSTOMER = "cus_1";

/** A Stripe invoice as `GET /v1/invoices?customer=…` returns it (the fields we read). */
const stripeInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: "in_1",
  object: "invoice",
  customer: CUSTOMER,
  created: 1_772_323_200, // 2026-03-01T00:00:00Z
  currency: "usd",
  total: 2900,
  amount_due: 2900,
  amount_paid: 2900,
  number: "ABCD-0001",
  status: "paid",
  hosted_invoice_url: HOSTED_URL,
  invoice_pdf: PDF_URL,
  ...overrides,
});

const stripeList = (data: unknown[], has_more = false) => ({
  object: "list",
  url: "/v1/invoices",
  has_more,
  data,
});

describe("readInvoiceList – the display model", () => {
  it("keeps the date, number, amount, currency and status of each invoice, newest first as Stripe orders them", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_2", created: 1_775_001_600, number: "ABCD-0002" }),
        stripeInvoice({ id: "in_1", created: 1_772_323_200, number: "ABCD-0001" }),
      ]),
      CUSTOMER,
    );

    expect(reading).toEqual({
      ok: true,
      hasMore: false,
      lastId: "in_1",
      received: 2,
      rejectedDocumentUrls: 0,
      ids: ["in_2", "in_1"],
      positions: [0, 1],
      invoices: [
        {
          key: encodeInvoiceKey("in_2"),
          number: "ABCD-0002",
          createdAt: "2026-04-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: true, pdf: true },
        },
        {
          key: encodeInvoiceKey("in_1"),
          number: "ABCD-0001",
          createdAt: "2026-03-01T00:00:00.000Z",
          total: 2900,
          currency: "usd",
          status: "paid",
          documents: { view: true, pdf: true },
        },
      ],
    });
  });

  it("carries no Stripe identifiers or URLs into the display model (the key is opaque)", () => {
    const reading = readInvoiceList(stripeList([stripeInvoice()]), CUSTOMER);

    expect(JSON.stringify(reading.ok ? reading.invoices : reading)).not.toMatch(
      /in_1|cus_1|stripe\.com|https?:/,
    );
  });

  it("reports where the scan got to — the last object, draft or not — and how many objects it saw", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_3", status: "paid" }),
        stripeInvoice({ id: "in_2", status: "draft" }),
        stripeInvoice({ id: "in_1", status: "draft" }),
      ]),
      CUSTOMER,
    );

    expect(reading).toMatchObject({ ok: true, lastId: "in_1", received: 3 });
    expect(reading.ok && reading.invoices).toHaveLength(1);
  });

  it("passes Stripe's has_more through (and treats anything else as false)", () => {
    expect(readInvoiceList(stripeList([], true), CUSTOMER)).toMatchObject({
      hasMore: true,
    });
    expect(readInvoiceList(stripeList([], false), CUSTOMER)).toMatchObject({
      hasMore: false,
    });
    expect(readInvoiceList({ data: [] }, CUSTOMER)).toMatchObject({ hasMore: false });
  });

  it("reads an empty list as no invoices", () => {
    expect(readInvoiceList(stripeList([]), CUSTOMER)).toEqual({
      ok: true,
      invoices: [],
      ids: [],
      positions: [],
      hasMore: false,
      lastId: null,
      received: 0,
      rejectedDocumentUrls: 0,
    });
  });

  it("drops drafts: they are not invoices yet and their amounts can still change", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_2", status: "draft", number: null, total: 1 }),
        stripeInvoice({ id: "in_1", status: "paid" }),
      ]),
      CUSTOMER,
    );

    expect(reading).toMatchObject({ ok: true });
    expect(reading.ok && reading.invoices.map((i) => i.status)).toEqual(["paid"]);
  });

  it.each(LISTED_INVOICE_STATUSES)("lists a %s invoice under that status", (status) => {
    const reading = readInvoiceList(stripeList([stripeInvoice({ status })]), CUSTOMER);

    expect(reading.ok && reading.invoices[0].status).toBe(status);
  });

  it("shows a status it does not know — or none — as 'unknown', never as something else", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_3", status: "some_future_status" }),
        stripeInvoice({ id: "in_2", status: null }),
        stripeInvoice({ id: "in_1", status: undefined }),
      ]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices.map((i) => i.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("has no number until Stripe assigns one", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_2", number: null }),
        stripeInvoice({ id: "in_1", number: "" }),
      ]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices.map((i) => i.number)).toEqual([null, null]);
  });

  it("normalises the currency code to lower case and keeps a negative total (a credit)", () => {
    const reading = readInvoiceList(
      stripeList([stripeInvoice({ currency: "EUR", total: -500 })]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices[0]).toMatchObject({
      currency: "eur",
      total: -500,
    });
  });

  it("accepts the customer as an expanded object naming the same id", () => {
    const reading = readInvoiceList(
      stripeList([stripeInvoice({ customer: { id: CUSTOMER, object: "customer" } })]),
      CUSTOMER,
    );

    expect(reading.ok).toBe(true);
  });
});

describe("readInvoiceList – refusing what is not this customer's invoice list", () => {
  it("refuses the whole answer when any invoice belongs to another customer", () => {
    for (const customer of [
      "cus_other",
      { id: "cus_other" },
      null,
      undefined,
      "",
      { id: null },
    ]) {
      expect(
        readInvoiceList(
          stripeList([stripeInvoice(), stripeInvoice({ id: "in_2", customer })]),
          CUSTOMER,
        ),
      ).toEqual({ ok: false, reason: "foreign_customer" });
    }
  });

  it("refuses an answer that is not a list of invoices", () => {
    for (const answer of [
      null,
      undefined,
      "list",
      42,
      {},
      { data: null },
      { data: {} },
    ]) {
      expect(readInvoiceList(answer, CUSTOMER)).toEqual({
        ok: false,
        reason: "not_a_list",
      });
    }
  });

  it("refuses an entry that lacks the fields an invoice has", () => {
    const malformed: Record<string, unknown>[] = [
      { id: null },
      { id: "" },
      { id: "cus_1" },
      { id: "in_" },
      { id: 12 },
      { created: "yesterday" },
      { created: -1 },
      { created: Number.NaN },
      { created: null },
      { total: "29.00" },
      { total: 29.5 },
      { total: null },
      { currency: "dollars" },
      { currency: null },
      { number: 1 },
      { status: 2 },
    ];

    for (const fields of malformed) {
      expect(
        readInvoiceList(
          stripeList([stripeInvoice(), stripeInvoice({ id: "in_2", ...fields })]),
          CUSTOMER,
        ),
        JSON.stringify(fields),
      ).toEqual({ ok: false, reason: "malformed_invoice" });
    }

    for (const entry of [null, "in_1", 1]) {
      expect(readInvoiceList(stripeList([entry]), CUSTOMER)).toEqual({
        ok: false,
        reason: "malformed_invoice",
      });
    }
  });

  it("refuses a batch in which the same invoice appears twice", () => {
    expect(
      readInvoiceList(stripeList([stripeInvoice(), stripeInvoice()]), CUSTOMER),
    ).toEqual({ ok: false, reason: "duplicate_invoice" });
  });

  it("keeps nothing from a refused answer", () => {
    const reading = readInvoiceList(
      stripeList([stripeInvoice({ customer: "cus_other", number: "LEAK-0001" })]),
      CUSTOMER,
    );

    expect(JSON.stringify(reading)).not.toMatch(/LEAK|cus_other/);
  });
});

describe("readInvoiceList – documents", () => {
  it("marks each document available when Stripe provides a usable URL, and never keeps the URL", () => {
    const reading = readInvoiceList(stripeList([stripeInvoice()]), CUSTOMER);

    expect(reading.ok && reading.invoices[0].documents).toEqual({
      view: true,
      pdf: true,
    });
    expect(JSON.stringify(reading)).not.toMatch(/stripe\.com|acct_|\?s=ap/);
  });

  it("marks a document unavailable while Stripe has not provided it (null or absent), without counting it as rejected", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ id: "in_2", hosted_invoice_url: null, invoice_pdf: undefined }),
        stripeInvoice({ id: "in_1", invoice_pdf: null }),
      ]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices.map((i) => i.documents)).toEqual([
      { view: false, pdf: false },
      { view: true, pdf: false },
    ]);
    expect(reading).toMatchObject({ rejectedDocumentUrls: 0 });
  });

  it("treats a URL it will not follow as no document, and counts it for the log", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({
          id: "in_3",
          hosted_invoice_url: "http://invoice.stripe.com/i/plain-http",
          invoice_pdf: "https://evil.example/invoice.pdf",
        }),
        stripeInvoice({ id: "in_2", hosted_invoice_url: "not a url", invoice_pdf: 42 }),
        stripeInvoice({ id: "in_1" }),
      ]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices.map((i) => i.documents)).toEqual([
      { view: false, pdf: false },
      { view: false, pdf: false },
      { view: true, pdf: true },
    ]);
    expect(reading).toMatchObject({ rejectedDocumentUrls: 4 });
  });

  it("accepts a configured extra host (a custom invoice domain) for documents", () => {
    const invoice = stripeInvoice({
      hosted_invoice_url: "https://invoices.example.com/i/abc",
      invoice_pdf: "https://invoices.example.com/i/abc/pdf",
    });
    const documentsWith = (hosts?: string[]) => {
      const reading = readInvoiceList(stripeList([invoice]), CUSTOMER, {
        documentHosts: hosts,
      });
      return reading.ok ? reading.invoices[0].documents : reading;
    };

    expect(documentsWith()).toEqual({ view: false, pdf: false });
    expect(documentsWith(["invoices.example.com"])).toEqual({ view: true, pdf: true });
  });

  it("does not let a document URL decide whether the invoice is listed", () => {
    const reading = readInvoiceList(
      stripeList([
        stripeInvoice({ hosted_invoice_url: "garbage", invoice_pdf: "garbage" }),
      ]),
      CUSTOMER,
    );

    expect(reading.ok && reading.invoices).toHaveLength(1);
  });
});

describe("isInvoiceDocumentUrl – what may be followed", () => {
  it("accepts https URLs on Stripe's hosts", () => {
    for (const url of [
      HOSTED_URL,
      PDF_URL,
      "https://stripe.com/x",
      "https://files.stripe.com/x.pdf",
      "https://INVOICE.STRIPE.COM/i/x",
    ]) {
      expect(isInvoiceDocumentUrl(url), url).toBe(true);
    }
  });

  it("refuses everything else", () => {
    const refused: unknown[] = [
      null,
      undefined,
      "",
      42,
      {},
      "/i/acct_1/test_1", // relative
      "invoice.stripe.com/i/x", // no scheme
      "http://invoice.stripe.com/i/x", // plain http
      "ftp://invoice.stripe.com/i/x",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://stripe.com.evil.example/i/x", // suffix trick
      "https://evilstripe.com/i/x", // not a subdomain
      "https://stripe.evil.example/i/x",
      "https://user:pw@evil.example#invoice.stripe.com",
      "https://localhost/i/x", // loopback is only allowed when configured
      "https://" + "a".repeat(2100) + ".stripe.com/",
    ];

    for (const value of refused) {
      expect(isInvoiceDocumentUrl(value), String(value)).toBe(false);
    }
  });

  it("accepts a configured extra host over https, and over http only for loopback", () => {
    const hosts = ["invoices.example.com", "127.0.0.1", "localhost"];

    expect(isInvoiceDocumentUrl("https://invoices.example.com/i/x", hosts)).toBe(true);
    expect(isInvoiceDocumentUrl("https://Invoices.Example.com/i/x", hosts)).toBe(true);
    expect(isInvoiceDocumentUrl("http://invoices.example.com/i/x", hosts)).toBe(false);
    expect(isInvoiceDocumentUrl("http://127.0.0.1:4242/i/x", hosts)).toBe(true);
    expect(isInvoiceDocumentUrl("http://localhost:4242/i/x", hosts)).toBe(true);
    expect(isInvoiceDocumentUrl("http://127.0.0.1:4242/i/x", [])).toBe(false);
    expect(isInvoiceDocumentUrl("https://other.example.com/i/x", hosts)).toBe(false);
  });
});

describe("invoice document paths", () => {
  it("builds a same-origin path from the key and the kind", () => {
    expect(invoiceDocumentPath("abc_-123", "view")).toBe(
      "/billing/invoices/abc_-123/view",
    );
    expect(invoiceDocumentPath("abc", "pdf")).toBe("/billing/invoices/abc/pdf");
  });

  it("escapes a key that is not URL-safe rather than letting it shape the path", () => {
    expect(invoiceDocumentPath("../x?y", "pdf")).toBe("/billing/invoices/..%2Fx%3Fy/pdf");
  });

  it("knows the two kinds and their Stripe fields, and nothing else", () => {
    expect(INVOICE_DOCUMENT_KINDS).toEqual(["view", "pdf"]);
    expect(INVOICE_DOCUMENT_FIELDS).toEqual({
      view: "hosted_invoice_url",
      pdf: "invoice_pdf",
    });
    expect(isInvoiceDocumentKind("view")).toBe(true);
    expect(isInvoiceDocumentKind("pdf")).toBe(true);
    for (const value of ["VIEW", "html", "", null, 1, "hosted_invoice_url"]) {
      expect(isInvoiceDocumentKind(value)).toBe(false);
    }
  });
});

describe("invoice keys", () => {
  it("round-trips a Stripe invoice id through an opaque token", () => {
    for (const id of ["in_1", "in_1Abc2DEF3ghi", "in_1NXWPnCRMbs6FrXv8a1b2c3d"]) {
      const key = encodeInvoiceKey(id);

      expect(key).not.toContain(id);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/); // URL- and attribute-safe
      expect(decodeInvoiceKey(key)).toBe(id);
    }
  });

  it("decodes nothing that is not a token for a well-formed invoice id", () => {
    const rejected: unknown[] = [
      null,
      undefined,
      "",
      42,
      {},
      ["in_1"],
      "in_1", // the raw id is not a token
      encodeInvoiceKey("cus_1"),
      encodeInvoiceKey("sub_1"),
      encodeInvoiceKey("in_"),
      encodeInvoiceKey("in_1 or 1=1"),
      encodeInvoiceKey("in_1") + "=", // padding or trailing junk
      encodeInvoiceKey("in_1") + "/",
      "!!!",
      "a".repeat(65),
    ];

    for (const value of rejected) {
      expect(decodeInvoiceKey(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("recognises Stripe invoice ids and nothing else", () => {
    expect(isStripeInvoiceId("in_1A2b")).toBe(true);
    for (const value of ["in_", "in-1", "cus_1", "IN_1", " in_1", "in_1 ", null, 1]) {
      expect(isStripeInvoiceId(value), String(value)).toBe(false);
    }
  });

  it("tokens: base64url round trip, length-bounded, strict charset", () => {
    expect(decodeToken(encodeToken('{"a":"in_1","f":"status=paid"}'), 512)).toBe(
      '{"a":"in_1","f":"status=paid"}',
    );
    expect(decodeToken(encodeToken("x".repeat(100)), 64)).toBeNull();
    expect(decodeToken("abc+def", 64)).toBeNull();
    expect(decodeToken("", 64)).toBeNull();
  });
});

describe("appendInvoices – adding a page to the invoices on screen", () => {
  const inv = (id: string): InvoiceSummary => ({
    key: encodeInvoiceKey(id),
    number: id.toUpperCase(),
    createdAt: "2026-03-01T00:00:00.000Z",
    total: 100,
    currency: "usd",
    status: "paid",
    documents: { view: true, pdf: true },
  });

  it("appends new invoices after the existing ones, in their own order", () => {
    expect(
      appendInvoices([inv("in_3")], [inv("in_2"), inv("in_1")]).map((i) => i.key),
    ).toEqual([inv("in_3"), inv("in_2"), inv("in_1")].map((i) => i.key));
  });

  it("drops an invoice that is already on screen (a duplicated or overlapping response)", () => {
    const shown = [inv("in_3"), inv("in_2")];

    expect(appendInvoices(shown, [inv("in_2"), inv("in_1")])).toEqual([
      inv("in_3"),
      inv("in_2"),
      inv("in_1"),
    ]);
    expect(appendInvoices(shown, shown)).toEqual(shown);
    expect(appendInvoices(shown, [inv("in_1"), inv("in_1")])).toHaveLength(3);
  });

  it("never mutates its inputs", () => {
    const shown = [inv("in_2")];
    const incoming = [inv("in_1")];

    appendInvoices(shown, incoming);

    expect(shown).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });
});

describe("paging constants", () => {
  it("ask Stripe for more objects than a page shows, so drafts in between rarely cost a second request", () => {
    expect(INVOICE_FETCH_BATCH_SIZE).toBeGreaterThan(INVOICE_HISTORY_PAGE_SIZE);
    expect(INVOICE_FETCH_BATCH_SIZE).toBeLessThanOrEqual(100); // Stripe's maximum
  });

  it("bound the scan for one page", () => {
    expect(INVOICE_MAX_FETCHES_PER_PAGE).toBeGreaterThanOrEqual(2);
    expect(INVOICE_MAX_FETCHES_PER_PAGE).toBeLessThanOrEqual(10);
  });
});

describe("invoice status content", () => {
  it("has a label and a tone for every status the page can show", () => {
    for (const status of [...LISTED_INVOICE_STATUSES, "unknown"] as const) {
      expect(INVOICE_STATUS_CONTENT[status].label).toMatch(/\S/);
      expect(["neutral", "attention"]).toContain(INVOICE_STATUS_CONTENT[status].tone);
    }
  });

  it("draws attention to money that is owed or was written off, and to a status it cannot read", () => {
    expect(INVOICE_STATUS_CONTENT.open.tone).toBe("attention");
    expect(INVOICE_STATUS_CONTENT.uncollectible.tone).toBe("attention");
    expect(INVOICE_STATUS_CONTENT.unknown.tone).toBe("attention");
    expect(INVOICE_STATUS_CONTENT.paid.tone).toBe("neutral");
    expect(INVOICE_STATUS_CONTENT.void.tone).toBe("neutral");
  });

  it("never lists drafts", () => {
    expect(LISTED_INVOICE_STATUSES).not.toContain("draft");
    expect(isListedInvoiceStatus("draft")).toBe(false);
    expect(isListedInvoiceStatus("paid")).toBe(true);
    expect(isListedInvoiceStatus(null)).toBe(false);
  });
});

describe("formatInvoiceAmount – Stripe minor units to text", () => {
  it("formats two-decimal currencies from their minor unit", () => {
    expect(formatInvoiceAmount(2900, "usd")).toBe("$29.00");
    expect(formatInvoiceAmount(2900, "eur")).toBe("€29.00");
    expect(formatInvoiceAmount(0, "usd")).toBe("$0.00");
    expect(formatInvoiceAmount(123_456_789, "gbp")).toBe("£1,234,567.89");
  });

  it("does not scale zero-decimal currencies", () => {
    expect(formatInvoiceAmount(2900, "jpy")).toBe("¥2,900");
    expect(formatInvoiceAmount(2900, "krw")).toBe("₩2,900");
  });

  it("scales three-decimal currencies by a thousand", () => {
    expect(formatInvoiceAmount(2900, "kwd")).toMatch(/^KWD\s?2\.900$/);
  });

  it("follows Stripe's special cases, not ISO: ISK, HUF, TWD and UGX are two-decimal", () => {
    for (const code of ["isk", "huf", "twd", "ugx"]) {
      expect(minorUnitDigits(code)).toBe(2);
    }
    expect(formatInvoiceAmount(100_000, "isk")).toMatch(/1,000\.00$/);
  });

  it("is case-insensitive about the code", () => {
    expect(formatInvoiceAmount(2900, "USD")).toBe("$29.00");
    expect(formatInvoiceAmount(2900, "JPY")).toBe("¥2,900");
  });

  it("shows a negative total (a credit) with its sign", () => {
    expect(formatInvoiceAmount(-500, "usd")).toBe("-$5.00");
  });

  it("still shows the amount for a currency it cannot format, followed by the code", () => {
    expect(formatInvoiceAmount(2900, "zzz")).toMatch(/^(ZZZ\s?29\.00|29\.00 ZZZ)$/);
    expect(formatInvoiceAmount(2900, "x")).toBe("29.00 X");
  });
});

describe("formatInvoiceDate", () => {
  it("formats the UTC calendar date, independent of the server's time zone", () => {
    expect(formatInvoiceDate("2026-03-01T00:00:00.000Z")).toBe("Mar 1, 2026");
    expect(formatInvoiceDate("2026-03-01T23:59:59.000Z")).toBe("Mar 1, 2026");
    expect(formatInvoiceDate("2025-12-31T23:30:00.000Z")).toBe("Dec 31, 2025");
  });
});
