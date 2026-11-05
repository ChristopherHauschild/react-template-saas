// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formulaCells, parseCsv } from "@/shared/test/csv";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";

import {
  buildInvoiceExportCsv,
  formatInvoiceExportAmount,
  INVOICE_EXPORT_COLUMNS,
  invoiceExportFileName,
} from "./invoice-export";
import {
  encodeInvoiceKey,
  type InvoiceSummary,
  LISTED_INVOICE_STATUSES,
  readInvoiceList,
} from "./invoice-history";

const invoice = (overrides: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  key: encodeInvoiceKey("in_1"),
  number: "ABCD-0001",
  createdAt: "2026-03-01T10:00:00.000Z",
  total: 2900,
  currency: "usd",
  status: "paid",
  documents: { view: true, pdf: true },
  ...overrides,
});

/** The file as a consumer reads it: BOM checked and stripped, then parsed. */
const read = (csv: string) => {
  expect(csv.startsWith(CSV_UTF8_BOM)).toBe(true);
  return parseCsv(csv.slice(CSV_UTF8_BOM.length));
};

describe("formatInvoiceExportAmount", () => {
  it.each([
    [2900, "usd", "29.00"],
    [1999, "usd", "19.99"],
    [5, "usd", "0.05"],
    [0, "usd", "0.00"],
    [-550, "eur", "-5.50"],
    [-5, "eur", "-0.05"],
    [2900, "jpy", "2900"],
    [-300, "jpy", "-300"],
    [1234, "kwd", "1.234"],
    [7, "bhd", "0.007"],
    [2900, "USD", "29.00"], // case-insensitive, like minorUnitDigits
    [123456789012, "usd", "1234567890.12"],
    [Number.MAX_SAFE_INTEGER, "usd", "90071992547409.91"],
    [2900, "ugx", "29.00"], // Stripe treats UGX as two-decimal
    [2900, "zzz", "29.00"], // unknown code: Stripe's default
  ])("%d %s → %s", (total, currency, expected) => {
    expect(formatInvoiceExportAmount(total, currency)).toBe(expected);
  });

  it("treats negative zero as zero", () => {
    expect(formatInvoiceExportAmount(-0, "usd")).toBe("0.00");
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses a total that is not a safe integer (%s)",
    (total) => {
      expect(() => formatInvoiceExportAmount(total, "usd")).toThrow(/safe integer/);
    },
  );
});

describe("buildInvoiceExportCsv – layout", () => {
  it("starts with a UTF-8 BOM and the column headings", () => {
    const rows = read(buildInvoiceExportCsv([]));

    expect(rows).toEqual([[...INVOICE_EXPORT_COLUMNS]]);
    expect(INVOICE_EXPORT_COLUMNS).toEqual([
      "Date (UTC)",
      "Invoice number",
      "Status",
      "Total",
      "Currency",
    ]);
  });

  it("writes one row per invoice: UTC date, number, status label, decimal total, currency code", () => {
    const rows = read(buildInvoiceExportCsv([invoice()]));

    expect(rows[1]).toEqual(["2026-03-01", "ABCD-0001", "Paid", "29.00", "USD"]);
  });

  it("dates an invoice by its UTC calendar day, as the page and the filters do", () => {
    const rows = read(
      buildInvoiceExportCsv([invoice({ createdAt: "2026-02-28T23:59:59.000Z" })]),
    );

    expect(rows[1][0]).toBe("2026-02-28");
  });

  it.each([...LISTED_INVOICE_STATUSES, "unknown" as const])(
    "labels the status %s as the page does",
    (status) => {
      const label = read(buildInvoiceExportCsv([invoice({ status })]))[1][2];

      expect(label).toBe(
        {
          paid: "Paid",
          open: "Open",
          uncollectible: "Uncollectible",
          void: "Void",
          unknown: "Unknown",
        }[status],
      );
    },
  );

  it("leaves the number empty when Stripe has not assigned one", () => {
    expect(read(buildInvoiceExportCsv([invoice({ number: null })]))[1][1]).toBe("");
  });

  it("writes a negative total (a credit) as a plain negative number, not as text", () => {
    const csv = buildInvoiceExportCsv([invoice({ total: -1250 })]);

    expect(csv).toContain(",-12.50,");
    expect(read(csv)[1][3]).toBe("-12.50");
  });

  it("neutralises an invoice number a spreadsheet would run as a formula", () => {
    const rows = read(buildInvoiceExportCsv([invoice({ number: "=HYPERLINK(1)" })]));

    expect(rows[1][1]).toBe("'=HYPERLINK(1)");
  });
});

describe("buildInvoiceExportCsv – completeness and order", () => {
  it("keeps every invoice given, in the order given, with no deduplication or filtering", () => {
    const given = Array.from({ length: 250 }, (_, i) =>
      invoice({
        key: encodeInvoiceKey(`in_${i}`),
        number: `HUGE-${String(i + 1).padStart(4, "0")}`,
        status: LISTED_INVOICE_STATUSES[i % LISTED_INVOICE_STATUSES.length],
        total: i % 7 === 0 ? 0 : i * 100,
      }),
    );

    const rows = read(buildInvoiceExportCsv(given)).slice(1);

    expect(rows).toHaveLength(250);
    expect(rows.map((row) => row[1])).toEqual(given.map((i) => i.number));
  });

  it("writes two distinct invoices that share a number as two rows", () => {
    const rows = read(
      buildInvoiceExportCsv([
        invoice({ key: encodeInvoiceKey("in_a") }),
        invoice({ key: encodeInvoiceKey("in_b") }),
      ]),
    );

    expect(rows).toHaveLength(3);
  });
});

describe("buildInvoiceExportCsv – nothing beyond what the page shows", () => {
  const STRIPE_INVOICE = {
    id: "in_1SecretIdAbc",
    object: "invoice",
    customer: "cus_SecretCustomer",
    created: 1_772_323_200,
    currency: "usd",
    total: 2900,
    number: "ABCD-0001",
    status: "paid",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/test_TOKEN123",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_1/test_TOKEN123/pdf",
    customer_email: "someone@example.com",
    account_name: "Acme Inc",
  };

  it("carries no Stripe ids, document URLs, opaque keys or other invoice fields", () => {
    const reading = readInvoiceList(
      { object: "list", has_more: false, data: [STRIPE_INVOICE] },
      "cus_SecretCustomer",
    );
    if (!reading.ok) throw new Error("fixture did not read");

    const csv = buildInvoiceExportCsv(reading.invoices);

    for (const secret of [
      "in_1SecretIdAbc",
      "cus_SecretCustomer",
      "acct_1",
      "TOKEN123",
      "stripe.com",
      "someone@example.com",
      "Acme",
      reading.invoices[0].key,
    ]) {
      expect(csv).not.toContain(secret);
    }
    expect(read(csv)[1]).toEqual(["2026-03-01", "ABCD-0001", "Paid", "29.00", "USD"]);
  });
});

describe("invoiceExportFileName", () => {
  it("is invoices-<UTC date>.csv", () => {
    expect(invoiceExportFileName(new Date("2026-03-01T12:00:00Z"))).toBe(
      "invoices-2026-03-01.csv",
    );
  });
});

describe("buildInvoiceExportCsv – no cell can be evaluated as a formula", () => {
  it.each([
    "=1+1",
    "+1",
    "-1+1",
    "@SUM(A1)",
    " =1+1",
    "\t=1",
    "\uFF1D1",
    '=HYPERLINK("https://evil.example","x")',
  ])("with the invoice number %j, while negative totals stay numbers", (number) => {
    const rows = read(
      buildInvoiceExportCsv([
        invoice({ number, total: -1250 }),
        invoice({ number, total: -3, currency: "jpy" }),
      ]),
    );

    expect(formulaCells(rows)).toEqual([]);
    expect(rows[1][1]).toBe(`'${number}`);
    expect(rows.slice(1).map((row) => row[3])).toEqual(["-12.50", "-3"]);
  });
});
